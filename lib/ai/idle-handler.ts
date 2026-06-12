// lib/ai/idle-handler.ts
// Server-side only.
//
// THE CONVERSATION ENGINE — the primary handler for (almost) every customer
// message. Architecture: conversation → understanding → booking_context → facts
// → response.
//
// Conversation-quality alignment (this pass):
//   - Gemini's prompt receives the booking context INCLUDING the current
//     message's deterministic probe (working memory is never one turn behind)
//   - a system-computed REPLY GUIDANCE line tells the model the single most
//     useful next step (acknowledge first, ask only for the missing field)
//   - corrections ("אמרתי מחר", "למה אתה שוב שואל") are first-class signals
//   - loop recovery fires EARLY: redundant-question guard (any turn),
//     contextual recovery at stuck>=3, prompt strategy-change at stuck>=2
//   - the customer's existing future appointments are fetched (read-only) so
//     cancel/reschedule questions get honest answers
//
// The engine does NOT send WhatsApp messages — the router (flow.ts) sends the
// returned replyText. Gemini never writes the DB and never executes bookings.

import type { DB } from "@/lib/booking/helpers";
import { upsertConversationState } from "@/lib/booking/helpers";
import { getBusinessAIContext } from "./context";
import {
  getConversationContext, findTimeInHistory, didLastReplyFailToSend, renderUpcomingAppointments,
} from "./conversation";
import { isGeminiCoolingDown, geminiCooldownRemainingMs } from "./gemini";
import {
  loadBookingSession, sessionFromLegacyContext, probeMessage, overlayProbe,
  mergeUnderstanding, missingFields, isReadyForConfirm, renderSession,
  detectRedundantQuestion, buildContextReply, applyChangeRequests,
  applyOfferRejection, captureOfferedSlots, protectArmedDraft,
  nextStepQuestion, isCredibleChangeRequest,
  type BookingSession, type ServiceLite,
} from "./booking-session";
import {
  ensureDateEcho, ensureConfirmCta, stripEmojis, sameOutboundText, nearDuplicateText,
  claimsBookingCompleted, applyVerdictAlignment,
} from "./reply-polish";
import {
  buildAvailabilityInfo, renderAvailabilityInfo, buildReplyGuidance,
  type AvailabilityInfo,
} from "./availability-facts";
import {
  runReceptionistTurn, FALLBACK, classifyInput, composeDegradedReply, overloadNoticeAlreadyShown,
  type ReceptionistDecision,
} from "./brain";
import { logAIEvent } from "./events";

export interface TurnOutcome {
  replyText: string;
  decision: ReceptionistDecision;
  session: BookingSession;
  newFields: string[];
  progress: boolean;
  stuckTurns: number;
  loopBroken: boolean;            // reply was replaced by a deterministic recovery
  guardReason: string | null;     // redundant_service | stuck3 | duplicate | null
  enteredConfirm: boolean;
  availabilitySource: "none" | "message" | "session" | "session+message" | "post_merge";
  evaluationCategory: string | null;
  memLines: number;
}

/**
 * Runs one conversational turn. Persists session/state and logs ai_events, but
 * does NOT send the reply — the router sends `replyText`.
 */
export async function runConversationTurn(
  db: DB,
  businessId: string,
  customerId: string,
  messageText: string,
  rawContext: Record<string, unknown>,
  timezone: string,
  rawState: string = "idle"
): Promise<TurnOutcome> {
  // 1. Facts (source of truth).
  let ctx;
  try {
    ctx = await getBusinessAIContext(businessId);
  } catch (err) {
    console.error("[engine] failed to load business context:", err instanceof Error ? err.message : String(err));
    const decision: ReceptionistDecision = {
      geminiCalled: false, ok: false, turn: null, replyText: FALLBACK.error,
      responseType: "error", grounded: null, replySource: "fallback",
      wantsToCancel: false, branch: "context_load_error", fallbackReason: "context_load_error",
    };
    await safeLog(businessId, customerId, decision);
    return {
      replyText: FALLBACK.error, decision, session: loadBookingSession(rawContext),
      newFields: [], progress: false, stuckTurns: 0, loopBroken: false, guardReason: null,
      enteredConfirm: false, availabilitySource: "none", evaluationCategory: null, memLines: 0,
    };
  }

  const services: ServiceLite[] = ctx.services
    .filter((s) => s.active)
    .map((s) => ({ id: s.id, name: s.name, duration_minutes: s.duration_minutes }));

  // Per-turn AI-settings visibility (owner config — safe to log, no customer data).
  {
    const ai = ctx.aiSettings;
    const ci = ai?.custom_instructions?.trim();
    console.log(
      `[ai] settings tone=${ai?.tone ?? "-"} length=${ai?.response_length ?? "-"} emoji=${ai?.emoji_usage ?? "-"}` +
      ` custom=${ci ? `yes(len=${ci.length},"${ci.slice(0, 24)}${ci.length > 24 ? "…" : ""}")` : "no"}`
    );
  }

  // 2. Session (booking context — the primary abstraction) + memory + appointments.
  //    Deterministic draft-change detection runs FIRST ("בוא נחשוב על יום אחר" →
  //    reopen the day), so the probe, availability, working memory and guards all
  //    see the reopened field this very turn.
  const loadedSession = sessionFromLegacyContext(rawContext);
  const changeResult = applyChangeRequests(loadedSession, messageText);
  const preCleared = changeResult.cleared;
  if (preCleared.length > 0) {
    console.log(`[engine] draft change request detected — reopened: [${preCleared.join(",")}]`);
  }
  // Offer rejection ("אף אחת!") → previously-offered times become rejected for
  // this day BEFORE the prompt is built, so they vanish from the facts.
  const rejection = applyOfferRejection(changeResult.session, messageText);
  const prevSession = rejection.session;
  if (rejection.rejectedNow.length > 0) {
    console.log(`[engine] offered slots rejected: [${rejection.rejectedNow.join(",")}] — total rejected for day: [${prevSession.rejectedSlots.join(",")}]`);
  }
  if (rejection.unrejected.length > 0) {
    console.log(`[engine] customer reconsidered: [${rejection.unrejected.join(",")}] removed from rejected`);
  }
  const [memory, upcomingBlock, lastSendFailed] = await Promise.all([
    getConversationContext(db, businessId, customerId),
    renderUpcomingAppointments(db, businessId, customerId, timezone),
    didLastReplyFailToSend(db, businessId, customerId),
  ]);

  // 3. Probe + availability from ACCUMULATED context (session ∪ message).
  const probe = probeMessage(messageText, prevSession, services, timezone);
  let availability: AvailabilityInfo | null = null;
  let availabilitySource: TurnOutcome["availabilitySource"] = "none";
  if (probe.dateISO) {
    availability = await buildAvailabilityInfo(
      db, businessId, ctx, probe.dateISO, probe.time, probe.service?.duration_minutes ?? null
    );
    const fromMsg = probe.dateISO !== prevSession.dateISO;
    const fromSession = prevSession.dateISO !== null;
    availabilitySource = fromMsg && fromSession ? "session+message" : fromMsg ? "message" : "session";
  }
  const pendingTimeNoDate = !probe.dateISO && probe.time ? probe.time : null;

  // 4. PREVIEW session for the prompt: prior session + this message's probe — so
  //    Gemini's working memory is never one turn behind what was just said.
  const preview = overlayProbe(prevSession, probe);
  const bookingBlock = [renderSession(preview), upcomingBlock].filter(Boolean).join("\n\n");
  let replyGuidance = buildReplyGuidance(preview, availability);
  if (lastSendFailed) {
    // Meta delivery failure recovery: the customer never received our last reply.
    replyGuidance = [
      `NOTE: your PREVIOUS reply FAILED to deliver (technical issue on our side — the customer never saw it). Open with a brief, warm acknowledgement of a small hiccup ("הייתה לי תקלה קטנה קודם") and recap where things stand before continuing.`,
      replyGuidance,
    ].filter(Boolean).join("\n");
  }

  // 5. One Gemini call. (allowedTimes keeps rejected times grounded so honest
  //    references like "חוץ מ-12:00 שלא התאים" never trip the grounding fence —
  //    the PROMPT, not the fence, is what excludes them from being offered.)
  const allowedTimes = availability
    ? [...availability.slots, ...(availability.requested?.nearest ?? []), ...prevSession.rejectedSlots]
    : [...prevSession.rejectedSlots];
  // DEGRADED MODE GATE: while Gemini is in overload cooldown, serve the turn
  // fully deterministically — probe-merge, availability, recap — with NO AI
  // call. Noise/abuse still goes through the brain (its guards run pre-Gemini,
  // so they cost nothing).
  const cooling = isGeminiCoolingDown() && classifyInput(messageText) === "ok";
  let decision: ReceptionistDecision;
  if (cooling) {
    console.warn(
      `[engine] DEGRADED MODE — gemini overload cooldown (${Math.ceil(geminiCooldownRemainingMs() / 1000)}s left); deterministic turn, no AI call`
    );
    decision = {
      geminiCalled: false, ok: true, turn: null, replyText: "",
      responseType: "degraded", grounded: null, replySource: "fallback",
      wantsToCancel: false, branch: "gemini_cooldown", skipReason: "gemini_cooldown",
    };
  } else {
    decision = await runReceptionistTurn(ctx, {
      historyTurns: memory.turns,           // native multi-turn — best follow-up understanding
      conversationContext: memory.transcript, // fallback only (unused when turns exist)
      message: messageText,
      availabilityBlock: renderAvailabilityInfo(availability, pendingTimeNoDate, prevSession.rejectedSlots),
      bookingBlock,
      stuckTurns: prevSession.stuckTurns,
      allowedTimes,
      replyGuidance,
    });
  }

  // 6. Merge into the session (authoritative). Merge runs even when the AI turn
  //    failed or was skipped (cooldown): the deterministic probe's findings must
  //    never be lost together with the AI reply.
  let session = prevSession;
  let newFields: string[] = [];
  if (decision.turn || decision.geminiCalled || decision.branch === "gemini_cooldown") {
    const mu = decision.turn?.understanding;
    // A model changeRequest needs supporting change vocabulary in the message —
    // otherwise it's noise ("לא הבנתי מה" emitted changeRequest=day live and
    // silently reopened the settled day). A genuinely new value still replaces
    // the old one without needing any clear.
    const credibleChange =
      mu?.changeRequest && (preCleared.length > 0 || isCredibleChangeRequest(messageText))
        ? mu.changeRequest
        : null;
    if (mu?.changeRequest && !credibleChange) {
      console.log(`[engine] changeRequest=${mu.changeRequest} ignored (no change vocabulary in message)`);
    }
    const merged = mergeUnderstanding(prevSession, {
      serviceName: mu?.serviceName,
      dateText: mu?.dateText,
      time: mu?.time,
      timePreference: mu?.timePreference,
      customerReference: mu?.customerReference,
      conversationGoal: mu?.conversationGoal,
      bookingIntent: mu?.intent === "booking",
      appointmentIntent: mu?.appointmentIntent,
      changeRequest: credibleChange,
    }, probe, services, timezone, preCleared);
    session = merged.session;
    newFields = merged.newFields;
  }

  // 6a. CONFIRM-STATE PROTECTION (armed confirmation + meta-question): restore
  //     fields a model change-signal cleared WITHOUT a replacement value.
  if (rawState === "booking_confirm" && preCleared.length === 0) {
    const protectedDraft = protectArmedDraft(prevSession, session, decision.turn?.understanding.intent);
    if (protectedDraft.restored.length > 0) {
      session = protectedDraft.session;
      newFields = newFields.filter((f) => !f.endsWith("_reopened"));
      console.log(`[engine] confirm-state protection — restored [${protectedDraft.restored.join(",")}] (change signal without replacement on an armed confirmation)`);
    }
  }

  // 6b. "אמרתי כבר" recovery: the customer insists a detail was already given.
  //     If the TIME is still missing, recover it from their recent messages with
  //     the rich Hebrew parser (forms older turns failed to read) instead of
  //     asking yet again.
  {
    const u0 = decision.turn?.understanding;
    if (session.active && !session.time && (u0?.userRepeatingInfo || u0?.userCorrecting)) {
      const recovered = findTimeInHistory(memory.turns, session.rejectedSlots);
      if (recovered) {
        session = { ...session, time: recovered, updatedAt: new Date().toISOString() };
        newFields.push("time");
        console.log(`[engine] time recovered from history: ${recovered}`);
      }
    }
  }

  // 6c. POST-MERGE availability check: the time/day may have arrived via Gemini's
  //     understanding (or history recovery) only — invisible to the pre-call
  //     probe. Re-evaluate NOW so the confirm step arms in the SAME turn instead
  //     of one turn late (live: the "5 וחצי" turn ended in a dead-end reply).
  if (
    session.active && session.dateISO && session.time &&
    (availability?.dateISO !== session.dateISO || availability?.requested?.time !== session.time)
  ) {
    availability = await buildAvailabilityInfo(
      db, businessId, ctx, session.dateISO, session.time, session.serviceDurationMin
    );
    availabilitySource = "post_merge";
    console.log(
      `[engine] post-merge availability check — ${session.dateISO} ${session.time} → ${availability?.requested?.category ?? "?"}`
    );
  }

  // 7. Correction & loop bookkeeping. A correction means the PREVIOUS reply was
  //    wrong → force the strategy change immediately (stuck >= 2).
  const u = decision.turn?.understanding;
  const intent = u?.intent;
  const correctionSignal = !!(u?.userCorrecting || u?.userRepeatingInfo || u?.userFrustrated);

  const realFieldGained = newFields.some((f) => ["service", "day", "time"].includes(f));
  // Reopening a draft field IS progress — the customer changed direction and the
  // context moved with them.
  const fieldReopened = preCleared.length > 0 || newFields.some((f) => f.endsWith("_reopened"));
  const availabilityEvaluated = !!availability?.requested || (availability !== null && availabilitySource !== "session");
  const isPivot = intent === "faq" || intent === "smalltalk" || intent === "out_of_scope";
  const progress = realFieldGained || fieldReopened || availabilityEvaluated || newFields.includes("goal") || isPivot || !session.active;

  if (session.active && !progress) {
    session.stuckTurns = prevSession.stuckTurns + 1;
  } else {
    session.stuckTurns = 0;
  }
  if (correctionSignal) {
    session.stuckTurns = Math.max(session.stuckTurns, 2);
  }
  session.lastMissing = missingFields(session)[0] ?? null;

  // 8. Reply guards (deterministic recovery — EARLY, not after 5 turns):
  //    a) redundant-question guard: never ask for a field that is already known
  //    b) stuck>=3 → contextual recovery (summary + one focused question)
  //    c) exact repeat of the previous assistant message → contextual recovery
  let replyText = decision.replyText;
  let guardReason: string | null = null;
  const lastAssistant = lastAssistantLine(memory.transcript);
  // Cooldown turn: compose the deterministic reply from the MERGED session +
  // availability (notice → recap → verdict; the notice shows once per window).
  if (decision.branch === "gemini_cooldown") {
    replyText = composeDegradedReply(
      messageText, session, availability, overloadNoticeAlreadyShown(memory.transcript)
    );
  }
  // GUARDS DEFER TO UNDERSTOOD CHANGE/CORRECTION. When the customer just asked
  // to change a draft detail (or corrected us), Gemini's question about that
  // field is the RIGHT move — overriding it is what caused the redundant_day
  // loop ("בוא ננסה לחשוב על יום אחר" → guard re-asked to confirm the old day).
  // Only the exact-duplicate guard remains active on such turns.
  //
  // EXCEPTION (correction loop): a correction WITHOUT a direction change that
  // leaves the SAME field missing for 3+ turns is not "the model knows better" —
  // it IS the stuck case (live: "אמרתי כבר" turns kept correcting=true, which
  // disabled every safety net while the time was asked six times).
  const changeSignaled = fieldReopened || !!u?.changeRequest || correctionSignal;
  const correctionLoop =
    correctionSignal && !fieldReopened && !u?.changeRequest &&
    session.stuckTurns >= 3 &&
    prevSession.lastMissing !== null &&
    missingFields(session)[0] === prevSession.lastMissing;
  if (decision.ok && session.active) {
    // CONFUSION RECOVERY: the customer says they didn't understand and the model
    // re-sends (essentially) the same line — restate the state deterministically
    // instead (live: a garbled question was repeated verbatim after "לא הבנתי").
    const confused = /לא הבנתי|מה זאת אומרת|מה זה אומר|לא ברור לי/.test(messageText);
    const redundant = changeSignaled && !correctionLoop ? null : detectRedundantQuestion(replyText, session);
    if (confused && nearDuplicateText(replyText, lastAssistant)) {
      replyText = buildContextReply(session, { correction: true });
      guardReason = "confused_repeat";
    } else if (redundant) {
      replyText = buildContextReply(session, { correction: correctionSignal });
      guardReason = `redundant_${redundant}`;
    } else if ((!changeSignaled || correctionLoop) && session.stuckTurns >= 3 && !isReadyForConfirm(session)) {
      // Strategy change, not repetition: for a stuck TIME, ask for digits (17:30).
      replyText = buildContextReply(session, {
        correction: correctionSignal,
        digitHint: missingFields(session)[0] === "time",
      });
      guardReason = "stuck3";
    } else if (sameOutboundText(replyText, lastAssistant)) {
      replyText = buildContextReply(session, { correction: correctionSignal });
      guardReason = "duplicate";
    }
  } else if (!decision.ok) {
    // Gemini failure — never abandon the conversation. With an active booking,
    // keep helping deterministically (hiccup + context summary + one question);
    // and never send the exact same failure line twice in a row.
    if (session.active && isTechnicalFallback(decision.fallbackReason)) {
      // Keep the failure line the brain chose (overload has its own helpful
      // wording) + a contextual recap — but never repeat the overload notice
      // twice in a row.
      const skipNotice =
        decision.fallbackReason === "gemini_overloaded" && !!lastAssistant && /עומס/.test(lastAssistant);
      replyText = `${skipNotice ? "" : decision.replyText} ${buildContextReply(session)}`.trim();
      guardReason = "tech_continue";
    } else if (sameOutboundText(replyText, lastAssistant)) {
      // Emoji/whitespace-insensitive: stored history is emoji-stripped, the
      // in-flight fallback isn't — raw comparison let the SAME failure line go
      // out three times in a row live.
      replyText = FALLBACK.errorAlt;
      guardReason = "fallback_rotated";
    }
  }

  // VERDICT ALIGNMENT (uniform — pre-call AND post-merge evaluations): the reply
  // must never contradict the availability verdict, and the session must never
  // keep an unbookable value as "known". (Live: 15:30 evaluated "taken" PRE-call
  // yet the model replied "אנחנו מאשרים" — the old alignment ran post-merge only.)
  if (decision.ok && !decision.wantsToCancel && session.active && availability &&
      (session.lifecycle === null || session.lifecycle === "book")) {
    const aligned = applyVerdictAlignment(replyText, session, availability);
    replyText = aligned.replyText;
    session = aligned.session;
    guardReason = guardReason ?? aligned.guardReason;
  }
  // Date-echo (deterministic): the turn a day is settled or CHANGED, the customer
  // sees the resolved calendar date — bare "חמישי" must never silently become a
  // specific date that first surfaces at final confirmation.
  if (decision.ok && !decision.wantsToCancel && session.active &&
      session.dateISO && newFields.includes("day")) {
    replyText = ensureDateEcho(replyText, session);
  }

  // NEXT-STEP BACKSTOP: a booking turn must end with a clear next step. (Live:
  // "אחלה, תספורת זה תמיד רעיון אש." — full stop — and the customer had to nudge
  // twice.) Applies only to model-authored booking-intent replies that ask
  // nothing while a field is still missing; FAQ/smalltalk pivots are exempt.
  if (decision.ok && session.active && !decision.wantsToCancel && guardReason === null &&
      u?.intent === "booking" && !replyText.includes("?") &&
      missingFields(session)[0] !== "confirmation") {
    const q = nextStepQuestion(session);
    if (q) replyText = `${replyText} ${q}`;
  }

  // AI-Settings consistency: when the owner set emoji=none, NO outgoing text —
  // model-written, guard, or fallback — may contain emojis.
  if (ctx.aiSettings?.emoji_usage === "none") {
    replyText = stripEmojis(replyText);
  }

  // Record which open slots THIS reply actually offered (so a later "אף אחת!"
  // knows exactly what was turned down).
  if (availability) {
    session = captureOfferedSlots(
      session, replyText, availability.slots, availability.requested?.nearest ?? []
    );
    if (session.lastOfferedSlots.length > 0) {
      console.log(`[engine] offered slots this turn: [${session.lastOfferedSlots.join(",")}]`);
    }
  }
  // Remember a NON-available verdict ("17:30 was taken when checked") — the
  // truthful answer to a later "למה הצעת לי שעות אחרות?".
  if (availability?.requested && availability.requested.category !== "available") {
    session = {
      ...session,
      lastVerdict: { time: availability.requested.time, category: availability.requested.category },
    };
  }

  // 9. Persist + transition. Cancel → clear. Complete + slot AVAILABLE → arm the
  //    EXISTING deterministic confirm step (INSERT unchanged, literal "כן" required).
  let enteredConfirm = false;
  if (decision.wantsToCancel) {
    await upsertConversationState(db, businessId, customerId, "idle", {});
    session = { ...session, active: false };
  } else if (
    isReadyForConfirm(session) &&
    (session.lifecycle === null || session.lifecycle === "book") &&
    availability?.requested?.category === "available" &&
    availability.requested.time === session.time
  ) {
    enteredConfirm = true;
    await upsertConversationState(db, businessId, customerId, "booking_confirm", {
      booking_session: session,
      selected_service_id: session.serviceId,
      selected_service_name: session.service,
      selected_duration_minutes: session.serviceDurationMin ?? availability.durationUsedMin,
      selected_date: session.dateISO,
      selected_slot_time: session.time,
    });
  } else {
    await upsertConversationState(db, businessId, customerId, "idle", { booking_session: session });
  }

  // Confirmation-UX backstop: when the confirm step armed, the reply must say
  // exactly how to confirm (soft CTAs invite "יאללה" instead of the literal כן).
  if (enteredConfirm) {
    replyText = ensureConfirmCta(replyText);
  }

  // BOOKED-CLAIM FENCE: the engine never inserts appointments — a reply claiming
  // the booking is done/held on an unfinished draft is a lie (live: "כן, התור
  // נקבע" with eval=taken and no INSERT, after "אנחנו מאשרים" and "מחכים לך").
  if (!enteredConfirm && decision.ok && !decision.wantsToCancel && session.active &&
      claimsBookingCompleted(replyText)) {
    replyText = `עוד לא סגרנו סופית 🙂 ${buildContextReply(session)}`;
    if (ctx.aiSettings?.emoji_usage === "none") replyText = stripEmojis(replyText);
    guardReason = guardReason ?? "booked_claim";
  }
  const loopBroken = guardReason !== null;

  // 10. Log (responseType upgraded when the confirm step was armed).
  const logDecision: ReceptionistDecision = enteredConfirm
    ? { ...decision, responseType: "booking_handoff" }
    : decision;
  await safeLog(businessId, customerId, logDecision);

  console.log(
    `[engine] ai_called=${decision.geminiCalled}` +
    ` intent=${intent ?? "-"}` +
    ` goal="${session.conversationGoal ?? "-"}"` +
    ` fields_new=[${newFields.join(",")}]` +
    ` missing=[${missingFields(session).join(",")}]` +
    ` correcting=${correctionSignal}` +
    ` progress=${progress} stuck=${session.stuckTurns}` +
    ` guard=${guardReason ?? "-"}` +
    ` avail_src=${availabilitySource} eval=${availability?.requested?.category ?? "-"}` +
    ` entered_confirm=${enteredConfirm}` +
    ` src=${loopBroken ? "fallback(guard)" : decision.replySource}` +
    ` memLines=${memory.turnsUsed}` +
    (decision.usage
      ? ` tok_in=${decision.usage.promptTokens} tok_out=${decision.usage.outputTokens + decision.usage.thoughtTokens}` +
        ` est_cost=$${decision.usage.estCostUSD !== null ? decision.usage.estCostUSD.toFixed(6) : "?"}`
      : "") +
    (decision.fallbackReason ? ` fallback=${decision.fallbackReason}` : "")
  );

  return {
    replyText, decision, session, newFields, progress,
    stuckTurns: session.stuckTurns, loopBroken, guardReason, enteredConfirm,
    availabilitySource,
    evaluationCategory: availability?.requested?.category ?? null,
    memLines: memory.turnsUsed,
  };
}

// ── Small helpers ──────────────────────────────────────────────────────────────

function isTechnicalFallback(reason: string | undefined): boolean {
  if (!reason) return false;
  return reason === "not_configured" || reason === "malformed_json" || reason.startsWith("gemini_");
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Pulls the last assistant line out of the context-only transcript. */
function lastAssistantLine(transcript: string): string | null {
  const lines = transcript.split("\n").filter((l) => l.startsWith("Assistant (you, earlier): "));
  if (lines.length === 0) return null;
  return normalize(lines[lines.length - 1].replace("Assistant (you, earlier): ", ""));
}

async function safeLog(businessId: string, customerId: string, d: ReceptionistDecision): Promise<void> {
  const success =
    d.responseType !== "error" &&
    d.responseType !== "not_configured" &&
    d.responseType !== "grounding_failed";
  await logAIEvent({
    businessId,
    customerId,
    called: d.geminiCalled,
    intent: d.turn?.understanding.intent ?? null,
    confidence: null,
    success,
    responseType: d.responseType,
  });
}
