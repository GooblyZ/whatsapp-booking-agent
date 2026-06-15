// lib/ai/conversation.ts
// Server-side only.
//
// Bounded conversation memory for the receptionist brain — derived from the
// existing `messages` table (no new storage).
//
// HYGIENE (important): memory is provided to Gemini as a clearly-labeled,
// CONTEXT-ONLY transcript embedded in the system instruction — NOT as role:"model"
// few-shot turns. Sending prior assistant replies as model turns makes Gemini
// imitate their wording/style (that is how old template phrasing like
// "רק לוודא שהבנתי…" leaked back in). As context text, history informs the model
// about what was already said without dictating tone/personality — which is owned
// by AI Settings.
//
// Configurable, cost-conscious:
//   AI_MEMORY_TURNS         (default 10)  — max turns kept
//   AI_MEMORY_MAX_AGE_HOURS (default 24)  — ignore anything older (recent session only)
//   AI_MAX_TURN_CHARS       (default 500) — per-message truncation

import type { DB } from "@/lib/booking/helpers";
import { extractExplicitTime } from "./grounding";
import { isKnownFallbackText } from "./brain";

// Memory finding (live tests): the log's "memTurns=20" counted LINES (user+assistant),
// i.e. a full 10-exchange window. Now that the durable booking facts live in the
// BOOKING SESSION (lib/ai/booking-session.ts), raw history matters less — 8 exchanges
// (16 lines) is enough for references/continuity at lower cost and less stale drift.
const DEFAULT_MEMORY_TURNS = 8;
const DEFAULT_MAX_AGE_HOURS = 24;
const DEFAULT_MAX_TURN_CHARS = 500;
// Conversation-boundary heuristic: a silence longer than this means a NEW
// conversation — memory starts after the most recent gap. (Live: a fresh "שלום"
// arrived with a FULL 16-line window from the previous conversation; the 24h age
// bound alone doesn't separate conversations.) Durable facts live in the booking
// session and the EXISTING APPOINTMENTS block, so cutting chat memory at a gap
// loses style/chit-chat continuity only.
const DEFAULT_GAP_HOURS = 6;

export interface ConversationTurn {
  role: "user" | "model";
  text: string;
}

export interface ConversationContext {
  /**
   * Recent history as REAL conversation turns (oldest → newest), for native
   * multi-turn Gemini calls — the model's strongest conversational format.
   * Style authority remains with AI Settings (enforced in the persona).
   */
  turns: ConversationTurn[];
  /** Labeled transcript of the same history — used by reply guards / loop detection. */
  transcript: string;
  /** Number of prior MESSAGES (lines) actually included. */
  turnsUsed: number;
  /** Configured window (exchanges) and recency cutoff (hours) — for observability. */
  windowTurns: number;
  maxAgeHours: number;
}

/**
 * True when the most recent outbound message FAILED to send RECENTLY — the
 * customer never saw our last reply, so the next reply should briefly
 * acknowledge the hiccup. The recency bound is essential: without it, a stale
 * failed send from a PAST conversation leaked "הייתה לי תקלה קטנה קודם" into a
 * fresh greeting hours later. Fail-safe: false on any error.
 */
const SEND_FAILURE_ACK_WINDOW_MIN = 45;

export async function didLastReplyFailToSend(db: DB, businessId: string, customerId: string): Promise<boolean> {
  try {
    const sinceISO = new Date(Date.now() - SEND_FAILURE_ACK_WINDOW_MIN * 60_000).toISOString();
    const { data } = await db
      .from("messages")
      .select("send_status")
      .eq("business_id", businessId)
      .eq("customer_id", customerId)
      .eq("direction", "outbound")
      .gte("created_at", sinceISO)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.send_status === "failed";
  } catch {
    return false;
  }
}

/**
 * Existing-appointment awareness (read-only): renders the customer's upcoming
 * appointments as a system-checked prompt block — the source of truth for
 * cancel/reschedule questions.
 */
export async function renderUpcomingAppointments(
  db: DB, businessId: string, customerId: string, timezone: string, platformMode = false
): Promise<string> {
  try {
    const { data } = await db
      .from("appointments")
      .select("start_time, status, services(name)")
      .eq("business_id", businessId)
      .eq("customer_id", customerId)
      .in("status", ["pending", "confirmed"])
      .gte("start_time", new Date().toISOString())
      .order("start_time", { ascending: true })
      .limit(5);

    const rows = (data ?? []) as Array<{ start_time: string; status: string; services: { name?: string } | null }>;
    if (rows.length === 0) {
      const tail = platformMode
        ? "If they ask to cancel/change one, say honestly that you don't see an upcoming appointment under this number, and offer to book (the system attaches a booking link)."
        : "If they ask to cancel/change one, say honestly that you don't see an active appointment under this number.";
      return `EXISTING APPOINTMENTS (system-checked): this customer has NO upcoming appointment. ${tail}`;
    }
    const fmt = rows.map((r) => {
      const d = new Date(r.start_time);
      const date = new Intl.DateTimeFormat("he-IL", { timeZone: timezone, day: "2-digit", month: "2-digit" }).format(d);
      const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
      return `• ${date} בשעה ${time}${r.services?.name ? ` — ${r.services.name}` : ""} (${r.status})`;
    });
    // The system-checked list is the ONLY truth about appointments. The closing
    // line differs by mode: platform mode routes changes to the website (the
    // system attaches the right link), so it must NOT tell the model to "refer to
    // the business" — that produced wrong, confusing answers.
    const tail = platformMode
      ? "Relay these appointments accurately (date/time/service) when asked — never invent, omit, or merge one. Viewing, rescheduling and cancelling happen on the booking page; the SYSTEM attaches the correct link (a single-appointment link, or a 'My Appointments' link when there are 2+). NEVER claim you changed/cancelled anything, and NEVER claim the website can do something beyond view/reschedule/cancel these appointments."
      : "Changes/cancellations are not possible via this chat yet — refer them to the business, and refer to these appointments accurately.";
    return `EXISTING APPOINTMENTS (system-checked) for this customer:\n${fmt.join("\n")}\n${tail}`;
  } catch (err) {
    console.error("[ai-memory] upcoming-appointments fetch failed:", err instanceof Error ? err.message : String(err));
    return "";
  }
}

/**
 * Renders a CUSTOMER block for the persona's working memory: who the system
 * already knows this person to be (name, new vs returning, visit history). This
 * is what lets the receptionist greet a regular by name and treat a first-timer
 * with a touch more orientation — the difference between "a real receptionist"
 * and "a generic bot". Derived entirely from existing tables (customers +
 * appointments); contains NO phone number or message content. Fail-open: returns
 * "" on any error so it can never block a reply.
 */
export async function renderCustomerState(
  db: DB, businessId: string, customerId: string, timezone: string
): Promise<string> {
  try {
    const [{ data: cust }, { data: past }] = await Promise.all([
      db.from("customers").select("name, created_at").eq("id", customerId).maybeSingle(),
      db
        .from("appointments")
        .select("start_time, status")
        .eq("business_id", businessId)
        .eq("customer_id", customerId)
        .in("status", ["completed", "confirmed", "cancelled"])
        .lt("start_time", new Date().toISOString())
        .order("start_time", { ascending: false })
        .limit(20),
    ]);

    const name = (cust?.name as string | null)?.trim() || null;
    const rows = (past ?? []) as Array<{ start_time: string; status: string }>;
    const kept = rows.filter((r) => r.status === "completed" || r.status === "confirmed");
    const visits = kept.length;

    const parts: string[] = [];
    parts.push(name ? `Name: ${name} (use it naturally — don't ask for it again).` : `Name: unknown.`);

    if (visits > 0) {
      const last = kept[0];
      const lastStr = new Intl.DateTimeFormat("he-IL", { timeZone: timezone, day: "2-digit", month: "2-digit" }).format(new Date(last.start_time));
      parts.push(
        `Returning customer — ${visits} previous visit${visits > 1 ? "s" : ""}, most recent around ${lastStr}. ` +
        `Treat them as someone who already knows the place; warmth over orientation.`
      );
    } else {
      parts.push(`Likely a first-time customer here — a touch more orientation is welcome, no assumptions about familiarity.`);
    }

    return `CUSTOMER (system-checked):\n${parts.join("\n")}`;
  } catch (err) {
    console.error("[ai-memory] customer-state fetch failed:", err instanceof Error ? err.message : String(err));
    return "";
  }
}

/**
 * Stuck-recovery helper: scans the customer's recent messages (newest first) for
 * a concrete clock time that earlier turns failed to parse — used when the
 * customer insists "אמרתי כבר" while the session's time is still missing.
 * Times already rejected for the current day are skipped.
 */
export function findTimeInHistory(turns: ConversationTurn[], rejectedSlots: string[]): string | null {
  const userTurns = turns.filter((t) => t.role === "user").slice(-6).reverse();
  for (const t of userTurns) {
    const found = extractExplicitTime(t.text);
    if (found && !rejectedSlots.includes(found)) return found;
  }
  return null;
}

export function getMemoryTurns(): number {
  const n = parseInt(process.env.AI_MEMORY_TURNS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MEMORY_TURNS;
}

function getMaxAgeHours(): number {
  const n = parseInt(process.env.AI_MEMORY_MAX_AGE_HOURS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_AGE_HOURS;
}

function getMaxTurnChars(): number {
  const n = parseInt(process.env.AI_MAX_TURN_CHARS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TURN_CHARS;
}

function getGapHours(): number {
  const n = parseFloat(process.env.AI_MEMORY_GAP_HOURS ?? "");
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GAP_HOURS;
}

/**
 * Keeps only the rows after the most recent silence longer than `gapHours` —
 * including the gap between the last row and NOW (a customer returning after a
 * long break starts a fresh conversation). Rows must be chronological. Pure.
 */
export function applyConversationGap<T extends { created_at: string }>(
  rows: T[], gapHours: number, nowMs: number
): T[] {
  if (rows.length === 0) return rows;
  const gapMs = gapHours * 3_600_000;
  if (nowMs - new Date(rows[rows.length - 1].created_at).getTime() > gapMs) return [];
  let start = 0;
  for (let i = 1; i < rows.length; i++) {
    const gap = new Date(rows[i].created_at).getTime() - new Date(rows[i - 1].created_at).getTime();
    if (gap > gapMs) start = i;
  }
  return rows.slice(start);
}

const EMPTY = (windowTurns: number, maxAgeHours: number): ConversationContext => ({
  turns: [],
  transcript: "",
  turnsUsed: 0,
  windowTurns,
  maxAgeHours,
});

/**
 * Builds a recent, recency-bounded, context-only transcript for one customer.
 * Excludes the current inbound message (already persisted before the flow runs).
 * Fail-safe: returns an empty context on any error.
 */
export async function getConversationContext(
  db: DB,
  businessId: string,
  customerId: string,
  maxTurns: number = getMemoryTurns()
): Promise<ConversationContext> {
  const maxAgeHours = getMaxAgeHours();
  try {
    const sinceISO = new Date(Date.now() - maxAgeHours * 3_600_000).toISOString();
    const limit = maxTurns * 2 + 1; // +1 for the current inbound row we drop

    const { data, error } = await db
      .from("messages")
      .select("direction, body, created_at")
      .eq("business_id", businessId)
      .eq("customer_id", customerId)
      .gte("created_at", sinceISO)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !data) {
      if (error) console.error("[ai-memory] read failed:", error.message);
      return EMPTY(maxTurns, maxAgeHours);
    }

    let rows = data as { direction: string; body: string | null; created_at: string }[];
    // Drop the newest row if it is the current inbound message.
    if (rows.length > 0 && rows[0].direction === "inbound") rows = rows.slice(1);
    rows.reverse(); // chronological
    // Cross-conversation hygiene: memory never crosses a long silence.
    rows = applyConversationGap(rows, getGapHours(), Date.now());

    const maxChars = getMaxTurnChars();
    const allTurns: ConversationTurn[] = rows
      .filter((r) => (r.body ?? "").trim().length > 0)
      .map((r) => ({
        role: r.direction === "inbound" ? ("user" as const) : ("model" as const),
        text: (r.body as string).slice(0, maxChars).replace(/\s*\n\s*/g, " ").trim(),
      }))
      .slice(-(maxTurns * 2));

    // AI-facing turns drop our own failure/degraded lines — they carry no
    // information, and as model turns they teach the model to talk about
    // glitches. The transcript keeps EVERYTHING (guards compare against it).
    const turns = allTurns.filter((t) => t.role === "user" || !isKnownFallbackText(t.text));

    if (allTurns.length === 0) return EMPTY(maxTurns, maxAgeHours);

    const transcript = allTurns
      .map((t) => `${t.role === "user" ? "Customer" : "Assistant (you, earlier)"}: ${t.text}`)
      .join("\n");

    return {
      turns,
      transcript,
      turnsUsed: turns.length,
      windowTurns: maxTurns,
      maxAgeHours,
    };
  } catch (err) {
    console.error("[ai-memory] unexpected error:", err instanceof Error ? err.message : String(err));
    return EMPTY(maxTurns, maxAgeHours);
  }
}
