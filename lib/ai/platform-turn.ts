// lib/ai/platform-turn.ts
// Server-side only.
//
// PLATFORM-MODE conversation turn (TRANSITION_PLAN.md): the AI converses,
// answers FAQs from facts, and DETECTS appointment intent — it never collects
// scheduling details. The SYSTEM (this module, deterministically) attaches the
// booking / self-service link after the model's reply. One Gemini call per
// turn, same as always; the conversational-scheduling machinery in
// idle-handler.ts is bypassed entirely.

import type { DB } from "@/lib/booking/helpers";
import { upsertConversationState } from "@/lib/booking/helpers";
import { getBusinessAIContext } from "./context";
import {
  getConversationContext, renderUpcomingAppointments, renderCustomerState, didLastReplyFailToSend,
  OFF_TOPIC_REASON,
} from "./conversation";
import { isGeminiCoolingDown, geminiCooldownRemainingMs, isGeminiConfigured, getGeminiHealth, type GeminiHealthState } from "./gemini";
import {
  runReceptionistTurn, FALLBACK, isLowValueAck, type ReceptionistDecision, type ReceptionistTurn,
} from "./brain";
import { stripEmojis, sameOutboundText, claimsBookingCompleted, stripDuplicateCtaWording } from "./reply-polish";
import { resolveRoute, linkKindForRoute, messageOperation, type Route } from "./routing";
import { logAIEvent } from "./events";
import { buildBookingLink, buildAppointmentLink } from "@/lib/config";
import { buildMyAppointmentsLink } from "@/lib/booking/appointment-token";
import { listUpcomingByCustomer } from "@/lib/booking/appointments";
import { beginTurn, isCurrentTurn } from "./turn-registry";
import { buildFacts, type BusinessFacts } from "./facts";
import {
  planContinuityMenu, resolveMenuNavigation, resolveMenuPayload, readMenuState,
  buildInteractiveForNav, buildMainMenu, buildInteractiveMainMenu, ctaBody, MENU_REMINDER,
  NO_APPOINTMENT_PROMPT, noAppointmentCtaBody, detectInfoTopic, type MenuState, type MenuNav,
} from "./continuity-menu";
import { capInteractiveBody, type WhatsAppInteractive } from "@/lib/whatsapp";

export type PlatformLink = "booking" | "manage" | null;

export interface PlatformTurnOutcome {
  replyText: string;
  decision: ReceptionistDecision;
  linkAttached: PlatformLink;
  /** Quiet mode: the router should NOT send a WhatsApp reply this turn (inbound is
   *  already saved; state is persisted). Used to stop replying to endless nonsense. */
  suppressReply?: boolean;
  /** CLICKABLE menu message for this turn (deterministic menu mode / navigation). When set,
   *  the router sends it as an interactive WhatsApp message; `replyText` is the text fallback. */
  interactive?: WhatsAppInteractive;
  /** AI-FACING HISTORY HYGIENE: a durable `reason` token the router persists on this turn's outbound so a
   *  later turn can drop it from Gemini's history. Set to OFF_TOPIC_REASON on a visible scope-deflection so
   *  the preceding off-topic user message does not color the next real reply. Omitted ⇒ use decision.branch. */
  historyReason?: string;
}

// ── OPERATING STATE — the SINGLE source of truth for AI-vs-deterministic routing (Phase 2) ──────
// One pure resolver names the turn's operating state; the menu gate, the mode-resolution log, and the
// legacy helpers all DERIVE from it, so the precedence rules live in exactly one place and can't drift.
//
//   AI LANE (Gemini may run):                 healthy_ai, degraded_ai
//   DETERMINISTIC LANE (no Gemini, menu):     provider_outage, owner_ai_disabled, no_key
//
// The menu is authoritative ONLY in the deterministic lane — when AI genuinely cannot operate (owner
// DISABLED it, no API key, or a SUSTAINED outage/cooldown). `degraded_ai` (one recent overload strike,
// not cooling) stays in the AI LANE: this turn still ATTEMPTS Gemini; the soft "resend?" only fires if
// THIS call also fails. So degraded_ai is an observability/Phase-3 hook and does NOT change routing
// today. Decided from CURRENT-turn signals, so re-enabling AI / a provider recovery flips the lane on
// the next turn — a stale menu cursor / old button payload is therefore never trusted in the AI lane.
export type OperatingState =
  | "healthy_ai" | "degraded_ai" | "provider_outage" | "owner_ai_disabled" | "no_key";

export interface OperatingStateInputs {
  aiEnabled: boolean;
  geminiConfigured: boolean;
  providerCoolingDown: boolean;
  /** getGeminiHealth().state — ONLY distinguishes degraded_ai from healthy_ai; irrelevant to the lane. */
  providerHealth?: GeminiHealthState;
}
/** THE resolver. Precedence: owner intent > config > sustained outage > recent blip > healthy. */
export function resolveOperatingState(i: OperatingStateInputs): OperatingState {
  if (!i.aiEnabled) return "owner_ai_disabled";        // owner intent wins over provider health
  if (!i.geminiConfigured) return "no_key";            // no API key → AI cannot operate
  if (i.providerCoolingDown) return "provider_outage"; // sustained outage (cooldown active)
  if (i.providerHealth === "transient") return "degraded_ai"; // recent blip — still AI lane
  return "healthy_ai";
}
/** True for the DETERMINISTIC lane (no Gemini, menu-anchored). The AI lane (healthy_ai/degraded_ai) is
 *  false. This is THE deterministic decision; every downstream guard reads the boolean derived from it. */
export function isDeterministicState(state: OperatingState): boolean {
  return state === "owner_ai_disabled" || state === "no_key" || state === "provider_outage";
}

/** Back-compat menu gate — now DERIVED from the resolver (no duplicate precedence). Byte-identical to
 *  the previous implementation for every input (degraded_ai/healthy_ai both → false = AI mode). */
export function isDeterministicMenuActive(opts: {
  aiEnabled: boolean; geminiConfigured: boolean; providerCoolingDown: boolean;
}): boolean {
  return isDeterministicState(resolveOperatingState(opts));
}

/** Back-compat human-readable log reason — derived from the resolver, keeping the EXACT existing strings
 *  (incl. "no_api_key") so log consumers / evals are unaffected. */
export type OperatingModeReason = "owner_ai_disabled" | "no_api_key" | "provider_outage" | "healthy_ai";
export function operatingModeReason(opts: {
  aiEnabled: boolean; geminiConfigured: boolean; providerCoolingDown: boolean;
}): OperatingModeReason {
  const s = resolveOperatingState(opts); // providerHealth omitted → never "degraded_ai"
  return s === "no_key" ? "no_api_key" : s === "degraded_ai" ? "healthy_ai" : s;
}

// WhatsApp renders *…* as bold and auto-links a bare URL on its own line. A bold
// label + clean URL reads as an intentional, premium CTA (no markdown links in
// WhatsApp). Emojis are intentionally omitted here so the CTA looks the same
// regardless of the owner's emoji setting and never trips the chokepoint.
const BOOK_LINE = "*לקביעת תור — מהיר ופשוט:*";
const MANAGE_LINE = "*לניהול התור (צפייה · שינוי · ביטול):*";
const MY_APPTS_LINE = "*כל התורים שלך — לבחירה וניהול:*";
// Honest reply for an explicit manage/list ask when there are NO upcoming appointments: says there are
// no FUTURE appointments (never "none at all" — past ones may exist in history) and offers booking as a
// clearly-BOOKING action, so the wording matches the booking link that gets attached.
const NO_UPCOMING_MANAGE = "אין לך תורים עתידיים לניהול כרגע 🙂 אפשר לקבוע תור חדש דרך הקישור.";
// Wording that CLAIMS the customer can manage / see / change their appointments via the attached link.
// Used ONLY to detect a contradiction with a BOOKING link — general/business-agnostic, not a sentence patch.
const MANAGE_CLAIM_RE = /(?:ניהול|לניהול|לנהל)\s+(?:את\s+)?ה?תור|לראות\s+(?:את\s+)?ה?תור|ה?תור(?:ים)?\s+שלך|(?:שינוי|לשנות|ביטול|לבטל|להזיז)\s+(?:את\s+)?ה?תור|manage\s+appointment|appointment\s+management/i;

// ── Degraded-mode (Gemini overload/error) — PLATFORM-SAFE lines ─────────────────
// The fallback is part of the product surface: even when the model is down it must obey
// platform architecture — NEVER ask for service/day/time in chat, never promise to "check
// availability". For booking/manage intent it routes to the link; otherwise it stays a
// short, useful, safe acknowledgement.
const DEGRADED_NOTICE = "יש לי רגע עומס קטן במערכת 🙏";
// Brain branches that mean "no usable AI answer" → route through the deterministic continuity
// core. Deliberate guard replies (abuse/noise) and grounding deflections are intentionally NOT here.
const CONTINUITY_BRANCHES = new Set(["ai_disabled", "not_configured", "api_overloaded", "api_error", "parse_error"]);

// ── DETERMINISTIC RECEPTIONIST — reason-specific wording ─────────────────────────
// The SAME deterministic core (classifyDegradedIntent + booking/manage links) serves every
// no-AI state; only the WORDING differs by reason. ai_disabled is the owner's deliberate choice
// → neutral, never mentions "overload"/limited AI. Provider states explain a momentary limit.
// Provider health is graded, not binary: a SINGLE transient 503 must NOT dump the customer into
// full deterministic menu mode (that would destroy the AI experience over one blip). Only a
// SUSTAINED outage (cooldown active) or an owner-disabled/internal-error state does that.
export type DegradedReason = "ai_disabled" | "provider_transient" | "provider_outage" | "ai_error";
const CONTINUITY_MENU_BODY =
  "אפשר לקבוע תור, לנהל תור קיים (שינוי או ביטול), או לשאול על שעות, מחירים, כתובת וחניה.";
/** The customer-facing line for a deterministic-continuity turn, by reason + resolved kind. */
export function continuityText(reason: DegradedReason, kind: "booking" | "manage" | "menu", url?: string): string {
  if (reason === "ai_disabled") {
    if (kind === "booking") return `בשמחה! לקביעת תור:\n${url}`;
    if (kind === "manage") return `לניהול התור — צפייה, שינוי או ביטול:\n${url}`;
    return `אני כאן 🙂 ${CONTINUITY_MENU_BODY} מה נוח לך?`;
  }
  if (reason === "provider_transient") {
    // ONE brief glitch — keep the AI experience alive: acknowledge + invite a resend (so the need
    // is preserved, NOT pretended-answered) rather than dropping into the full FAQ menu. An explicit
    // booking/manage op still routes to its link (no point asking the customer to resend that).
    if (kind === "booking") return `הייתה לי תקלה רגעית 🙏 לקביעת תור אפשר ישירות בקישור:\n${url}`;
    if (kind === "manage") return `הייתה לי תקלה רגעית 🙏 לניהול התור — צפייה, שינוי או ביטול — בקישור:\n${url}`;
    return "הייתה לי תקלה רגעית 🙏 אפשר לשלוח שוב את ההודעה? ואם זה לגבי תור — אפשר לקבוע או לנהל גם דרך הקישור.";
  }
  // provider_outage (sustained) / ai_error — explain a momentary limit (never "ask me service/day/
  // time"); ai_error is a softer "limited mode" rather than an overload claim.
  const notice = reason === "ai_error" ? "אני במצב מצומצם כרגע 🙏" : DEGRADED_NOTICE;
  if (kind === "booking") return `${notice} אפשר בינתיים לקבוע ישירות בקישור:\n${url}`;
  if (kind === "manage") return `${notice} לניהול התור — צפייה, שינוי או ביטול — אפשר ישירות בקישור:\n${url}`;
  return `${notice} נסו שוב עוד רגע. בינתיים ${CONTINUITY_MENU_BODY}`;
}
// SHORT visible micro-ack for a REPEAT provider-transient blip inside the notice-gap window — replaces
// the old SILENT `transient_quiet`, so a good-faith customer message is NEVER met with silence. Distinct
// from (and shorter than) the soft "resend?" notice, carries no link, gender-neutral ("אפשר לשלוח", not a
// masculine imperative). Emoji is stripped at the emojiNone chokepoint like every other continuity line.
export const TRANSIENT_MICRO_ACK =
  "עדיין יש עומס קטן אצלי 🙏 אפשר לשלוח שוב עוד רגע.";

export interface TransientPlan {
  kind: "transient_soft" | "transient_micro";
  text: string;
  suppress: boolean;      // always false — a provider-transient blip is never silent for a normal message
  persistNotice: boolean; // only the fuller soft notice stamps the rate-limit clock
}
/**
 * Provider-transient (ONE 503 blip, still AI-lane) reply plan for a GENERIC/CONTEXTUAL message — the
 * branch that previously went SILENT (`transient_quiet`). First hit (notice allowed) → the fuller soft
 * "resend?" line, which stamps the 90s notice clock. A REPEAT inside that window → a SHORT visible
 * micro-ack: never the long line again, and NEVER silence. Booking / manage / recovery / accountability
 * are resolved BEFORE this branch — this covers only the "menu" (FAQ / contextual / unknown) case and
 * never attaches a link. Pure + exported so the visible-not-silent contract is unit-testable.
 */
export function planTransientContinuity(noticeAllowed: boolean): TransientPlan {
  return noticeAllowed
    ? { kind: "transient_soft", text: continuityText("provider_transient", "menu"), suppress: false, persistNotice: true }
    : { kind: "transient_micro", text: TRANSIENT_MICRO_ACK, suppress: false, persistNotice: false };
}

const STILL_DEGRADED_ACK =
  "עדיין יש קצת עומס במערכת 🙏 אפשר להמשיך — אם מדובר בתור, הכי מהיר דרך הקישור. נסו שוב עוד רגע ואשמח לעזור.";
const RECOVERY_ACK =
  "כן, נראה שחזרתי 🙂 תודה על הסבלנות! אפשר להמשיך — לקבוע תור, לנהל תור קיים, או לשאול כל דבר על העסק.";
// A bare "כן"/"סבבה" with NO resolvable context (no pending offer, our last reply neither
// asked nor offered anything) — give ONE useful clarification instead of routing a cold action.
const COLD_YES_CLARIFY =
  "לא בטוח/ה למה התכוונת 🙂 רוצה לקבוע תור, לנהל תור קיים, או לשאול משהו על העסק?";
// Accountability repair: the user references our earlier overload/system message. ACKNOWLEDGE it
// (never deny, never blame the user), say it was momentary, bridge back to the task.
const ACCOUNTABILITY_REPAIR =
  "צודק, הייתה אצלי הודעת עומס רגעית קודם 🙏 נראה שעכשיו חזרתי — בוא נמשיך, במה אוכל לעזור?";

// ── REPEAT-ANSWER TONE GUARD ─────────────────────────────────────────────────────
// Even when the customer asks something already answered, the receptionist must NOT sound
// annoyed/corrective. Strips a scolding lead-in ("כבר אמרתי לך ש…", "כמו שאמרתי", "שוב…") while
// KEEPING the actual answer + any vocative ("קובי, …"). General class, not a per-phrase patch.
const SCOLDING_RE =
  /כבר\s+אמרתי\s+לך|אמרתי\s+לך\s+כבר|כבר\s+אמרתי|הרי\s+אמרתי(?:\s+לך)?|כמו\s+שאמרתי|כפי\s+שאמרתי|שוב\s+אני\s+אומר(?:ת)?/;
export function mentionsRepeatScolding(reply: string): boolean {
  return SCOLDING_RE.test(reply ?? "");
}
/** Softens a corrective "I already told you…" lead-in to plain customer-service tone, keeping
 *  the answer. No-op when no scolding is present (good replies untouched). */
export function softenRepeatTone(reply: string): { text: string; softened: boolean } {
  const r = reply ?? "";
  if (!SCOLDING_RE.test(r)) return { text: r, softened: false };
  const out = r
    .replace(/([,!.]\s*|^|\s)(כבר\s+אמרתי\s+לך|אמרתי\s+לך\s+כבר|כבר\s+אמרתי|הרי\s+אמרתי(?:\s+לך)?|כמו\s+שאמרתי|כפי\s+שאמרתי|שוב\s+אני\s+אומר(?:ת)?)\s*ש?/g, "$1")
    .replace(/(^|[\n.!?]\s*)שוב[,!.\s]+/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/^[\s,–-]+/, "")
    .trim();
  if (out.replace(/\s/g, "").length < 2) return { text: r, softened: false }; // never blank the reply
  return { text: out, softened: out !== r };
}

/**
 * TEST-ONLY injection seam (exercised by reliability-eval §42 — the runtime-lane harness).
 * Lets a PURE eval drive the REAL lane ordering + state transitions of `runPlatformTurn` with no DB,
 * no network and no Gemini, by replacing the THREE external boundaries: the business-context load, the
 * per-turn DB snapshot, and the model call. PRODUCTION NEVER passes this — every real call site omits
 * the arg, so each `testDeps?.x ?? x` resolves to the real import and the live path is byte-identical.
 * The types are derived from the real functions (`typeof …`) so an injected fake can never drift from
 * the production signature.
 */
export interface PlatformTurnTestDeps {
  loadContext?: typeof getBusinessAIContext;
  loadTurnInputs?: (
    db: DB, businessId: string, customerId: string, timezone: string,
  ) => Promise<[Awaited<ReturnType<typeof getConversationContext>>, string, string, boolean]>;
  runModel?: typeof runReceptionistTurn;
}

/**
 * Runs one platform-mode turn. Persists nothing except a state reset for
 * legacy non-idle states; the router sends `replyText`.
 */
export async function runPlatformTurn(
  db: DB,
  businessId: string,
  customerId: string,
  customerPhone: string,
  messageText: string,
  rawState: string,
  priorContext: Record<string, unknown> = {},
  checkSuperseded?: () => Promise<boolean>,
  /** When the inbound was a TAP on a clickable menu option, this is its stable payload id
   *  (e.g. "f:hours"). Resolved deterministically BEFORE any AI — a tap always acts. */
  interactivePayloadId?: string,
  /** TEST-ONLY (reliability-eval §42). Omitted by every production call site → live path unchanged. */
  testDeps?: PlatformTurnTestDeps,
): Promise<PlatformTurnOutcome> {
  // Low-signal + greeting escalation counters — persisted in the (always-idle) platform state.
  const prevLowSignal = readLowSignalCount(priorContext);
  const prevGreeting = readGreetingCount(priorContext);
  // Short-term pending offer (still within TTL) — lets a LATER bare "כן" resolve to the
  // booking/manage action we offered earlier, even across intervening turns / a time gap.
  const now = Date.now();
  const prevPending = readPendingOffer(priorContext, now);

  // ── PER-CONVERSATION SINGLE-FLIGHT (turn ownership). Claim this conversation; aborting any
  //    OLDER in-flight turn for the same customer (its Gemini call is cancelled via turn.signal —
  //    no completion, no retry, no overload strike). `superseded()` is the authoritative,
  //    race-free supersede check: this turn is obsolete if a newer turn has taken over (in-process)
  //    OR the DB shows a newer inbound (cross-check). Replaces the bare DB poll everywhere.
  const turn = beginTurn(businessId, customerId);
  const superseded = async (): Promise<boolean> =>
    !isCurrentTurn(turn) || (checkSuperseded ? await checkSuperseded() : false);

  // Persists platform state (always idle), merging priorContext (Risk F) and skipping
  // the write when this turn is superseded (Risk E). The optional `pending` arg sets/clears
  // the pendingOffer (undefined ⇒ carry forward). See persistPlatformState for the contract.
  const persist = (low: number, greet: number, pending?: PendingOffer | null, lastDegradedAt?: number, failedNeed?: PendingFailedNeed | null, menu?: MenuState | null): Promise<boolean> =>
    persistPlatformState(db, businessId, customerId, low, greet, priorContext, superseded, pending, lastDegradedAt, failedNeed, menu);
  // A message that hit a TRANSIENT 503 last turn and was never answered — recovered this turn.
  const prevFailedNeed = readPendingFailedNeed(priorContext, now);

  // Legacy conversational-booking states cannot continue in platform mode —
  // reset once so the customer starts clean after the flip (but carry the
  // counters forward so repeated gibberish across a reset still escalates).
  // Deliberately does NOT merge priorContext — that's where stale legacy booking
  // fields (services_list, …) live, and the reset's whole job is to drop them.
  if (rawState !== "idle") {
    console.log(`[platform-turn] resetting legacy state "${rawState}" → idle`);
    await upsertConversationState(db, businessId, customerId, "idle", {
      consecutiveLowSignalTurns: prevLowSignal, consecutiveGreetingTurns: prevGreeting,
    });
  }

  let ctx;
  try {
    ctx = await (testDeps?.loadContext ?? getBusinessAIContext)(businessId);
  } catch (err) {
    console.error("[platform-turn] failed to load business context:", err instanceof Error ? err.message : String(err));
    const decision = errorDecision("context_load_error");
    await safeLog(businessId, customerId, decision);
    return { replyText: FALLBACK.error, decision, linkAttached: null };
  }

  const timezone = ctx.business.timezone || "Asia/Jerusalem";
  const [memory, upcomingBlock, customerBlock, lastSendFailed] = testDeps?.loadTurnInputs
    ? await testDeps.loadTurnInputs(db, businessId, customerId, timezone)
    : await Promise.all([
        getConversationContext(db, businessId, customerId),
        renderUpcomingAppointments(db, businessId, customerId, timezone, true),
        renderCustomerState(db, businessId, customerId, timezone),
        didLastReplyFailToSend(db, businessId, customerId),
      ]);
  const lastAssistant = lastAssistantLine(memory.transcript);
  // Were we recently degraded/overloaded? Scans the last few assistant lines (robust to the
  // degraded notice being followed by superseded/recovered turns). Drives recovery follow-ups
  // ("הסתדר?"/"זמין?") and accountability repair ("כי כתבת שיש עומס").
  const lastReplyWasDegraded = recentlyDegraded(memory.transcript);
  const bookingBlock = [customerBlock, upcomingBlock].filter(Boolean).join("\n\n");
  // A booking link was sent earlier iff our transcript already carries a URL — only
  // we ever send links. Lets the reply legitimately reference "the link I sent".
  const previousBookingLinkSent = /https?:\/\/\S+/.test(memory.transcript);

  // ── DETERMINISTIC MENU NAVIGATION — gated by the CURRENT operating mode (mode-boundary fix).
  //    The clickable menu is authoritative ONLY in a deterministic operating state (owner disabled
  //    AI, no API key, or sustained provider outage). In AI mode (AI enabled + provider healthy) the
  //    interceptor is SKIPPED entirely: a stale menu cursor or an old button payload ("m:book",
  //    "m:main") must NOT pull the customer back into menu mode — the visible text flows to the
  //    model / normal platform routing, and the cursor is cleared by the healthy persist below.
  //    Decided from THIS turn's facts (ctx.aiSettings.ai_enabled + live provider health), so toggling
  //    AI back on or a provider recovery flips the gate on the very next turn — no stale state trusted.
  // ── OPERATING STATE — resolved ONCE here, near the top of the turn (Phase 2). Everything below
  //    (the menu interceptor, the emoji/quiet guards, the cooldown block, the post-Gemini dispatch)
  //    reads `deterministicMenu`, which is DERIVED from this single named state — no second copy of
  //    the precedence rules. `providerCoolingDown` keeps using isGeminiCoolingDown() so the gate is
  //    byte-identical to before; providerHealth only adds the degraded_ai observability distinction.
  const modeInputs = {
    aiEnabled: ctx.aiSettings?.ai_enabled !== false,
    geminiConfigured: isGeminiConfigured(),
    providerCoolingDown: isGeminiCoolingDown(),
  };
  const gh = getGeminiHealth();
  const operatingState = resolveOperatingState({ ...modeInputs, providerHealth: gh.state });
  const deterministicMenu = isDeterministicState(operatingState); // THE deterministic decision
  // Mode-resolution log — emitted BEFORE any branch that can suppress, call Gemini, or route to AI, so
  // "owner AI disabled" can never be mistaken for "healthy AI". No secrets: a business UUID + booleans +
  // provider-health counters (strikes/cooldown). If aiEnabled=true while the owner believes AI is off,
  // the toggle wasn't persisted as ai_enabled=false.
  console.log(
    `[platform-turn] mode-resolution business=${businessId}` +
    ` operatingState=${operatingState} modeReason=${operatingModeReason(modeInputs)} deterministicMenu=${deterministicMenu}` +
    ` aiEnabled=${modeInputs.aiEnabled} geminiConfigured=${modeInputs.geminiConfigured}` +
    ` providerCoolingDown=${modeInputs.providerCoolingDown} providerHealth=${gh.state}` +
    ` strikes=${gh.strikes} cooldownMs=${gh.cooldownRemainingMs}` +
    ` aiSettingsRow=${ctx.aiSettings ? "present" : "missing(default_enabled)"}`
  );
  if (deterministicMenu) {
    const facts = buildFacts(ctx);
    const menuState = readMenuState(priorContext, now);
    // A TAPPED option (payload id) acts; otherwise navigation on an explicit menu request or an
    // active cursor. Free text returns null → falls through to deterministic handling (runContinuity).
    const nav: MenuNav | null =
      (interactivePayloadId ? resolveMenuPayload(interactivePayloadId, facts) : null)
      ?? resolveMenuNavigation(menuState?.node ?? null, messageText, facts, { activeMenu: !!menuState });
    if (nav && !(await superseded())) {
      return runMenuNavigation(nav, {
        db, businessId, customerId, customerPhone, slug: ctx.business.slug, facts,
        emojiNone: ctx.aiSettings?.emoji_usage === "none",
        prevLowSignal, prevGreeting, memLines: memory.turnsUsed, persist,
        interactivePayloadId,
      });
    }
  } else if (interactivePayloadId || readMenuState(priorContext, now)) {
    // AI mode but a STALE tap/cursor arrived (menu was shown before AI was re-enabled / before the
    // provider recovered) — ignore it as stale and let the AI/platform path own the turn.
    console.log(`[platform-turn] AI mode active — ignoring STALE menu payload/cursor (interactivePayloadId=${interactivePayloadId ?? "-"}); routing to AI`);
  }

  // ── EMOJI-ONLY messages (e.g. "🙏🏻", "😊😊"): contentless but legitimate. NEVER
  //    call Gemini, and route them through the SAME low-signal counter + escalation
  //    + quiet mode as text gibberish (fixes the per-emoji fallback spam). Mixed
  //    text+emoji ("תודה 😊") is NOT emoji-only and flows normally. Detected
  //    cheaply and generally (no blacklist): has a pictographic char and no letters/
  //    digits. Gender on the boundary reply is fixed at the outbound chokepoint.
  //    SKIPPED in full deterministic mode — there the turn is menu-anchored (the low-signal
  //    "אני כאן" reply is an AI-mode hybrid); the deterministic handler below owns it instead.
  if (isEmojiOnly(messageText) && !deterministicMenu) {
    const newCount = prevLowSignal + 1;
    const action = lowSignalActionFor(newCount);
    let replyText = LOW_SIGNAL_SHORT;       // tiers 1-2: one short clarification
    let suppressReply = false;
    if (action === "boundary") replyText = LOW_SIGNAL_BOUNDARY;
    else if (action === "quiet_mode") {
      const plan = quietModePlan(newCount);
      suppressReply = plan.suppressReply;
      replyText = plan.suppressReply ? "" : LOW_SIGNAL_QUIET_REMINDER;
    }
    await persist(newCount, 0); // emoji breaks any greeting run
    const decision = errorDecision("low_signal_emoji", true);
    await safeLog(businessId, customerId, decision);
    console.log(
      `[platform-turn] ai_called=false pre_gemini_guard=true pre_gemini_action=skip_gemini_emoji` +
      ` gemini_skipped_reason=emoji_only low_signal=true low_signal_kind=emoji` +
      ` low_signal_count_before=${prevLowSignal} low_signal_count_after=${newCount}` +
      ` greeting_count_before=${prevGreeting} greeting_count_after=0` +
      ` low_signal_action=${action} reply_suppressed=${suppressReply} link=-`
    );
    return { replyText, decision, linkAttached: null, suppressReply };
  }

  // ── PROMPT-INJECTION SAFETY LANE (deterministic, BEFORE any model call) ─────────
  //    A confident injection / override / "reveal your instructions" attempt gets a short SCOPE refusal —
  //    no Gemini, no internal disclosure, no routing/booking/manage effect. Repeated attempts DE-ESCALATE via
  //    the shared low-signal counter (turn 1 → refusal, then quiet), so an attacker can't burn Gemini calls.
  //    The output disclosure fence (reply-polish) stays as defense-in-depth. SKIPPED in full deterministic
  //    mode — the menu/continuity core owns the turn and never calls Gemini anyway.
  if (!deterministicMenu && looksLikeInjection(messageText)) {
    const newCount = prevLowSignal + 1;
    const plan = injectionPlan(newCount);
    await persist(newCount, 0); // injection breaks any greeting run; shares the low-signal counter (de-escalation)
    const decision = errorDecision("injection_refused", true);
    await safeLog(businessId, customerId, decision);
    console.log(
      `[platform-turn] ai_called=false pre_gemini_guard=true pre_gemini_action=refuse_injection` +
      ` gemini_skipped_reason=prompt_injection low_signal=true low_signal_kind=injection` +
      ` low_signal_count_before=${prevLowSignal} low_signal_count_after=${newCount}` +
      ` greeting_count_before=${prevGreeting} greeting_count_after=0` +
      ` low_signal_action=${newCount <= 1 ? "refuse" : "quiet_mode"} reply_suppressed=${plan.suppressReply} link=-`
    );
    return { replyText: plan.replyText, decision, linkAttached: null, suppressReply: plan.suppressReply };
  }

  // ── PRE-GEMINI QUIET-MODE GUARD (cost control, BEFORE any model call) ──────────
  // Active only once the boundary has been set (3+ consecutive low-signal turns).
  // Cheap, local classification decides — Gemini is never paid for here:
  //   • OBVIOUS gibberish/keyboard-smash → no Gemini, mostly silent (sparse reminder)
  //   • a normal greeting / meta ("היי", "מה קורה", "יש תשובה?") → NOT spam: a short
  //     friendly RESET reply (no Gemini) and the counter resets — never silently dropped
  //   • anything else (a real-looking message) → fall through to Gemini
  //   • SKIPPED entirely in full deterministic mode (owner-disabled / outage / no-key): there
  //     the low-signal/greeting-reset replies are AI-mode hybrids — every turn is menu-anchored.
  const activeServiceNames = ctx.services.filter((s) => s.active).map((s) => s.name);
  const preGemini = deterministicMenu ? "proceed_to_gemini" : preGeminiAction(prevLowSignal, prevGreeting, messageText, activeServiceNames);
  if (preGemini !== "proceed_to_gemini") {
    if (preGemini === "skip_gemini_gibberish") {
      const newCount = prevLowSignal + 1;
      const plan = machineNoisePlan(newCount); // turn 1 → one short clarify, turn 2+ → quiet (faster than good-faith)
      // Defense-in-depth: machine-noise is never good-faith (looksLikeNoise excludes "?"/words), but keep the
      // good-faith guard so a borderline detection never silences a real confused user.
      const suppress = plan.suppressReply && !isGoodFaithLowSignal(latestFragment(messageText));
      await persist(newCount, 0); // gibberish breaks any greeting run
      const decision = errorDecision("low_signal_machine_noise", true);
      await safeLog(businessId, customerId, decision);
      console.log(
        `[platform-turn] ai_called=false pre_gemini_guard=true pre_gemini_action=skip_gemini_gibberish` +
        ` gemini_skipped_reason=machine_noise low_signal=true low_signal_kind=gibberish` +
        ` low_signal_count_before=${prevLowSignal} low_signal_count_after=${newCount}` +
        ` greeting_count_before=${prevGreeting} greeting_count_after=0` +
        ` low_signal_action=${newCount <= 1 ? "clarify" : "quiet_mode"} reply_suppressed=${suppress} link=-`
      );
      return {
        replyText: suppress ? "" : (plan.replyText || LOW_SIGNAL_QUIET_REMINDER),
        decision, linkAttached: null, suppressReply: suppress,
      };
    }
    if (preGemini === "cheap_reset_reply") {
      // ANTI-ABUSE: a presence/greeting ping while DEEP in a low-value streak must NOT fully reset the abuse
      // counter (else "junk … אתה פה? … junk …" loops forever, burning nothing but never de-escalating). Deep
      // streak → ONE visible boundary and CARRY the counter (don't zero it); a real business message still
      // recovers (it resets via the productive path below). Shallow streak → the normal friendly reset, so a
      // genuine slip ("oops, אתה פה?") recovers cleanly and is never trapped.
      if (prevLowSignal >= LOW_VALUE_DEEP_AT) {
        await persist(prevLowSignal, 0); // carry low-signal (no reset), break the greeting run
        const decision = errorDecision("presence_boundary", true);
        await safeLog(businessId, customerId, decision);
        console.log(
          `[platform-turn] ai_called=false pre_gemini_guard=true pre_gemini_action=presence_boundary` +
          ` gemini_skipped_reason=deep_streak_presence low_signal=true low_signal_kind=presence route=NONE link=-` +
          ` low_signal_count_before=${prevLowSignal} low_signal_count_after=${prevLowSignal} reply_suppressed=false`
        );
        return { replyText: LOW_VALUE_BOUNDARY, decision, linkAttached: null };
      }
      // Clear human greeting/meta after low-signal history (B), as the recovery tail
      // of a noise burst (D), or a repeated-greeting loop (C): answer cheaply WITHOUT
      // Gemini and DE-escalate low-signal to 0. The reply DE-SPAMS as the greeting loop
      // deepens — full friendly reset first, then mostly suppressed / a short sparse
      // reminder (BUG-009) — never the identical full line every turn, never cold first.
      const newGreeting = prevGreeting + 1;
      await persist(0, newGreeting);
      const plan = greetingResetPlan(newGreeting);
      const decision = errorDecision("low_signal_reset", true);
      await safeLog(businessId, customerId, decision);
      console.log(
        `[platform-turn] ai_called=false pre_gemini_guard=true pre_gemini_action=cheap_reset_reply` +
        ` gemini_skipped_reason=low_signal_greeting_reset low_signal=false low_signal_kind=meta` +
        ` low_signal_count_before=${prevLowSignal} low_signal_count_after=0` +
        ` greeting_count_before=${prevGreeting} greeting_count_after=${newGreeting} reply_suppressed=${plan.suppressReply} link=-`
      );
      return { replyText: plan.reply, decision, linkAttached: null, suppressReply: plan.suppressReply };
    }
    // else: real-looking message → fall through to Gemini (recovery happens there).
  }

  // ── DETERMINISTIC RECEPTIONIST CORE — shared by EVERY no-AI state (owner-disabled AI, provider
  //    503, cooldown, internal AI error). One classifier + one link policy; only the WORDING varies
  //    by `reason`. accountability/recovery apply only to provider states (system frame); booking/
  //    manage attach the right link on an EXPLICIT operation; FAQ/mixed/unknown → a rate-limited
  //    continuity menu (one per window, then quiet) so a provider incident can't spam — while
  //    booking/manage/recovery always answer. Never attaches a link off a loose signal.
  const runContinuity = async (reason: DegradedReason, decision: ReceptionistDecision): Promise<PlatformTurnOutcome> => {
    const emojiNone = ctx.aiSettings?.emoji_usage === "none";
    const degIntent = classifyDegradedIntent(messageText);
    const isProvider = reason !== "ai_disabled";
    const facts = buildFacts(ctx);
    // Is the customer already INSIDE the deterministic menu (a live cursor)? Distinguishes a fresh
    // ENTRY into deterministic mode (anchor to the main menu) from mid-navigation (Axis C).
    const hasCursor = !!readMenuState(priorContext, now);
    let text = ""; let link: PlatformLink = null; let suppress = false; let persistNotice = false;
    let menuKind = "-";
    let interactive: WhatsAppInteractive | undefined;
    // Menu cursor to persist (so a follow-up numeric/alias resolves): undefined ⇒ carry, object ⇒ set.
    let menuNode: MenuState | null | undefined = undefined;
    if (isProvider && degIntent === "accountability") text = ACCOUNTABILITY_REPAIR;
    else if (isProvider && degIntent === "recovery") text = STILL_DEGRADED_ACK;
    else if (degIntent === "booking") {
      const url = buildBookingLink(ctx.business.slug, customerPhone);
      text = continuityText(reason, "booking", url); link = "booking"; logPlatformLink("booking", url);
      interactive = { kind: "cta_url", body: ctaBody("book"), buttonText: "לחץ כאן", url };
      menuNode = { node: "main", at: now };
    } else if (degIntent === "manage") {
      const upcoming = await listUpcomingByCustomer(db, businessId, customerId, 5);
      const m = manageLinkFor(upcoming, ctx.business.slug, customerPhone, customerId);
      const mo = buildManageOutcome(m, reason); // 0 upcoming → "no active appointment" + offer to book new
      text = mo.text; interactive = mo.interactive; link = mo.link; logPlatformLink(m.kind, m.url);
      menuNode = { node: "main", at: now };
    } else if (reason === "provider_transient") {
      // ONE brief blip — keep the AI experience and PRESERVE the original need below (storeFailedNeed)
      // so the next healthy turn recovers it. NEVER the full deterministic FAQ menu over a single 503.
      // First hit → the fuller soft "resend?" (stamps the 90s clock); a REPEAT inside that window → a
      // SHORT VISIBLE micro-ack (transient_micro) — never silence for a good-faith message (this replaces
      // the old transient_quiet suppression that made the customer feel ignored → "הלו?").
      const plan = planTransientContinuity(degradedNoticeAllowed(priorContext, now));
      text = plan.text; menuKind = plan.kind; suppress = plan.suppress; persistNotice = plan.persistNotice;
    } else if (isProvider && !hasCursor) {
      // AXIS C — OUTAGE / severe-failure ENTRY (no active cursor): the customer was talking to the AI
      // and it became unavailable. Anchor to the MAIN MENU, VISIBLY — bypass the vague rate-limit so
      // the FIRST outage turn is never silence (C1), and show the MAIN menu (book/manage/FAQ), not the
      // FAQ submenu (C2). Stamp the rate-limit clock + set the cursor so the NEXT vague turn stays quiet
      // (no spam). Explicit booking/manage already routed above; ai_disabled (not isProvider) keeps its
      // direct-answer behavior. Subsequent turns have a cursor → normal navigation / rate-limiting.
      text = buildMainMenu(facts, reason);
      interactive = buildInteractiveMainMenu(facts, reason);
      menuNode = { node: "main", at: now };
      persistNotice = true;
      menuKind = "outage_entry";
    } else {
      // FULL DETERMINISTIC MODE (owner-disabled AI / sustained outage mid-navigation / no-key) — every
      // free-text turn is MENU-ANCHORED. A RECOGNIZED business-info topic (e.g. "חניה", "שעות") is
      // answered directly from facts/KB; EVERYTHING ELSE anchors to the MAIN menu — the FAQ submenu is
      // reached ONLY by an explicit FAQ selection (tap "מידע ושאלות" / type "שאלות נפוצות"), never from
      // vague/unrecognized free text (the live "מה אפשר לשאול?" → FAQ-submenu bug). Repeated vague text
      // is rate-limited to a SHORT reminder — never the full menu spam, and NEVER silent (which felt broken).
      const plan = planContinuityMenu(reason, messageText, facts);
      menuKind = plan.kind;
      if (plan.kind === "answer") {
        text = plan.text; interactive = plan.interactive; menuNode = { node: "faq", at: now };
      } else if (degradedNoticeAllowed(priorContext, now)) {
        text = buildMainMenu(facts, reason); interactive = buildInteractiveMainMenu(facts, reason);
        persistNotice = true; menuNode = { node: "main", at: now }; menuKind = "main_menu";
      } else {
        text = MENU_REMINDER; menuNode = { node: "main", at: now }; menuKind = "menu_reminder"; // short anchor, never silent
      }
    }
    if (!suppress && emojiNone) text = stripEmojis(text);
    // A TRANSIENT 503 on a FAQ/unclear message (the "menu" kind) — PRESERVE the original text so
    // the next healthy turn can recover it. Explicit booking/manage or recovery already handled it.
    const storeFailedNeed: PendingFailedNeed | undefined =
      reason === "provider_transient" && degIntent === "menu" ? { text: messageText.slice(0, 300), at: now } : undefined;
    await persist(prevLowSignal, prevGreeting, undefined, persistNotice ? now : undefined, storeFailedNeed, menuNode);
    await safeLog(businessId, customerId, decision);
    const lc = deriveLastAssistantContract(memory.transcript);
    console.log(`[platform-turn] continuity reason=${reason} intent=${degIntent} menu=${menuKind} link=${link ?? "-"} suppressed=${suppress} branch=${decision.branch}`);
    logTurnTrace({
      bookingMode: "platform", geminiCalled: decision.geminiCalled,
      route: link === "booking" ? "BOOK" : link === "manage" ? "MANAGE" : "NONE",
      routeReason: `continuity_${reason}`, signalKind: "unclear", linkKind: link, linkAttached: link !== null,
      suppressReply: suppress, guardBranch: decision.branch, bookingEvidence: false,
      lowSignalBefore: prevLowSignal, lowSignalAfter: prevLowSignal,
      greetingBefore: prevGreeting, greetingAfter: prevGreeting,
      replySource: "fallback", memLines: memory.turnsUsed,
      latestSignal: classifyGoodFaithSignal(latestFragment(messageText), { serviceNames: activeServiceNames }),
      aggregateSignal: classifyGoodFaithSignal(messageText, { serviceNames: activeServiceNames }),
      lastAssistant: `${lc.sentBookingLink ? "B" : ""}${lc.sentManageLink ? "M" : ""}${lc.offeredHelp ? "H" : ""}${lc.offeredBooking ? "K" : ""}${lc.askedQuestion ? "Q" : ""}` || "-",
      staleTopicGuard: false, softIntent: false, contextualConfirmation: false,
      capabilityFence: false, recoveryFollowup: degIntent === "recovery", pendingResolved: false, coldYes: false,
      customerVisible: !suppress, action: suppress ? "continuity_suppressed" : `continuity_${reason}${link ? `+${link}` : menuKind !== "-" ? `+${menuKind}` : ""}`,
      // Observability (LOG-ONLY): the deterministic fallback kind, live provider health, and whether a
      // transient-503 need was PRESERVED this turn (recovered later on the next healthy turn).
      fallbackType: menuKind !== "-" ? menuKind : `continuity_${reason}`,
      providerHealth: getGeminiHealth().state, strikes: getGeminiHealth().strikes,
      failedNeedStored: !!storeFailedNeed, failedNeedRecovered: false,
    });
    return { replyText: text, decision, linkAttached: link, suppressReply: suppress, interactive: suppress ? undefined : interactive };
  };

  // CONFIRMED OUTAGE (provider cooldown active) — full deterministic mode: serve EVERY message via
  // the menu-anchored core (no Gemini, even for noise/emoji — the AI-protection guards above are
  // skipped in deterministic mode). The pre-call gate (deterministicMenu) is true whenever cooling.
  if (isGeminiCoolingDown()) {
    console.warn(`[platform-turn] DEGRADED MODE — cooldown ${Math.ceil(geminiCooldownRemainingMs() / 1000)}s left`);
    return runContinuity("provider_outage", errorDecision("gemini_cooldown", true));
  }

  let replyGuidance: string | undefined;
  if (lastSendFailed) {
    replyGuidance =
      `NOTE: your PREVIOUS reply FAILED to deliver (technical issue on our side — the customer never saw it). Open with a brief, warm acknowledgement of a small hiccup ("הייתה לי תקלה קטנה קודם") before continuing.`;
  }
  // RECOVER a transient-503 need: a recent earlier message went unanswered due to a brief glitch.
  // Re-surface it to the (now healthy) model so it isn't silently swallowed.
  if (prevFailedNeed) {
    const recover =
      `NOTE: an earlier customer message ("${prevFailedNeed.text.replace(/"/g, "'")}") was NOT answered due to a brief technical glitch. If the CURRENT message does not already move past it, gently address that earlier question too.`;
    replyGuidance = replyGuidance ? `${recover}\n${replyGuidance}` : recover;
  }

  // ── CUSTOMER SAFETY CONTRACT v1: classify the LATEST message + derive what our last
  //    reply did, BEFORE the model call — so a topic-switch FOCUS note can steer the reply.
  const latest = latestFragment(messageText);
  const latestSignalRaw = classifyGoodFaithSignal(latest, { serviceNames: activeServiceNames });
  const lastContract = deriveLastAssistantContract(memory.transcript);
  // Topic switch (latest wins): a NEW non-manage topic while our recent reply was a
  // manage/cancel/link/help thread → tell the model to answer THIS message, not the thread.
  const topicSwitch =
    (latestSignalRaw === "faq" || latestSignalRaw === "soft_intent"
      || (latestSignalRaw === "action" && inferOperation(latest) === "BOOK")) &&
    !isManageHelpTopic(latest) && (lastContract.sentManageLink || lastContract.offeredHelp);
  if (topicSwitch) {
    const focus = "FOCUS: the customer's CURRENT message is a NEW topic — answer THIS message from the BUSINESS FACTS. Do NOT continue an earlier cancellation / manage / link / help thread unless this message refers to it.";
    replyGuidance = replyGuidance ? `${focus}\n${replyGuidance}` : focus;
  }

  // FINAL supersede gate BEFORE the (expensive) Gemini call. A newer fragment that
  // arrived during the debounce / aggregation / context-load means a later turn will
  // answer the full aggregate — so THIS turn must not also call Gemini. This guarantees a
  // burst costs ONE Gemini call (the last fragment's), not one per fragment. State is left
  // untouched (no persist) and the reply is suppressed (the router skips it anyway).
  if (await superseded()) {
    console.log("[platform-turn] superseded before Gemini call — skipping model call (burst coalesced to a later turn)");
    const supersededDecision = errorDecision("superseded", true);
    await safeLog(businessId, customerId, supersededDecision);
    return { replyText: "", decision: supersededDecision, linkAttached: null, suppressReply: true };
  }

  // ── ACKNOWLEDGEMENT LANE (post-CTA / post-answer): a positive ack ("מעולה"/"תודה"/"מגניב"/"הבנתי") is NOT
  //    an unclear token — it's a natural close. Answer it deterministically with a short close (no Gemini, no
  //    CTA), and do NOT count it as low-signal (CARRY the streak — an ack neither escalates nor rescues abuse).
  //    Excludes bare affirmations ("כן"/"סבבה") — they keep their existing pending-offer handling — and any
  //    turn that ANSWERS a pending question. SKIPPED in deterministic mode (menu-anchored there).
  if (!deterministicMenu && isLowValueAck(messageText) && !isBareAffirmation(messageText)
      && !hasPendingAnswerExpectedQuestion(lastContract.askedQuestion, lastAssistant ?? "")) {
    await persist(prevLowSignal, 0); // neutral: carry low-signal (no escalate/rescue), break the greeting run
    const decision = errorDecision("acknowledgement", true);
    await safeLog(businessId, customerId, decision);
    console.log(
      `[platform-turn] ai_called=false pre_gemini_guard=true pre_gemini_action=acknowledgement` +
      ` gemini_skipped_reason=acknowledgement low_signal=false low_signal_kind=ack route=NONE link=-` +
      ` low_signal_count_before=${prevLowSignal} low_signal_count_after=${prevLowSignal} reply_suppressed=false`
    );
    return { replyText: ACK_CLOSE, decision, linkAttached: null };
  }

  // ── REPEATED OFF-TOPIC CAP (cost control for a SUSTAINED off-topic streak). Once the customer is already
  //    DEEP in a low-value streak (prevLowSignal ≥ LOW_VALUE_DEEP_AT), a message with NO business signal is
  //    de-escalated WITHOUT a Gemini call. RECOGNIZED business questions are PROTECTED and always proceed: a
  //    booking/FAQ/manage signal OR a business-info topic (hours/prices/location/parking/policy/contact/about
  //    via detectInfoTopic). Good-faith confusion, presence pings and greetings keep their own lanes (excluded
  //    here). The FIRST few off-topic turns still reach Gemini (a one-off unrelated question gets a short
  //    deflection) — this only caps a sustained off-topic loop so a bored/malicious user can't burn Gemini
  //    forever. Honest residual: a signal-less business question in DEEP quiet gets the boundary, not an answer
  //    — recoverable via any clear business message. SKIPPED in deterministic mode.
  const isBusinessTopic = hasBusinessAnchor(messageText, activeServiceNames);
  if (!deterministicMenu && prevLowSignal >= LOW_VALUE_DEEP_AT && !isBusinessTopic
      && !isGoodFaithLowSignal(latest) && !looksLikePresenceCheck(latest)
      && !looksLikeGreetingOrMeta(latest, activeServiceNames)) {
    const newCount = prevLowSignal + 1;
    const plan = machineNoisePlan(newCount);                       // boundary already shown earlier → quiet/sparse here
    const suppress = plan.suppressReply && !isGoodFaithLowSignal(latest);
    await persist(newCount, 0);
    const decision = errorDecision("off_topic_capped", true);
    await safeLog(businessId, customerId, decision);
    console.log(
      `[platform-turn] ai_called=false pre_gemini_guard=true pre_gemini_action=off_topic_capped` +
      ` gemini_skipped_reason=repeated_off_topic low_signal=true low_signal_kind=unclear route=NONE link=-` +
      ` low_signal_count_before=${prevLowSignal} low_signal_count_after=${newCount} reply_suppressed=${suppress}`
    );
    // A VISIBLE cap turn (boundary/sparse reminder) is a scope deflection → tag it so the off-topic user
    // message drops from AI-facing history (suppressed turns carry no outbound, so the tag is a harmless no-op).
    return { replyText: suppress ? "" : (plan.replyText || LOW_VALUE_BOUNDARY), decision, linkAttached: null, suppressReply: suppress, historyReason: OFF_TOPIC_REASON };
  }

  // ── PRE-GEMINI SINGLE-TOKEN CLARIFY SKIP (call-waste + safety). A lone short, SIGNAL-LESS token with
  //    NO pending question is ALREADY going to ship the deterministic LOW_SIGNAL_SHORT after Gemini (the
  //    forcesDeterministicClarify path) — so decide it HERE and skip a full ~3.3k-token call. This also
  //    CLOSES the residual name-adoption hole (the model can't label a lone token as a name we then echo).
  //    Escalation tiers mirror the emoji-only pre-Gemini skip exactly, so repeated low-signal still climbs
  //    to boundary/quiet. SKIPPED in deterministic mode (every turn there is menu-anchored). The whole
  //    message is checked (multi-fragment bursts have whitespace → never skipped → they reach Gemini).
  if (!deterministicMenu && shouldPreSkipSingleTokenClarify(messageText, lastContract.askedQuestion, lastAssistant ?? "", activeServiceNames)) {
    const newCount = prevLowSignal + 1;
    const action = lowSignalActionFor(newCount);
    let replyText = LOW_SIGNAL_SHORT;
    let suppressReply = false;
    if (action === "boundary") replyText = LOW_SIGNAL_BOUNDARY;
    else if (action === "quiet_mode") {
      const plan = quietModePlan(newCount);
      suppressReply = plan.suppressReply;
      replyText = plan.suppressReply ? "" : LOW_SIGNAL_QUIET_REMINDER;
    }
    await persist(newCount, 0); // a lone unclear token breaks any greeting run
    const decision = errorDecision("low_signal_single_token", true);
    await safeLog(businessId, customerId, decision);
    console.log(
      `[platform-turn] ai_called=false action=false intent=unclear appt_intent=NONE route=NONE route_reason=not_actionable link=-` +
      ` pre_gemini_guard=true pre_gemini_action=skip_gemini_single_token gemini_skipped_reason=single_token_unclear` +
      ` low_signal=true low_signal_kind=unclear` +
      ` low_signal_count_before=${prevLowSignal} low_signal_count_after=${newCount}` +
      ` greeting_count_before=${prevGreeting} greeting_count_after=0` +
      ` low_signal_action=${action} cooldown_short_circuit=false reply_suppressed=${suppressReply} src=fallback`
    );
    logTurnTrace({
      bookingMode: "platform", geminiCalled: false, route: "NONE", routeReason: "not_actionable",
      signalKind: "unclear", linkKind: null, linkAttached: false, suppressReply,
      guardBranch: decision.branch, bookingEvidence: false,
      lowSignalBefore: prevLowSignal, lowSignalAfter: newCount,
      greetingBefore: prevGreeting, greetingAfter: 0,
      replySource: "fallback", memLines: memory.turnsUsed,
      latestSignal: "none", aggregateSignal: "none",
      lastAssistant: `${lastContract.sentBookingLink ? "B" : ""}${lastContract.sentManageLink ? "M" : ""}${lastContract.offeredHelp ? "H" : ""}${lastContract.offeredBooking ? "K" : ""}${lastContract.askedQuestion ? "Q" : ""}` || "-",
      staleTopicGuard: false, softIntent: false, contextualConfirmation: false,
      capabilityFence: false, recoveryFollowup: false, pendingResolved: false, coldYes: false,
      customerVisible: !suppressReply && replyText.trim().length > 0,
      action: suppressReply ? "suppressed" : "reply",
      fallbackType: fallbackTypeForLowSignal(action, action === "normal_clarify"),
      providerHealth: getGeminiHealth().state, strikes: getGeminiHealth().strikes,
      failedNeedStored: false, failedNeedRecovered: !!prevFailedNeed,
    });
    return { replyText, decision, linkAttached: null, suppressReply };
  }

  const decision = await (testDeps?.runModel ?? runReceptionistTurn)(ctx, {
    historyTurns: memory.turns,
    conversationContext: memory.transcript,
    message: messageText,
    bookingBlock,
    replyGuidance,
    platformMode: true,
    customerPhone,
    // Single-flight: a newer turn for this conversation CANCELS this in-flight Gemini call
    // (no completion, no retry, no overload strike). abortIfSuperseded is the 503-path backstop.
    abortSignal: turn.signal,
    abortIfSuperseded: superseded,
  });

  // ── DETERMINISTIC RECEPTIONIST for EVERY no-AI outcome (owner disabled AI, provider 503,
  //    internal AI/parse error) — route through the SHARED continuity core with reason-specific
  //    wording, so the product stays a useful receptionist (book/manage/recovery/menu) instead of
  //    a dead canned line. Deliberate guard replies (abuse/noise) and grounding deflections are
  //    left as-is. A turn that became superseded mid-call just suppresses (the router skips it).
  if (!decision.ok && CONTINUITY_BRANCHES.has(decision.branch)) {
    if (await superseded()) {
      const sup = errorDecision("superseded", true);
      await safeLog(businessId, customerId, sup);
      return { replyText: "", decision: sup, linkAttached: null, suppressReply: true };
    }
    // Grade provider failures by HEALTH: a 503 that left us still-healthy (no cooldown) is a
    // TRANSIENT blip → soft "resend?" that keeps the AI experience and preserves the need; a 503
    // that tipped us into cooldown is a SUSTAINED outage → deterministic menu. (The pre-call
    // cooldown block already routes subsequent in-cooldown turns to provider_outage.)
    const reason: DegradedReason =
      decision.branch === "ai_disabled" ? "ai_disabled"
      : decision.branch === "api_overloaded" ? (isGeminiCoolingDown() ? "provider_outage" : "provider_transient")
      : "ai_error"; // api_error | parse_error | not_configured (incl. empty/blocked/RECITATION)
    // ── AXIS B: a MODEL blocked/empty/RECITATION/parse/api hiccup in HEALTHY AI MODE is a per-turn
    //    glitch, NOT a mode change — it must NOT open the deterministic menu (the live bug:
    //    "כמה אנשים יש בכדור הארץ?" → RECITATION → ai_error → FAQ submenu). Answer with a soft
    //    AI-mode fallback and stay in AI mode. Deterministic menu is reserved for genuine no-AI
    //    states (owner disabled / no key / sustained outage) — exactly when `deterministicMenu` is
    //    true (e.g. not_configured), where ai_error correctly routes to the menu below.
    if (reason === "ai_error" && !deterministicMenu) {
      const softText = decision.replyText || FALLBACK.error; // calm "try again", no menu, no link
      await safeLog(businessId, customerId, decision);
      console.log(`[platform-turn] ai_error in healthy AI mode → soft fallback (no menu) branch=${decision.branch}`);
      return { replyText: softText, decision, linkAttached: null };
    }
    return runContinuity(reason, decision);
  }

  // CTA COMPLEMENT FENCE (Stage 3a): the SYSTEM owns the CTA — strip a redundant call-to-action clause
  // from the MODEL reply so the message reads once, not twice. Applied to the model output ONLY (ok=true);
  // every deterministic bridge/fallback below is assigned AFTER this and legitimately references the link,
  // so it is never fenced. Byte-identical no-op for any reply with no CTA pointer (every non-CTA turn).
  let replyText = decision.ok ? stripDuplicateCtaWording(decision.replyText) : decision.replyText;

  // The model must never claim a booking action happened — in platform mode it structurally can't have.
  // Replace the lie with the LINK-NEUTRAL honest correction (no phantom-link wording, so the phantom-link
  // fence below can never strip it into a fragment on a no-link turn). A real booking link, if the route
  // attaches one this turn, is appended separately downstream.
  if (decision.ok && claimsBookingCompleted(replyText)) {
    replyText = BOOKED_CLAIM_CORRECTION;
  }
  // Never send the exact same reply twice in a row. (No link wording here — a link
  // is only ever promised by the deterministic link logic below, never by a generic
  // fallback; the link-wording fence at the end is the backstop.)
  if (decision.ok && sameOutboundText(replyText, lastAssistant)) {
    replyText = "אני כאן 🙂 אפשר לשאול אותי כל דבר על העסק, או לקבוע תור מתי שתרצה.";
  }
  // Repeat-answer tone guard: even for an already-answered question, never scold ("כבר אמרתי
  // לך…"). Soften to plain customer-service tone while keeping the answer + vocative.
  if (decision.ok) {
    const toned = softenRepeatTone(replyText);
    if (toned.softened) {
      replyText = toned.text;
      console.log("[platform-turn] tone guard: softened a repeat-answer scolding lead-in");
    }
  }

  // ── POST-FALLBACK RECOVERY / ACCOUNTABILITY (detection): after a degraded/overload reply,
  //    "הסתדר?"/"זמין?" is a SYSTEM-recovery question (not "how are you?"), and "כי כתבת שיש
  //    עומס"/"הנה תראה" is an accountability challenge (acknowledge, never deny/blame). Resolved
  //    AUTHORITATIVELY at the end of the turn (override any routing/low-signal). Accountability
  //    takes precedence over recovery. Recognized ONLY after a degraded reply (context-gated).
  const accountabilityRepair = decision.ok && lastReplyWasDegraded && isAccountabilityChallenge(latest);
  const recoveryFollowup = decision.ok && lastReplyWasDegraded && !accountabilityRepair && isRecoveryFollowup(latest);

  // ── Outbound URL safety: strip any URL the MODEL wrote (echoed from history or
  //    invented) so the final message carries AT MOST the one deterministic link.
  replyText = stripModelUrls(replyText);

  // ── EVIDENCE GATE (BUG-004): never trust a model-claimed operation without
  //    supporting evidence in the USER message. Gemini hallucinates BOOK on
  //    gibberish; this downgrades it to non-actionable IN PLACE, so the corrected
  //    understanding flows into BOTH the link decision and the low-signal counter
  //    below (a hallucinated BOOK can no longer reset the counter / escape quiet mode).
  let bookingEvidence = false;
  let bookingEvidenceReason = "n/a";
  if (decision.ok && decision.turn) {
    const ev = applyBookingEvidenceGate(decision.turn.understanding, messageText, activeServiceNames);
    bookingEvidence = ev.evidence;
    bookingEvidenceReason = ev.reason;
  }

  // Good-faith category of the LATEST message (classified pre-Gemini). A bare "כן"
  // inherits the prior assistant trajectory: after a help offer → help; otherwise a
  // contextual follow-up (never an action route on its own).
  let latestSignal: GoodFaithSignal = decision.ok && decision.turn ? latestSignalRaw : "none";
  if (latestSignal === "none" && decision.ok && decision.turn && isBareAffirmation(latest)) {
    latestSignal = lastContract.offeredHelp ? "help" : "contextual_ref";
  }

  // ── Deterministic link control (OVERRIDES Gemini's intent). Complaints about
  //    links/bugs, bare meta-questions ("מה?"/"למה?"/"לא הבנתי"), corrections and
  //    one-char messages must NEVER get a booking/manage link — Gemini mislabels
  //    them as BOOK, which created the live "complain about links → bot sends
  //    another link" loop. The link attaches only on a genuine action intent.
  const u = decision.turn?.understanding;
  let linkAttached: PlatformLink = null;
  // Presentation parity with deterministic mode: when a platform link is attached we also build a
  // clean cta_url interactive (URL in the button, not the body). Gated on linkAttached at the return,
  // so a guard that later revokes the link (low-signal / recovery) also drops the button.
  let interactive: WhatsAppInteractive | undefined;
  let platformRoute = "-";
  let platformRouteReason = "-";

  if (decision.ok && suppressLinkFor(messageText)) {
    platformRoute = "NONE"; // complaints / bare-meta / one-char never get a link
    if (LINK_COMPLAINT_RE.test(messageText) && !isExplicitLinkRequest(messageText)) {
      replyText = COMPLAINT_ACK; // breaks the complaint loop — acknowledge, no link
      console.log("[platform-turn] link suppressed (complaint) — deterministic ack, no link");
    } else if (/קישור|לינק/.test(replyText)) {
      replyText = META_FALLBACK; // model dangled a link promise on a no-link turn
      console.log("[platform-turn] link suppressed (meta/non-action) — cleaned dangling link promise");
    } else {
      console.log("[platform-turn] link suppressed (meta/non-action) — model reply kept, no link");
    }
  } else if (decision.ok && u) {
    // ── SINGLE SOURCE OF TRUTH (lib/ai/routing.ts): one canonical route, computed ONCE.
    //    Everything below — which link, the wording/fence, the follow-up — derives from
    //    it; no component re-interprets intent. This closes the class of bugs where the
    //    coarse `intent`, the fine `appointmentIntent`, and the user's words disagreed and
    //    different layers picked different answers (the live LIST→booking-link incident).
    const { route, reason, modelRoute } = resolveRoute(u, messageText);
    const linkKind = linkKindForRoute(route);
    const bookingSignal = hasBookingSignal(messageText, activeServiceNames);
    platformRoute = route;
    platformRouteReason = reason;

    // When the user's words OVERRODE the model's own operation, the model's free text was
    // written for the WRONG operation — replace it with a deterministic, route-appropriate
    // line so the reply can NEVER disagree with the link that gets attached.
    if (reason === "message_verb" && route !== modelRoute) {
      console.log(`[platform-turn] route override: model=${modelRoute} → ${route} (user's words) — reply replaced for consistency`);
      replyText = route === "BOOK" ? `בטח! ${FENCE_BRIDGE_BOOK}` : `בטח! ${FENCE_BRIDGE_MANAGE}`;
    }

    if (linkKind && reason === "model_intent" && !bookingSignal) {
      // Defense-in-depth floor: a MODEL-derived operation with no corroborating signal in
      // the message is not trusted to attach a link (the evidence gate normally already
      // downgraded it). A message_verb route is self-evidenced and never lands here.
      console.log(`[platform-turn] link suppressed: route=${route} (model_intent) but no booking signal in message`);
    } else if (linkKind === "manage") {
      // Route is fixed; only WHICH manage page varies, decided by real data (never the
      // model): 0 upcoming → booking link (nothing to manage; offer to book) · 1 → that
      // appointment's page · 2+ → My Appointments page.
      const upcoming = await listUpcomingByCustomer(db, businessId, customerId, 5);
      // ONE deterministic, route/CONTEXT-AWARE decision (never the model): the manage page is sized by
      // REAL upcoming count, AND an explicit manage/list route with 0 upcoming has NOTHING to manage → the
      // reply is FORCED to the honest no-upcoming line regardless of the model's wording, so we never imply
      // "manage your appointments" over a booking link. (The wording guard below is the net for any other path.)
      const mo = resolveManageOutcome(upcoming, replyText, ctx.business.slug, customerPhone, customerId);
      const url = mo.url;
      const label = mo.label;
      linkAttached = mo.kind;
      replyText = mo.replyText;
      if (upcoming.length === 0) console.log(`[platform-turn] manage route with 0 upcoming → honest no-upcoming reply + booking link (route=${route})`);
      // Never ask the customer to identify/specify an appointment in chat — the link shows
      // the accurate list. (If we already replaced the reply on override, no question
      // remains, so this is a no-op then.)
      const fenced =
        upcoming.length === 0
          ? defuseSchedulingQuestion(replyText)
          : defuseSchedulingQuestion(replyText, { bridge: FENCE_BRIDGE_MANAGE, keepWarmth: false });
      if (fenced.defused) {
        console.log(`[platform-turn] fence: neutralized in-chat selection question (manage, ${upcoming.length} appts)`);
        replyText = fenced.text;
      }
      // Rewrite an in-chat "I'll schedule/manage it for you" promise to link-first wording.
      const capM = defuseCapabilityPromise(replyText, { bridge: FENCE_BRIDGE_MANAGE });
      if (capM.defused) {
        console.log("[platform-turn] fence: rewrote in-chat capability promise (manage link → link-first)");
        replyText = capM.text;
      }
      // No false refusal when a MANAGE link is attached (the page does it). Skip the
      // 0-upcoming case — there the honest "no appointment under this number" reply is
      // correct (and it routes to a booking link, not a manage one).
      if (upcoming.length > 0) {
        const refused = defuseActionRefusal(replyText, route);
        if (refused.defused) {
          console.log("[platform-turn] fence: neutralized false action-refusal (manage link attached)");
          replyText = refused.text;
        }
      }
      ({ replyText, interactive } = attachPlatformLink(replyText, label, url, lastAssistant, messageText));
      logPlatformLink(linkAttached, url);
    } else if (linkKind === "booking") {
      // A booking reply must never ask the customer to pick service/day/time in chat —
      // that's the website's job. Strip any such question deterministically.
      const fenced = defuseSchedulingQuestion(replyText);
      if (fenced.defused) {
        console.log("[platform-turn] fence: stripped in-chat scheduling question (booking intent → link-first)");
        replyText = fenced.text;
      }
      // Rewrite an in-chat "I'll book it for you" promise ("נתאם לך") to link-first wording.
      const capB = defuseCapabilityPromise(replyText);
      if (capB.defused) {
        console.log("[platform-turn] fence: rewrote in-chat capability promise (booking link → link-first)");
        replyText = capB.text;
      }
      // No false "I can't book" when a BOOKING link is attached (the page does it).
      const refused = defuseActionRefusal(replyText, route);
      if (refused.defused) {
        console.log("[platform-turn] fence: neutralized false action-refusal (booking link attached)");
        replyText = refused.text;
      }
      const url = buildBookingLink(ctx.business.slug, customerPhone);
      ({ replyText, interactive } = attachPlatformLink(replyText, BOOK_LINE, url, lastAssistant, messageText));
      linkAttached = "booking";
      logPlatformLink(linkAttached, url);
    }
    // route === NONE → no link (any override reply replacement already applied above).
  }

  // ── ACTION / HELP ESCAPE (Customer Safety Contract): a help request, OR an operation
  //    the model MISSED, gets the RIGHT link + TRUTH-SAFE guidance. The website performs
  //    the action; chat NEVER does and never claims it did. Latest-message-driven; a
  //    QUESTION about an operation ("כמה עולה לבטל?") is faq, not action — never forced.
  const escapeOp = inferOperation(latest);
  const affirm = isBareAffirmation(latest);
  // IMMEDIATE context: our LAST reply offered/sent a booking. DELAYED context: a still-valid
  // pending offer from earlier (survives intervening turns + a time gap, TTL-bounded) — this is
  // what makes a later "כן" resolve to the action we discussed instead of arriving cold.
  const immediateBookCtx = lastContract.sentBookingLink || lastContract.offeredBooking;
  const pendingBookConfirm = affirm && !immediateBookCtx && prevPending?.kind === "BOOK";
  const pendingManageConfirm = affirm && !immediateBookCtx && prevPending?.kind === "MANAGE";
  const confirmIntoBooking = affirm && (immediateBookCtx || pendingBookConfirm);
  // A "help" signal escapes to MANAGE only with real manage evidence (helpEscapesToManage) — generic
  // confusion / location / access / frustration "help" stays in AI/FAQ (the model's reply is used), never a
  // manage→booking "no active appointment" reply. The action-op and pending-MANAGE escapes are unchanged.
  const wantsManage = helpEscapesToManage(latestSignal, latest, lastContract, prevPending?.kind ?? null)
    || (latestSignal === "action" && (escapeOp === "CANCEL" || escapeOp === "RESCHEDULE" || escapeOp === "LIST"))
    || pendingManageConfirm;
  const wantsBook = (latestSignal === "action" && escapeOp === "BOOK") || confirmIntoBooking;
  const pendingResolved = pendingBookConfirm || pendingManageConfirm;
  let softIntentLink = false;
  if (decision.ok && !suppressLinkFor(latest) && wantsManage && (latestSignal === "help" || linkAttached === null)) {
    // HELP overrides even an attached link (truth-safe guidance beats a vague model reply);
    // a MISSED manage operation fires only when nothing was attached.
    const upcoming = await listUpcomingByCustomer(db, businessId, customerId, 5);
    const m = manageLinkFor(upcoming, ctx.business.slug, customerPhone, customerId);
    ({ replyText, interactive } = attachPlatformLink(buildManageHelpReply(upcoming.length, escapeOp), m.label, m.url, lastAssistant, messageText));
    linkAttached = m.kind;
    platformRoute = escapeOp ?? "HELP";
    platformRouteReason = "help_escape";
    logPlatformLink(m.kind, m.url);
    console.log(`[platform-turn] help-escape: truth-safe manage/help (op=${escapeOp ?? "-"}, upcoming=${upcoming.length})`);
  } else if (decision.ok && linkAttached === null && wantsBook && !suppressLinkFor(latest)) {
    const url = buildBookingLink(ctx.business.slug, customerPhone);
    ({ replyText, interactive } = attachPlatformLink(`בטח! ${FENCE_BRIDGE_BOOK}`, BOOK_LINE, url, lastAssistant, messageText));
    linkAttached = "booking";
    platformRoute = "BOOK";
    platformRouteReason = pendingBookConfirm ? "pending_confirm" : confirmIntoBooking ? "contextual_confirm" : "action_escape";
    logPlatformLink("booking", url);
    console.log(`[platform-turn] ${pendingBookConfirm ? "pending-confirm: 'כן' resolved a still-open booking offer" : confirmIntoBooking ? "contextual-confirm: 'כן' after a booking offer" : "action-escape: model missed a booking imperative"} → booking link`);
  } else if (decision.ok && linkAttached === null && latestSignal === "soft_intent" && !suppressLinkFor(latest)) {
    // SOFT SERVICE INTENT ("חשבתי על להסתפר, יש לי טיסה..."): keep the model's WARMTH,
    // strip any in-chat scheduling question / availability promise, and route to the
    // booking page (the safe universal entry — link-first, never an in-chat flow).
    let warm = defuseSchedulingQuestion(replyText).text;
    warm = defuseCapabilityPromise(warm).text;
    const refused = defuseActionRefusal(warm, "BOOK");
    if (refused.defused) warm = refused.text;
    const url = buildBookingLink(ctx.business.slug, customerPhone);
    ({ replyText, interactive } = attachPlatformLink(warm, BOOK_LINE, url, lastAssistant, messageText));
    linkAttached = "booking";
    platformRoute = "BOOK";
    platformRouteReason = "soft_intent";
    softIntentLink = true;
    logPlatformLink("booking", url);
    console.log("[platform-turn] soft-intent: indirect service intent → booking link (warmth kept)");
  }

  // ── CAPABILITY-PROMISE FENCE (route-agnostic backstop): the model promised an in-chat
  //    booking/availability flow it can't run. If nothing was attached, either route to
  //    booking (when there's intent/booking context) or neutralize the promise — so an
  //    unsupported "אני אבדוק לך זמינות" never ships and never dangles an unanswerable yes.
  let capabilityFenceApplied = false;
  if (decision.ok && linkAttached === null && mentionsCapabilityPromise(replyText)) {
    const bookingContext = latestSignal === "soft_intent"
      || hasBookingSignal(messageText, activeServiceNames)
      || (affirm && (lastContract.sentBookingLink || lastContract.offeredBooking || prevPending?.kind === "BOOK"));
    if (bookingContext && !suppressLinkFor(latest)) {
      const url = buildBookingLink(ctx.business.slug, customerPhone);
      ({ replyText, interactive } = attachPlatformLink(defuseCapabilityPromise(replyText).text, BOOK_LINE, url, lastAssistant, messageText));
      linkAttached = "booking";
      platformRoute = "BOOK";
      platformRouteReason = "capability_fence";
      logPlatformLink("booking", url);
      console.log("[platform-turn] capability fence: unsupported in-chat promise → booking link");
    } else {
      replyText = defuseCapabilityPromise(replyText).text;
      console.log("[platform-turn] capability fence: neutralized unsupported in-chat promise (no link)");
    }
    capabilityFenceApplied = true;
  }

  // ── COLD AFFIRMATION GUARD: a bare "כן"/"סבבה" with NO resolvable context (no still-valid
  //    pending offer, and our last reply neither asked nor offered anything actionable) must
  //    NOT route to an action — give ONE safe clarification instead of a cold guess. (A pending
  //    offer, or a last-reply question/offer, is resolved above and never reaches here.)
  let coldYes = false;
  if (decision.ok && linkAttached === null && affirm && !prevPending
      && !(lastContract.askedQuestion || lastContract.offeredHelp || lastContract.offeredBooking
           || lastContract.sentBookingLink || lastContract.sentManageLink)) {
    replyText = COLD_YES_CLARIFY;
    coldYes = true;
    console.log("[platform-turn] cold affirmation with no pending context → safe clarification (no action)");
  }

  // ── STALE-TOPIC GUARD (deterministic backstop): the latest message is a clear NEW
  //    non-manage business question, but the reply continued an old cancellation/manage/
  //    link thread → latest wins; don't answer the stale topic. (FOCUS guidance prevents
  //    most of these pre-Gemini; this catches the rest.)
  let staleTopicGuard = false;
  if (decision.ok && latestSignal === "faq" && !isManageHelpTopic(latest)
      && linkAttached === null && replyLooksStaleManage(replyText)) {
    replyText = STALE_TOPIC_PIVOT;
    staleTopicGuard = true;
    console.log("[platform-turn] stale-topic guard: reply continued a stale manage thread → pivot to latest question");
  }

  // ── LOW-SIGNAL GUARD: gently clarify, then set a polite boundary, so repeated
  //    no-intent / gibberish messages don't loop forever. Any productive turn (a
  //    real business question or an operation) resets the counter. Friendly first.
  // Counter is driven by KIND, not raw intent: only gibberish + meaningless unclear
  // escalate. Greetings/smalltalk/meta are legitimate human turns — they reset the
  // counter and keep the model's friendly reply (BUG-005). Productive resets too.
  const kind: LowSignalKind = decision.ok && decision.turn
    ? lowSignalKind(decision, messageText, activeServiceNames, latestSignal)
    : "unclear";
  const lowSignal = decision.ok && !!decision.turn && countsTowardQuiet(kind);
  let newLowSignal = prevLowSignal;
  // Greeting run: a greeting/meta turn that reached Gemini advances the counter
  // (so a sustained loop eventually short-circuits, Risk C); any other turn resets
  // it. System errors (!decision.ok) leave it unchanged — never penalize our fault.
  let newGreeting = prevGreeting;
  let lowSignalAct: LowSignalAction = "none";
  let suppressReply = false;
  let forcedClarify = false; // LOG-ONLY: did the tier-1 deterministic clarify actually override the reply?
  let historyReason: string | undefined; // set on a visible scope-deflection → drops the off-topic turn from history
  if (decision.ok && decision.turn) {
    newLowSignal = lowSignal ? prevLowSignal + 1 : 0;
    // Greeting LOOP counter (cost cap) advances ONLY on an actual bare opener — NOT on
    // content-ful smalltalk. A warm exchange ("ציון טוב במתמטיקה") must not inflate the
    // counter and risk later suppressing a real greeting (assistant-driven social drift).
    newGreeting = looksLikeGreetingOrMeta(latest, activeServiceNames) ? prevGreeting + 1 : 0;
    lowSignalAct = lowSignalActionFor(newLowSignal);
    // count 1 → normally keep the model's (friendly) clarification; escalate from 2 up. EXCEPT tier-1
    // cases that must NOT ship a model-authored guess: gibberish ("במבח" → "אתה מתכוון למחר?"), and a
    // lone contentless `unclear` token the model tends to "interpret" as a name ("אורי" → "מה שלומך,
    // אורי?") — unless our last reply asked a direct question a one-word answer could resolve. Those get
    // the deterministic clarify (no link). See forcesDeterministicClarify.
    // OFF-TOPIC (general out-of-scope question): a SHORT, consistent business-scope deflection from turn 1
    // (no long warm re-intro, no CTA) — still counts toward quiet, so repeated off-topic de-escalates (quiet
    // suppression caps the cost). A genuine business FAQ is intent=faq (productive) and never lands here.
    // OUTCOME-driven: the off-topic ladder + counting + history-tag all key off the SAME relevance verdict
    // (kind === "out_of_domain" = the model judged it out_of_scope AND there is no business anchor). An
    // anchored out_of_scope (a real FAQ the model mislabeled) is `productive` → it is NOT force-deflected here.
    const isOffTopic = kind === "out_of_domain";
    if (isOffTopic && lowSignalAct !== "quiet_mode") {
      // off-topic ladder: tiers 1–2 → short scope deflection, tier 3 → the shared visible boundary (deep
      // off-topic in quiet is intercepted pre-Gemini by the off-topic cap above). Then quiet suppression.
      replyText = lowSignalAct === "boundary" ? LOW_VALUE_BOUNDARY : OFF_TOPIC_DEFLECTION;
      linkAttached = null;
      historyReason = OFF_TOPIC_REASON; // visible scope deflection → drop this off-topic turn from AI history
    }
    else if (forcesDeterministicClarify(kind, lowSignalAct, latest, lastContract.askedQuestion)) { replyText = LOW_SIGNAL_SHORT; linkAttached = null; forcedClarify = true; }
    else if (lowSignalAct === "short_clarify") { replyText = LOW_SIGNAL_SHORT; linkAttached = null; }
    else if (lowSignalAct === "boundary") { replyText = LOW_SIGNAL_BOUNDARY; linkAttached = null; }
    else if (lowSignalAct === "quiet_mode") {
      // Reached via Gemini (the message wasn't obvious local nonsense). Go sparse:
      // mostly suppress, a rare reminder — never the same line every turn. EXCEPT: a GOOD-FAITH
      // confused message ("מה?", "לא הבנתי", "??") is NEVER walked into silence (Phase 4A) — it gets
      // the short reminder instead, even on a would-be-suppressed turn. Machine noise still goes quiet.
      linkAttached = null;
      const plan = quietModePlan(newLowSignal);
      if (plan.suppressReply && !isGoodFaithLowSignal(latest)) suppressReply = true;
      else replyText = LOW_SIGNAL_QUIET_REMINDER;
    }
  }
  // !decision.ok (system fallback) leaves the counter unchanged — never penalize a
  // customer for our own error.

  // ── RECOVERY / ACCOUNTABILITY OVERRIDE (authoritative): after a degraded reply, a recovery
  //    question ("הסתדר?"/"זמין?") or an accountability challenge ("כי כתבת שיש עומס"/"הנה תראה")
  //    gets a deterministic calm reply and NO link — overriding any routing/low-signal mutation
  //    above. A recovery/repair exchange is productive (never escalate the counter).
  if (recoveryFollowup || accountabilityRepair) {
    replyText = accountabilityRepair
      ? ACCOUNTABILITY_REPAIR
      : (isGeminiCoolingDown() ? STILL_DEGRADED_ACK : RECOVERY_ACK);
    // A recovery/accountability reply replaces the model's — so if an earlier message went
    // unanswered (transient 503), bridge to it here so it isn't lost ("answer recovery but do not
    // lose the original failed need").
    if (prevFailedNeed) replyText += " דרך אגב, הייתה הודעה קודמת שלא הספקתי לענות עליה — אפשר לשלוח אותה שוב 🙂";
    linkAttached = null;
    newLowSignal = 0;
    suppressReply = false;
    console.log(`[platform-turn] ${accountabilityRepair ? "accountability repair" : "recovery follow-up"}: degraded context → calm repair/recovery reply, no link`);
  }

  // ── LINK-WORDING FENCE: never imply a link is present/sent unless one was
  //    actually attached this turn or sent earlier in the conversation.
  let linkWordingFenceApplied = false;
  if (shouldFenceLinkWording(linkAttached, previousBookingLinkSent, replyText)) {
    replyText = stripPhantomLinkWording(replyText);
    linkWordingFenceApplied = true;
  }

  // ── WORDING ↔ LINK-KIND CONSISTENCY (general): an explicit manage/list ask that found 0 upcoming
  //    collapses to a BOOKING link — never let the reply still CLAIM "manage your appointments" while a
  //    booking URL is attached. Reconcile to an honest, booking-worded "no upcoming appointments" line.
  {
    const r = reconcileLinkWording(
      replyText, linkAttached, interactive,
      interactive?.kind === "cta_url" ? interactive.url : buildBookingLink(ctx.business.slug, customerPhone),
    );
    replyText = r.replyText;
    interactive = r.interactive;
    if (r.reconciled) console.log("[platform-turn] wording/link-kind fence: manage wording + booking link → honest no-upcoming reply");
  }

  // ── SET / CARRY the short-term pending offer: remember a platform-safe action we offered or
  //    attached this turn, so a LATER bare "כן" resolves to it. undefined ⇒ carry the existing
  //    one forward; object ⇒ refresh. Never set on a cold-yes clarification or a low-signal
  //    (gibberish/unclear) turn. Offer detection reads the MODEL's ORIGINAL reply (not a fence-
  //    rewritten clarify line) so a deterministic clarification can't fabricate a pending offer.
  const discussedService = (u?.serviceName ?? prevPending?.service) || undefined;
  let newPending: PendingOffer | null | undefined = undefined;
  if (!coldYes && kind !== "gibberish" && kind !== "unclear" && kind !== "out_of_domain") {
    if (linkAttached === "booking") newPending = { kind: "BOOK", service: discussedService, at: now };
    else if (linkAttached === "manage") newPending = { kind: "MANAGE", service: discussedService, at: now };
    else if (decision.ok && BOOKING_OFFER_RE.test(decision.replyText)) newPending = { kind: "BOOK", service: discussedService, at: now };
  }

  // Persist the counters + pending offer (platform state is always idle; merge-safe + supersede-aware).
  // Clear any preserved transient-503 need — this healthy turn had its chance to recover it
  // (re-injected as guidance above / bridged into a recovery reply below), so consume it once.
  // AI-FIRST: a healthy free-text turn means the customer is conversing, not navigating — EXIT any
  // menu cursor (a later numeric/alias won't be hijacked into menu mode; the AI owns the turn).
  await persist(newLowSignal, newGreeting, newPending, undefined, prevFailedNeed ? null : undefined, null);

  if (ctx.aiSettings?.emoji_usage === "none") {
    replyText = stripEmojis(replyText);
  }

  await safeLog(businessId, customerId, decision);
  console.log(
    `[platform-turn] ai_called=${decision.geminiCalled} action=${u?.requestsBusinessAction ?? "-"}` +
    ` intent=${u?.intent ?? "-"} appt_intent=${u?.appointmentIntent ?? "-"}` +
    ` route=${platformRoute} route_reason=${platformRouteReason} link=${linkAttached ?? "-"}` +
    ` booking_evidence=${bookingEvidence} booking_evidence_reason=${bookingEvidenceReason}` +
    ` pre_gemini_guard=false pre_gemini_action=proceed_to_gemini gemini_skipped_reason=none` +
    ` low_signal=${lowSignal} low_signal_kind=${kind}` +
    ` low_signal_count_before=${prevLowSignal} low_signal_count_after=${newLowSignal}` +
    ` greeting_count_before=${prevGreeting} greeting_count_after=${newGreeting}` +
    ` low_signal_action=${lowSignalAct} cooldown_short_circuit=false reply_suppressed=${suppressReply}` +
    ` link_wording_fence_applied=${linkWordingFenceApplied}` +
    ` src=${decision.replySource} memLines=${memory.turnsUsed}`
  );
  logTurnTrace({
    bookingMode: "platform",
    geminiCalled: decision.geminiCalled,
    route: platformRoute,
    routeReason: platformRouteReason,
    signalKind: kind,
    linkKind: linkAttached,
    linkAttached: linkAttached !== null,
    suppressReply,
    guardBranch: decision.branch,
    bookingEvidence,
    lowSignalBefore: prevLowSignal,
    lowSignalAfter: newLowSignal,
    greetingBefore: prevGreeting,
    greetingAfter: newGreeting,
    replySource: decision.replySource,
    memLines: memory.turnsUsed,
    latestSignal,
    aggregateSignal: decision.ok && decision.turn
      ? classifyGoodFaithSignal(messageText, { serviceNames: activeServiceNames }) : "none",
    lastAssistant: `${lastContract.sentBookingLink ? "B" : ""}${lastContract.sentManageLink ? "M" : ""}${lastContract.offeredHelp ? "H" : ""}${lastContract.offeredBooking ? "K" : ""}${lastContract.askedQuestion ? "Q" : ""}` || "-",
    staleTopicGuard,
    softIntent: latestSignal === "soft_intent" || softIntentLink,
    contextualConfirmation: confirmIntoBooking,
    capabilityFence: capabilityFenceApplied,
    recoveryFollowup,
    pendingResolved,
    coldYes,
    customerVisible: !suppressReply && replyText.trim().length > 0,
    action: `${suppressReply ? "suppressed" : "reply"}${linkAttached ? `+${linkAttached}` : ""}`,
    // Observability (LOG-ONLY): the low-signal deterministic override that shaped the reply (if any),
    // live provider health, and whether a transient-503 need was recovered this (healthy) turn.
    fallbackType: fallbackTypeForLowSignal(lowSignalAct, forcedClarify),
    providerHealth: getGeminiHealth().state,
    strikes: getGeminiHealth().strikes,
    failedNeedStored: false,
    failedNeedRecovered: !!prevFailedNeed,
  });

  // interactive is sent ONLY when a link is still attached at the end — a guard that revoked the link
  // (low-signal / recovery set linkAttached=null) also drops the stale button, falling back to text.
  return { replyText, decision, linkAttached, suppressReply, interactive: linkAttached !== null ? interactive : undefined, historyReason };
}

// ── DETERMINISTIC MENU NAVIGATION runner ──────────────────────────────────────────
// Executes a resolved menu-navigation action with NO Gemini call: book/manage attach the
// real, sized link (neutral wording — a menu pick is reason-agnostic); main/faq/answer just
// reply with the menu text. Always persists the new menu cursor so the next numeric/alias/
// topic resolves against the right node. Kept separate so runPlatformTurn stays readable.
interface MenuNavDeps {
  db: DB; businessId: string; customerId: string; customerPhone: string; slug: string; facts: BusinessFacts;
  emojiNone: boolean; prevLowSignal: number; prevGreeting: number; memLines: number;
  /** Stable payload id when the turn was a TAP (vs typed text) — surfaced in logs/trace. */
  interactivePayloadId?: string;
  persist: (
    low: number, greet: number, pending?: PendingOffer | null, lastDegradedAt?: number,
    failedNeed?: PendingFailedNeed | null, menu?: MenuState | null,
  ) => Promise<boolean>;
}
async function runMenuNavigation(nav: MenuNav, deps: MenuNavDeps): Promise<PlatformTurnOutcome> {
  const { db, businessId, customerId, customerPhone, slug, facts, emojiNone, prevLowSignal, prevGreeting, memLines, persist, interactivePayloadId } = deps;
  const now = Date.now();
  let text = "";
  let link: PlatformLink = null;
  let interactive: WhatsAppInteractive | undefined;
  if (nav.kind === "book") {
    const url = buildBookingLink(slug, customerPhone);
    text = continuityText("ai_disabled", "booking", url); link = "booking"; logPlatformLink("booking", url);
    interactive = { kind: "cta_url", body: ctaBody("book"), buttonText: "לחץ כאן", url };
  } else if (nav.kind === "manage") {
    const upcoming = await listUpcomingByCustomer(db, businessId, customerId, 5);
    const m = manageLinkFor(upcoming, slug, customerPhone, customerId);
    const mo = buildManageOutcome(m, "ai_disabled"); // 0 upcoming → "no active appointment" + offer to book new
    text = mo.text; interactive = mo.interactive; link = mo.link; logPlatformLink(m.kind, m.url);
  } else {
    text = nav.reply;
    interactive = buildInteractiveForNav(nav, facts) ?? undefined; // clickable buttons/list (settings enforced at chokepoint)
  }
  if (emojiNone) text = stripEmojis(text); // text FALLBACK only; the interactive is enforced at sendOutboundInteractive
  const decision = errorDecision("menu_navigation", true);
  // Carry the counters; set the new menu cursor (TTL refreshed) so navigation continues next turn.
  await persist(prevLowSignal, prevGreeting, undefined, undefined, undefined, { node: nav.node, at: now });
  await safeLog(businessId, customerId, decision);
  // Prove in live logs that the tap was handled by STABLE PAYLOAD ID (not only the visible title).
  console.log(`[platform-turn] menu-nav kind=${nav.kind} node=${nav.node} link=${link ?? "-"} interactive=${interactive?.kind ?? "-"} interactivePayloadId=${interactivePayloadId ?? "-"}`);
  logTurnTrace({
    bookingMode: "platform", geminiCalled: false,
    route: link === "booking" ? "BOOK" : link === "manage" ? "MANAGE" : "NONE",
    routeReason: `menu_${nav.kind}`, signalKind: "productive", linkKind: link, linkAttached: link !== null,
    suppressReply: false, guardBranch: "menu_navigation", bookingEvidence: false,
    lowSignalBefore: prevLowSignal, lowSignalAfter: prevLowSignal,
    greetingBefore: prevGreeting, greetingAfter: prevGreeting,
    replySource: "fallback", memLines,
    latestSignal: "none", aggregateSignal: "none", lastAssistant: "-",
    staleTopicGuard: false, softIntent: false, contextualConfirmation: false,
    capabilityFence: false, recoveryFollowup: false, pendingResolved: false, coldYes: false,
    customerVisible: true, action: `menu_${nav.kind}${link ? `+${link}` : ""}`,
    interactivePayloadId,
  });
  return { replyText: text, decision, linkAttached: link, suppressReply: false, interactive };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function lastAssistantLine(transcript: string): string | null {
  const lines = transcript.split("\n").filter((l) => l.startsWith("Assistant (you, earlier): "));
  if (lines.length === 0) return null;
  return lines[lines.length - 1].replace("Assistant (you, earlier): ", "").replace(/\s+/g, " ").trim();
}

// ── Low-signal conversation guard ──────────────────────────────────────────────
// "Low-signal" = the model judged the turn NON-actionable AND conversationally
// empty (unclear / gibberish / off-topic / contentless small talk / a question
// about the bot). A real business question (faq) or any operation is NOT low-signal.
// Driven entirely by the model/router classification + a per-session counter — no
// hardcoded message lists.
export type LowSignalAction = "none" | "normal_clarify" | "short_clarify" | "boundary" | "quiet_mode";

export const LOW_SIGNAL_SHORT =
  "לא הצלחתי להבין 🙂 רוצה לקבוע תור, או לשאול משהו על העסק?";
export const LOW_SIGNAL_BOUNDARY =
  "נראה שאני לא מצליחה להבין את הכוונה כרגע. אפשר לכתוב שוב בצורה ברורה כשתרצה לקבוע תור או לשאול משהו על העסק.";
// Sparse reminder used RARELY in quiet mode (not every turn) — distinct from the
// boundary so we never loop the same sentence.
export const LOW_SIGNAL_QUIET_REMINDER =
  "עדיין כאן 🙂 כשיהיה ברור מה צריך — תור או שאלה על העסק — אשמח לעזור.";
// Cheap, friendly reset used when a real human greeting/meta arrives during quiet
// mode — answered WITHOUT Gemini, and the counter resets (never silently dropped).
export const QUIET_RESET =
  "אני כאן 🙂 אפשר לכתוב לי אם תרצה לקבוע תור או לשאול משהו על העסק.";
// Short, distinct sparse reminder for a DEEP repeated-greeting loop — so we never spam
// the identical full QUIET_RESET line every turn (BUG-009).
export const GREETING_SPARSE_REMINDER = "אני כאן 🙂";
// Low-Value-Input Lane: a short, scope-only refusal for a prompt-injection / override / "reveal your
// instructions" attempt — it never acknowledges or echoes the attack and reveals NOTHING internal.
export const INJECTION_REFUSAL = "אני כאן לעזור עם תורים ושאלות על העסק 🙂";
// Short, consistent deflection for an OFF-TOPIC (out_of_scope) general question — no general-knowledge
// answer, no long business re-introduction; keeps the customer in business scope.
export const OFF_TOPIC_DEFLECTION = "זה לא בתחום שלי 🙂 לגבי העסק — תורים, שירותים ושאלות — אני כאן לעזור.";
// ONE human-visible boundary shown by every low-value lane (machine-noise / injection / off-topic) BEFORE
// it goes quiet — so the customer always knows how to recover instead of hitting sudden silence. Never says
// "quiet mode"/"blocked"; just states the scope + how to get help. Shared + reusable.
export const LOW_VALUE_BOUNDARY = "אני כאן לעזור עם תורים ושאלות על העסק 🙂 כתוב/כתבי לי ברור מה צריך ואשמח לעזור.";
// Post-CTA / post-answer ACKNOWLEDGEMENT close (מעולה/תודה/מגניב …) — a natural, short close, never an
// "I didn't understand" clarify and never a CTA.
export const ACK_CLOSE = "בשמחה 🙂";
// "Deep" low-value streak threshold: at/above this, a presence ping no longer fully resets the abuse counter,
// and a signal-less off-topic message is de-escalated WITHOUT Gemini. Below it, normal recovery applies.
export const LOW_VALUE_DEEP_AT = 3;

// In a deep greeting loop, send a short reminder only every Nth turn (otherwise suppress).
const GREETING_REMINDER_EVERY = 3;
/**
 * Plans the deterministic reply for a greeting/meta turn answered WITHOUT Gemini.
 * The first few (a genuine recovery, or the first loop reset) get the full, friendly
 * QUIET_RESET; a SUSTAINED repeated-greeting loop then goes sparse — mostly suppressed,
 * with a SHORT reminder every Nth turn — so the bot never re-sends the identical full
 * line on every "היי" (BUG-009). Never silent on the first reset, never cold.
 * `greetingCount` is the NEW (post-increment) consecutive greeting count.
 */
export function greetingResetPlan(greetingCount: number): { reply: string; suppressReply: boolean } {
  if (greetingCount <= 3) return { reply: QUIET_RESET, suppressReply: false };
  const idx = greetingCount - 3; // 1, 2, 3, … into the deep loop
  if (idx % GREETING_REMINDER_EVERY === 0) return { reply: GREETING_SPARSE_REMINDER, suppressReply: false };
  return { reply: "", suppressReply: true };
}

export function readLowSignalCount(context: Record<string, unknown>): number {
  const n = context?.consecutiveLowSignalTurns;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Consecutive greeting/meta turns (separate from low-signal — greetings are NOT
 *  spam and never count toward quiet mode; this counter only caps a greeting LOOP's
 *  Gemini cost). Reset to 0 by any non-greeting turn. */
export function readGreetingCount(context: Record<string, unknown>): number {
  const n = context?.consecutiveGreetingTurns;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// ── SHORT-TERM PENDING OFFER (conversation continuity — NOT a CRM / not long-term memory) ──
// A tiny per-customer record of the LAST platform-safe action we offered or attached, so a
// LATER bare confirmation ("כן", "סבבה", "תשלח") — even after intervening turns or a time gap —
// resolves to THAT offer instead of arriving cold. Lives in the EXISTING (always-idle) platform
// conversation_states.context (one object, merge-safe) and is TTL-bounded. Business-agnostic:
// it records the OPERATION kind + the discussed service NAME (whatever the business configured),
// never an industry assumption. We deliberately store NO personal/off-topic detail here.
export const PENDING_OFFER_TTL_MS = 3 * 60 * 60 * 1000; // 3h — a booking offer stays warm for hours, not days
export interface PendingOffer {
  kind: "BOOK" | "MANAGE";
  service?: string;   // last discussed service name (for warmth), or undefined
  at: number;         // epoch ms when offered
}
/** Reads a still-VALID pending offer (within TTL), or null. Expiry is enforced on read so we
 *  never delete state — a stale offer simply stops counting as pending. */
export function readPendingOffer(context: Record<string, unknown>, now: number = Date.now()): PendingOffer | null {
  const p = context?.pendingOffer as Partial<PendingOffer> | undefined;
  if (!p || (p.kind !== "BOOK" && p.kind !== "MANAGE")) return null;
  if (typeof p.at !== "number" || !Number.isFinite(p.at)) return null;
  if (now - p.at > PENDING_OFFER_TTL_MS || now - p.at < 0) return null; // expired (or clock skew)
  return { kind: p.kind, service: typeof p.service === "string" && p.service.trim() ? p.service : undefined, at: p.at };
}

// ── DEGRADED-NOTICE RATE LIMIT (degraded = state, not per-inbound spam) ──────────
// The provider cooldown is process-global, so during an incident EVERY inbound would
// otherwise emit another "יש לי רגע עומס…". We send at most ONE generic degraded notice per
// conversation per window, then go quiet — a direct recovery/accountability answer or an
// explicit booking link is still allowed. Stored in the existing per-customer state.
export const DEGRADED_NOTICE_MIN_GAP_MS = 90 * 1000; // ≥ the 60s provider cooldown, so a burst stays quiet
export function readLastDegradedAt(context: Record<string, unknown>): number {
  const n = context?.lastDegradedAt;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}
/** True when a fresh generic degraded notice is allowed (none sent within the window). */
export function degradedNoticeAllowed(context: Record<string, unknown>, now: number = Date.now()): boolean {
  const last = readLastDegradedAt(context);
  return last === 0 || now - last >= DEGRADED_NOTICE_MIN_GAP_MS || now - last < 0;
}

// ── PENDING FAILED NEED (transient-503 message preservation) ─────────────────────
// When a FAQ/unclear message hits a TRANSIENT 503 (one blip, provider still healthy), we keep
// the customer's original text so the NEXT healthy turn can recover it (re-injected as model
// guidance, or bridged into the recovery reply) — the message is never silently swallowed.
// Short TTL because a transient blip recovers fast; the saved transcript is the durable record.
export const PENDING_FAILED_NEED_TTL_MS = 10 * 60 * 1000;
export interface PendingFailedNeed { text: string; at: number; }
export function readPendingFailedNeed(context: Record<string, unknown>, now: number = Date.now()): PendingFailedNeed | null {
  const p = context?.pendingFailedNeed as Partial<PendingFailedNeed> | undefined;
  if (!p || typeof p.text !== "string" || !p.text.trim()) return null;
  if (typeof p.at !== "number" || !Number.isFinite(p.at)) return null;
  if (now - p.at > PENDING_FAILED_NEED_TTL_MS || now - p.at < 0) return null;
  return { text: p.text.slice(0, 300), at: p.at };
}

/**
 * Persists platform state (always idle). MERGES `priorContext` so unrelated fields
 * survive a low-signal update (Risk F). SKIPS the write entirely when `checkSuperseded`
 * reports a newer inbound already arrived (Risk E) — the router will skip this turn's
 * reply too, so a superseded burst turn must not mutate the counters. Returns whether
 * the write happened. Exported so the contract is unit-testable without a live DB.
 */
export async function persistPlatformState(
  db: DB, businessId: string, customerId: string,
  low: number, greet: number, priorContext: Record<string, unknown>,
  checkSuperseded?: () => Promise<boolean>,
  pending?: PendingOffer | null,
  lastDegradedAt?: number,
  failedNeed?: PendingFailedNeed | null,
  menu?: MenuState | null
): Promise<boolean> {
  if (checkSuperseded && (await checkSuperseded())) {
    console.log("[platform-turn] superseded before persist — state NOT mutated");
    return false;
  }
  // priorContext is merged (Risk F) so an existing pendingOffer survives a low-signal/greeting
  // update. Each optional field: undefined ⇒ leave as-is (carry forward), object ⇒ set, null ⇒ clear.
  const next: Record<string, unknown> = {
    ...priorContext, consecutiveLowSignalTurns: low, consecutiveGreetingTurns: greet,
  };
  if (pending !== undefined) {
    if (pending === null) delete next.pendingOffer;
    else next.pendingOffer = pending;
  }
  if (lastDegradedAt !== undefined) next.lastDegradedAt = lastDegradedAt;
  if (failedNeed !== undefined) {
    if (failedNeed === null) delete next.pendingFailedNeed;
    else next.pendingFailedNeed = failedNeed;
  }
  if (menu !== undefined) {
    if (menu === null) delete next.menu;            // exit the menu cursor (back to AI-first)
    else next.menu = menu;                          // enter/advance the menu cursor
  }
  await upsertConversationState(db, businessId, customerId, "idle", next);
  return true;
}

// Compact recognizer for normal greetings / "are you there?" / follow-up meta — a
// SMALL bounded set (not a gibberish blacklist) so quiet mode can answer a real
// human cheaply instead of suppressing them. Only short messages qualify; anything
// with a booking/service signal is productive, not a greeting.
const GREETING_META_RE =
  /^(היי+|הי|שלום|הלו+|אהלן|בוקר טוב|ערב טוב|צהריים טובים|מה קורה|מה נשמע|מה המצב|מה חדש|מה איתך|יש תשובה|יש מישהו|אתה שם|את שם|אתם שם|מישהו שם|את פה|אתה פה|אתם פה|למה לא ענית|למה אתה לא עונה|למה את לא עונה|מה קורה פה|מה קורה כאן|מה אתה עושה)(?=\s|$)/;
/** Collapses 3+ repeated characters to one ("מצבבב"→"מצב", "היייי"→"היי"→"הי"+) so a
 *  social opener / greeting survives WhatsApp elongation. General — no per-word list. */
export function collapseElongation(s: string): string {
  return (s ?? "").replace(/(.)\1{2,}/gu, "$1");
}
export function looksLikeGreetingOrMeta(message: string, serviceNames: string[] = []): boolean {
  // Collapse elongation first so "מה המצבבב" / "נשמעעע" still read as social openers
  // (the live FAQ-contamination bug: "מה המצבבב" fell through to a business-FAQ label).
  const t = collapseElongation((message ?? "").trim().replace(/[?!.…״"'\s]+$/g, "").trim());
  if (t.length === 0 || t.length > 22) return false; // greetings/meta are short
  if (hasBookingSignal(t, serviceNames)) return false; // productive, not a greeting
  if (hasPoliteInquiry(t)) return false;               // inquiry opener ("היי אשמח לדעת") outranks greeting
  return GREETING_META_RE.test(t);
}

// PRESENCE / RECOVERY checks vs warm SOCIAL openers — both are "greetings", but they
// deserve DIFFERENT handling. A presence check ("אתה פה?", "למה לא ענית?") is the customer
// probing a silent/stuck line → the deterministic recovery reply is appropriate. A warm
// social opener ("היי מה קורה") is normal smalltalk → it should feel NATURAL (go to Gemini),
// not a stiff "system is here" line, unless we're genuinely recovering (quiet/loop/burst).
const PRESENCE_CHECK_RE =
  /^(הלו+|יש תשובה|יש מישהו|אתה שם|את שם|אתם שם|מישהו שם|את פה|אתה פה|אתם פה|למה לא ענית|למה אתה לא עונה|למה את לא עונה|מה קורה פה|מה קורה כאן)(?=\s|$)/;
const SOCIAL_OPENER_RE =
  /^(היי+|הי|שלום|אהלן|בוקר טוב|ערב טוב|צהריים טובים|מה קורה|מה נשמע|מה המצב|מה חדש|מה איתך|מה הולך|מה אתה עושה|מה העניינים|מה קורה אחי|מה נשמע אחי)(?=\s|$)/;
/** True for a presence/recovery check ("are you there?", "why no answer?"). */
export function looksLikePresenceCheck(message: string): boolean {
  const t = collapseElongation((message ?? "").trim().replace(/[?!.…״"'\s]+$/g, "").trim());
  if (t.length === 0 || t.length > 22) return false;
  return PRESENCE_CHECK_RE.test(t);
}
/** True for a warm social opener ("hey, what's up") — natural smalltalk, not a presence probe. */
export function looksLikeSocialOpener(message: string, serviceNames: string[] = []): boolean {
  const t = collapseElongation((message ?? "").trim().replace(/[?!.…״"'\s]+$/g, "").trim());
  if (t.length === 0 || t.length > 22) return false;
  if (hasBookingSignal(t, serviceNames)) return false;
  if (hasPoliteInquiry(t)) return false;   // "היי אשמח לדעת" is an inquiry opener, not a social hello
  return SOCIAL_OPENER_RE.test(t);
}

// ── Degraded-mode / recovery follow-up recognizers ─────────────────────────────
// After we sent a degraded/overload notice, a short "did it recover?" question
// ("הסתדר?", "עובד עכשיו?", "עדיין יש עומס?") is a SYSTEM-recovery follow-up — not
// "how are you?" smalltalk. Detected only WHEN our last reply was degraded, so the
// context disambiguates; kept general (no single-phrase overfit).
const DEGRADED_MARKER_RE = /עומס|שיהוק|השתבש|תקלה|אחזור אלי|נסו?\s+שוב\s+עוד\s+רגע|בעוד\s+דקה/;
// Broad recovery class — "are you back / working / available now?". "זמינ" (available) is
// included on purpose: it's ambiguous with appointment-availability, but this regex is ONLY
// consulted AFTER a degraded reply (recentlyDegraded), where it unambiguously means "are you back".
const RECOVERY_FOLLOWUP_RE =
  /הסתדר|עובד\s+עכשיו|עכשיו\s+עובד|עובד\??$|זה\s+עבד|חזרת|חזרנו|חזר\s|תקין|נפתר|עדיין\s+(יש\s+)?עומס|עבר\s+ה?עומס|הכל\s+(בסדר|עובד)\s+עכשיו|זמי[נן]|אפשר\s+עכשיו|אפשר\s+להמשיך/;
// The user REFERENCES / quotes / corrects us about a PRIOR system/overload message ("שאלתי לגבי
// הזמינות שלך", "כי כתבת שיש עומס", "הנה תראה", "זה מה שאמרת"). After a degraded reply this is an
// accountability challenge → acknowledge + repair, never deny or blame.
const ACCOUNTABILITY_RE =
  /הזמינות\s+שלך|שאלתי\s+(על\s+|לגבי\s+)?ה?זמינות|כי\s+כתבת|כתבת\s+ש?\s*(יש|היה)?\s*עומס|אמרת\s+ש?\s*(יש|היה|לך)?\s*עומס|אמרת\s+ש?יש\s+לך|זה\s+מה\s+ש(אמרת|כתבת)|אמרת\s+(קודם|לפני)|לזה\s+התכוונתי|הנה\s+תראה|תראה\s+מה\s+ש(אמרת|כתבת)/;
/** True when OUR most recent reply was a degraded/overload/error notice. */
export function wasDegradedReply(lastAssistant: string | null | undefined): boolean {
  return !!lastAssistant && DEGRADED_MARKER_RE.test(lastAssistant);
}
/** True when ANY of our last few assistant lines were degraded notices — robust to a degraded
 *  reply being followed by superseded/recovered turns (the last line alone may not be degraded). */
export function recentlyDegraded(transcript: string, lookback: number = 3): boolean {
  const lines = (transcript ?? "").split("\n").filter((l) => l.startsWith("Assistant (you, earlier): "));
  return lines.slice(-lookback).some((l) => DEGRADED_MARKER_RE.test(l));
}
/** True when the message asks whether the system recovered (only meaningful after a degraded
 *  reply — the caller gates on recentlyDegraded). */
export function isRecoveryFollowup(message: string): boolean {
  const t = (message ?? "").trim();
  if (t.length === 0 || t.length > 30) return false;
  return RECOVERY_FOLLOWUP_RE.test(t);
}
/** True when the message references/quotes/corrects us about a prior system message (gated on
 *  recentlyDegraded by the caller). "הנה תראה" lives here — it's the user pointing at our message. */
export function isAccountabilityChallenge(message: string): boolean {
  const t = (message ?? "").trim();
  if (!t || t.length > 60) return false;
  return ACCOUNTABILITY_RE.test(t);
}

// ── DETERMINISTIC CONTINUITY MODE (AI unavailable) — one shared intent classifier ─
// When Gemini is overloaded/cooling down we cannot understand free text, so the degraded path
// must NOT guess. It follows an EXPLICIT priority, identical in the pre-call cooldown path and
// the in-call 503 path (no separate ad-hoc branches): system frame first, then an EXPLICIT
// appointment operation, else a neutral continuity menu. Crucially it NEVER uses the loose
// booking SIGNAL ("זמינות"/service words) to attach a link — only an explicit operation verb —
// so a mixed FAQ/meta/recovery burst can never be misframed as a booking (the live degraded+booking bug).
export type DegradedIntent = "accountability" | "recovery" | "booking" | "manage" | "menu";
// No serviceNames param BY DESIGN — the degraded path must NEVER infer booking from a service
// word; only an explicit operation verb attaches a link.
export function classifyDegradedIntent(messageText: string): DegradedIntent {
  const latest = latestFragment(messageText);
  const either = (fn: (s: string) => boolean): boolean => fn(latest) || fn(messageText);
  // 1) The customer is asking/repairing about OUR overload — answer in the system frame.
  if (either(isAccountabilityChallenge)) return "accountability";
  if (either(isRecoveryFollowup)) return "recovery";
  // 2) EXPLICIT appointment operation only (never the ambiguous "זמינות"/hasBookingSignal).
  const op = inferOperation(latest) ?? inferOperation(messageText);
  if (op === "BOOK") return "booking";
  if (op === "CANCEL" || op === "RESCHEDULE" || op === "LIST" || either(isManageHelpTopic)) return "manage";
  // 3) FAQ / mixed / meta / unknown → neutral continuity menu (NO link).
  return "menu";
}

// ── Cheap LOCAL low-signal detector (no Gemini) ────────────────────────────────
// Recognizes OBVIOUS nonsense so quiet mode can short-circuit before the model:
// single chars, punctuation-only, keyboard-smash, Hebrew consonant clusters,
// misplaced final-form letters. Deliberately HIGH-PRECISION and conservative —
// anything with a booking/service signal, a space (multi-word), a "?", or vowel
// structure is left for Gemini. No blacklist; purely structural.
const HEB_FINAL = "ךםןףץ"; // final-form letters — valid only at a word's end
const HEB_VOWEL = "אהוי";  // mater lectionis — almost every real Hebrew word has one
const isHebrewChar = (c: string): boolean => {
  const n = c.charCodeAt(0);
  return n >= 0x0590 && n <= 0x05ff;
};

export function looksLikeNoise(message: string, serviceNames: string[] = []): boolean {
  const t = (message ?? "").trim();
  if (!t) return false;
  if (hasBookingSignal(t, serviceNames)) return false;     // productive → never noise
  if (t.length <= 1) return true;                           // single character
  if (/^[^\p{L}\p{N}]+$/u.test(t)) return true;             // punctuation/symbols only
  if (t.includes("?") || t.includes("؟")) return false;     // a question → let Gemini decide
  if (/\s/.test(t)) return false;                           // multi-word → conservative, let Gemini
  // Single token: structural gibberish signals.
  const chars = [...t];
  for (let i = 0; i < chars.length - 1; i++) {
    if (HEB_FINAL.includes(chars[i])) return true;          // final-form letter mid-word
  }
  const hasVowel = chars.some((c) => HEB_VOWEL.includes(c));
  const hebrewCount = chars.filter(isHebrewChar).length;
  // Hebrew "mater lectionis" (א/ה/ו/י) appear in almost every real word; a 4+ letter
  // single token with NONE is a consonant smash ("חבצב", "חכלגצג"). 3-letter no-vowel
  // words exist ("מחר") so the floor is 4.
  if (!hasVowel && hebrewCount >= 4) return true;
  return false;
}

/**
 * True for an EMOJI-ONLY message: at least one pictographic emoji and NO meaningful
 * letters or digits (so emoji + modifiers / skin tones / ZWJ / variation selectors /
 * punctuation / whitespace all qualify). General, not a blacklist. Mixed text+emoji
 * ("תודה 😊") returns false. */
export function isEmojiOnly(message: string): boolean {
  const t = (message ?? "").trim();
  if (!t) return false;
  if (!/\p{Extended_Pictographic}/u.test(t)) return false; // must contain an emoji
  return !/[\p{L}\p{N}]/u.test(t);                          // and no letters/digits anywhere
}

// ── Quiet-mode sparse-reply planner ────────────────────────────────────────────
// Quiet mode starts at the 4th consecutive low-signal turn (the boundary was the
// 3rd). We then go mostly silent and emit ONE short reminder only every N turns,
// so we neither spam the same line forever nor ghost a possibly-confused user.
const QUIET_REMINDER_EVERY = 4;
export function quietModePlan(count: number): { isQuiet: boolean; suppressReply: boolean } {
  if (count < 4) return { isQuiet: false, suppressReply: false };
  const quietIndex = count - 3; // 1, 2, 3, …
  const sendReminder = quietIndex % QUIET_REMINDER_EVERY === 0;
  return { isQuiet: true, suppressReply: !sendReminder };
}

// ── Low-Value-Input FAST quiet ladder (machine-noise + injection) ─────────────────
// For CONFIDENT low-value input (deterministic machine-noise / a prompt-injection attempt) the lane is
// faster than the good-faith ladder, but ALWAYS shows ONE human-visible BOUNDARY before going silent:
//   turn 1 → a specific deterministic line · turn 2 → the shared visible boundary (how to recover) ·
//   turn 3+ → quiet (mostly suppressed, a sparse reminder every Nth turn so a (mis)detection never fully
//   ghosts the customer). The caller still applies the good-faith guard (isGoodFaithLowSignal) before
//   suppressing, so a real confused human is never silenced. PURE → eval-testable.
function lowValueQuietPlan(count: number, firstLine: string): { replyText: string; suppressReply: boolean } {
  if (count <= 1) return { replyText: firstLine, suppressReply: false };
  if (count === 2) return { replyText: LOW_VALUE_BOUNDARY, suppressReply: false }; // ONE visible boundary before silence
  const idx = count - 2; // 1, 2, 3, … into the quiet phase (quiet begins at turn 3, after the boundary)
  const sendReminder = idx % QUIET_REMINDER_EVERY === 0;
  return sendReminder ? { replyText: LOW_SIGNAL_QUIET_REMINDER, suppressReply: false } : { replyText: "", suppressReply: true };
}
/** Confident machine-noise: turn 1 → clarify, turn 2 → visible boundary, turn 3+ → quiet. */
export function machineNoisePlan(count: number): { replyText: string; suppressReply: boolean } {
  return lowValueQuietPlan(count, LOW_SIGNAL_SHORT);
}
/** Prompt-injection: turn 1 → scope refusal, turn 2 → visible boundary, turn 3+ → quiet (no Gemini). */
export function injectionPlan(count: number): { replyText: string; suppressReply: boolean } {
  return lowValueQuietPlan(count, INJECTION_REFUSAL);
}

// ── GOOD-FAITH low-signal (Phase 4A — never walk a confused human into silence) ──────────────────
// A confused-but-HUMAN message — a bare "what?", a string of question marks, "I didn't understand" —
// as opposed to MACHINE NOISE (keysmash, emoji-only, consonant clusters). Consulted ONLY at the
// quiet-mode SUPPRESSION points (AI-lane): when quiet mode would otherwise go SILENT, a good-faith
// message instead gets a short visible reminder. Machine noise can still go quiet (anti-spam intact).
// Affects suppression ONLY — never routing, booking/manage, links, or deterministic mode.
const GOODFAITH_PUNCT_RE = /^[?？!！]+$/; // "?", "??", "???", "?!" — a person asking "huh?"
export function isGoodFaithLowSignal(message: string): boolean {
  const t = (message ?? "").trim();
  if (!t || t.length > 30) return false;
  return GOODFAITH_PUNCT_RE.test(t) || META_ONLY_RE.test(t); // META_ONLY_RE: "מה?", "לא הבנתי", "מה זה", …
}

// ── PROMPT-INJECTION detector (input-side safety lane) ────────────────────────────
// HIGH-PRECISION typed marker set (he/en) for attempts to (a) EXTRACT internals — the system/developer
// prompt, internal rules/instructions — or (b) OVERRIDE/JAILBREAK — ignore/forget the rules, role-swap.
// Anchored so legitimate business wording never trips: "הוראות"/"כללים"/"הנחיות" only count when bound to
// "המערכת"/"הפנימיות" (system/internal) or to an override verb — so "הוראות הגעה" (directions) is SAFE.
// Precision over recall (the output disclosure fence stays as defense-in-depth for anything that slips to
// Gemini). Drives a deterministic refusal lane; never affects routing/booking/manage. PURE → eval-testable.
const INJECTION_RE = new RegExp([
  // (a) EXTRACTION — reveal internals:
  "system\\s*(prompt|instructions?|message)", "developer\\s*(prompt|message|instructions?)",
  "הפרומפט", "סיסטם\\s*פרומפט",
  "הוראות\\s*המערכת", "הנחיות\\s*המערכת", "ה?הוראות\\s*הפנימיות", "ה?כללים\\s*הפנימיים",
  "(מה\\s*כתוב|תראה|תגלה|תוציא|תחשוף|תדפיס|הראה)\\s*\\S{0,12}\\s*(פרומפט|הוראות\\s*המערכת|הנחיות\\s*המערכת)",
  // (b) OVERRIDE / JAILBREAK:
  "ignore\\s+(?:the\\s+|your\\s+|all\\s+|any\\s+|previous\\s+|above\\s+)*(instructions?|rules?|prompt)",
  "disregard\\s+\\S{0,15}\\s*(instructions?|rules?)", "override\\s+\\S{0,15}\\s*(instructions?|rules?|system)",
  "תתעלם\\s*מ(?:ה)?\\s*(הוראות|כללים|הנחיות)", "תשכח\\s*(?:את\\s*)?(?:ה)?(הוראות|כללים|הנחיות)",
  "אל\\s*תתייחס\\s*ל(?:ה)?(הוראות|כללים|הנחיות)",
  "\\bDAN\\b", "jailbreak", "אתה\\s*עכשיו\\s*לא\\s*ה?(בוט|עוזר|מערכת)",
  "you\\s*are\\s*(?:now\\s*)?(?:a\\s*|an\\s*)?(?:dan|different|not\\s*the)", "act\\s+as\\s+(?:a|an|if)", "pretend\\s+(?:you|to\\s*be|that)",
].join("|"), "i");
/** True when the message is (most likely) a prompt-injection / override / internal-disclosure attempt. */
export function looksLikeInjection(message: string): boolean {
  return INJECTION_RE.test((message ?? "").trim());
}

/** Does this turn push toward QUIET MODE? Only truly low-content turns do —
 *  gibberish and meaningless "unclear". Real business questions (faq), operations,
 *  AND ordinary greetings/smalltalk/meta are NOT counted (BUG-005: a greeting is a
 *  legitimate human message, not spam). */
export function isLowSignalTurn(d: ReceptionistDecision): boolean {
  if (!d.ok || !d.turn) return false;
  const u = d.turn.understanding;
  if (u.requestsBusinessAction) return false;       // an operation is productive
  if (u.intent === "faq") return false;             // a real business question is productive
  return u.intent === "unclear" || u.intent === "out_of_scope";
}

export type LowSignalKind = "gibberish" | "emoji" | "unclear" | "smalltalk" | "meta" | "productive" | "out_of_domain";

// ── BUSINESS ANCHOR (deterministic FAQ protection) ───────────────────────────────
// True when the message carries a concrete business signal — a booking/operation verb or configured
// service (hasBookingSignal), a price/cost question (hasFaqSignal), a manage/cancel/list/link topic
// (isManageHelpTopic), or a recognized business-info topic such as hours/location/parking/policy/contact
// (detectInfoTopic). This is the SINGLE definition of "looks business-relevant", reused by the repeated-
// off-topic cap and by lowSignalKind's relevance branch. It only ever RESCUES (protects a real FAQ from
// being counted/suppressed) — it is never used to suppress a message, so it can't over-block. Pure.
export function hasBusinessAnchor(message: string, serviceNames: string[] = []): boolean {
  return hasBookingSignal(message, serviceNames) || hasFaqSignal(message)
    || isManageHelpTopic(message) || detectInfoTopic(message) !== null;
}

/** Fine-grained kind for logging + counting. gibberish/unclear push toward quiet
 *  mode; smalltalk/meta/productive do not. */
// ── CUSTOMER SAFETY: good-faith signal classifier (Platform Safety Contract v1) ──
// ONE typed classifier instead of scattered ad-hoc detectors: given the customer's
// LATEST message, name the good-faith category it carries. A turn with ANY good-faith
// signal is PRODUCTIVE and must NEVER be suppressed/escalated as spam — even when the
// model mislabeled it `unclear`. Live failures this fixes: a price question and "the
// first one" answers escalated toward quiet/boundary; a help request after the bot
// offered help became a cold boundary; "אוקיי בוא נקבע" after noise was silently
// swallowed by quiet mode (no reply at all).

// Price/cost FAQ signal.
const FAQ_PRICE_RE = /כמה.{0,8}(עולה|יעלה|עולים|מחיר|עלות)|מה\s+ה?(מחיר|עלות|מחירים)|בכמה|(?:^|[\s,])ה?(מחיר|עלות|מחירון)(?=$|[\s,.!?])/;
/** True when the message is (most likely) a business price/cost QUESTION. */
export function hasFaqSignal(message: string): boolean {
  return FAQ_PRICE_RE.test((message ?? "").trim());
}

// Short ORDINAL / referential follow-up ("הראשון", "השני מביניהם", typo "הראשו7").
// "השני" (with ה) is required so "יום שני" (Monday) does not false-match.
const REFERENCE_RE = /ראשו[ןנ7]|ראשונה|שנייה|שניה|השני(?=$|[\s,.!?])|שליש|רביעי|חמישי|שישי|אחרונה|אחרון|אמצע|מביניהם|מבניהם|ביניהם|מהם/;
/** True for a short ordinal/referential answer (refers to a prior listed option). */
export function looksLikeContextualReference(message: string): boolean {
  const t = (message ?? "").trim();
  if (!t || t.length > 30) return false; // referential follow-ups are short
  return REFERENCE_RE.test(t);
}

// HELP / link-trouble / conversation-repair ("צריך עזרה", "איך אני מבטל", "לא נפתח",
// "מסתבך עם הקישור", "אמרת שתעזור"). The customer is asking for help in good faith.
const HELP_RE = /צריך\s+עזרה|רוצה\s+עזרה|אפשר\s+עזרה|תעזור|תעזרי|עזור\s+לי|עזרי\s+לי|איך\s+(אני\s+)?(מבטל|מבטלים|מזיז|מזיזים|משנה|משנים|קובע|קובעים|מזמין|לבטל|לשנות|לקבוע|להזיז)|איך\s+(זה\s+)?עובד|איפה\s+(לוחצים|ללחוץ|הקישור|הלינק)|לא\s+(נפתח|עובד|מצליח|הצלחתי|עובדת|רואה)|מסתבך|לא\s+מבין(\s+איך|\s+אותי)?|שלחת\s+(לי\s+)?שוב|אותו\s+(דבר|קישור|לינק)|אמרת\s+ש|זה\s+לא\s+מה\s+ששאלתי|אתה\s+לא\s+מבין|למה\s+(אתה|את)\s+לא\s+(עונה|ענית|עונים)|אני\s+לא\s+מצליח|לא\s+רואה\s+(את\s+)?ה?כפתור/;
/** True when the message asks for help, reports a link problem, or repairs/expresses
 *  frustration about the conversation ("אמרת שתעזור", "אתה לא מבין", "למה לא ענית"). */
export function hasHelpSignal(message: string): boolean {
  return HELP_RE.test((message ?? "").trim());
}

// Colloquial booking IMPERATIVES the operation-verb list (routing.ts) doesn't cover
// ("בוא נקבע", "תקבע לי", "נסגור תור"). Used only for the good-faith ACTION category.
const BOOKING_IMPERATIVE_RE = /בוא\s+נקבע|בוא\s+נסגור|בוא\s+נזמין|בוא\s+נתאם|נקבע\s+תור|נסגור\s+תור|תקבע(י)?\s+לי|קבע(י)?\s+לי|רוצה\s+לסגור\s+תור/;

const QUESTION_WORD_RE = /^(כמה|מה|האם|למה|מדוע|איך|כיצד|איפה|היכן|מתי|אילו|איז[הו])(\s|$|[?？])/;
/** A question (has '?' or opens with a question word) — keeps a QUESTION about an
 *  operation ("כמה עולה לבטל?") OUT of the imperative ACTION category. */
export function isQuestionLike(message: string): boolean {
  const t = (message ?? "").trim();
  return /[?？]/.test(t) || QUESTION_WORD_RE.test(t);
}

// Business-FAQ openers that don't need a "?" ("יש חניה", "מקבלים ביט", "אתם פתוחים
// היום", "אפשר לשלם", "מה כולל השירות"). Business-agnostic — generic question shapes.
const FAQ_OPENER_RE = /^(אפשר|מקבלים|מקבל|אתם|פתוחים|פתוח|האם)(\s|$|[?？])|^(יש|מה|כמה|מתי|איפה|כיצד)(\s|[?？])/;
// Polite / fragmented business-inquiry openers ("אשמח לדעת אם…", "רציתי לשאול אם…",
// "אפשר לדעת איפה…") — a productive FAQ even when split across WhatsApp messages and the LAST
// fragment alone looks incomplete ("אם יש איפה לשבת"). General class, not a per-question list.
const POLITE_INQUIRY_RE =
  /אשמח\s+(לדעת|לשמוע|לברר|לשאול)|רצית[יה]\s+(לשאול|לדעת|לברר)|אפשר\s+(לדעת|לשאול|לברר)|רוצה\s+(לדעת|לשאול|לברר)|תהית[יי]|מעניין\s+אותי|השאלה\s+(שלי\s+)?היא|שאלה\s+קצרה/;
/** True for a polite/indirect business inquiry opener (often the first fragment of a split FAQ). */
export function hasPoliteInquiry(message: string): boolean {
  return POLITE_INQUIRY_RE.test((message ?? "").trim());
}
/** A genuine multi-word business QUESTION (not a bare meta "מה?", not gibberish) — a
 *  productive FAQ even when the model can't answer it or mislabels it `unclear`. */
export function isGenuineQuestion(message: string, serviceNames: string[] = []): boolean {
  const t = (message ?? "").trim();
  if (t.length < 4 || !/\s/.test(t)) return false;          // multi-word only
  if (!isQuestionLike(t) && !FAQ_OPENER_RE.test(t)) return false; // a question OR a FAQ opener
  if (META_ONLY_RE.test(t)) return false;                   // bare meta is handled separately
  if (looksLikeGreetingOrMeta(t, serviceNames)) return false; // social opener ("מה המצב"), not a business Q
  if (looksLikeNoise(t, serviceNames)) return false;        // not gibberish
  return true;
}

// ── SOFT SERVICE INTENT (Customer Safety Contract v1 — soft intent) ──────────────
// Indirect "I'm considering a service / coming in" messages that carry NO explicit
// booking verb and NO literal service-name match — so the verb/noun booking-signal
// misses them and the model often can't name a clean operation ("חשבתי על להסתפר,
// יש לי טיסה ליוון..."). Business-AGNOSTIC by construction: a generic DESIRE /
// consideration cue PLUS a service/visit/event CONTEXT cue. NEVER industry verbs.
// BOTH are required, so a desire with no service context ("חשבתי שאתם יקרים") is NOT
// soft intent. Works the same for a haircut, a Pilates class, a physio session, a facial.
// NOTE: Hebrew final forms — masc "צריך"/"מתכנן"/"מעוניין" end in a FINAL letter (ך/ן),
// so the stems must allow both the regular and final glyph ([כך]/[נן]) or they silently
// miss the masculine ("אני צריך" was the live eval miss).
const SOFT_DESIRE_RE =
  /חשבתי\s+(על|ל|לבוא|לקפוץ)|בא\s+לי|מתחשק\s+לי|מעוניי[נן]|הייתי\s+רוצ|רוצה\s+ל|אני\s+צרי[כך]|מתלבט|מתכנ[נן]|שוקל(ת)?|אשמח\s+ל|נראה\s+לי\s+ש?אני/;
const SOFT_CONTEXT_RE =
  /לפני\s+ה|יש\s+לי\s+(אירוע|חתונה|טיסה|חג|משחק|פגישה|ראיון|תאריך|בר\s*מצווה)|השבוע|השבת|עוד\s+מעט|בקרוב|לבוא\s+אליכם|להגיע\s+אליכם|לבוא\s+אצלכם|לקפוץ\s+אליכם/;
/**
 * True for an INDIRECT service/booking-intent message: a desire/consideration cue PLUS
 * a service/visit/event context (a generic service noun / configured service name /
 * booking verb via hasBookingSignal, OR an event/visit cue). Both required → narrow.
 * Business-agnostic; never keys on industry-specific verbs.
 */
export function hasSoftServiceIntent(message: string, serviceNames: string[] = []): boolean {
  const t = (message ?? "").trim();
  if (!t || !SOFT_DESIRE_RE.test(t)) return false;
  return hasBookingSignal(t, serviceNames) || SOFT_CONTEXT_RE.test(t);
}

export type GoodFaithSignal = "action" | "help" | "presence" | "soft_intent" | "faq" | "contextual_ref" | "none";

/**
 * THE good-faith classifier (Customer Safety Contract v1). Operates on the customer's
 * LATEST message. Returns the highest-priority good-faith category, in contract order:
 *   action > help > presence > faq > contextual_ref > none.
 * Any non-"none" result means the turn is good-faith and must NOT be suppressed.
 */
export function classifyGoodFaithSignal(message: string, opts: { serviceNames?: string[] } = {}): GoodFaithSignal {
  const t = (message ?? "").trim();
  if (!t) return "none";
  const serviceNames = opts.serviceNames ?? [];
  // 1) explicit action INTENT (imperative) — but never a QUESTION about an operation.
  if (!isQuestionLike(t) && (messageOperation(t) !== null || BOOKING_IMPERATIVE_RE.test(t))) return "action";
  // 2) help / link-trouble / conversation-repair.
  if (hasHelpSignal(t)) return "help";
  // 3) presence / "are you there?".
  if (looksLikeGreetingOrMeta(t, serviceNames)) return "presence";
  // 4) soft service/booking intent — indirect "considering a service / coming in".
  //    Ranked ABOVE faq so "חשבתי להסתפר... מה כדאי?" is soft intent, not a generic FAQ.
  if (hasSoftServiceIntent(t, serviceNames)) return "soft_intent";
  // 5) productive business question (price, any genuine multi-word question, OR a polite
  //    inquiry opener like "אשמח לדעת אם…" — which may arrive split across messages).
  if (hasFaqSignal(t) || isGenuineQuestion(t, serviceNames) || hasPoliteInquiry(t)) return "faq";
  // 6) short ordinal/contextual reference to a prior listed option.
  if (looksLikeContextualReference(t)) return "contextual_ref";
  return "none";
}

/** The customer's LATEST message inside an aggregated burst ("frag1\nfrag2\n…") — the
 *  latest actionable/help/FAQ line must win over earlier noise (Contract: latest wins). */
export function latestFragment(message: string): string {
  const frags = (message ?? "").split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  return frags.length > 0 ? frags[frags.length - 1] : (message ?? "").trim();
}

export function lowSignalKind(
  d: ReceptionistDecision, message: string, serviceNames: string[] = [], latestSignal?: GoodFaithSignal
): LowSignalKind {
  if (!d.ok || !d.turn) return "unclear";
  const u = d.turn.understanding;
  const latest = latestFragment(message);
  if (u.intent === "faq") return "productive";
  if (claimsOperation(u)) return "productive";          // evidence gate already ran upstream
  // Gibberish wins over a model smalltalk/meta MISLABEL ("חבצב" labeled smalltalk is
  // still noise) — checked on the LATEST fragment so a burst's last line decides.
  if (looksLikeNoise(latest, serviceNames)) return "gibberish";
  // RELEVANCE (model is the authority): an `out_of_scope` verdict means the turn is OUT-OF-DOMAIN and must
  // COUNT toward quiet — REGARDLESS of question-shape. This closes the central cost loophole: a trivia
  // question ("כמה אנשים יש באיטליה?") used to be rescued to `productive` by the faq-SHAPE check below
  // (classifyGoodFaithSignal sees shape, not topic), so repeated trivia never escalated. ASYMMETRIC FAQ
  // protection: if the message carries a real business anchor, the model likely erred on a genuine business
  // topic → keep it `productive` (a real FAQ is never counted/suppressed). This rescues, never suppresses.
  if (u.intent === "out_of_scope") {
    return hasBusinessAnchor(message, serviceNames) ? "productive" : "out_of_domain";
  }
  // Respect the model's conversational labels: a greeting/smalltalk/meta is not spam and
  // must keep feeding the greeting-loop counter (never flattened to "productive").
  if (u.intent === "smalltalk") return "smalltalk";
  if (u.intent === "meta") return "meta";
  // Only `unclear` / `out_of_scope` remain → rescue a good-faith signal the model
  // MISLABELED. SINGLE SOURCE OF TRUTH: prefer the caller's already-RESOLVED latestSignal
  // (which folds in bare-affirmation context + soft intent), so the low-signal counter can
  // NEVER disagree with the main flow's classification — the live "כן" contradiction, where
  // latestSignal=contextual_ref but this returned unclear and escalated to a boundary line.
  const sig = latestSignal ?? classifyGoodFaithSignal(latest, { serviceNames });
  if (sig !== "none") return "productive";
  // Fragmented/polite inquiry: the AGGREGATE may be a clear business question even when the
  // LAST fragment alone is incomplete ("אשמח לדעת" / "אם יש איפה לשבת"). Rescue on the whole msg.
  if (classifyGoodFaithSignal(message, { serviceNames }) !== "none") return "productive";
  return "unclear";
}

/** Kinds that escalate toward quiet mode (the others reset the counter). `out_of_domain` is the model's
 *  `out_of_scope` relevance verdict (no business anchor) — repeated off-topic must de-escalate, not reset. */
export function countsTowardQuiet(kind: LowSignalKind): boolean {
  return kind === "gibberish" || kind === "unclear" || kind === "out_of_domain";
}

// ── CUSTOMER SAFETY: trajectory, operation inference & TRUTH-SAFE manage/help ─────
// These power the link/help TRAJECTORY of the Safety Contract: a help / manage request
// (or one the model missed) gets the RIGHT link plus guidance that matches the ACTUAL
// pages — /appointment/[id] (one appointment: buttons "שינוי מועד" / "ביטול התור") and
// /appointments/[token] (a list: pick one → its page). Nothing here claims an action
// happened in chat; the website performs it.

const CANCEL_HELP_RE = /לבטל|ביטול|מבטל|לבטול/;
const RESCHEDULE_HELP_RE = /להזיז|מזיז|לשנות|משנה|מזיזים|לדחות|להקדים|לעדכן|מחדש/;
const LIST_HELP_RE = /התורים\s+שלי|לראות\s+(את\s+)?ה?תור|רשימת\s+ה?תור/;

/** The appointment operation a message is about (imperative OR colloquial help form),
 *  or null. Keeps messageOperation()'s precedence (RESCHEDULE>CANCEL>LIST>BOOK). */
export function inferOperation(message: string): "BOOK" | "CANCEL" | "RESCHEDULE" | "LIST" | null {
  const t = (message ?? "").trim();
  const mo = messageOperation(t);
  if (mo && mo !== "NONE") return mo;
  if (RESCHEDULE_HELP_RE.test(t)) return "RESCHEDULE";
  if (CANCEL_HELP_RE.test(t)) return "CANCEL";
  if (LIST_HELP_RE.test(t)) return "LIST";
  if (BOOKING_IMPERATIVE_RE.test(t)) return "BOOK";
  return null;
}

const MANAGE_TOPIC_RE = /לבטל|ביטול|מבטל|לבטול|להזיז|מזיז|לשנות|משנה|לדחות|מחדש|התורים\s+שלי|לנהל|הקישור|הלינק|נפתח|לוחצים|כפתור|מסתבך/;
/** True when the message references cancel / reschedule / list / link-help / manage. */
export function isManageHelpTopic(message: string): boolean {
  return MANAGE_TOPIC_RE.test((message ?? "").trim());
}

const BARE_AFFIRMATION_RE = /^(כן|כן\s+בבקשה|כן\s+תודה|כן\s+כן|כן\s+אני\s+רוצה|כן\s+בטח|כן\s+תשלח|אוקיי|אוקי|בטח|סבבה|נכון|בהחלט|יאללה|קדימה|זורם|אפשר|בוא|תשלח|תשלחי|שלח|שלחי)$/;
/** A bare "yes" with no content of its own — its meaning comes from the prior turn. */
export function isBareAffirmation(message: string): boolean {
  const t = (message ?? "").trim().replace(/[!?.…\s]+$/g, "");
  return BARE_AFFIRMATION_RE.test(t);
}

// ── LAST-ASSISTANT CONTRACT (derived from transcript — no new stored state) ───────
// What did our most recent reply actually DO? Used to interpret terse follow-ups
// ("כן") and to detect a topic switch. Derived from the last assistant line.
export interface LastAssistantContract {
  sentBookingLink: boolean;
  sentManageLink: boolean;
  offeredHelp: boolean;
  offeredBooking: boolean;
  askedQuestion: boolean;
}
const HELP_OFFER_RE = /אם\s+תצטרך\s+עזרה|אם\s+צריך\s+עזרה|במה\s+אוכל\s+לעזור|במה\s+אפשר\s+לעזור|תגיד\s+לי\s+ואשלח|אשמח\s+לעזור|רק\s+תגיד|אני\s+כאן\s+לכל\s+שאלה|אם\s+משהו\s+לא\s+ברור/;
const ASKED_WHICH_RE = /איזה\s+תור|מה\s+מעניין|מה\s+תרצ|לאיזה|איזה\s+שירות/;
// Did OUR last reply offer to book / propose scheduling? Lets a terse "כן" that follows
// be resolved into a booking confirmation (→ booking link), distinct from a help offer.
const BOOKING_OFFER_RE = /לקבוע|לקבע|קביעת|זמינות|תור\s+חדש|רוצה\s+ש?(אקבע|אבדוק|אסדר|אזמין|נתאם|נקבע|נסגור|אתאם)|שאקבע\s+לך|לבדוק\s+לך|נקבע\s+לך|אבדוק\s+לך|אסדר\s+לך|אזמין\s+לך|נתאם\s+לך|אתאם\s+לך|נסגור\s+לך\s+תור/;
export function deriveLastAssistantContract(transcript: string): LastAssistantContract {
  const last = lastAssistantLine(transcript) ?? "";
  return {
    sentBookingLink: /\/book\//.test(last),
    sentManageLink: /\/appointment/.test(last), // matches /appointment/ and /appointments/
    offeredHelp: HELP_OFFER_RE.test(last),
    offeredBooking: BOOKING_OFFER_RE.test(last),
    askedQuestion: last.includes("?") || ASKED_WHICH_RE.test(last),
  };
}

/**
 * Does a good-faith "help" signal mean the customer wants help with an APPOINTMENT (→ manage escape)?
 * ONLY with real manage EVIDENCE: the message references a manage / link-trouble topic (isManageHelpTopic),
 * OR we are already in a manage thread (a manage link was the last thing we sent), OR a still-valid pending
 * MANAGE offer is open. A generic "help" — confusion, conversation-repair/frustration ("לא מבין", "אתה לא
 * מבין"), or a location/access/directions question that merely contains a confusion cue — is NOT an
 * appointment request: it must stay in AI/FAQ support (the model's own reply is used), never escape to a
 * manage/booking link + "no active appointment". PURE → eval-testable. Reuses the existing discriminator;
 * no phrase list, no new state. (The classifier still ranks "help" high so confused users are never
 * silenced — this only narrows the ROUTING meaning of "help".)
 */
export function helpEscapesToManage(
  latestSignal: GoodFaithSignal,
  latest: string,
  lastContract: LastAssistantContract,
  prevPendingKind: string | null,
): boolean {
  if (latestSignal !== "help") return false;
  return isManageHelpTopic(latest) || lastContract.sentManageLink || prevPendingKind === "MANAGE";
}

interface ManageLink { url: string; label: string; kind: PlatformLink; }
/** Picks the manage link sized by REAL upcoming count (never the model): 0 → booking,
 *  1 → that appointment's page, 2+ → the My-Appointments list. Exported for unit testing. */
export function manageLinkFor(
  upcoming: Array<{ id: string }>, slug: string, customerPhone: string, customerId: string
): ManageLink {
  if (upcoming.length === 0) return { url: buildBookingLink(slug, customerPhone), label: BOOK_LINE, kind: "booking" };
  if (upcoming.length === 1) return { url: buildAppointmentLink(upcoming[0].id), label: MANAGE_LINE, kind: "manage" };
  return { url: buildMyAppointmentsLink(customerId), label: MY_APPTS_LINE, kind: "manage" };
}

/**
 * ROUTE/CONTEXT-AWARE manage outcome (AI mode). Sizes the manage page by REAL upcoming count
 * (manageLinkFor), AND — the hardening — forces an honest no-upcoming reply when an explicit manage/list
 * route has 0 upcoming appointments: there is nothing to manage, so the reply is the deterministic
 * `NO_UPCOMING_MANAGE` line regardless of the model's wording (it never depends on MANAGE_CLAIM_RE
 * matching). 1+ upcoming keep the model's reply. Exported for unit testing; the wording/link-kind guard
 * (reconcileLinkWording) remains as defense-in-depth for any other path.
 */
export function resolveManageOutcome(
  upcoming: Array<{ id: string }>, modelReply: string, slug: string, customerPhone: string, customerId: string
): { replyText: string; url: string; label: string; kind: PlatformLink } {
  const m = manageLinkFor(upcoming, slug, customerPhone, customerId);
  return { replyText: upcoming.length === 0 ? NO_UPCOMING_MANAGE : modelReply, url: m.url, label: m.label, kind: m.kind };
}

/**
 * The deterministic MANAGE reply. When `manageLinkFor` resolved to a BOOKING link the customer has
 * NO active appointment to manage — so we say so plainly and offer to book a new one (never a bare
 * "great, to book!" that ignores the manage request). Otherwise we attach the right manage link.
 * Exported for unit testing; used by both the menu-tap path and the free-text continuity path.
 */
export function buildManageOutcome(
  m: ManageLink, reason: DegradedReason
): { text: string; interactive: WhatsAppInteractive; link: PlatformLink } {
  if (m.kind === "booking") {
    return {
      text: `${NO_APPOINTMENT_PROMPT}\nלקביעת תור:\n${m.url}`,
      interactive: { kind: "cta_url", body: noAppointmentCtaBody(), buttonText: "לחץ כאן", url: m.url },
      link: "booking",
    };
  }
  return {
    text: continuityText(reason, "manage", m.url),
    interactive: { kind: "cta_url", body: ctaBody("manage"), buttonText: "לחץ כאן", url: m.url },
    link: m.kind,
  };
}

/**
 * TRUTH-SAFE manage/help text — describes ONLY what the real pages do (the two buttons
 * "שינוי מועד" / "ביטול התור" on /appointment/[id]; pick-from-list on /appointments).
 * Never claims the action happened in chat. `op` tailors the steps; null = generic help.
 */
export function buildManageHelpReply(upcomingCount: number, op: "BOOK" | "CANCEL" | "RESCHEDULE" | "LIST" | null): string {
  if (upcomingCount === 0) {
    return "אני לא רואה תור פעיל על המספר הזה כרגע 🙂 אם בא לך לקבוע תור חדש, אפשר דרך הקישור.";
  }
  if (upcomingCount === 1) {
    if (op === "CANCEL") return "כדי לבטל את התור: נכנסים לקישור, ושם יש כפתור *ביטול התור* — לוחצים עליו ומאשרים. הביטול מתבצע בעמוד, לא כאן בצ׳אט.";
    if (op === "RESCHEDULE") return "כדי לשנות מועד: נכנסים לקישור, לוחצים *שינוי מועד*, ובוחרים יום ושעה חדשים.";
    return "בקישור רואים את התור שלך, עם כפתורים ל*שינוי מועד* ול*ביטול התור*.";
  }
  if (op === "CANCEL") return "כדי לבטל: נכנסים לקישור, בוחרים את התור מהרשימה, ואז לוחצים *ביטול התור* ומאשרים.";
  if (op === "RESCHEDULE") return "כדי לשנות מועד: נכנסים לקישור, בוחרים את התור מהרשימה, ולוחצים *שינוי מועד* כדי לבחור יום ושעה.";
  return "בקישור רואים את כל התורים הקרובים — בוחרים תור, ואז אפשר *לשנות מועד* או *לבטל*.";
}

// ── STALE-TOPIC guard ────────────────────────────────────────────────────────────
const STALE_MANAGE_RE = /לבטל\s+את\s+ה?תור|ביטול\s+ה?תור|לגבי\s+ה?ביטול|הקישור\s+ש?שלחתי|לניהול\s+ה?תור|לשנות\s+את\s+ה?תור/;
/** True when a reply continues a cancellation/manage/link thread — used ONLY when the
 *  customer's LATEST message is a NEW non-manage business question (latest wins). */
export function replyLooksStaleManage(reply: string): boolean {
  return STALE_MANAGE_RE.test(reply ?? "");
}
export const STALE_TOPIC_PIVOT = "רגע, אני רוצה לענות בדיוק על מה ששאלת 🙂 אפשר לכתוב לי שוב את השאלה במשפט קצר?";

export type PreGeminiAction = "skip_gemini_gibberish" | "cheap_reset_reply" | "proceed_to_gemini";

// After this many consecutive greetings/meta that already went to Gemini, a further
// greeting is answered deterministically (no Gemini) — caps a greeting-loop's cost
// while keeping the FIRST couple of greetings warm/model-generated (Risk C).
export const GREETING_DETERMINISTIC_AT = 2;

/** Decides — BEFORE any model call — what to do with the incoming message. A clear
 *  greeting/meta is answered cheaply (no Gemini, never silent) and de-escalates when:
 *    (B) there's prior low-signal history (prevLowSignal ≥ 1),
 *    (D) it's the recovery tail of an aggregated burst whose earlier fragments are
 *        all noise/greeting (e.g. "חבצב\nאת פה?"), or
 *    (C) it's a repeated-greeting loop (prevGreeting ≥ threshold).
 *  Obvious gibberish short-circuits only inside quiet mode (prevLowSignal ≥ 3).
 *  Anything with a real booking/service/FAQ signal ALWAYS proceeds to Gemini, and a
 *  clean conversation's first greeting (no history, no loop) proceeds too (warm). */
export function preGeminiAction(
  prevLowSignal: number, prevGreeting: number, message: string, serviceNames: string[] = []
): PreGeminiAction {
  // Never short-circuit anything carrying a real booking/service/FAQ signal.
  if (hasBookingSignal(message, serviceNames)) return "proceed_to_gemini";

  // Greeting/meta — single message OR the recovery tail of an aggregated burst.
  const frags = (message ?? "").split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  const last = frags.length > 0 ? frags[frags.length - 1] : (message ?? "").trim();
  const isPresence = looksLikePresenceCheck(last);
  const isSocial = looksLikeSocialOpener(last, serviceNames);
  if (isPresence || isSocial) {
    const earlierAllNoise = frags.length > 1 &&
      frags.slice(0, -1).every((f) => looksLikeNoise(f, serviceNames) || looksLikeGreetingOrMeta(f, serviceNames));
    // PRESENCE/recovery check → deterministic recovery on ANY recovery context (the customer
    // is probing a silent line). A WARM social opener is gentler: it only short-circuits on a
    // genuine greeting LOOP (cost cap), active quiet mode, or a noise-burst recovery tail —
    // NOT on mere residual low-signal, so "היי מה קורה" feels natural (the live stiff-reset bug).
    if (isPresence && (prevLowSignal >= 1 || earlierAllNoise || prevGreeting >= GREETING_DETERMINISTIC_AT)) {
      return "cheap_reset_reply";
    }
    if (isSocial && (earlierAllNoise || prevGreeting >= GREETING_DETERMINISTIC_AT || prevLowSignal >= 3)) {
      return "cheap_reset_reply";
    }
  }

  // Confident machine-noise (deterministic gibberish) skips Gemini from the FIRST detected turn: it carries
  // no booking/FAQ/service signal, no "?", and isn't a greeting (all handled above), so it can never be a
  // good-faith question — and good-faith confusion ("מה?"/"לא הבנתי") has a "?"/META shape that looksLikeNoise
  // already excludes. This kills the gibberish→Gemini cost AND the address-loop (the model is never called on
  // the noise turn, so it can't re-answer the prior directions topic).
  if (looksLikeNoise(message, serviceNames)) return "skip_gemini_gibberish";
  return "proceed_to_gemini";                                 // real-looking / first greeting
}

/** Escalation tier for N consecutive low-signal turns. */
export function lowSignalActionFor(count: number): LowSignalAction {
  if (count <= 0) return "none";
  if (count === 1) return "normal_clarify"; // friendly, keep the model's reply (unless forced below)
  if (count === 2) return "short_clarify";
  if (count === 3) return "boundary";
  return "quiet_mode";
}

/** LOG-ONLY: maps the low-signal action (+ whether the tier-1 clarify actually fired) to a fallback-type
 *  label for the turn trace. Returns undefined when the model's own reply shipped (no deterministic
 *  override). Pure — observability only, never gates behavior. */
export function fallbackTypeForLowSignal(action: LowSignalAction, forcedClarify: boolean): string | undefined {
  if (action === "short_clarify" || (action === "normal_clarify" && forcedClarify)) return "low_signal_short";
  if (action === "boundary") return "boundary";
  if (action === "quiet_mode") return "quiet";
  return undefined;
}

/** A single short word (name-like / typo-like): no internal whitespace and short, after trimming any
 *  trailing punctuation. The class of token the model tends to "interpret" (e.g. adopt a lone Hebrew
 *  name token as the customer's name). NOT exported — only forcesDeterministicClarify consults it. */
const SINGLE_SHORT_TOKEN_MAX = 12;
function isSingleShortToken(message: string): boolean {
  const t = (message ?? "").trim().replace(/[!?.…׳"'\s,־-]+$/g, "").trim();
  if (t.length === 0 || t.length > SINGLE_SHORT_TOKEN_MAX) return false;
  return !/\s/.test(t); // exactly one token
}

/**
 * Decides whether the post-Gemini reply MUST be replaced by the deterministic low-signal clarification
 * (LOW_SIGNAL_SHORT) instead of shipping the model's free text. Governs the tier-1 `normal_clarify`
 * step ONLY — higher tiers (short_clarify / boundary / quiet_mode) already force their own deterministic
 * line, so this returns false for every non-`normal_clarify` action.
 *
 *   • gibberish → ALWAYS force: a model-authored semantic guess on noise ("במבח" → "אתה מתכוון למחר?")
 *                must never reach the customer. (Preserves the prior tier-1 gibberish behavior exactly.)
 *   • unclear   → force when the message is a SINGLE SHORT TOKEN and our last reply did NOT ask a direct
 *                question. A lone, contentless token carries no resolvable intent, and the model tends to
 *                "interpret" it — e.g. adopt a name-like word as the customer's name ("אורי" → "מה שלומך,
 *                אורי?"). A generic clarify is safer. The askedQuestion gate protects a legitimate one-word
 *                ANSWER (e.g. after "איך קוראים לך?"). A MULTI-WORD unclear message keeps the model's
 *                friendly clarification (unchanged). This is a structural class, NOT a per-phrase patch.
 */
export function forcesDeterministicClarify(
  kind: LowSignalKind, action: LowSignalAction, message: string, askedQuestion: boolean
): boolean {
  if (action !== "normal_clarify") return false;
  if (kind === "gibberish") return true;
  if (kind === "unclear") return !askedQuestion && isSingleShortToken(message);
  return false;
}

// A GENERIC smalltalk / presence question ("מה שלומך?", "הכל בסדר?", "איך הולך?", "מה חדש?") — it asks
// for NO specific datum, so a lone signal-less token after it is still unclear (not a meaningful answer).
const GENERIC_SMALLTALK_Q_RE =
  /מה\s+שלומ|מה\s+קורה|מה\s+נשמע|מה\s+המצב|מה\s+חדש|מה\s+איתך|מה\s+העניינים|מה\s+אתה\s+עושה|איך\s+הולך|איך\s+את(?:ה|ם)?(?=[\s?!.,…]|$)|הכל\s+בסדר|הכל\s+טוב|מה\s+טוב/;
/** True for a generic smalltalk/presence question (asks nothing specific). */
export function isGenericSmalltalkQuestion(text: string): boolean {
  return GENERIC_SMALLTALK_Q_RE.test(text ?? "");
}

// A question whose valid ONE-WORD answer may carry NO deterministic signal — NAME, DAY/DATE, TIME, or
// PHONE. ONLY these block the single-token-unclear skip, because answers like "דני" / "מחר" / "12" / a
// phone number look signal-less yet are meaningful. SERVICE-preference / yes-no / link / booking-offer
// questions are deliberately NOT here: a valid service answer carries a booking signal (hasBookingSignal,
// incl. colloquial short-forms), and "כן"/"אוקי" are bare affirmations — both already protect those, so
// blocking on them was redundant and wrongly swallowed a lone NON-answer like "אורי" after a smalltalk
// reply that ended "…מה בא לך לעשות?". (A PURE, non-smalltalk service/confirm/link question still blocks
// via the conservative !isGenericSmalltalkQuestion arm in hasPendingAnswerExpectedQuestion.)
const ANSWER_EXPECTED_Q_RE =
  /איך\s+קוראים|מה\s+שמ|מה\s+השם|השם\s+שלך|איזה\s+יום|איזה\s+שעה|איזו\s+שעה|מתי|נוח\s+לך|מספר\s+(?:ה)?טלפון|הטלפון\s+שלך/;
/** True when our last reply asked a NAME / DAY / TIME / PHONE question (a one-word reply may be valid). */
export function asksAnswerExpectedQuestion(text: string): boolean {
  return ANSWER_EXPECTED_Q_RE.test(text ?? "");
}

/**
 * Is a REAL answer-expected question pending from our last reply? True iff we asked a question AND it is
 * either an explicit answer-expected request OR not recognizably generic smalltalk (conservative: an
 * UNRECOGNIZED question blocks the skip). False when there was no question, or it was PURELY generic
 * smalltalk with no answer-expected request — so a lone signal-less token after "מה שלומך?" can still skip.
 */
export function hasPendingAnswerExpectedQuestion(askedQuestion: boolean, lastAssistantText: string): boolean {
  if (!askedQuestion) return false;
  if (asksAnswerExpectedQuestion(lastAssistantText)) return true; // explicit request (covers mixed smalltalk+request)
  return !isGenericSmalltalkQuestion(lastAssistantText);          // unrecognized question → conservatively block
}

/**
 * PRE-GEMINI decidability of the single-token `unclear` clarify: true when this turn is ALREADY going to
 * ship the deterministic LOW_SIGNAL_SHORT regardless of the model, so the full Gemini call can be skipped.
 * It is the DETERMINISTIC precondition of forcesDeterministicClarify — a lone short token carrying NO
 * signal of any kind — computed without the model. Conditions (ALL required):
 *   1. no REAL answer-expected question is pending (a generic smalltalk question like "מה שלומך?" does
 *      NOT block; only a name/service/date/time/choice/confirm/link question does — see
 *      hasPendingAnswerExpectedQuestion), so a valid one-word ANSWER is never swallowed,
 *   2. the WHOLE message is a single short token (multi-fragment bursts have whitespace → excluded),
 *   3. not a bare affirmation (כן / אוקי / בטח / סבבה …),
 *   4. not a meta/presence token (מה / למה / נו / "?" via isGoodFaithLowSignal),
 *   5. not a greeting (היי / הי / שלום / אהלן …),
 *   6. not noise/gibberish (that keeps its own existing pre-Gemini path),
 *   7. no manage/help topic, no booking signal, and no good-faith signal (faq / soft / action / help /
 *      contextual) — so a meaningful lone token (a service name, a price-FAQ word) still reaches Gemini.
 * Mirrors the post-Gemini forced-clarify outcome; that override stays as defense-in-depth.
 */
export function shouldPreSkipSingleTokenClarify(
  message: string, askedQuestion: boolean, lastAssistantText: string, serviceNames: string[] = []
): boolean {
  if (hasPendingAnswerExpectedQuestion(askedQuestion, lastAssistantText)) return false;
  if (!isSingleShortToken(message)) return false;
  const t = message.trim();
  if (isBareAffirmation(t)) return false;
  if (isGoodFaithLowSignal(t)) return false;                  // מה / למה / נו / "?" — meta/presence, not unclear
  if (looksLikeGreetingOrMeta(t, serviceNames)) return false; // היי / הי / שלום / אהלן …
  if (looksLikeNoise(t, serviceNames)) return false;          // gibberish keeps its existing pre-Gemini path
  if (isManageHelpTopic(t)) return false;                     // cancel / reschedule / list / link-help
  if (hasBookingSignal(t, serviceNames)) return false;        // a service name / booking verb
  if (classifyGoodFaithSignal(t, { serviceNames }) !== "none") return false; // faq / soft / action / help / contextual
  return true;                                                // a lone, signal-less token → deterministic clarify
}

// ── Link-wording fence ─────────────────────────────────────────────────────────
// Catches replies that imply a link is PRESENT/SENT ("בקישור למטה", "דרך הקישור",
// "הקישור ששלחתי") when none was attached. Deliberately does NOT match a future
// promise ("אשלח לך קישור") — only references to an existing/attached link.
const PHANTOM_LINK_RE =
  /(?:דרך\s+ה?|ב)(?:קישור|לינק|link)|ה(?:קישור|לינק)\s+(?:ש?שלחתי|למטה|הזה|המצורף|מצורף|מעלה)/i;
// The phantom phrase + the rest of its clause, removed wholesale.
const PHANTOM_LINK_STRIP =
  /\s*(?:דרך\s+ה?|ב)(?:קישור|לינק|link)[^.,!?\n]*|\s*ה(?:קישור|לינק)\s+(?:ש?שלחתי|למטה|הזה|המצורף|מצורף|מעלה)[^.,!?\n]*/gi;
// The phantom phrase as the TRAILING clause with NO sentence terminator after it (it runs to the end of
// the message — only commas/other words, no . ! ?). When this matches, stripping the phantom clause removes
// the sentence's tail, so a remainder that no longer ends as a complete sentence is a dangling FRAGMENT.
const PHANTOM_LINK_TAIL_RE =
  /(?:דרך\s+ה?|ב)(?:קישור|לינק|link)[^.!?\n]*$|ה(?:קישור|לינק)\s+(?:ש?שלחתי|למטה|הזה|המצורף|מצורף|מעלה)[^.!?\n]*$/i;
export const LINK_SAFE_FALLBACK = "אני כאן 🙂 אפשר לשאול אותי על העסק או לקבוע תור.";

// The deterministic correction for a model reply that FALSELY claimed a booking happened (booked-claim
// guard). LINK-NEUTRAL by design: it carries NO phantom-link wording, so the phantom-link fence can never
// strip it into a fragment whether or not a booking link is attached this turn. It is honest (booking is on
// the site, never in chat — it does not imply an in-chat booking) and returns to helping; a real booking
// link, when the route attaches one, is appended separately by attachPlatformLink.
export const BOOKED_CLAIM_CORRECTION = "את התור עצמו קובעים באתר, לא כאן בצ׳אט 🙂 אבל אני כאן לכל שאלה אחרת.";

/** True when (ignoring a trailing emoji) the text ends at a sentence boundary — used by the fragment guard. */
function endsLikeSentence(s: string): boolean {
  const core = stripEmojis(s).trim();
  return core.length === 0 || /[.!?…]$/.test(core);
}

export function mentionsPhantomLink(text: string): boolean {
  return PHANTOM_LINK_RE.test(text ?? "");
}

/** Whether to rewrite phantom link wording: only when NO link was attached this
 *  turn AND none was sent earlier AND the reply implies one exists. (So
 *  "בקישור ששלחתי" is allowed once a link really was sent.) */
export function shouldFenceLinkWording(
  linkAttached: PlatformLink, previousBookingLinkSent: boolean, reply: string
): boolean {
  return linkAttached === null && !previousBookingLinkSent && mentionsPhantomLink(reply);
}

/** Removes phantom link references and tidies the leftovers; falls back to a safe
 *  line if stripping would leave the reply empty/too short. */
export function stripPhantomLinkWording(text: string): string {
  const out = (text ?? "")
    .replace(PHANTOM_LINK_STRIP, "")
    .replace(/\s*[,،]\s*(?:או|וגם)?\s*([.!?]|$)/g, "$1") // dangling ", או ." → "."
    .replace(/\s+(?:או|וגם)\s*([.!?]|$)/g, "$1")          // dangling " או." → "."
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.!?])/g, "$1")
    .trim();
  // If stripping left almost nothing (the reply was basically just a link line),
  // use a safe canned line. Codepoint-safe: count non-whitespace characters.
  if (out.replace(/\s/g, "").length < 3) return LINK_SAFE_FALLBACK;
  // Defense-in-depth FRAGMENT guard: when the phantom phrase was the trailing clause with no terminator
  // (PHANTOM_LINK_TAIL_RE) AND the remainder no longer ends as a complete sentence, the strip cut the
  // sentence's tail → a dangling fragment ("…קובעים בקישור — שניה…" → "…קובעים"). Serve the safe line
  // instead of shipping the fragment. General — keyed on sentence shape, not on any specific phrase.
  if (PHANTOM_LINK_TAIL_RE.test(text ?? "") && !endsLikeSentence(out)) return LINK_SAFE_FALLBACK;
  return out;
}

// ── Deterministic link-control (overrides Gemini's intent classification) ──────
// Complaints about the bot/links, bare meta-questions, and trivial messages must
// never trigger a booking/manage link. Gemini frequently mislabels these as BOOK.
const LINK_COMPLAINT_RE =
  /קישורים|שני\s*קישור|שתי\s*קישור|תפסיק|להפסיק|נמאס|באג|מבלבל|מבחבל|מתסכל|לא\s*טוב|טעית|בלי\s*שכתבתי|למה\s*כתבת|די\s/;
const META_ONLY_RE =
  /^(מה|למה|הא|נו|אה|לא\s*הבנתי|מה\s*זאת\s*אומרת|מה\s*אמרת|מה\s*זה|באמת|מה\s*קרה)\s*[?!.…׳"']*$/;
// An explicit REQUEST for the link (imperative/future) — these DO get one link.
const EXPLICIT_LINK_REQUEST_RE =
  /תשלח|תשלחי|שלח\s*לי|שלחי\s*לי|אפשר\s*(את\s*)?ה?קישור|איפה\s*ה?קישור|תן\s*לי\s*(את\s*)?ה?קישור|תני\s*לי\s*(את\s*)?ה?קישור|רוצה\s*(את\s*)?ה?(קישור|לינק)/;

export const COMPLAINT_ACK =
  "סליחה על הבלבול! 🙏 אני כאן לכל שאלה על העסק. מתי שתרצה לקבוע, לשנות או לבטל תור — תגיד לי ואשלח קישור אחד מסודר.";
export const META_FALLBACK =
  "לא בטוח/ה שהבנתי 🙂 אפשר לשאול אותי כל דבר על העסק, ואם תרצה לקבוע, לשנות או לבטל תור — רק תגיד.";

export function isExplicitLinkRequest(message: string): boolean {
  return EXPLICIT_LINK_REQUEST_RE.test(message);
}

/** True when this message must NOT receive a link, whatever Gemini classified it
 *  as: one-char/punctuation, bare meta-questions, and complaints — unless the user
 *  explicitly asks for the link (then they get exactly one). */
export function suppressLinkFor(message: string): boolean {
  const t = (message ?? "").trim();
  if (isExplicitLinkRequest(t)) return false;
  if (t.length <= 1) return true;
  if (/^[?؟!.…״"'\s,־-]+$/.test(t)) return true;
  if (META_ONLY_RE.test(t)) return true;
  if (LINK_COMPLAINT_RE.test(t)) return true;
  return false;
}

// ── Deterministic BOOKING-SIGNAL gate ──────────────────────────────────────────
// A booking/manage link attaches only when Gemini's intent AND a real booking
// signal in the message AGREE — two independent gates. This stops the live
// "unsure → BOOK" drift, where vague/unrelated messages ("אני טס לחו״ל עוד
// שבועיים", "רציתי לאכול", "מה עוד?", "לא תעזרי לי בזה?") were classified BOOK by
// the model and wrongly received a link. The SHOULD-BOOK cases all carry a signal
// (a booking verb or a service name), so genuine intent is never blocked.
// No \b (it doesn't work on Hebrew). Each term is bounded so it can't fire inside
// a longer word ("צבע" must NOT match "האצבע"/finger), while still allowing the
// standard one-letter Hebrew prefixes ב/ה/ל/ו/ש/מ/כ so "הצבע"/"לתורים" still match.
// Hebrew range via explicit codepoints (never a literal glyph, whose value is
// unreliable through tooling).
const HEB = `${String.fromCharCode(0x0590)}-${String.fromCharCode(0x05ff)}`;
function bookingToken(term: string): string {
  return `(?<![${HEB}])[בהלושמכ]?${term}`;
}
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const BOOKING_DOMAIN = [
  "לקבוע", "לקבע", "קביעת", "לתאם", "תיאום", "להזמין", "הזמנה", "פגישה", "פנוי", "זמינות",
  "תורים", "לבטל", "ביטול", "לבטול", "להזיז", "לשנות", "לדחות", "להקדים", "לעדכן",
];
// BUSINESS-AGNOSTIC (see CLAUDE.md "Product principle"): the business's OWN configured
// service names are the PRIMARY signal (matched below in hasBookingSignal). This list is
// only a small generic fallback of cross-industry service/booking NOUNS — never a
// per-vertical service catalogue. It must stay industry-neutral: a haircut, a Pilates
// class, a physiotherapy session and a manicure all reach it through the same generic
// words OR (better) through the business's configured service names. Do NOT re-add
// salon-specific terms (תספורת / צבע / בלונד / מניקור …) here — those belong in each
// business's services data. (Booking VERBS and the generic nouns פגישה/תורים already live
// in BOOKING_DOMAIN above; bare "תור"/"ביקור" are deliberately omitted — they fire inside
// תורה/תורת and ביקורת.) Every term is intent-gated (a link attaches only when Gemini ALSO
// judged the turn an operation), but keep additions generic to avoid false signals — and
// extend SCENARIO 29 in the sim suite when you change this.
const GENERIC_SERVICE = [
  "שירות", "טיפול", "שיעור", "סשן", "ייעוץ", "אימון",
];
const SIGNAL_RE = new RegExp([...BOOKING_DOMAIN, ...GENERIC_SERVICE].map(bookingToken).join("|"));

/** True when the message carries a genuine booking/manage/service signal — the
 *  deterministic half of the two-gate link decision (the other half is Gemini's
 *  intent). Checks booking verbs, generic service words, and the business's own
 *  configured service names — all word-bounded so they don't misfire mid-word. */
// Per-WORD service match (additive, BUSINESS-AGNOSTIC): a configured service name's individual significant
// words also count as a booking signal — tolerating a Hebrew construct/absolute suffix swap on the final
// letter (צביעת ↔ צביעה) and a leading vav-conjunction (ועיצוב → עיצוב). This recognizes colloquial
// SHORT-FORMS of a multi-word service ("פן" for "פן ועיצוב", "צביעה" for "צביעת שיער") that the full-name
// match misses — derived ENTIRELY from THIS business's configured names (no hardcoded industry terms).
// Word-bounded both sides. Like every booking signal it is intent-gated downstream (no link without
// Gemini ALSO judging an operation), and a false positive only ever fails SAFE: it routes the turn to
// Gemini (and, for the pre-Gemini skip, simply declines to skip).
function matchesServiceWord(message: string, serviceName: string): boolean {
  for (const raw of serviceName.split(/\s+/)) {
    const w = raw.replace(/^ו/, "").trim(); // drop a leading vav-conjunction ("ועיצוב" → "עיצוב")
    if (w.length < 2) continue;
    const endsCT = /[תה]$/.test(w);             // construct/absolute suffix (צביעת ↔ צביעה)
    const stem = endsCT ? w.slice(0, -1) : w;
    if (stem.length < 2) continue;
    const body = endsCT ? `${escapeForRegex(stem)}[תה]` : escapeForRegex(w);
    if (new RegExp(`(?<![${HEB}])[בהלושמכ]?${body}(?![${HEB}])`).test(message)) return true;
  }
  return false;
}

export function hasBookingSignal(message: string, serviceNames: string[] = []): boolean {
  const t = (message ?? "").trim();
  if (!t) return false;
  if (SIGNAL_RE.test(t)) return true;
  for (const name of serviceNames) {
    const n = (name ?? "").trim();
    if (n.length < 2) continue;
    if (new RegExp(bookingToken(escapeForRegex(n))).test(t)) return true; // full configured name
    if (matchesServiceWord(t, n)) return true;                            // colloquial short-form / suffix variant
  }
  return false;
}

// ── EVIDENCE GATE (BUG-004) ────────────────────────────────────────────────────
// Gemini intermittently hallucinates BOOK for keyboard-smash gibberish ("חכלגצג",
// "חבצב"). The model's claim alone is NOT trusted: an operation
// (BOOK / RESCHEDULE / CANCEL / LIST) requires CORROBORATING EVIDENCE in the user's
// own words (a booking/manage verb or a service name). Without it, the turn is
// downgraded to non-actionable — so it can't reset the low-signal counter or escape
// quiet mode. (FAQ stays productive via intent; it isn't an operation.)
type Understanding = ReceptionistTurn["understanding"];
const APPT_OPERATIONS = ["BOOK", "RESCHEDULE", "CANCEL", "MODIFY", "LIST"];
const INTENT_OPERATIONS = ["booking", "cancel_request", "reschedule_request"];

/** True when the model's understanding asserts a business OPERATION (not FAQ/chat). */
export function claimsOperation(u: Understanding): boolean {
  return u.requestsBusinessAction === true ||
    APPT_OPERATIONS.includes(u.appointmentIntent) ||
    INTENT_OPERATIONS.includes(u.intent);
}

/**
 * Enforces the evidence requirement IN PLACE. If an operation is claimed but the
 * user message carries no booking/service evidence, the operation is stripped
 * (requestsBusinessAction=false, appointmentIntent=NONE, operation-intent→unclear).
 * Returns whether evidence was present + a reason for logs. No-op for non-operations.
 */
export function applyBookingEvidenceGate(
  u: Understanding, message: string, serviceNames: string[]
): { evidence: boolean; reason: string } {
  if (!claimsOperation(u)) {
    return { evidence: false, reason: u.intent === "faq" ? "faq_productive" : "no_operation_claimed" };
  }
  const evidence = hasBookingSignal(message, serviceNames);
  if (!evidence) {
    u.requestsBusinessAction = false;
    u.appointmentIntent = "NONE";
    if (INTENT_OPERATIONS.includes(u.intent)) u.intent = "unclear";
  }
  return { evidence, reason: evidence ? "signal_in_message" : "no_signal_model_hallucinated" };
}

/** Removes any URL the model wrote so the final message carries at most the one
 *  deterministic platform link (prevents the "two links" the user complained of). */
export function stripModelUrls(text: string): string {
  return (text ?? "")
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Appends the single deterministic link — OR, if we just sent this exact link and
 *  the user didn't ask for it again, references it instead of re-spamming the URL. */
function appendPlatformLink(
  reply: string, label: string, url: string, lastAssistant: string | null, message: string
): string {
  if (lastAssistant?.includes(url) && !isExplicitLinkRequest(message)) {
    return `${reply}\n\nהקישור שכבר שלחתי קודם עדיין מחכה לך — בודקים שם 🙂`;
  }
  return `${reply}\n\n${label}\n${url}`;
}

/**
 * AI-mode platform-link attachment with PRESENTATION PARITY to deterministic mode. Returns BOTH:
 *   - replyText: the text-with-URL fallback (identical to appendPlatformLink — older clients / an
 *     interactive-send failure still get the link), and
 *   - interactive: a clean cta_url button (the URL lives in the BUTTON, never in the body).
 * The anti-spam "reference the link I already sent" case carries NO url → interactive=undefined, so it
 * stays text-only (there's nothing to button-ize). The URL is system-built and deterministic; the model
 * never writes it. Gender/emoji enforcement on the cta_url body happens at the outbound chokepoint.
 */
export function attachPlatformLink(
  reply: string, label: string, url: string, lastAssistant: string | null, message: string
): { replyText: string; interactive: WhatsAppInteractive | undefined } {
  const replyText = appendPlatformLink(reply, label, url, lastAssistant, message);
  const referencedPrevious = !!lastAssistant?.includes(url) && !isExplicitLinkRequest(message);
  if (referencedPrevious) return { replyText, interactive: undefined }; // reference line has no URL → text only
  // Length-cap the cta_url body so a long model reply never trips an avoidable interactive rejection.
  return { replyText, interactive: { kind: "cta_url", body: capInteractiveBody(`${reply}\n\n${label}`), buttonText: "לחץ כאן", url } };
}

/**
 * WORDING ↔ LINK-KIND consistency guard (general, business-agnostic). The assistant must never imply
 * managing / seeing / changing appointments while a BOOKING link is attached — which happens when an
 * explicit LIST/manage ask finds 0 upcoming appointments (manageLinkFor collapses 0 → a booking link).
 * When that contradiction is detected, reconcile to an honest, booking-worded line ("no FUTURE
 * appointments — book a new one"), so the text and the attached booking link can never disagree. Keyed
 * on intent WORDING, not a specific sentence. No-op for booking-worded replies and for manage links.
 */
export function reconcileLinkWording(
  replyText: string, linkAttached: PlatformLink, interactive: WhatsAppInteractive | undefined, bookingUrl: string
): { replyText: string; interactive: WhatsAppInteractive | undefined; reconciled: boolean } {
  if (linkAttached !== "booking" || !MANAGE_CLAIM_RE.test(replyText)) {
    return { replyText, interactive, reconciled: false };
  }
  const reconciledInteractive = interactive?.kind === "cta_url"
    ? { ...interactive, body: NO_UPCOMING_MANAGE }       // primary cta_url: URL stays in the button only
    : interactive;
  return { replyText: `${NO_UPCOMING_MANAGE}\n${bookingUrl}`, interactive: reconciledInteractive, reconciled: true };
}

// In-chat selection questions the model must never ask in platform mode (the
// website collects service/day/time AND lets the customer pick which appointment).
// Covers booking ("איזה שירות/יום/שעה?") and manage ("איזה תור?", "לאיזה תאריך?").
const SCHEDULING_Q = new RegExp(
  [
    "איז[הו]\\s+(שירות|טיפול|יום|תאריך|שעה|תור)",
    "מתי\\s+(נוח|בא\\s*לך|מתאים|תרצ|תוכל|יתאים|מעדיפ|תעדיפ|נראה|להגיע|לקבוע|לבוא)",
    "מתאים\\s+לך\\s+\\S*\\s*(שעה|יום|תאריך|מועד)",
    "שעה\\s+(מסוימת|מסויימת|ספציפית|שנוחה|שמתאימה)",
    "מה\\s+התאריך",
    "באיז[הו]\\s+(תאריך|שעה|שירות|יום|תור)",
    "לאיז[הו]\\s+(שעה|תאריך|יום|שירות|תור)",
    "איז[הו]\\s+\\S{1,12}\\s+(את|אתה)\\s+(רוצ|מעוניינ|תרצ)",
    // Soft preference-collection — the PAGE collects service/day/time, so the chat must
    // not (live: "יש לך העדפה לגבי יום או שעה...?" slipped through the scheduling fence).
    "יש\\s+לך\\s+העדפ",
    "העדפ\\S*\\s+(לגבי\\s+)?(יום|שעה|תאריך|מועד|שירות|טיפול)",
    // English forms — the model occasionally answers in English on thin context.
    "\\bwhich\\s+(appointment|service|one|day|time|date)",
    "\\bwhat\\s+(date|time|service)\\b",
    "\\bwhen\\s+(would|works|suits)",
  ].join("|"),
  "i"
);

export const FENCE_BRIDGE_BOOK = "את השירות, היום והשעה בוחרים ישירות בקישור — קל ומהיר.";
export const FENCE_BRIDGE_MANAGE = "כל הפרטים והניהול בקישור — בוחרים תור וצופים, משנים או מבטלים אותו.";

/**
 * Deterministic platform fence: if a reply asked the customer to pick a
 * service/day/time/appointment in chat, neutralize it and bridge to the link.
 *  - book mode (keepWarmth=true): drop the offending sentence(s) + any question,
 *    keep the model's non-question warmth.
 *  - manage mode (keepWarmth=false): replace the whole reply — manage
 *    disambiguation is exactly where the model MERGES/INVENTS appointment details
 *    ("the OTHER one was צביעת at 10:30" — wrong), so we don't keep its sentences.
 * If no selection question is present the reply is returned untouched (good
 * replies are never altered; FAQ / small talk never reach here).
 */
export function defuseSchedulingQuestion(
  reply: string,
  opts: { bridge?: string; keepWarmth?: boolean } = {}
): { text: string; defused: boolean } {
  if (!SCHEDULING_Q.test(reply)) return { text: reply, defused: false };
  const bridge = opts.bridge ?? FENCE_BRIDGE_BOOK;
  if (opts.keepWarmth === false) return { text: `בטח! ${bridge}`, defused: true };
  const warmth = reply
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !SCHEDULING_Q.test(s) && !s.includes("?") && !s.includes("？"))
    .join(" ")
    .trim();
  const text = warmth.length >= 8 ? `${warmth} ${bridge}` : `בטח! ${bridge}`;
  return { text, defused: true };
}

// ── CAPABILITY-PROMISE fence (platform mode) ───────────────────────────────────
// Beyond explicit scheduling QUESTIONS, the model sometimes PROMISES an in-chat
// booking/availability flow it cannot run in platform mode ("אני אבדוק לך זמינות",
// "אני יכול לקבוע לך", "רק כדי לוודא, אתה רוצה תור?"). The website performs scheduling,
// so these promises are unsupported. This catches them ANYWHERE (not only inside the
// link branches — the live miss was on a route=NONE turn) and bridges to link-first,
// keeping the model's non-promise warmth (same shape as defuseSchedulingQuestion).
const CAPABILITY_PROMISE_RE = new RegExp(
  [
    "א?בדוק\\s+(לך\\s+)?(את\\s+ה)?זמינות",
    "לבדוק\\s+(לך\\s+)?(את\\s+ה)?זמינות",
    "(אני\\s+)?יכול(ה)?\\s+לקבוע\\s+לך",
    "אקבע\\s+לך",
    "אסדר\\s+לך\\s+(את\\s+ה)?תור",
    "אזמין\\s+לך\\s+תור",
    // "we/I will schedule for you" OFFER class — implies in-chat scheduling. Platform-unsafe
    // wording even though it's phrased as a friendly offer (the live "רוצה שנתאם לך תור?").
    "נתאם\\s+לך",
    "אתאם\\s+לך",
    "נקבע\\s+לך",
    "נסגור\\s+לך\\s+תור",
    "רוצה\\s+ש(אקבע|אבדוק|אסדר|אזמין|נתאם|נקבע|נסגור|אתאם)",
    "רק\\s+כדי\\s+לוודא[^?]{0,24}רוצה\\s+ת",
  ].join("|")
);
/** True when the reply PROMISES an unsupported in-chat booking/availability flow. */
export function mentionsCapabilityPromise(reply: string): boolean {
  return CAPABILITY_PROMISE_RE.test(reply ?? "");
}
/** Neutralizes an unsupported in-chat capability promise → a link-first bridge, keeping
 *  the model's non-promise warmth. No-op when no promise is present (good replies untouched). */
export function defuseCapabilityPromise(
  reply: string, opts: { bridge?: string } = {}
): { text: string; defused: boolean } {
  if (!mentionsCapabilityPromise(reply)) return { text: reply, defused: false };
  const bridge = opts.bridge ?? FENCE_BRIDGE_BOOK;
  const warmth = (reply ?? "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !CAPABILITY_PROMISE_RE.test(s) && !SCHEDULING_Q.test(s) && !s.includes("?") && !s.includes("？"))
    .join(" ")
    .trim();
  const text = warmth.length >= 8 ? `${warmth} ${bridge}` : `בטח! ${bridge}`;
  return { text, defused: true };
}

// ── Deterministic ACTION-REFUSAL fence (platform mode) ─────────────────────────
// In platform mode the WEBSITE books / reschedules / cancels, so the assistant must
// never tell the customer it "can't" do those — yet the model occasionally drifts into
// the legacy "אי אפשר בצ'אט" refusal (a holdover instinct). When we are ALREADY
// attaching the correct link for an operation, a refusal of that operation is, by
// construction, false. This fence catches a NEGATION co-occurring with a book/reschedule/
// cancel INFINITIVE in the SAME sentence and replaces the reply with the route's bridge
// line (the same deterministic line the route-override path uses). Deliberately NARROW:
//   • only book/reschedule/cancel verbs (LIST / "לראות" excluded — rarer, riskier);
//   • requires BOTH a negation AND an operation infinitive in one sentence, so honest
//     existence statements ("אין לך תור פעיל") and genuine capability limits
//     ("לא יכולה לראות היסטוריה") never trip it;
//   • invoked ONLY on turns where a booking/manage link is actually attached.
const ACTION_REFUSAL_NEG =
  /אי[\s-]?אפשר|לא\s+ניתן|לא\s+נית|לא\s+יכול(?:ה|ים)?|לא\s+אוכל|אינ(?:י|ני)\s+יכול(?:ה)?|לא\s+מתאפשר|can(?:'|’|`)?t|cannot|unable\s+to/i;
const ACTION_REFUSAL_OP = /לקבוע|לקבע|לתאם|להזמין|לבטל|לבטול|לשנות|להזיז|לדחות|להקדים|לעדכן/;

/** True when the reply REFUSES to book/reschedule/cancel (a negation + an operation verb
 *  in one sentence) — a false claim in platform mode, where the website performs these. */
export function mentionsActionRefusal(reply: string): boolean {
  return (reply ?? "")
    .split(/[.!?\n]/)
    .some((s) => ACTION_REFUSAL_NEG.test(s) && ACTION_REFUSAL_OP.test(s));
}

/** If the reply refuses the operation, replace it with the route's bridge line so the
 *  reply can never contradict the link being attached. No-op otherwise — good replies,
 *  honest "no appointment" lines, and non-operation capability limits are untouched. */
export function defuseActionRefusal(reply: string, route: Route): { text: string; defused: boolean } {
  if (!mentionsActionRefusal(reply)) return { text: reply, defused: false };
  const bridge = route === "BOOK" ? FENCE_BRIDGE_BOOK : FENCE_BRIDGE_MANAGE;
  return { text: `בטח! ${bridge}`, defused: true };
}

/**
 * Diagnostics for the attached CTA: logs the link's base ORIGIN + PATH only.
 * Never logs the `?p=<phone>` query (dropped) or the full appointment-id access
 * token (truncated to 8 chars) — no secrets, no PII. Lets us confirm at a glance
 * that PUBLIC_BASE_URL resolved to the intended domain (e.g. the Vercel URL) and
 * not the localhost fallback.
 */
function logPlatformLink(kind: PlatformLink, url: string): void {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(
      /\/appointment\/([0-9a-f]{8})[0-9a-f-]*/i,
      "/appointment/$1…"
    );
    console.log(`[platform-turn] link_attached=${kind} base=${parsed.origin} path=${path}`);
  } catch {
    console.log(`[platform-turn] link_attached=${kind} (url parse failed)`);
  }
}

// ── Structured turn trace (debuggability; behavior-preserving) ─────────────────
// One machine-parseable line per completed platform turn, COMPLEMENTING the existing
// human-readable [platform-turn] log (it does not replace it and changes no behavior).
// PII-safe by construction: only decision metadata — never the message/reply text,
// never a phone number. Lets an incident be reconstructed from one JSON line instead
// of grepping prose. (Emitted on the main post-Gemini path; the early-exit paths
// already carry their own detailed [platform-turn] logs.)
export interface TurnTrace {
  bookingMode: "platform";
  geminiCalled: boolean;
  route: string;          // resolved route (BOOK/LIST/RESCHEDULE/CANCEL/NONE/-)
  routeReason: string;    // not_actionable | message_verb | model_intent | -
  signalKind: string;     // LowSignalKind for the turn
  linkKind: PlatformLink; // booking | manage | null
  linkAttached: boolean;
  suppressReply: boolean;
  guardBranch: string;    // decision.branch (which brain path produced the reply)
  bookingEvidence: boolean;
  lowSignalBefore: number;
  lowSignalAfter: number;
  greetingBefore: number;
  greetingAfter: number;
  replySource: string;    // gemini | fallback
  memLines: number;
  latestSignal: GoodFaithSignal;    // good-faith category of the customer's LATEST message
  aggregateSignal: GoodFaithSignal; // signal of the FULL aggregate (vs the latest fragment)
  lastAssistant: string;            // prior-reply contract flags: B(ooking)/M(anage)/H(elp)/Q(uestion)
  staleTopicGuard: boolean;         // true ⇒ a stale manage thread was overridden by the latest topic
  softIntent: boolean;              // true ⇒ latest message classified as indirect service intent
  contextualConfirmation: boolean;  // true ⇒ a bare "כן" resolved via the last-assistant booking contract
  capabilityFence: boolean;         // true ⇒ an unsupported in-chat promise was redirected/neutralized
  recoveryFollowup: boolean;        // true ⇒ a "did it recover?" question after a degraded reply
  pendingResolved: boolean;         // true ⇒ a bare affirmation resolved a still-valid pending offer
  coldYes: boolean;                 // true ⇒ a bare affirmation with NO context → safe clarification
  customerVisible: boolean;         // false ⇒ this turn sent the customer nothing (silence)
  action: string;         // short human summary, e.g. "reply+booking" / "suppressed"
  interactivePayloadId?: string;    // stable id when this turn was a TAP on a clickable option
  // ── Observability (LOG-ONLY) — optional so existing call sites stay valid. Let later analysis group by
  //    fallback kind + live provider health and see whether a failed need was preserved/recovered. ──
  fallbackType?: string;            // transient_soft | transient_micro | outage_entry | low_signal_short | boundary | quiet | …
  providerHealth?: string;          // getGeminiHealth().state at trace time: healthy | transient | outage
  strikes?: number;                 // overload strikes at trace time
  failedNeedStored?: boolean;       // a transient-503 need was PRESERVED this turn for later recovery
  failedNeedRecovered?: boolean;    // a previously-preserved transient-503 need was consumed this turn
}

function logTurnTrace(t: TurnTrace): void {
  console.log(`[turn-trace] ${JSON.stringify(t)}`);
}

function errorDecision(branch: string, ok = false): ReceptionistDecision {
  return {
    geminiCalled: false, ok, turn: null,
    replyText: FALLBACK.error, responseType: ok ? "degraded" : "error",
    grounded: null, replySource: "fallback", wantsToCancel: false,
    branch, fallbackReason: ok ? undefined : branch,
  };
}

async function safeLog(businessId: string, customerId: string, d: ReceptionistDecision): Promise<void> {
  await logAIEvent({
    businessId,
    customerId,
    called: d.geminiCalled,
    intent: d.turn?.understanding.intent ?? null,
    confidence: null,
    success: d.responseType !== "error",
    responseType: d.responseType,
  });
}
