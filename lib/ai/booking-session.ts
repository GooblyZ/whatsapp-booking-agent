// lib/ai/booking-session.ts
// Server-side only.
//
// BOOKING CONTEXT is the primary abstraction (not booking states).
// A BookingSession is a structured, continuously-evolving picture of what the
// customer wants: service / day / time / goal — gathered in ANY order, from
// Gemini's structured understanding plus cheap deterministic extraction.
//
// The session lives inside conversation_states.context (key "booking_session"),
// so it is automatically isolated per (business_id, customer_id).
//
// Nothing here writes to the DB or talks to Gemini — pure data + parsing.

import { parseHebrewDate, todayInTZ } from "@/lib/booking/availability";
import { DAY_NAMES } from "@/lib/services/business-hours";
import { extractTimeTokens, extractExplicitTime } from "./grounding";

/** Session staleness: a booking discussion older than this is forgotten. */
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface BookingSession {
  active: boolean;                 // a booking discussion is in progress
  service: string | null;          // matched service name (validated against catalog)
  serviceId: string | null;
  serviceDurationMin: number | null;
  serviceRaw: string | null;       // what the customer said, when no catalog match
  dateText: string | null;         // raw day phrase ("שבוע הבא", "יום שני")
  dateISO: string | null;          // resolved YYYY-MM-DD (system-resolved)
  time: string | null;             // "HH:MM" when a concrete time was given
  timePreference: string | null;   // softer preference ("בערב")
  customerReference: string | null;// who it's for ("הבן שלי")
  conversationGoal: string | null;
  /**
   * Appointment lifecycle the customer is in. The system arms a NEW-booking
   * confirmation ONLY when lifecycle is "book" (or null) — reschedule/cancel/
   * modify talk must NEVER produce a new appointment.
   */
  lifecycle: "book" | "reschedule" | "cancel" | "modify" | "list" | null;
  /** Times the assistant offered in its LAST reply (for the current day). */
  lastOfferedSlots: string[];
  /** Times the customer rejected for the CURRENT day — never re-offer unless reopened. */
  rejectedSlots: string[];
  /**
   * Most recent NON-available verdict on the current day ("17:30 was taken when
   * checked"; time=null for a whole-day verdict like closed_day). Powers
   * truthful answers to "למה הצעת לי שעות אחרות?" — the system's real reason,
   * not an invented motive.
   */
  lastVerdict: { time: string | null; category: string } | null;
  stuckTurns: number;              // loop detection: turns without progress
  lastMissing: string | null;
  updatedAt: string;               // ISO — staleness check
}

export function emptySession(): BookingSession {
  return {
    active: false,
    service: null, serviceId: null, serviceDurationMin: null, serviceRaw: null,
    dateText: null, dateISO: null,
    time: null, timePreference: null,
    customerReference: null, conversationGoal: null,
    lifecycle: null,
    lastOfferedSlots: [], rejectedSlots: [], lastVerdict: null,
    stuckTurns: 0, lastMissing: null,
    updatedAt: new Date().toISOString(),
  };
}

/** Loads the session from a conversation_states.context blob (stale → fresh). */
export function loadBookingSession(context: Record<string, unknown>): BookingSession {
  const raw = context?.booking_session;
  if (typeof raw !== "object" || raw === null) return emptySession();
  const s = { ...emptySession(), ...(raw as Partial<BookingSession>) };
  const age = Date.now() - new Date(s.updatedAt ?? 0).getTime();
  if (!Number.isFinite(age) || age > SESSION_MAX_AGE_MS) return emptySession();
  return s;
}

/**
 * Migrates legacy menu-flow context fields (selected_service_*, selected_date,
 * selected_slot_time) into a session, so customers stuck in old states carry
 * their progress into the conversation model.
 */
export function sessionFromLegacyContext(context: Record<string, unknown>): BookingSession {
  const s = loadBookingSession(context);
  if (!s.service && typeof context.selected_service_name === "string") {
    s.service = context.selected_service_name;
    s.serviceId = (context.selected_service_id as string) ?? null;
    s.serviceDurationMin = (context.selected_duration_minutes as number) ?? null;
    s.active = true;
  }
  if (!s.dateISO && typeof context.selected_date === "string") {
    s.dateISO = context.selected_date;
    s.active = true;
  }
  if (!s.time && typeof context.selected_slot_time === "string") {
    s.time = context.selected_slot_time;
    s.active = true;
  }
  return s;
}

// ── Field helpers ──────────────────────────────────────────────────────────────

export type MissingField = "service" | "day" | "time" | "confirmation";

/** What is still needed before the booking can be confirmed. */
export function missingFields(s: BookingSession): MissingField[] {
  const missing: MissingField[] = [];
  if (!s.serviceId) missing.push("service");
  if (!s.dateISO) missing.push("day");
  if (!s.time) missing.push("time");
  if (missing.length === 0) missing.push("confirmation");
  return missing;
}

export function isReadyForConfirm(s: BookingSession): boolean {
  return !!(s.serviceId && s.dateISO && s.time);
}

// ── Deterministic extraction (cheap, pre-Gemini "probe") ──────────────────────

const WEEKDAYS: Record<string, number> = {
  "ראשון": 0, "שני": 1, "שלישי": 2, "רביעי": 3, "חמישי": 4, "שישי": 5, "שבת": 6,
};

function addDaysISO(todayISO: string, days: number): string {
  const d = new Date(todayISO + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

/**
 * Resolves a free-text day phrase to YYYY-MM-DD (business timezone) or null.
 * Handles: היום / מחר / מחרתיים / DD-MM / weekday names ("יום שני", "ביום שני")
 * / "שבוע הבא" + weekday. Bare "שבוע הבא" (no day) is NOT resolvable.
 */
export function resolveDateText(text: string | null | undefined, timezone: string): string | null {
  if (!text) return null;
  const t = text.trim();
  const today = todayInTZ(timezone);

  if (t.includes("מחרתיים")) return addDaysISO(today, 2);
  if (t.includes("מחר")) return addDaysISO(today, 1);
  if (t.includes("היום")) return today;

  const dm = t.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (dm) {
    const parsed = parseHebrewDate(dm[0], timezone);
    if (parsed) return parsed;
  }

  const nextWeek = t.includes("שבוע הבא");
  for (const [name, target] of Object.entries(WEEKDAYS)) {
    const re = new RegExp(`(?:^|[\\s,])ב?(?:יום\\s+)?${name}(?=$|[\\s,?.!])`);
    const bare = t === name;
    // NEGATED mentions don't count: "לא יום שלישי, אמרתי חמישי" must resolve to
    // Thursday — the first-listed weekday must not win just by appearing.
    const negated = new RegExp(`לא\\s+ב?(?:יום\\s+)?${name}(?=$|[\\s,?.!])`).test(t);
    if (negated) continue;
    if (re.test(t) || bare) {
      const todayDow = new Date(today + "T12:00:00Z").getDay();
      let delta = (target - todayDow + 7) % 7;
      if (delta === 0) delta = 7;
      // "שבוע הבא": if the next occurrence still falls inside the current
      // Sun-Sat week, push one week further.
      if (nextWeek && todayDow + delta < 7) delta += 7;
      return addDaysISO(today, delta);
    }
  }
  return null;
}

// Concrete-time extraction lives in lib/ai/grounding.ts (extractExplicitTime):
// rich Hebrew forms ("חמש וחצי", "5 וןצי", "רבע לחמש") with daypart inference.

export interface ServiceLite {
  id: string; name: string; duration_minutes: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word containment (Hebrew-aware: \b doesn't work for Hebrew). An optional
 * single-letter prefix (ו/ל/ב/ה) is allowed — "לפן", "והפן" — but mid-word hits
 * like "באופן" ⊅ "פן" are rejected (raw substring matching produced phantom
 * service hits on words like "פנוי"/"באופן").
 */
function containsWord(haystack: string, needle: string): boolean {
  if (needle.length < 2) return false;
  return new RegExp(`(?:^|[\\s,.!?])[ולבה]?${escapeRe(needle)}(?=$|[\\s,.!?])`).test(haystack);
}

/** Finds an active service the text plausibly names (exact / whole-word). */
export function matchService(text: string | null | undefined, services: ServiceLite[]): ServiceLite | null {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  if (t.length < 2) return null;
  for (const s of services) {
    const n = s.name.trim().toLowerCase();
    if (n === t || containsWord(t, n) || containsWord(n, t)) return s;
  }
  return null;
}

export interface ProbeResult {
  dateISO: string | null;
  time: string | null;
  service: ServiceLite | null;
}

// ── Tentative-field change requests (reopening a draft detail) ────────────────
//
// "בוא ננסה לחשוב על יום אחר" / "לשנות יום" while a DRAFT booking exists means:
// reopen the tentative day — NOT confirm the old one, NOT reschedule a confirmed
// appointment. Fields must be clearable, otherwise the draft can never change.

export type ChangeableField = "service" | "day" | "time";

const CHANGE_PATTERNS: { field: ChangeableField; re: RegExp }[] = [
  { field: "day",     re: /יום אחר|תאריך אחר|לשנות\s+(את\s+)?ה?יום|להחליף\s+(את\s+)?ה?יום|לא\s+מתאים\s+לי\s+ה?יום/ },
  { field: "time",    re: /שעה אחרת|זמן אחר|לשנות\s+(את\s+)?ה?שעה|להחליף\s+(את\s+)?ה?שעה/ },
  { field: "service", re: /שירות אחר|טיפול אחר|לשנות\s+(את\s+)?ה?שירות|להחליף\s+(את\s+)?ה?שירות/ },
];

/** Detects explicit "I want a different X" phrases in the message. */
export function detectFieldChangeRequests(text: string): ChangeableField[] {
  return CHANGE_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.field);
}

/** Clears one tentative field (reopens it). Returns true if anything changed. */
export function clearField(s: BookingSession, field: ChangeableField): boolean {
  if (field === "day" && (s.dateISO || s.dateText)) {
    s.dateISO = null; s.dateText = null;
    // Rejections and verdicts are day-scoped: a new day means a fresh slate.
    s.rejectedSlots = []; s.lastOfferedSlots = []; s.lastVerdict = null;
    return true;
  }
  if (field === "time" && (s.time || s.timePreference)) {
    s.time = null; s.timePreference = null;
    return true;
  }
  if (field === "service" && (s.serviceId || s.serviceRaw)) {
    s.service = null; s.serviceId = null; s.serviceDurationMin = null; s.serviceRaw = null;
    return true;
  }
  return false;
}

/**
 * Applies deterministic change-request detection to the session BEFORE the
 * probe/prompt — so working memory, availability and the redundant-question
 * guard all see the reopened (missing) field this very turn.
 * Only applies to the DRAFT (lifecycle book/null) — never to talk about
 * existing confirmed appointments.
 */
export function applyChangeRequests(
  s: BookingSession, message: string
): { session: BookingSession; cleared: ChangeableField[] } {
  if (!s.active || (s.lifecycle !== null && s.lifecycle !== "book")) {
    return { session: s, cleared: [] };
  }
  const requested = detectFieldChangeRequests(message);
  if (requested.length === 0) return { session: s, cleared: [] };

  const out = { ...s };
  const cleared: ChangeableField[] = [];
  for (const f of requested) {
    if (clearField(out, f)) cleared.push(f);
  }
  if (cleared.length > 0) out.updatedAt = new Date().toISOString();
  return { session: out, cleared };
}

/**
 * CONFIRM-STATE PROTECTION: while the deterministic confirm step is armed, a
 * meta-question ("למה הצעת לי שעות אחרות?") must not silently un-fill the draft.
 * A model change-signal with NO replacement value is treated as noise and the
 * field is restored (live: a "why" question cleared the time, disarmed the
 * confirmation, and forced an extra round trip). Explicit changes still work:
 * deterministic change phrases and NEW values are untouched by this.
 */
export function protectArmedDraft(
  prev: BookingSession, merged: BookingSession, modelIntent: string | undefined
): { session: BookingSession; restored: string[] } {
  let s = merged;
  const restored: string[] = [];
  if (prev.time && !s.time) {
    s = { ...s, time: prev.time };
    restored.push("time");
  }
  if (prev.dateISO && !s.dateISO) {
    s = { ...s, dateISO: prev.dateISO, dateText: prev.dateText };
    restored.push("day");
  }
  if (prev.serviceId && !s.serviceId) {
    s = { ...s, service: prev.service, serviceId: prev.serviceId, serviceDurationMin: prev.serviceDurationMin };
    restored.push("service");
  }
  if ((prev.lifecycle === null || prev.lifecycle === "book") &&
      s.lifecycle && s.lifecycle !== "book" && modelIntent !== "cancel_request") {
    s = { ...s, lifecycle: prev.lifecycle };
    restored.push("lifecycle");
  }
  return { session: s, restored };
}

// ── Offered-slot rejection ("אף אחת!") ─────────────────────────────────────────
//
// When the assistant offered concrete times and the customer rejects them all,
// those times become rejectedSlots for the current day — the system stops
// presenting them as options (native history alone is NOT enough: the
// availability facts re-feed them as valid every turn, which is exactly how
// 12:00 got re-offered live one turn after being rejected).

const OFFER_REJECTION_RE = /אף\s*אח(ת|ד)|לא\s*מתאים|שום\s*(שעה|דבר|זמן)|לא\s*טוב(ה)?\s*לי/;

/** True when the message rejects the previously-offered options wholesale. */
export function detectOfferRejection(text: string, hasOffers: boolean): boolean {
  if (!hasOffers) return false;
  const t = text.trim();
  if (OFFER_REJECTION_RE.test(t)) return true;
  // A bare "לא" right after an offer is a rejection of the offer.
  return t === "לא" || t === "לא!" || t === "לא.";
}

/**
 * Applies offer-rejection + explicit reconsideration to the session.
 *   - rejection → lastOfferedSlots move into rejectedSlots; time fully reopens
 *   - the customer naming a rejected time again ("אולי בעצם 12:00?") un-rejects it
 */
export function applyOfferRejection(
  s: BookingSession, message: string
): { session: BookingSession; rejectedNow: string[]; unrejected: string[] } {
  let out = s;
  let rejectedNow: string[] = [];
  const unrejected: string[] = [];

  if (detectOfferRejection(message, s.lastOfferedSlots.length > 0)) {
    rejectedNow = s.lastOfferedSlots.filter((t) => !s.rejectedSlots.includes(t));
    out = {
      ...s,
      rejectedSlots: [...s.rejectedSlots, ...rejectedNow],
      lastOfferedSlots: [],
      time: null,             // the whole time question reopens
      timePreference: s.timePreference,
      updatedAt: new Date().toISOString(),
    };
  }

  // Explicitly naming a time again reopens it.
  const mentioned = extractTimeTokens(message);
  if (mentioned.size > 0 && out.rejectedSlots.some((t) => mentioned.has(t))) {
    const keep = out.rejectedSlots.filter((t) => !mentioned.has(t));
    unrejected.push(...out.rejectedSlots.filter((t) => mentioned.has(t)));
    out = out === s ? { ...s, rejectedSlots: keep } : { ...out, rejectedSlots: keep };
  }

  return { session: out, rejectedNow, unrejected };
}

/**
 * Records which slots the assistant actually OFFERED in its outgoing reply —
 * the intersection of times mentioned in the reply with real open slots.
 * (Times like opening hours mentioned in passing are excluded by construction.)
 */
export function captureOfferedSlots(
  s: BookingSession, replyText: string, openSlots: string[], nearest: string[] = []
): BookingSession {
  const offerable = new Set([...openSlots, ...nearest]);
  if (offerable.size === 0) return s;
  const offered = [...extractTimeTokens(replyText)].filter((t) => offerable.has(t));
  if (offered.length === 0) return s;
  return { ...s, lastOfferedSlots: offered };
}

/**
 * Overlays the current message's deterministic probe onto the session — used to
 * render the PROMPT view, so Gemini sees details mentioned in THIS message too
 * (the authoritative merge still happens after Gemini replies).
 */
export function overlayProbe(s: BookingSession, probe: ProbeResult): BookingSession {
  const out: BookingSession = { ...s };
  if (!out.serviceId && probe.service) {
    out.service = probe.service.name;
    out.serviceId = probe.service.id;
    out.serviceDurationMin = probe.service.duration_minutes;
    out.active = true;
  }
  if (!out.dateISO && probe.dateISO) {
    out.dateISO = probe.dateISO;
    out.active = true;
  }
  if (!out.time && probe.time) {
    out.time = probe.time;
    out.active = true;
  }
  return out;
}

/**
 * Cheap deterministic look at the CURRENT message, overlaid on the session — so
 * the system can fetch real availability BEFORE calling Gemini.
 */
export function probeMessage(
  message: string, session: BookingSession, services: ServiceLite[], timezone: string
): ProbeResult {
  const msgDate = resolveDateText(message, timezone);
  // Combine a stored partial ("שבוע הבא") with a new day mention ("יום שני").
  const combined = !msgDate && session.dateText && !session.dateISO
    ? resolveDateText(`${session.dateText} ${message}`, timezone)
    : null;
  return {
    dateISO: msgDate ?? combined ?? session.dateISO,
    // Rich Hebrew parsing ("חמש וחצי", "5 וןצי", "רבע לחמש") with daypart inference.
    time: extractExplicitTime(message) ?? session.time,
    service: matchService(message, services)
      ?? (session.serviceId
        ? { id: session.serviceId, name: session.service ?? "", duration_minutes: session.serviceDurationMin ?? 30 }
        : null),
  };
}

// ── Merge (Gemini understanding → session) ─────────────────────────────────────

export interface UnderstandingFields {
  serviceName?: string | null;
  dateText?: string | null;
  timePreference?: string | null;
  time?: string | null;
  customerReference?: string | null;
  conversationGoal?: string | null;
  bookingIntent?: boolean;
  appointmentIntent?: string | null; // BOOK | RESCHEDULE | CANCEL | MODIFY | LIST | NONE
  /** Model-signaled "the customer wants a DIFFERENT value for this draft detail". */
  changeRequest?: string | null;     // service | day | time
}

export interface MergeResult {
  session: BookingSession;
  newFields: string[];
}

/**
 * Merges newly-discovered information into the session. The session only ever
 * IMPROVES within a turn (a field, once known, is never silently forgotten —
 * but an explicit new value replaces an old one).
 */
export function mergeUnderstanding(
  prev: BookingSession,
  u: UnderstandingFields,
  probe: ProbeResult,
  services: ServiceLite[],
  timezone: string,
  preReopened: ChangeableField[] = []
): MergeResult {
  const s: BookingSession = { ...prev };
  const newFields: string[] = [];

  // Reopened fields must not be silently re-filled with their OLD value — the
  // model often echoes the stale value from history (e.g. changeRequest="day"
  // together with dateText="מחר").
  //   preSet (deterministic pre-clear, BEFORE merge): prev already lost the old
  //     value, so echoes can't be compared away → ignore the model's extracted
  //     value entirely; the probe is message-derived post-clear and still
  //     catches a genuinely new value ("לשנות ליום רביעי").
  //   crSet (model changeRequest, cleared HERE): prev still holds the old value
  //     → reject candidates equal to it, accept anything new.
  const preSet = new Set<string>(preReopened);
  const crSet = new Set<string>();
  const cr = (u.changeRequest ?? "").toLowerCase();
  if ((cr === "service" || cr === "day" || cr === "time") && (s.lifecycle === null || s.lifecycle === "book")) {
    if (clearField(s, cr as ChangeableField)) {
      newFields.push(`${cr}_reopened`);
    }
    crSet.add(cr);
  }

  // Service: Gemini's extraction first, deterministic probe as backup.
  const svcCandidate = preSet.has("service")
    ? probe.service
    : (matchService(u.serviceName, services) ?? probe.service);
  const svc = crSet.has("service") && svcCandidate?.id === prev.serviceId ? null : svcCandidate;
  if (svc && svc.id !== s.serviceId) {
    s.service = svc.name;
    s.serviceId = svc.id;
    s.serviceDurationMin = svc.duration_minutes;
    s.serviceRaw = null;
    newFields.push("service");
  } else if (!svc && u.serviceName && u.serviceName !== s.serviceRaw && !s.serviceId) {
    s.serviceRaw = u.serviceName; // heard a service we couldn't match — keep for context
    newFields.push("service_raw");
  }

  // Day: resolve Gemini's dateText (alone, or combined with a stored partial).
  // preSet day → the model's dateText is untrusted this turn (likely an echo).
  if (u.dateText && u.dateText !== s.dateText && !preSet.has("day")) {
    const resolved =
      resolveDateText(u.dateText, timezone) ??
      (s.dateText ? resolveDateText(`${s.dateText} ${u.dateText}`, timezone) : null);
    const echoOfOld = crSet.has("day") && resolved === prev.dateISO;
    if (!echoOfOld) {
      s.dateText = u.dateText;
      if (resolved && resolved !== s.dateISO) {
        s.dateISO = resolved;
        newFields.push("day");
      } else if (!resolved) {
        newFields.push("day_partial");
      }
    }
  }
  if (!s.dateISO && probe.dateISO && !(crSet.has("day") && probe.dateISO === prev.dateISO)) {
    s.dateISO = probe.dateISO;
    newFields.push("day");
  }
  // A different day means a fresh slate of times — rejections and verdicts are
  // day-scoped.
  if (s.dateISO !== prev.dateISO) {
    s.rejectedSlots = [];
    s.lastOfferedSlots = [];
    s.lastVerdict = null;
  }

  // Time: prefer an explicit HH:MM (Gemini's `time`, else probe), keep preference text.
  let timeCandidate = preSet.has("time") ? probe.time : (normalizeTime(u.time) ?? probe.time);
  // Daypart disagreement: when the model returns the AM reading of the very hour
  // the message-derived probe resolved to afternoon ("05:30" vs probe "17:30"),
  // trust the probe's booking-context inference.
  if (timeCandidate && probe.time && timeCandidate !== probe.time) {
    const [ch, cm] = timeCandidate.split(":").map(Number);
    const [ph, pm] = probe.time.split(":").map(Number);
    if (cm === pm && ph === ch + 12) timeCandidate = probe.time;
  }
  const newTime = crSet.has("time") && timeCandidate === prev.time ? null : timeCandidate;
  if (newTime && newTime !== s.time) {
    s.time = newTime;
    newFields.push("time");
  }
  if (u.timePreference && u.timePreference !== s.timePreference) {
    // A "preference" that actually names a clock value ("חמש וחצי") IS the time —
    // the model often files natural-Hebrew times under timePreference.
    const asTime = normalizeTime(u.timePreference) ?? extractExplicitTime(u.timePreference);
    if (asTime && asTime !== s.time) {
      s.time = asTime;
      newFields.push("time");
    } else {
      s.timePreference = u.timePreference;
      if (!s.time) newFields.push("time_pref");
    }
  }

  if (u.customerReference && u.customerReference !== s.customerReference) {
    s.customerReference = u.customerReference;
    newFields.push("customer_reference");
  }
  if (u.conversationGoal && u.conversationGoal !== s.conversationGoal) {
    s.conversationGoal = u.conversationGoal;
    newFields.push("goal");
  }

  if (u.bookingIntent || newFields.some((f) => ["service", "day", "time"].includes(f))) {
    s.active = true;
  }

  // Lifecycle (sticky until the customer switches): reschedule/cancel/modify talk
  // must never silently become a NEW booking.
  const ai = (u.appointmentIntent ?? "").toUpperCase();
  if (ai === "BOOK") s.lifecycle = "book";
  else if (ai === "RESCHEDULE") s.lifecycle = "reschedule";
  else if (ai === "CANCEL") s.lifecycle = "cancel";
  else if (ai === "MODIFY") s.lifecycle = "modify";
  else if (ai === "LIST") s.lifecycle = "list";
  // "NONE" keeps the current lifecycle.

  s.updatedAt = new Date().toISOString();
  return { session: s, newFields };
}

function normalizeTime(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (h > 23 || mm > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

// ── Rendering (for the Gemini prompt) ─────────────────────────────────────────

export function dayNameHe(dateISO: string): string {
  return DAY_NAMES[new Date(dateISO + "T12:00:00Z").getDay()] ?? "";
}

/** Renders the session for the persona's CURRENT BOOKING block. */
export function renderSession(s: BookingSession): string {
  if (!s.active) return "";
  const lines: string[] = ["A booking is being put together. Details can arrive in ANY order — never force a sequence."];
  lines.push(`- service: ${s.service ?? (s.serviceRaw ? `"${s.serviceRaw}" (NOT in our service list — clarify which service they mean)` : "not chosen yet")}`);
  lines.push(`- day: ${s.dateISO ? `${s.dateISO} (יום ${dayNameHe(s.dateISO)})` : s.dateText ? `"${s.dateText}" mentioned but no specific day yet — pin down which day` : "not mentioned yet"}`);
  lines.push(`- time: ${s.time ?? s.timePreference ?? "not mentioned yet"}`);
  if (s.customerReference) lines.push(`- for: ${s.customerReference}`);
  if (s.conversationGoal) lines.push(`- goal: ${s.conversationGoal}`);
  if (s.lifecycle && s.lifecycle !== "book") {
    lines.push(`⚠ lifecycle: ${s.lifecycle.toUpperCase()} — the customer is talking about an EXISTING appointment. Do NOT collect details toward a NEW booking unless they explicitly ask to book another one.`);
  }
  lines.push(`- still needed: ${missingFields(s).join(", ")}`);

  const known: string[] = [];
  if (s.serviceId) known.push(`service (${s.service})`);
  if (s.dateISO) known.push(`day (${dayNameHe(s.dateISO)})`);
  if (s.time) known.push(`time (${s.time})`);
  if (known.length > 0) {
    lines.push(`⚠ NEVER ask the customer again for: ${known.join(", ")} — these are ALREADY KNOWN. Re-asking makes you look broken. Build your reply on top of them.`);
  }
  if (s.lastVerdict) {
    const what = s.lastVerdict.time ?? "the requested day";
    lines.push(
      `- note: ${what} was checked earlier in this conversation and was ${s.lastVerdict.category} AT THAT MOMENT. ` +
      `If asked why other times were offered — that is the truthful reason (availability can change between checks; the AVAILABILITY block is the current truth).`
    );
  }
  return lines.join("\n");
}

/**
 * Detects a reply that asks for a field the session ALREADY knows — the exact
 * failure observed live ("איזה שירות תרצה?" when the service is set).
 */
export function detectRedundantQuestion(reply: string, s: BookingSession): "service" | "day" | "time" | null {
  if (s.serviceId && /איזה?\s+(שירות|טיפול)/.test(reply)) return "service";
  if (s.dateISO && /(לאיזה|באיזה|איזה)\s+(יום|תאריך)/.test(reply)) return "day";
  if (s.time && /(לאיזו|באיזו|איזו|לאיזה|באיזה|איזה)\s+שעה/.test(reply)) return "time";
  return null;
}

/**
 * Deterministic contextual reply (FALLBACK ONLY — loop recovery / redundant-question
 * guard): acknowledge, summarize the known context, ask ONE focused question.
 * Gender-neutral phrasing.
 */
export function buildContextReply(
  s: BookingSession, opts: { correction?: boolean; digitHint?: boolean } = {}
): string {
  const known: string[] = [];
  if (s.service) known.push(`שירות: ${s.service}`);
  if (s.dateISO) known.push(`יום ${dayNameHe(s.dateISO)} (${s.dateISO.split("-").reverse().slice(0, 2).join("/")})`);
  else if (s.dateText) known.push(`מועד: ${s.dateText}`);
  if (s.time) known.push(`שעה ${s.time}`);

  const missing = missingFields(s)[0];
  const question =
    missing === "time" && opts.digitHint
      // Repeated-stuck recovery: change strategy — ask for an unambiguous format
      // instead of re-asking the same open question.
      ? "כדי שאקלוט נכון הפעם — אפשר לכתוב לי את השעה בספרות? למשל 17:30."
      : nextStepQuestion(s) ?? "";

  // Neutral apology — never "צודק/ת": the customer's claim may contradict what
  // they actually wrote earlier (live: "אמרתי חמישי" when the log shows שלישי),
  // and affirming a false claim violates accuracy-over-helpfulness.
  const ack = opts.correction ? "סליחה על הבלבול 🙏 " : "";
  const summary = known.length > 0 ? `מה שכבר רשום אצלי: ${known.join(", ")}. ` : "";
  return `${ack}${summary}${question}`;
}

/** Back-compat alias — loop recovery uses the contextual reply. */
export function buildLoopBreaker(s: BookingSession): string {
  return buildContextReply(s);
}

/** The ONE focused question that moves the booking forward (null when none). */
export function nextStepQuestion(s: BookingSession): string | null {
  switch (missingFields(s)[0]) {
    case "service": return "איזה שירות מתאים לך?";
    case "day": return "איזה יום נוח לך?";
    case "time": return "איזו שעה בערך נוחה לך?";
    case "confirmation": return "אפשר לאשר? פשוט לכתוב *כן*.";
    default: return null;
  }
}

/**
 * A model changeRequest with NO supporting change vocabulary in the message is
 * usually noise (live: "לא הבנתי מה" emitted changeRequest=day and silently
 * reopened the settled day). A credible change either matched the deterministic
 * CHANGE_PATTERNS, carries change vocabulary, or arrives WITH a new value
 * (which replaces without needing a clear).
 */
const CHANGE_VOCAB = /אחר|אחרת|שונה|במקום|בעצם|לא רוצה|לא מתאים|שנה|תשנה|החלף|נחליף/;

export function isCredibleChangeRequest(message: string): boolean {
  return CHANGE_VOCAB.test(message);
}

// Reply-text alignment & guards (date echo, confirm CTA, verdict alignment,
// duplicate detection, emoji strip) live in lib/ai/reply-polish.ts.
