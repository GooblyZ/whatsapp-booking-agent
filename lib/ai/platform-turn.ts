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
} from "./conversation";
import { isGeminiCoolingDown, geminiCooldownRemainingMs } from "./gemini";
import {
  runReceptionistTurn, FALLBACK, classifyInput, type ReceptionistDecision, type ReceptionistTurn,
} from "./brain";
import { stripEmojis, sameOutboundText, claimsBookingCompleted } from "./reply-polish";
import { logAIEvent } from "./events";
import { buildBookingLink, buildAppointmentLink } from "@/lib/config";
import { buildMyAppointmentsLink } from "@/lib/booking/appointment-token";
import { listUpcomingByCustomer } from "@/lib/booking/appointments";

export type PlatformLink = "booking" | "manage" | null;

export interface PlatformTurnOutcome {
  replyText: string;
  decision: ReceptionistDecision;
  linkAttached: PlatformLink;
  /** Quiet mode: the router should NOT send a WhatsApp reply this turn (inbound is
   *  already saved; state is persisted). Used to stop replying to endless nonsense. */
  suppressReply?: boolean;
}

// WhatsApp renders *…* as bold and auto-links a bare URL on its own line. A bold
// label + clean URL reads as an intentional, premium CTA (no markdown links in
// WhatsApp). Emojis are intentionally omitted here so the CTA looks the same
// regardless of the owner's emoji setting and never trips the chokepoint.
const BOOK_LINE = "*לקביעת תור — מהיר ופשוט:*";
const MANAGE_LINE = "*לניהול התור (צפייה · שינוי · ביטול):*";
const MY_APPTS_LINE = "*כל התורים שלך — לבחירה וניהול:*";

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
  priorContext: Record<string, unknown> = {}
): Promise<PlatformTurnOutcome> {
  // Low-signal escalation counter — persisted in the (always-idle) platform state.
  const prevLowSignal = readLowSignalCount(priorContext);

  // Legacy conversational-booking states cannot continue in platform mode —
  // reset once so the customer starts clean after the flip (but carry the
  // low-signal counter forward so repeated gibberish across a reset still escalates).
  if (rawState !== "idle") {
    console.log(`[platform-turn] resetting legacy state "${rawState}" → idle`);
    await upsertConversationState(db, businessId, customerId, "idle", { consecutiveLowSignalTurns: prevLowSignal });
  }

  let ctx;
  try {
    ctx = await getBusinessAIContext(businessId);
  } catch (err) {
    console.error("[platform-turn] failed to load business context:", err instanceof Error ? err.message : String(err));
    const decision = errorDecision("context_load_error");
    await safeLog(businessId, customerId, decision);
    return { replyText: FALLBACK.error, decision, linkAttached: null };
  }

  const timezone = ctx.business.timezone || "Asia/Jerusalem";
  const [memory, upcomingBlock, customerBlock, lastSendFailed] = await Promise.all([
    getConversationContext(db, businessId, customerId),
    renderUpcomingAppointments(db, businessId, customerId, timezone, true),
    renderCustomerState(db, businessId, customerId, timezone),
    didLastReplyFailToSend(db, businessId, customerId),
  ]);
  const lastAssistant = lastAssistantLine(memory.transcript);
  const bookingBlock = [customerBlock, upcomingBlock].filter(Boolean).join("\n\n");
  // A booking link was sent earlier iff our transcript already carries a URL — only
  // we ever send links. Lets the reply legitimately reference "the link I sent".
  const previousBookingLinkSent = /https?:\/\/\S+/.test(memory.transcript);

  // ── EMOJI-ONLY messages (e.g. "🙏🏻", "😊😊"): contentless but legitimate. NEVER
  //    call Gemini, and route them through the SAME low-signal counter + escalation
  //    + quiet mode as text gibberish (fixes the per-emoji fallback spam). Mixed
  //    text+emoji ("תודה 😊") is NOT emoji-only and flows normally. Detected
  //    cheaply and generally (no blacklist): has a pictographic char and no letters/
  //    digits. Gender on the boundary reply is fixed at the outbound chokepoint.
  if (isEmojiOnly(messageText)) {
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
    await upsertConversationState(db, businessId, customerId, "idle", { consecutiveLowSignalTurns: newCount });
    const decision = errorDecision("low_signal_emoji", true);
    await safeLog(businessId, customerId, decision);
    console.log(
      `[platform-turn] ai_called=false pre_gemini_guard=true pre_gemini_action=skip_gemini_emoji` +
      ` gemini_skipped_reason=emoji_only low_signal=true low_signal_kind=emoji` +
      ` low_signal_count_before=${prevLowSignal} low_signal_count_after=${newCount}` +
      ` low_signal_action=${action} reply_suppressed=${suppressReply} link=-`
    );
    return { replyText, decision, linkAttached: null, suppressReply };
  }

  // ── PRE-GEMINI QUIET-MODE GUARD (cost control, BEFORE any model call) ──────────
  // Active only once the boundary has been set (3+ consecutive low-signal turns).
  // Cheap, local classification decides — Gemini is never paid for here:
  //   • OBVIOUS gibberish/keyboard-smash → no Gemini, mostly silent (sparse reminder)
  //   • a normal greeting / meta ("היי", "מה קורה", "יש תשובה?") → NOT spam: a short
  //     friendly RESET reply (no Gemini) and the counter resets — never silently dropped
  //   • anything else (a real-looking message) → fall through to Gemini
  const activeServiceNames = ctx.services.filter((s) => s.active).map((s) => s.name);
  const preGemini = preGeminiAction(prevLowSignal, messageText, activeServiceNames);
  if (preGemini !== "proceed_to_gemini") {
    if (preGemini === "skip_gemini_gibberish") {
      const newCount = prevLowSignal + 1;
      const plan = quietModePlan(newCount);
      await upsertConversationState(db, businessId, customerId, "idle", { consecutiveLowSignalTurns: newCount });
      const decision = errorDecision("low_signal_quiet", true);
      await safeLog(businessId, customerId, decision);
      console.log(
        `[platform-turn] ai_called=false pre_gemini_guard=true pre_gemini_action=skip_gemini_gibberish` +
        ` gemini_skipped_reason=quiet_mode_gibberish low_signal=true low_signal_kind=gibberish` +
        ` low_signal_count_before=${prevLowSignal} low_signal_count_after=${newCount}` +
        ` low_signal_action=quiet_mode cooldown_short_circuit=true reply_suppressed=${plan.suppressReply} link=-`
      );
      return {
        replyText: plan.suppressReply ? "" : LOW_SIGNAL_QUIET_REMINDER,
        decision, linkAttached: null, suppressReply: plan.suppressReply,
      };
    }
    if (preGemini === "cheap_reset_reply") {
      // Human greeting/meta during quiet mode: answer cheaply and DE-escalate.
      await upsertConversationState(db, businessId, customerId, "idle", { consecutiveLowSignalTurns: 0 });
      const decision = errorDecision("low_signal_reset", true);
      await safeLog(businessId, customerId, decision);
      console.log(
        `[platform-turn] ai_called=false pre_gemini_guard=true pre_gemini_action=cheap_reset_reply` +
        ` gemini_skipped_reason=quiet_mode_reset_message low_signal=false low_signal_kind=meta` +
        ` low_signal_count_before=${prevLowSignal} low_signal_count_after=0 reply_suppressed=false link=-`
      );
      return { replyText: QUIET_RESET, decision, linkAttached: null, suppressReply: false };
    }
    // else: real-looking message → fall through to Gemini (recovery happens there).
  }

  // DEGRADED MODE: during a Gemini overload cooldown the platform story is
  // simple — the booking page IS the deterministic path. Route to it directly.
  if (isGeminiCoolingDown() && classifyInput(messageText) === "ok") {
    console.warn(`[platform-turn] DEGRADED MODE — cooldown ${Math.ceil(geminiCooldownRemainingMs() / 1000)}s left`);
    // Even during an outage, only attach the link on a real booking signal — never
    // spam a link onto small talk just because the AI is down.
    if (hasBookingSignal(messageText, activeServiceNames)) {
      const link = buildBookingLink(ctx.business.slug, customerPhone);
      let replyText = `יש לי רגע עומס קטן במערכת 🙏 אפשר בינתיים לקבוע, לשנות או לבדוק זמינות כאן:\n${link}`;
      if (ctx.aiSettings?.emoji_usage === "none") replyText = stripEmojis(replyText);
      const decision = errorDecision("gemini_cooldown", true);
      await safeLog(businessId, customerId, decision);
      return { replyText, decision, linkAttached: "booking" };
    }
    let replyText = "יש לי רגע עומס קטן במערכת 🙏 אחזור אלייך עוד רגע — אפשר גם לכתוב לי שוב בעוד דקה.";
    if (ctx.aiSettings?.emoji_usage === "none") replyText = stripEmojis(replyText);
    const decision = errorDecision("gemini_cooldown", true);
    await safeLog(businessId, customerId, decision);
    return { replyText, decision, linkAttached: null };
  }

  let replyGuidance: string | undefined;
  if (lastSendFailed) {
    replyGuidance =
      `NOTE: your PREVIOUS reply FAILED to deliver (technical issue on our side — the customer never saw it). Open with a brief, warm acknowledgement of a small hiccup ("הייתה לי תקלה קטנה קודם") before continuing.`;
  }

  const decision = await runReceptionistTurn(ctx, {
    historyTurns: memory.turns,
    conversationContext: memory.transcript,
    message: messageText,
    bookingBlock,
    replyGuidance,
    platformMode: true,
    customerPhone,
  });

  let replyText = decision.replyText;

  // The model must never claim a booking action happened — in platform mode it
  // structurally can't have. Replace the lie with an honest router line.
  if (decision.ok && claimsBookingCompleted(replyText)) {
    replyText = "את התור עצמו קובעים בקישור — שניה ושולח לך אותו 🙂";
  }
  // Never send the exact same reply twice in a row. (No link wording here — a link
  // is only ever promised by the deterministic link logic below, never by a generic
  // fallback; the link-wording fence at the end is the backstop.)
  if (decision.ok && sameOutboundText(replyText, lastAssistant)) {
    replyText = "אני כאן 🙂 אפשר לשאול אותי כל דבר על העסק, או לקבוע תור מתי שתרצה.";
  }

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

  // ── Deterministic link control (OVERRIDES Gemini's intent). Complaints about
  //    links/bugs, bare meta-questions ("מה?"/"למה?"/"לא הבנתי"), corrections and
  //    one-char messages must NEVER get a booking/manage link — Gemini mislabels
  //    them as BOOK, which created the live "complain about links → bot sends
  //    another link" loop. The link attaches only on a genuine action intent.
  const u = decision.turn?.understanding;
  let linkAttached: PlatformLink = null;

  if (decision.ok && suppressLinkFor(messageText)) {
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
    // PRIMARY GATE — actionability: the model must have judged this an actual
    // business operation. (The parser already forces appointmentIntent=NONE when
    // requestsBusinessAction is false, so this is also defense-in-depth.)
    const isAction = u.requestsBusinessAction === true;
    const wantsBooking = isAction && (u.appointmentIntent === "BOOK" || u.intent === "booking");
    const wantsManage = isAction && (
      u.appointmentIntent === "CANCEL" || u.appointmentIntent === "RESCHEDULE" ||
      u.appointmentIntent === "MODIFY" || u.appointmentIntent === "LIST" ||
      u.intent === "cancel_request" || u.intent === "reschedule_request");

    // SECONDARY GATE (deterministic floor): even an affirmed operation must be
    // corroborated by a real booking/service signal in the message — catches the
    // rare case where the model still over-asserts an action.
    const bookingSignal = hasBookingSignal(messageText, activeServiceNames);

    if ((wantsBooking || wantsManage) && !bookingSignal) {
      console.log(`[platform-turn] link suppressed: action=${isAction} intent=${u.intent}/${u.appointmentIntent} but no booking signal in message`);
    } else if (wantsManage) {
      // Deterministic link decision — code decides the fact, the model never
      // guesses how many appointments exist or which one to manage:
      //   0 upcoming → booking link (nothing to manage; offer to book)
      //   1 upcoming → that appointment's manage page (/appointment/[id])
      //   2+ upcoming → My Appointments page (customer picks which one)
      const upcoming = await listUpcomingByCustomer(db, businessId, customerId, 5);
      let url: string;
      let label: string;
      if (upcoming.length === 0) {
        url = buildBookingLink(ctx.business.slug, customerPhone);
        label = BOOK_LINE;
        linkAttached = "booking";
      } else if (upcoming.length === 1) {
        url = buildAppointmentLink(upcoming[0].id);
        label = MANAGE_LINE;
        linkAttached = "manage";
      } else {
        url = buildMyAppointmentsLink(customerId);
        label = MY_APPTS_LINE;
        linkAttached = "manage";
      }
      // Same fence as booking: never ask the customer to identify/specify an
      // appointment in chat. For manage we DON'T keep model sentences (that's where
      // it merges/invents appointment details) — the link shows the accurate list.
      const fenced =
        upcoming.length === 0
          ? defuseSchedulingQuestion(replyText)
          : defuseSchedulingQuestion(replyText, { bridge: FENCE_BRIDGE_MANAGE, keepWarmth: false });
      if (fenced.defused) {
        console.log(`[platform-turn] fence: neutralized in-chat selection question (manage, ${upcoming.length} appts)`);
        replyText = fenced.text;
      }
      replyText = appendPlatformLink(replyText, label, url, lastAssistant, messageText);
      logPlatformLink(linkAttached, url);
    } else if (wantsBooking) {
      // DETERMINISTIC FENCE: a booking-intent reply must never ask the customer
      // to pick service/day/time in chat — that's the website's job. Validation
      // showed the model still slips a scheduling question in ~60-80% of the time
      // even with the persona rules, so we strip it deterministically here.
      const fenced = defuseSchedulingQuestion(replyText);
      if (fenced.defused) {
        console.log("[platform-turn] fence: stripped in-chat scheduling question (booking intent → link-first)");
        replyText = fenced.text;
      }
      const url = buildBookingLink(ctx.business.slug, customerPhone);
      replyText = appendPlatformLink(replyText, BOOK_LINE, url, lastAssistant, messageText);
      linkAttached = "booking";
      logPlatformLink(linkAttached, url);
    }
  }

  // ── LOW-SIGNAL GUARD: gently clarify, then set a polite boundary, so repeated
  //    no-intent / gibberish messages don't loop forever. Any productive turn (a
  //    real business question or an operation) resets the counter. Friendly first.
  // Counter is driven by KIND, not raw intent: only gibberish + meaningless unclear
  // escalate. Greetings/smalltalk/meta are legitimate human turns — they reset the
  // counter and keep the model's friendly reply (BUG-005). Productive resets too.
  const kind: LowSignalKind = decision.ok && decision.turn
    ? lowSignalKind(decision, messageText, activeServiceNames)
    : "unclear";
  const lowSignal = decision.ok && !!decision.turn && countsTowardQuiet(kind);
  let newLowSignal = prevLowSignal;
  let lowSignalAct: LowSignalAction = "none";
  let suppressReply = false;
  if (decision.ok && decision.turn) {
    newLowSignal = lowSignal ? prevLowSignal + 1 : 0;
    lowSignalAct = lowSignalActionFor(newLowSignal);
    // count 1 → keep the model's (friendly) clarification; escalate from 2 up.
    if (lowSignalAct === "short_clarify") { replyText = LOW_SIGNAL_SHORT; linkAttached = null; }
    else if (lowSignalAct === "boundary") { replyText = LOW_SIGNAL_BOUNDARY; linkAttached = null; }
    else if (lowSignalAct === "quiet_mode") {
      // Reached via Gemini (the message wasn't obvious local nonsense). Go sparse:
      // mostly suppress, a rare reminder — never the same line every turn.
      linkAttached = null;
      const plan = quietModePlan(newLowSignal);
      if (plan.suppressReply) suppressReply = true;
      else replyText = LOW_SIGNAL_QUIET_REMINDER;
    }
  }
  // !decision.ok (system fallback) leaves the counter unchanged — never penalize a
  // customer for our own error.

  // ── LINK-WORDING FENCE: never imply a link is present/sent unless one was
  //    actually attached this turn or sent earlier in the conversation.
  let linkWordingFenceApplied = false;
  if (shouldFenceLinkWording(linkAttached, previousBookingLinkSent, replyText)) {
    replyText = stripPhantomLinkWording(replyText);
    linkWordingFenceApplied = true;
  }

  // Persist the low-signal counter (platform state is always idle).
  await upsertConversationState(db, businessId, customerId, "idle", { consecutiveLowSignalTurns: newLowSignal });

  if (ctx.aiSettings?.emoji_usage === "none") {
    replyText = stripEmojis(replyText);
  }

  await safeLog(businessId, customerId, decision);
  console.log(
    `[platform-turn] ai_called=${decision.geminiCalled} action=${u?.requestsBusinessAction ?? "-"}` +
    ` intent=${u?.intent ?? "-"} appt_intent=${u?.appointmentIntent ?? "-"} link=${linkAttached ?? "-"}` +
    ` booking_evidence=${bookingEvidence} booking_evidence_reason=${bookingEvidenceReason}` +
    ` pre_gemini_guard=false pre_gemini_action=proceed_to_gemini gemini_skipped_reason=none` +
    ` low_signal=${lowSignal} low_signal_kind=${kind}` +
    ` low_signal_count_before=${prevLowSignal} low_signal_count_after=${newLowSignal}` +
    ` low_signal_action=${lowSignalAct} cooldown_short_circuit=false reply_suppressed=${suppressReply}` +
    ` link_wording_fence_applied=${linkWordingFenceApplied}` +
    ` src=${decision.replySource} memLines=${memory.turnsUsed}`
  );

  return { replyText, decision, linkAttached, suppressReply };
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

export function readLowSignalCount(context: Record<string, unknown>): number {
  const n = context?.consecutiveLowSignalTurns;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Compact recognizer for normal greetings / "are you there?" / follow-up meta — a
// SMALL bounded set (not a gibberish blacklist) so quiet mode can answer a real
// human cheaply instead of suppressing them. Only short messages qualify; anything
// with a booking/service signal is productive, not a greeting.
const GREETING_META_RE =
  /^(היי+|הי|שלום|הלו+|אהלן|בוקר טוב|ערב טוב|צהריים טובים|מה קורה|מה נשמע|מה המצב|מה חדש|מה איתך|יש תשובה|יש מישהו|אתה שם|את שם|מישהו שם|למה לא ענית|למה אתה לא עונה|למה את לא עונה|מה קורה פה|מה קורה כאן|מה אתה עושה)(?=\s|$)/;
export function looksLikeGreetingOrMeta(message: string, serviceNames: string[] = []): boolean {
  const t = (message ?? "").trim().replace(/[?!.…״"'\s]+$/g, "").trim();
  if (t.length === 0 || t.length > 22) return false; // greetings/meta are short
  if (hasBookingSignal(t, serviceNames)) return false; // productive, not a greeting
  return GREETING_META_RE.test(t);
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

export type LowSignalKind = "gibberish" | "emoji" | "unclear" | "smalltalk" | "meta" | "productive";

/** Fine-grained kind for logging + counting. gibberish/unclear push toward quiet
 *  mode; smalltalk/meta/productive do not. */
export function lowSignalKind(d: ReceptionistDecision, message: string, serviceNames: string[] = []): LowSignalKind {
  if (!d.ok || !d.turn) return "unclear";
  const u = d.turn.understanding;
  if (u.intent === "faq") return "productive";
  if (claimsOperation(u)) return "productive";          // evidence gate already ran upstream
  if (looksLikeNoise(message, serviceNames)) return "gibberish";
  if (u.intent === "smalltalk") return "smalltalk";
  if (u.intent === "meta") return "meta";
  return "unclear";
}

/** Kinds that escalate toward quiet mode (the others reset the counter). */
export function countsTowardQuiet(kind: LowSignalKind): boolean {
  return kind === "gibberish" || kind === "unclear";
}

export type PreGeminiAction = "skip_gemini_gibberish" | "cheap_reset_reply" | "proceed_to_gemini";

/** Decides — BEFORE any model call — what to do with the incoming message. Quiet
 *  mode (3+ prior low-signal turns) short-circuits obvious gibberish (no Gemini) and
 *  answers a human greeting/meta cheaply (no Gemini, never silent). Everything else
 *  proceeds to Gemini, where recovery/normal handling happens. */
export function preGeminiAction(prevLowSignal: number, message: string, serviceNames: string[] = []): PreGeminiAction {
  if (prevLowSignal < 3) return "proceed_to_gemini";          // not in quiet mode
  if (looksLikeNoise(message, serviceNames)) return "skip_gemini_gibberish";
  if (looksLikeGreetingOrMeta(message, serviceNames)) return "cheap_reset_reply";
  return "proceed_to_gemini";                                 // real-looking message
}

/** Escalation tier for N consecutive low-signal turns. */
export function lowSignalActionFor(count: number): LowSignalAction {
  if (count <= 0) return "none";
  if (count === 1) return "normal_clarify"; // friendly, keep the model's reply
  if (count === 2) return "short_clarify";
  if (count === 3) return "boundary";
  return "quiet_mode";
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
const LINK_SAFE_FALLBACK = "אני כאן 🙂 אפשר לשאול אותי על העסק או לקבוע תור.";

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
  let out = (text ?? "")
    .replace(PHANTOM_LINK_STRIP, "")
    .replace(/\s*[,،]\s*(?:או|וגם)?\s*([.!?]|$)/g, "$1") // dangling ", או ." → "."
    .replace(/\s+(?:או|וגם)\s*([.!?]|$)/g, "$1")          // dangling " או." → "."
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.!?])/g, "$1")
    .trim();
  // If stripping left almost nothing (the reply was basically just a link line),
  // use a safe canned line. Codepoint-safe: count non-whitespace characters.
  if (out.replace(/\s/g, "").length < 3) out = LINK_SAFE_FALLBACK;
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
export function hasBookingSignal(message: string, serviceNames: string[] = []): boolean {
  const t = (message ?? "").trim();
  if (!t) return false;
  if (SIGNAL_RE.test(t)) return true;
  for (const name of serviceNames) {
    const n = (name ?? "").trim();
    if (n.length >= 2 && new RegExp(bookingToken(escapeForRegex(n))).test(t)) return true;
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
