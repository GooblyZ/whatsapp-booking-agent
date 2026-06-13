// scripts/simulate-conversations.ts
// Developer validation harness — NOT part of the app build.
//
// Drives the PURE receptionist brain (lib/ai/brain.ts) with a synthetic
// BusinessAIContext and real Gemini calls. NO database writes, NO WhatsApp,
// NO ai_events logging — safe to run anytime.
//
// Run from the project root:
//   npm i -D --no-save tsx
//   node --env-file=.env.local --import tsx scripts/simulate-conversations.ts

import type { BusinessAIContext } from "../types/database";
import {
  runReceptionistTurn, composeDegradedReply, overloadNoticeAlreadyShown,
  isLowValueAck, isKnownFallbackText, FALLBACK,
} from "../lib/ai/brain";
import { isGeminiCoolingDown, resetGeminiHealth } from "../lib/ai/gemini";
import {
  emptySession, probeMessage, overlayProbe, mergeUnderstanding, renderSession,
  detectRedundantQuestion, missingFields, applyChangeRequests,
  applyOfferRejection, captureOfferedSlots, detectOfferRejection,
  resolveDateText, buildContextReply, matchService,
  nextStepQuestion, protectArmedDraft, isCredibleChangeRequest, dayNameHe,
  type BookingSession, type ServiceLite,
} from "../lib/ai/booking-session";
import {
  ensureDateEcho, ensureConfirmCta, stripEmojis, sameOutboundText, nearDuplicateText,
  alignAvailableReply, claimsBookingCompleted, lacksUnavailabilityMarker, falseClosedClaim,
  dayRefsFor,
} from "../lib/ai/reply-polish";
import { isIntervalFree, todayInTZ } from "../lib/booking/availability";
import { supabaseServer } from "../lib/supabase/server";
import { renderAvailabilityInfo, renderVerdictReplyHe, type AvailabilityInfo } from "../lib/ai/availability-facts";
import { extractExplicitTime, extractTimeTokens } from "../lib/ai/grounding";
import { findTimeInHistory, applyConversationGap, type ConversationTurn } from "../lib/ai/conversation";
import { isCancelIntent, parseYesNo } from "../lib/booking/flow";

const TZ = "Asia/Jerusalem";

function makeCtx(overrides: Partial<{
  tone: string; emoji: string; length: string; custom: string | null;
}> = {}): BusinessAIContext {
  return {
    business: {
      id: "sim-biz", name: "מספרת השכונה", slug: "sim", phone: "03-1234567",
      timezone: TZ, created_at: "", updated_at: "",
    },
    businessSettings: {
      id: "s", business_id: "sim-biz", booking_enabled: true, confirmation_required: true,
      default_slot_duration_minutes: 30, address: "הרצל 12", city: "תל אביב",
      parking_instructions: null, entrance_instructions: null, cancellation_policy_text: null,
      language: "he", created_at: "", updated_at: "",
    },
    aiSettings: {
      id: "a", business_id: "sim-biz", assistant_name: "נועה",
      tone: (overrides.tone ?? "friendly") as never,
      response_length: (overrides.length ?? "medium") as never,
      emoji_usage: (overrides.emoji ?? "low") as never,
      language: "he", custom_instructions: overrides.custom ?? null,
      ai_enabled: true, faq_enabled: true, intent_detection_enabled: true,
      created_at: "", updated_at: "",
    },
    services: [
      { id: "svc1", business_id: "sim-biz", category_id: null, name: "תספורת", description: null, duration_minutes: 30, price: 80, active: true, created_at: "", updated_at: "" },
      { id: "svc2", business_id: "sim-biz", category_id: null, name: "פן", description: null, duration_minutes: 45, price: 120, active: true, created_at: "", updated_at: "" },
    ],
    knowledgeBaseItems: [
      { id: "kb1", business_id: "sim-biz", category: "about", title: "על העסק", content: "מספרה שכונתית חמה ברחוב הרצל 12, תל אביב.", active: true, created_at: "", updated_at: "" },
      { id: "kb2", business_id: "sim-biz", category: "parking", title: "חניה", content: "יש חניה חינם מאחורי הבניין.", active: true, created_at: "", updated_at: "" },
    ],
    businessHours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      id: `h${d}`, business_id: "sim-biz", day_of_week: d,
      opens_at: d === 0 ? null : "09:00",
      closes_at: d === 0 ? null : "18:00",
      is_closed: d === 0,
      created_at: "", updated_at: "",
    })),
  } as BusinessAIContext;
}

const SERVICES: ServiceLite[] = [
  { id: "svc1", name: "תספורת", duration_minutes: 30 },
  { id: "svc2", name: "פן", duration_minutes: 45 },
];

interface SimState { session: BookingSession; turns: { role: "user" | "model"; text: string }[]; }

async function turn(
  ctx: BusinessAIContext, st: SimState, message: string, extraBlock = "", avail: AvailabilityInfo | null = null
): Promise<void> {
  // Mirror the engine: deterministic draft-change detection BEFORE probe/prompt.
  const pre = applyChangeRequests(st.session, message);
  st.session = pre.session;
  // Mirror the engine: offer rejection moves offered → rejected before the prompt.
  const rej = applyOfferRejection(st.session, message);
  st.session = rej.session;

  const probe = probeMessage(message, st.session, SERVICES, TZ);
  const preview = overlayProbe(st.session, probe);
  const bookingBlock = [renderSession(preview), extraBlock].filter(Boolean).join("\n\n");

  const d = await runReceptionistTurn(ctx, {
    historyTurns: st.turns,
    conversationContext: "",
    message,
    bookingBlock,
    availabilityBlock: avail ? renderAvailabilityInfo(avail, null, st.session.rejectedSlots) : undefined,
    allowedTimes: avail ? [...avail.slots, ...(avail.requested?.nearest ?? []), ...st.session.rejectedSlots] : st.session.rejectedSlots,
  });

  let newFields: string[] = [];
  if (d.turn) {
    const u = d.turn.understanding;
    const merged = mergeUnderstanding(st.session, {
      serviceName: u.serviceName, dateText: u.dateText, time: u.time,
      timePreference: u.timePreference, customerReference: u.customerReference,
      conversationGoal: u.conversationGoal, bookingIntent: u.intent === "booking",
      appointmentIntent: u.appointmentIntent, changeRequest: u.changeRequest,
    }, probe, SERVICES, TZ, pre.cleared);
    st.session = merged.session;
    newFields = merged.newFields;
  }
  // Mirror the engine: record which open slots this reply actually offered.
  if (avail) {
    st.session = captureOfferedSlots(st.session, d.replyText, avail.slots, avail.requested?.nearest ?? []);
  }
  // Mirror the engine: deterministic date-echo when a day was settled this turn.
  let replyOut = d.replyText;
  if (d.ok && newFields.includes("day") && st.session.dateISO) {
    replyOut = ensureDateEcho(replyOut, st.session);
  }
  // Mirror the engine: next-step backstop (booking turns must end with a step).
  const uMirror = d.turn?.understanding;
  if (d.ok && st.session.active && uMirror?.intent === "booking" && !replyOut.includes("?") &&
      missingFields(st.session)[0] !== "confirmation") {
    const q = nextStepQuestion(st.session);
    if (q) replyOut = `${replyOut} ${q}`;
  }
  st.turns.push({ role: "user", text: message });
  st.turns.push({ role: "model", text: replyOut.replace(/\s*\n\s*/g, " ") });

  const u = d.turn?.understanding;
  // Mirror the engine's guard restraint: change/correction turns skip the guard.
  const changeSignaled = pre.cleared.length > 0 || !!u?.changeRequest || !!u?.userCorrecting;
  const redundant = d.ok && st.session.active && !changeSignaled
    ? detectRedundantQuestion(d.replyText, st.session)
    : null;
  console.log(`\n>> USER: ${message}`);
  console.log(`   REPLY: ${replyOut.replace(/\n/g, " | ")}`);
  console.log(
    `   meta: intent=${u?.intent ?? "-"} apptIntent=${u?.appointmentIntent ?? "-"} changeReq=${u?.changeRequest ?? "-"}` +
    ` preCleared=[${pre.cleared.join(",")}] correcting=${u?.userCorrecting ?? "-"} frustrated=${u?.userFrustrated ?? "-"}` +
    ` | fields_new=[${newFields.join(",")}] missing=[${st.session.active ? missingFields(st.session).join(",") : ""}]` +
    ` day=${st.session.dateISO ?? "-"} time=${st.session.time ?? "-"} lifecycle=${st.session.lifecycle ?? "-"} grounded=${d.grounded} ` +
    (redundant ? `⚠ REDUNDANT-GUARD WOULD FIRE: ${redundant}` : "")
  );
}

function emojiCount(s: string): number {
  return (s.match(/\p{Extended_Pictographic}/gu) ?? []).length;
}

async function main() {
  // Validate against the production model: gemini-2.5-flash-lite (single model).
  process.env.GEMINI_MODEL = "gemini-2.5-flash-lite";
  console.log(`Simulating with model = ${process.env.GEMINI_MODEL}`);
  const ctx = makeCtx();

  console.log("\n================ SCENARIO 1: greeting, fragments + correction ================");
  const s1: SimState = { session: emptySession(), turns: [] };
  await turn(ctx, s1, "היי");
  await turn(ctx, s1, "אפשר תור?");
  await turn(ctx, s1, "תספורת");
  await turn(ctx, s1, "מחר");
  await turn(ctx, s1, "למה אתה שוב שואל? אמרתי מחר");

  console.log("\n================ SCENARIO 2: acknowledge before collect ================");
  const s2: SimState = { session: emptySession(), turns: [] };
  await turn(ctx, s2, "אני רוצה לקבוע פן");
  await turn(ctx, s2, "אני לא יכול השבוע");

  console.log("\n================ SCENARIO 3: follow-up questions ================");
  const s3: SimState = { session: emptySession(), turns: [] };
  await turn(ctx, s3, "אפשר תספורת ביום ראשון?");
  await turn(ctx, s3, "למה?");
  await turn(ctx, s3, "באמת?");

  console.log("\n================ SCENARIO 4: FAQ during booking (context retention) ================");
  const s4b: SimState = { session: emptySession(), turns: [] };
  await turn(ctx, s4b, "אני רוצה פן");
  await turn(ctx, s4b, "רגע, יש חניה?");
  await turn(ctx, s4b, "מעולה. אז ביום שני");
  console.log(`   [check] service retained after FAQ pivot: ${s4b.session.service === "פן" ? "YES ✓" : "NO ✗"}`);

  console.log("\n================ SCENARIO 5: reschedule of existing appointment ================");
  const APPT_BLOCK =
    "EXISTING APPOINTMENTS (system-checked) for this customer:\n• 12/06 בשעה 16:00 — תספורת (confirmed)\nChanges/cancellations are not possible via this chat yet — refer them to the business, and refer to these appointments accurately.";
  const s4: SimState = { session: emptySession(), turns: [] };
  await turn(ctx, s4, "יש לי תור ביום חמישי. אפשר להזיז אותו?", APPT_BLOCK);
  await turn(ctx, s4, "אז מה כן אפשר לעשות?", APPT_BLOCK);

  console.log("\n================ SCENARIO 6: cancel with NO appointment ================");
  const NO_APPT_BLOCK =
    "EXISTING APPOINTMENTS (system-checked): this customer has NO upcoming appointment. If they ask to cancel/change one, say honestly that you don't see an active appointment under this number.";
  const s5: SimState = { session: emptySession(), turns: [] };
  await turn(ctx, s5, "תבטל לי את התור", NO_APPT_BLOCK);

  console.log("\n================ SCENARIO 7: appointment listing ================");
  const s7: SimState = { session: emptySession(), turns: [] };
  await turn(ctx, s7, "אילו תורים יש לי?", APPT_BLOCK);

  console.log("\n================ SCENARIO 8: post-booking FAQ ================");
  const s6: SimState = {
    session: emptySession(),
    turns: [
      { role: "user", text: "כן" },
      { role: "model", text: "מעולה! התור נקבע בהצלחה 🎉 תספורת ב-12/06 בשעה 16:00" },
    ],
  };
  await turn(ctx, s6, "יש חניה?", APPT_BLOCK);

  console.log("\n================ SCENARIO 10: tentative DAY CHANGE (live-bug repro) ================");
  const s10: SimState = { session: emptySession(), turns: [] };
  await turn(ctx, s10, "אשמח לקבוע תור לפן");
  await turn(ctx, s10, "שלישי");
  await turn(ctx, s10, "ב11:30");
  await turn(ctx, s10, "אף אחת!");
  await turn(ctx, s10, "בוא ננסה לחשוב על יום אחר");
  console.log(`   [check] day reopened (dateISO null): ${s10.session.dateISO === null ? "YES ✓" : `NO ✗ (${s10.session.dateISO})`}`);
  await turn(ctx, s10, "רביעי");
  console.log(`   [check] new day set after change: ${s10.session.dateISO ?? "NONE ✗"}`);

  console.log("\n================ SCENARIO 11: bare day-change requests ================");
  const s11: SimState = { session: emptySession(), turns: [] };
  await turn(ctx, s11, "אני רוצה תספורת מחר ב16:00");
  await turn(ctx, s11, "אני רוצה לשנות יום ליום אחר");
  console.log(`   [check] day reopened: ${s11.session.dateISO === null ? "YES ✓" : `NO ✗ (${s11.session.dateISO})`}`);

  console.log("\n================ SCENARIO 13: rejected-slot exclusion ================");
  // Pure-logic checks first (no Gemini):
  console.log("  [pure] rejection patterns:",
    detectOfferRejection("אף אחת !", true) && detectOfferRejection("לא מתאים", true) &&
    detectOfferRejection("שום שעה לא טובה", true) && detectOfferRejection("לא", true) &&
    !detectOfferRejection("אף אחת !", false) /* no offers → not a slot rejection */
      ? "PASS ✓" : "FAIL ✗");
  {
    let s = { ...emptySession(), active: true, lastOfferedSlots: ["10:30", "12:00"], rejectedSlots: [] as string[] };
    s = applyOfferRejection(s, "אף אחת !").session;
    const movedOk = s.rejectedSlots.includes("10:30") && s.rejectedSlots.includes("12:00") && s.lastOfferedSlots.length === 0;
    const unrej = applyOfferRejection(s, "אולי בעצם 12:00?").session;
    const unrejOk = !unrej.rejectedSlots.includes("12:00") && unrej.rejectedSlots.includes("10:30");
    const captured = captureOfferedSlots(emptySession(), "יש מקום ב-10:30 או ב-12:00, ואנחנו פתוחים עד 18:00", ["10:30", "11:15", "12:00"], []);
    const captureOk = captured.lastOfferedSlots.join(",") === "10:30,12:00"; // 18:00 not a slot → excluded
    console.log(`  [pure] offered→rejected: ${movedOk ? "PASS ✓" : "FAIL ✗"} | un-reject on mention: ${unrejOk ? "PASS ✓" : "FAIL ✗"} | capture (hours excluded): ${captureOk ? "PASS ✓" : "FAIL ✗"}`);
  }

  // Live Gemini check — the exact validation scenario:
  const AVAIL_S13: AvailabilityInfo = {
    dateISO: "2026-06-16", dayName: "שלישי", durationUsedMin: 45,
    slots: ["10:30", "11:15", "12:00", "13:00"], truncated: false,
    hours: { closed: false, opens: "09:00", closes: "18:00" },
    requested: { time: "11:30", category: "taken", nearest: ["11:15", "10:30", "12:00"] },
  };
  const s13: SimState = {
    session: {
      ...emptySession(), active: true, lifecycle: "book",
      service: "פן", serviceId: "svc2", serviceDurationMin: 45,
      dateISO: "2026-06-16", dateText: "שלישי",
      lastOfferedSlots: ["10:30", "12:00"],
    },
    turns: [
      { role: "user", text: "אפשר פן ביום שלישי ב11:30?" },
      { role: "model", text: "ב-11:30 כבר תפוס, אבל יש מקום ב-10:30 או ב-12:00. מה יותר נוח לך?" },
    ],
  };
  await turn(ctx, s13, "אף אחת !", "", AVAIL_S13);
  const lastReply = s13.turns[s13.turns.length - 1].text;
  console.log(`   [check] rejected recorded: ${s13.session.rejectedSlots.includes("10:30") && s13.session.rejectedSlots.includes("12:00") ? "YES ✓" : "NO ✗"}`);
  console.log(`   [check] reply does NOT re-offer 10:30: ${!lastReply.includes("10:30") ? "PASS ✓" : "FAIL ✗"}`);
  console.log(`   [check] reply does NOT re-offer 12:00: ${!lastReply.includes("12:00") ? "PASS ✓" : "FAIL ✗"}`);

  console.log("\n================ SCENARIO 14: 'my son wants a haircut tomorrow' ================");
  const s14: SimState = { session: emptySession(), turns: [] };
  await turn(ctx, s14, "הבן שלי רוצה תספורת מחר");
  console.log(`   [check] customerReference captured: ${s14.session.customerReference ? `YES ✓ ("${s14.session.customerReference}")` : "NO ✗"}`);
  console.log(`   [check] service+day captured: ${s14.session.serviceId && s14.session.dateISO ? "YES ✓" : "NO ✗"}`);

  console.log("\n================ SCENARIO 15: FAQ → booking switch ================");
  const s15: SimState = { session: emptySession(), turns: [] };
  await turn(ctx, s15, "כמה עולה פן?");
  await turn(ctx, s15, "סבבה, אז תקבעי לי");
  console.log(`   [check] switched to booking with service carried: ${s15.session.active && s15.session.serviceId === "svc2" ? "YES ✓" : `partial (active=${s15.session.active}, service=${s15.session.service ?? "-"})`}`);

  console.log("\n================ SCENARIO 16: live-incident replay (F1/F2/F3/F5) ================");
  // ── Pure F1: cancel detection ──
  console.log("  [pure F1] live correction sentence NOT a cancel:",
    !isCancelIntent("אני לא וודע מאיפה הבאת את זה אבל לא רוצה את זה") ? "PASS ✓" : "FAIL ✗");
  console.log("  [pure F1] explicit commands still cancel:",
    isCancelIntent("ביטול") && isCancelIntent("בטל") && isCancelIntent(" ביטול! ") && isCancelIntent("Cancel")
      ? "PASS ✓" : "FAIL ✗");
  console.log("  [pure F1] embedded/soft forms go to the engine:",
    !isCancelIntent("לא רוצה") && !isCancelIntent("לא רוצה את יום שלישי") && !isCancelIntent("לא תודה")
      ? "PASS ✓" : "FAIL ✗");

  // ── Pure F2: Hebrew time extraction (every form from the live conversation + more) ──
  const f2Cases: [string, string | null][] = [
    ["חשבתי על 5 וןצי מה אומר", "17:30"],   // the live typo
    ["כן אמרתי חמש וחצי", "17:30"],          // spelled out
    ["אמרתי 5 וחצי", "17:30"],               // digits + fraction
    ["בחמש", "17:00"],
    ["ב5", "17:00"],
    ["ב-19", "19:00"],
    ["רבע לחמש", "16:45"],
    ["תשע וחצי בבוקר", "09:30"],
    ["שבע בערב", "19:00"],
    ["5 בערב", "17:00"],
    ["10 בבוקר", "10:00"],
    ["נפגשים ב11:30", "11:30"],
    ["שמונה ורבע", "08:15"],   // 8-11 default to morning (1-7 → afternoon); "שמונה בערב" → 20:00
    ["שמונה בערב", "20:00"],
    ["אגיע בעוד חמש דקות", null],            // duration, not a time
    ["יש לכם חמישה ספרים?", null],           // not a time at all
  ];
  const f2Fails = f2Cases.filter(([msg, want]) => extractExplicitTime(msg) !== want);
  console.log(`  [pure F2] time parsing ${f2Cases.length - f2Fails.length}/${f2Cases.length}:`,
    f2Fails.length === 0 ? "PASS ✓" : `FAIL ✗ ${f2Fails.map(([m, w]) => `"${m}"→${extractExplicitTime(m)}≠${w}`).join("; ")}`);
  console.log("  [pure F2] echo allowance includes PM variant:",
    extractTimeTokens("אמרתי חמש וחצי").has("17:30") && extractTimeTokens("ב7").has("19:00")
      ? "PASS ✓" : "FAIL ✗");

  // ── Pure F5: history recovery + digit-hint strategy change ──
  const liveHistory: ConversationTurn[] = [
    { role: "user", text: "אני מעולה אפשר תור ?" },
    { role: "model", text: "בטח, אחי! איזה שירות בדיוק תרצה, ומתי נוח לך להגיע?" },
    { role: "user", text: "חשבתי על תספורת ביום שלישי הבא" },
    { role: "model", text: "אחי, שלישי הבא זה 16.6, מה השעה שנוח לך?" },
    { role: "user", text: "חשבתי על 5 וןצי מה אומר" },
    { role: "model", text: "מה שכבר רשום אצלי: שירות: תספורת, יום שלישי (16/06). איזו שעה בערך נוחה לך?" },
  ];
  console.log("  [pure F5] time recovered from live history:",
    findTimeInHistory(liveHistory, []) === "17:30" ? "PASS ✓" : `FAIL ✗ (${findTimeInHistory(liveHistory, [])})`);
  console.log("  [pure F5] rejected times skipped in recovery:",
    findTimeInHistory(liveHistory, ["17:30"]) === null ? "PASS ✓" : "FAIL ✗");
  const hintReply = buildContextReply(
    { ...emptySession(), active: true, service: "תספורת", serviceId: "svc1", dateISO: "2026-06-11" },
    { correction: true, digitHint: true }
  );
  console.log("  [pure F5] stuck recovery asks for digits:",
    hintReply.includes("17:30") && hintReply.includes("ספרות") ? "PASS ✓" : `FAIL ✗ ("${hintReply}")`);

  // ── Pure F3: post-merge verdict replies (grounded, rejected excluded) ──
  const verdictTaken = renderVerdictReplyHe({
    dateISO: "2026-06-11", dayName: "חמישי", durationUsedMin: 30,
    slots: ["10:00", "16:30"], truncated: false,
    hours: { closed: false, opens: "09:00", closes: "18:00" },
    requested: { time: "17:30", category: "taken", nearest: ["17:00", "16:30"] },
  }, ["17:00"]);
  console.log("  [pure F3] taken verdict honest + rejected excluded:",
    verdictTaken !== null && !verdictTaken.includes("17:00,") && verdictTaken.includes("16:30") && verdictTaken.includes("תפוס")
      ? "PASS ✓" : `FAIL ✗ ("${verdictTaken}")`);

  // ── Live replay of the incident conversation (probe+merge layer) ──
  const s16: SimState = { session: emptySession(), turns: [] };
  await turn(ctx, s16, "אני מעולה אפשר תור ?");
  await turn(ctx, s16, "חשבתי על תספורת ביום שלישי הבא");
  await turn(ctx, s16, "חשבתי על 5 וןצי מה אומר");
  console.log(`   [check] time captured ON THE TURN IT WAS SAID: ${s16.session.time === "17:30" ? "YES ✓" : `NO ✗ (${s16.session.time ?? "-"})`}`);
  console.log(`   [check] day = next Tuesday: ${s16.session.dateISO === resolveDateText("שלישי", TZ) ? "YES ✓" : `got ${s16.session.dateISO}`}`);
  await turn(ctx, s16, "לא יום שלישי מה הקשר, אמרתי חמישי");
  console.log(`   [check] day switched to Thursday: ${s16.session.dateISO === resolveDateText("חמישי", TZ) ? "YES ✓" : `NO ✗ (${s16.session.dateISO ?? "-"})`}`);
  console.log(`   [check] time RETAINED through day change: ${s16.session.time === "17:30" ? "YES ✓" : `NO ✗ (${s16.session.time ?? "-"})`}`);
  console.log(`   [check] ready for confirm (all fields set): ${s16.session.serviceId && s16.session.dateISO && s16.session.time ? "YES ✓" : "NO ✗"}`);
  {
    // F6: the day-change reply must SHOW the resolved date (model or echo).
    const lastModel = s16.turns[s16.turns.length - 1].text;
    const iso = s16.session.dateISO ?? "0000-00-00";
    const [, mm, dd] = iso.split("-");
    const dateRe = new RegExp(`0?${parseInt(dd, 10)}[./]0?${parseInt(mm, 10)}`);
    console.log(`   [check F6] day-change reply shows resolved date: ${dateRe.test(lastModel) ? "YES ✓" : `NO ✗ ("${lastModel}")`}`);
    // F8 (soft): no false affirmation of a claim the transcript contradicts.
    console.log(`   [soft F8] reply avoids "צודק" on contradicted correction: ${!lastModel.includes("צודק") ? "YES ✓" : "no (model wording — prompt-level, non-blocking)"}`);
  }

  console.log("\n================ SCENARIO 17: second-pass pure checks (F6/F7/F8/F10 + review finds) ================");
  // ── F6: deterministic date-echo ──
  const echoSession: BookingSession = { ...emptySession(), active: true, dateISO: "2026-06-11" };
  const echoed = ensureDateEcho("איזו שעה נוחה לך?", echoSession);
  console.log("  [pure F6] date appended when missing:",
    /11\/06/.test(echoed) && echoed.includes("חמישי") ? "PASS ✓" : `FAIL ✗ ("${echoed}")`);
  console.log("  [pure F6] no double-append when date present:",
    ensureDateEcho("שלישי הבא זה 16.6, מה השעה?", { ...echoSession, dateISO: "2026-06-16" }) === "שלישי הבא זה 16.6, מה השעה?"
      && ensureDateEcho("נקבע ל-11/06", echoSession) === "נקבע ל-11/06" ? "PASS ✓" : "FAIL ✗");

  // ── F7: settings enforcement on the actual deterministic strings ──
  console.log("  [pure F7] deterministic strings strippable:",
    emojiCount(stripEmojis("קביעת התור בוטלה. נשמח לעזור בכל עת! 😊")) === 0 &&
    emojiCount(stripEmojis("מעולה! התור נקבע בהצלחה 🎉 נשמח לראות אותך! 😊")) === 0 ? "PASS ✓" : "FAIL ✗");

  // ── F8: confirmation CTA backstop + neutral correction ack ──
  console.log("  [pure F8] CTA added to soft confirm ask:",
    ensureConfirmCta("תרצה לאשר את זה?").includes("*כן*") ? "PASS ✓" : "FAIL ✗");
  console.log("  [pure F8] CTA not duplicated:",
    ensureConfirmCta("לאישור פשוט לכתוב *כן*") === "לאישור פשוט לכתוב *כן*" ? "PASS ✓" : "FAIL ✗");
  console.log("  [pure F8] correction ack is neutral (no צודק):",
    !buildContextReply({ ...emptySession(), active: true }, { correction: true }).includes("צודק") ? "PASS ✓" : "FAIL ✗");

  // ── F8/review: unified yes/no parsing ("כן אבל" must NOT book) ──
  const yesNoCases: [string, "yes" | "no" | null][] = [
    ["כן", "yes"], ["כן בטח", "yes"], ["כן, מאשר", "yes"], ["יאללה", "yes"], ["סגור", "yes"],
    ["כן אבל ביום אחר", null], ["כן רק תבדוק שוב את השעה", null], ["כן בעצם רגע", null],
    ["לא", "no"], ["לא תודה", "no"], ["אולי", null], ["מה השעה?", null],
  ];
  const ynFails = yesNoCases.filter(([m, want]) => parseYesNo(m) !== want);
  console.log(`  [pure F8] yes/no parsing ${yesNoCases.length - ynFails.length}/${yesNoCases.length}:`,
    ynFails.length === 0 ? "PASS ✓" : `FAIL ✗ ${ynFails.map(([m, w]) => `"${m}"→${parseYesNo(m)}≠${w}`).join("; ")}`);

  // ── F10: conversation-gap memory boundary ──
  const now = Date.now();
  const mkRow = (hoursAgo: number) => ({ created_at: new Date(now - hoursAgo * 3_600_000).toISOString() });
  const gapRows = [mkRow(10), mkRow(9.5), mkRow(1), mkRow(0.5)];
  const cut = applyConversationGap(gapRows, 6, now);
  console.log("  [pure F10] memory cut at long silence:",
    cut.length === 2 && cut[0].created_at === gapRows[2].created_at ? "PASS ✓" : `FAIL ✗ (kept ${cut.length})`);
  console.log("  [pure F10] stale-only history → empty:",
    applyConversationGap([mkRow(9), mkRow(8)], 6, now).length === 0 ? "PASS ✓" : "FAIL ✗");
  console.log("  [pure F10] continuous conversation untouched:",
    applyConversationGap([mkRow(2), mkRow(1), mkRow(0.2)], 6, now).length === 3 ? "PASS ✓" : "FAIL ✗");

  // ── Review find: service-name whole-word matching (no phantom hits) ──
  console.log("  [pure svc] phantom substring hits rejected:",
    matchService("מחר בבוקר אם פנוי", SERVICES) === null &&
    matchService("באופן כללי מה המחירים", SERVICES) === null ? "PASS ✓" : "FAIL ✗");
  console.log("  [pure svc] real mentions still match:",
    matchService("אני רוצה פן", SERVICES)?.id === "svc2" &&
    matchService("כמה עולה פן?", SERVICES)?.id === "svc2" &&
    matchService("בא לי לפן", SERVICES)?.id === "svc2" &&
    matchService("תספורת", SERVICES)?.id === "svc1" ? "PASS ✓" : "FAIL ✗");

  console.log("\n================ SCENARIO 12: custom instructions A/B ================");
  const msgCI = "מתי אתם פתוחים?";
  const ctxPlain = makeCtx();
  const ctxCI = makeCtx({ custom: "פתחי כל תשובה במילה 'אהלן', וסיימי כל תשובה בשאלה אם אפשר לעזור בעוד משהו" });
  const dP = await runReceptionistTurn(ctxPlain, { conversationContext: "", message: msgCI, bookingBlock: "" });
  const dC = await runReceptionistTurn(ctxCI, { conversationContext: "", message: msgCI, bookingBlock: "" });
  console.log(`\n>> [no custom]   ${dP.replyText.replace(/\n/g, " | ")}`);
  console.log(`>> [with custom] ${dC.replyText.replace(/\n/g, " | ")}`);
  console.log(`   [check] custom visibly applied: ${dC.replyText.includes("אהלן") ? "YES ✓" : "NO ✗"}`);

  console.log("\n================ SCENARIO 9: AI settings A/B (same message) ================");
  const msgAB = "היי, כמה עולה תספורת?";
  const ctxCasual = makeCtx({ tone: "casual", emoji: "medium", custom: "דבר/י בקליל וברוח טובה" });
  const ctxLuxury = makeCtx({ tone: "luxury", emoji: "none", length: "short" });
  const dA = await runReceptionistTurn(ctxCasual, { conversationContext: "", message: msgAB, bookingBlock: "" });
  const dB = await runReceptionistTurn(ctxLuxury, { conversationContext: "", message: msgAB, bookingBlock: "" });
  console.log(`\n>> [casual+emoji=medium]  ${dA.replyText.replace(/\n/g, " | ")}   (emojis=${emojiCount(dA.replyText)})`);
  console.log(`>> [luxury+emoji=none+short] ${dB.replyText.replace(/\n/g, " | ")}   (emojis=${emojiCount(dB.replyText)})`);

  console.log("\n================ SCENARIO 19: live replay 10/06 (dead-ends, וחןצי, verdict flip, why-question) ================");
  // Pure: the live double-typo time form now parses deterministically.
  console.log("  [pure] 'נגיד חמש וחןצי' → 17:30:",
    extractExplicitTime("נגיד חמש וחןצי") === "17:30" ? "PASS ✓" : `FAIL ✗ (${extractExplicitTime("נגיד חמש וחןצי")})`);
  // Pure: negated weekday must not win ("לא יום שלישי... אמרתי חמישי" → Thursday).
  console.log("  [pure] negated weekday skipped in date resolution:",
    resolveDateText("לא יום שלישי מה הקשר, אמרתי חמישי", TZ) === resolveDateText("חמישי", TZ) &&
    resolveDateText("יום שלישי", TZ) !== null
      ? "PASS ✓" : `FAIL ✗ (${resolveDateText("לא יום שלישי מה הקשר, אמרתי חמישי", TZ)})`);

  // Pure: align-available composer (the two incoherent live composites).
  const s19: BookingSession = {
    ...emptySession(), active: true, service: "תספורת", serviceId: "svc1",
    serviceDurationMin: 30, dateISO: "2026-06-11", dateText: "חמישי", time: "17:30",
  };
  const aligned1 = alignAvailableReply("בהחלט, יש לנו עוד כמה אפשרויות נדירות ביום חמישי, כמו 15:30 או 14:30.", s19);
  console.log("  [pure] contradictory offer → replaced by honest verdict+confirm:",
    !aligned1.includes("15:30") && aligned1.includes("17:30") && aligned1.includes("*כן*") ? "PASS ✓" : `FAIL ✗ ("${aligned1}")`);
  const aligned2 = alignAvailableReply("אחלה, אז תספורת ליום חמישי בשעה 17:30.", s19);
  console.log("  [pure] existing summary → CTA only, no duplicate summary:",
    (aligned2.match(/17:30/g) ?? []).length === 1 && aligned2.includes("*כן*") ? "PASS ✓" : `FAIL ✗ ("${aligned2}")`);
  const aligned3 = alignAvailableReply("נשמע מצוין!", s19);
  console.log("  [pure] neutral reply → full summary appended:",
    aligned3.includes("17:30") && aligned3.includes("*כן*") ? "PASS ✓" : "FAIL ✗");

  // Pure: duplicate/rotation comparison is emoji-insensitive (3× identical
  // fallback went out live because history is emoji-stripped).
  console.log("  [pure] outbound comparison ignores emojis/whitespace:",
    sameOutboundText(FALLBACK.error, stripEmojis(FALLBACK.error)) && !sameOutboundText(FALLBACK.error, FALLBACK.errorAlt)
      ? "PASS ✓" : "FAIL ✗");

  // Pure: truthful "why" material lives in working memory after a taken verdict.
  const s19v: BookingSession = { ...s19, time: null, lastVerdict: { time: "17:30", category: "taken" } };
  console.log("  [pure] taken-verdict note rendered for the model:",
    renderSession(s19v).includes("17:30") && renderSession(s19v).includes("taken") ? "PASS ✓" : "FAIL ✗");
  console.log("  [pure] next-step question matches the missing field:",
    nextStepQuestion({ ...emptySession(), active: true, serviceId: "svc1", service: "תספורת" }) === "איזה יום נוח לך?"
      ? "PASS ✓" : "FAIL ✗");

  // Pure: armed-confirmation protection (the "why" question must not disarm).
  const armedPrev: BookingSession = { ...s19, lifecycle: "book" };
  const disrupted: BookingSession = { ...armedPrev, time: null, lifecycle: "modify" };
  const prot = protectArmedDraft(armedPrev, disrupted, "booking");
  console.log("  [pure] armed confirm survives a meta-question (time+lifecycle restored):",
    prot.session.time === "17:30" && prot.session.lifecycle === "book" && prot.restored.includes("time") && prot.restored.includes("lifecycle")
      ? "PASS ✓" : `FAIL ✗ (${JSON.stringify(prot.restored)})`);
  const protCancel = protectArmedDraft(armedPrev, { ...armedPrev, lifecycle: "cancel" }, "cancel_request");
  console.log("  [pure] explicit cancel intent NOT overridden by protection:",
    protCancel.session.lifecycle === "cancel" ? "PASS ✓" : "FAIL ✗");

  // Live: the real conversation's opening — no more dead-end replies.
  const st19: SimState = { session: emptySession(), turns: [] };
  await turn(ctx, st19, "אני רוצה תספורת");
  const r19a = st19.turns[st19.turns.length - 1].text;
  console.log(`   [check] booking turn ends with a clear next step: ${r19a.includes("?") ? "YES ✓" : `NO ✗ ("${r19a}")`}`);
  await turn(ctx, st19, "יופ חמישי");
  const r19b = st19.turns[st19.turns.length - 1].text;
  console.log(`   [check] typo'd day captured (יופ חמישי): ${st19.session.dateISO === resolveDateText("חמישי", TZ) ? "YES ✓" : `NO ✗ (${st19.session.dateISO ?? "-"})`}`);
  console.log(`   [check] day turn also has a next step: ${r19b.includes("?") ? "YES ✓" : `NO ✗ ("${r19b}")`}`);
  await turn(ctx, st19, "נגיד חמש וחןצי");
  console.log(`   [check] typo'd time captured same turn: ${st19.session.time === "17:30" ? "YES ✓" : `NO ✗ (${st19.session.time ?? "-"})`}`);

  console.log("\n================ SCENARIO 21: live replay 10/06 evening (taken-confirm lie, false closed-claim) ================");
  // Pure: meta/confusion messages are NOT credible change requests; real ones are.
  console.log("  [pure] changeRequest credibility gate:",
    !isCredibleChangeRequest("לא הבנתי מה") && !isCredibleChangeRequest("מה קורה פה") &&
    isCredibleChangeRequest("בוא ננסה יום אחר") && isCredibleChangeRequest("לא רוצה את זה") && isCredibleChangeRequest("בעצם שלישי")
      ? "PASS ✓" : "FAIL ✗");

  // Pure: the three live booking-completion lies are caught; honest phrases are not.
  console.log("  [pure] booked-claim fence matches the live lies:",
    claimsBookingCompleted("כן, התור נקבע ליום שישי הקרוב בשעה 15:30 לטיפול פן ועיצוב.") &&
    claimsBookingCompleted("15:30 ביום שישי מתאים, אנחנו מאשרים את הטיפול של פן ועיצוב.") &&
    claimsBookingCompleted("מעולה, מחכים לך לטיפול פן ועיצוב ביום שישי בשעה 15:30.") &&
    !claimsBookingCompleted("אין בעיה, כבר רשום אצלי חמישי. איזו שעה נוחה לך?") &&
    !claimsBookingCompleted("מה שכבר רשום אצלי: שירות: תספורת. איזה יום נוח לך?")
      ? "PASS ✓" : "FAIL ✗");

  // Pure: verdict replacement decision — soft-confirm of a taken slot is replaced,
  // an honest "כבר לא פנוי" reply is kept.
  console.log("  [pure] unavailability-marker detection:",
    lacksUnavailabilityMarker("15:30 ביום שישי מתאים, אנחנו מאשרים את הטיפול.") &&
    !lacksUnavailabilityMarker("מצטערת, יום חמישי השבוע כבר לא פנוי, אבל יום שישי פתוח.")
      ? "PASS ✓" : "FAIL ✗");

  // Pure: the garbled line resent minus a prefix is a near-duplicate.
  console.log("  [pure] near-duplicate detection (prefix-tolerant):",
    nearDuplicateText(
      "יום שישי פתוח אצלנו, איזה יום חמישי זה נוח לך? (יום שישי, 12/06)",
      "כן, יום שישי פתוח אצלנו, איזה יום חמישי זה נוח לך? (יום שישי, 12/06)"
    ) && !nearDuplicateText("איזה יום נוח לך?", "איזו שעה נוחה לך בערך, אם אפשר לדייק?")
      ? "PASS ✓" : "FAIL ✗");

  // Pure: closed-claim about an OPEN day caught; cross-day mention not false-flagged.
  console.log("  [pure] false closed-claim detection (sentence-scoped):",
    falseClosedClaim("יום חמישי זה יום אש, אבל אנחנו סגורים בו.", "חמישי") &&
    !falseClosedClaim("בשבת אנחנו סגורים. ביום שישי יש מקום.", "שישי")
      ? "PASS ✓" : "FAIL ✗");

  // Pure: the live typo'd day phrase resolves (ט6ב אז יון ראשון הבא → Sunday).
  console.log("  [pure] typo'd day phrase resolves to Sunday:",
    resolveDateText("ט6ב אז יון ראשון הבא", TZ) === resolveDateText("ראשון", TZ) ? "PASS ✓" : "FAIL ✗");

  // Live DB (read-only): off-grid interval availability — the root cause of the
  // "15:30 taken on an empty Friday" lie.
  try {
    const dbCheck = supabaseServer();
    const { data: bizRow } = await dbCheck.from("businesses").select("id, timezone").limit(1).single();
    if (bizRow) {
      const tzB = (bizRow.timezone as string) || TZ;
      const offGrid = await isIntervalFree(dbCheck, bizRow.id as string, "2026-07-06", "15:30", 45, tzB); // open Monday, far future
      const closedDay = await isIntervalFree(dbCheck, bizRow.id as string, "2026-07-05", "15:30", 45, tzB); // Sunday (closed)
      console.log("  [live-db] off-grid 15:30 free on an empty open day:", offGrid ? "PASS ✓" : "FAIL ✗");
      console.log("  [live-db] closed day rejects any interval:", !closedDay ? "PASS ✓" : "FAIL ✗");
    }
  } catch (e) {
    console.log("  [live-db] interval check skipped:", e instanceof Error ? e.message : String(e));
  }

  // Live: "what do you offer?" must name real services (soft — model wording).
  const st21: SimState = { session: emptySession(), turns: [] };
  await turn(ctx, st21, "לא יודע, מה אתה מציע ?");
  const r21 = st21.turns[st21.turns.length - 1].text;
  console.log(`   [soft] recommendation names real services: ${/פן|פנים|תספור|צביע/.test(r21) ? "YES ✓" : `no ("${r21}") — prompt-level, non-blocking`}`);

  console.log("\n================ SCENARIO 22: PLATFORM MODE (intent routing, no chat scheduling) ================");
  // Pure: the platform persona drops every conversational-scheduling instruction.
  {
    const { buildReceptionistInstruction } = await import("../lib/ai/persona");
    const inst = buildReceptionistInstruction(ctx, {
      factsBlock: "facts", caps: { canAnswer: true, canStartBooking: true, canCancel: false, canReschedule: false },
      conversationContext: "", platformMode: true,
    });
    console.log("  [pure] platform persona has no detail-collection instructions:",
      !inst.includes("collect service + day + time") && !inst.includes("AVAILABILITY block says the time is AVAILABLE") &&
      inst.includes("BOOKING PAGE") && inst.includes("NEVER write a URL")
        ? "PASS ✓" : "FAIL ✗");
  }

  // Live: booking intent detected; reply collects nothing and offers no times.
  {
    const d22 = await runReceptionistTurn(ctx, {
      conversationContext: "", message: "היי, אפשר לקבוע תור לתספורת למחר?", bookingBlock: "", platformMode: true,
    });
    const u22 = d22.turn?.understanding;
    const intentDetected = u22?.appointmentIntent === "BOOK" || u22?.intent === "booking";
    console.log(`  [live] booking intent detected for routing: ${intentDetected ? "PASS ✓" : `FAIL ✗ (intent=${u22?.intent} appt=${u22?.appointmentIntent})`}`);
    // Opening-hours mentions and "see the available times on the page" are fine;
    // what platform mode forbids is OFFERING bookable slots in chat — a list of
    // times, or binding a concrete time to a free/taken claim ("16:00 פנוי").
    const timeTokens = d22.replyText.match(/\d{1,2}:\d{2}/g) ?? [];
    const slotList = timeTokens.length >= 3;
    const claimsSpecificFree = /\d{1,2}:\d{2}[^.!?\n]{0,12}(פנוי|זמין|מתאים|תפוס)|(פנוי|זמין|תפוס)[^.!?\n]{0,12}\d{1,2}:\d{2}/.test(d22.replyText);
    const offersSlots = slotList || claimsSpecificFree;
    console.log(`  [live] reply offers no bookable slots: ${!offersSlots ? "PASS ✓" : `FAIL ✗ ("${d22.replyText}")`}`);
    console.log(`  [live] reply claims no completed booking: ${!claimsBookingCompleted(d22.replyText) ? "PASS ✓" : `FAIL ✗ ("${d22.replyText}")`}`);
  }

  // Live: cancellation request → manage-intent detected (routes to self-service link).
  {
    const d22b = await runReceptionistTurn(ctx, {
      conversationContext: "",
      message: "אני רוצה לבטל את התור שלי",
      bookingBlock: "EXISTING APPOINTMENTS (system-checked) for this customer:\n• 20/06 בשעה 16:00 — תספורת (confirmed)",
      platformMode: true,
    });
    const u22b = d22b.turn?.understanding;
    const manageIntent = u22b?.appointmentIntent === "CANCEL" || u22b?.intent === "cancel_request";
    console.log(`  [live] cancel intent detected for routing: ${manageIntent ? "PASS ✓" : `FAIL ✗ (intent=${u22b?.intent} appt=${u22b?.appointmentIntent})`}`);
  }

  // Live: FAQ still answered from facts in platform mode (conversation quality intact).
  {
    const d22c = await runReceptionistTurn(ctx, {
      conversationContext: "", message: "יש אצלכם חניה?", bookingBlock: "", platformMode: true,
    });
    console.log(`  [live] FAQ answered from facts: ${/חניה|בניין/.test(d22c.replyText) ? "PASS ✓" : `FAIL ✗ ("${d22c.replyText}")`}`);
  }

  console.log("\n================ SCENARIO 23: today-anchor + relative-day closed claims (pure) ================");
  {
    const { buildReceptionistInstruction } = await import("../lib/ai/persona");
    const todayISO = todayInTZ(TZ);
    const tomorrow = new Date(todayISO + "T12:00:00Z");
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tomorrowISO = tomorrow.toISOString().split("T")[0];

    // The persona always carries a correct, current date anchor.
    const inst23 = buildReceptionistInstruction(ctx, {
      factsBlock: "facts", caps: { canAnswer: true, canStartBooking: true, canCancel: false, canReschedule: false },
      conversationContext: "",
    });
    console.log("  [pure] persona anchors today's weekday:",
      inst23.includes(`TODAY ("היום") is יום ${dayNameHe(todayISO)}`) ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] persona anchors tomorrow's weekday:",
      inst23.includes(`TOMORROW ("מחר") is יום ${dayNameHe(tomorrowISO)}`) ? "PASS ✓" : "FAIL ✗");

    // dayRefsFor: relative references resolve only when the date IS today/tomorrow.
    console.log("  [pure] day refs include היום for today / מחר for tomorrow / neither for far dates:",
      dayRefsFor(todayISO, todayISO).includes("היום") &&
      dayRefsFor(tomorrowISO, todayISO).includes("מחר") &&
      !dayRefsFor("2026-07-06", todayISO).some((r) => r === "היום" || r === "מחר")
        ? "PASS ✓" : "FAIL ✗");

    // The live miss: "מחר אנחנו סגורים" about an OPEN tomorrow is now caught.
    // Explicit ref arrays keep these date-independent (dayRefsFor correctness is
    // asserted separately above).
    console.log("  [pure] relative closed-claims caught (היום/מחר):",
      falseClosedClaim("מחר אנחנו סגורים, מצטערת.", ["שני", "מחר"]) &&
      falseClosedClaim("היום סגור אצלנו.", ["שני", "היום"]) &&
      !falseClosedClaim("ביום ראשון אנחנו סגורים. מחר יש מקום.", ["מחר"])
        ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 24: receptionist quality (customer-state, FAQ, escalation) ================");
  {
    const { buildReceptionistInstruction } = await import("../lib/ai/persona");
    const inst24 = buildReceptionistInstruction(ctx, {
      factsBlock: "facts", caps: { canAnswer: true, canStartBooking: true, canCancel: false, canReschedule: false },
      conversationContext: "",
    });
    // Pure: the persona instructs use of customer state + escalation + answer-first.
    console.log("  [pure] persona has customer-state + escalation + answer-first guidance:",
      inst24.includes("CUSTOMER block") && inst24.includes("point them to the business") && inst24.includes("lead with the actual answer")
        ? "PASS ✓" : "FAIL ✗");

    // Live (soft): a returning customer named in the CUSTOMER block is greeted by name.
    const dName = await runReceptionistTurn(ctx, {
      conversationContext: "", message: "היי, מה שלומך?",
      bookingBlock: "CUSTOMER (system-checked):\nName: דנה (use it naturally — don't ask for it again).\nReturning customer — 3 previous visits, most recent around 01/06. Treat them as someone who already knows the place; warmth over orientation.",
      platformMode: true,
    });
    console.log(`  [soft] returning customer greeted by name: ${dName.replyText.includes("דנה") ? "YES ✓" : `no ("${dName.replyText}") — prompt-level, non-blocking`}`);

    // Live: a fact the business doesn't have → honest escalation, no invention.
    const dEsc = await runReceptionistTurn(ctx, {
      conversationContext: "", message: "אתם עושים גם החלקות קראטין?", bookingBlock: "", platformMode: true,
    });
    console.log(`  [soft] unknown service → no invented yes: ${!/בטח שכן|כן, אנחנו עושים|בהחלט עושים/.test(dEsc.replyText) ? "YES ✓" : `no ("${dEsc.replyText}")`}`);
  }

  console.log("\n================ SCENARIO 25: AI Settings persona depth (migration 008) ================");
  {
    const { buildReceptionistInstruction } = await import("../lib/ai/persona");
    const caps = { canAnswer: true, canStartBooking: true, canCancel: false, canReschedule: false };

    // Unset → persona degrades gracefully (no orphan labels, no business-type clause).
    const bare = buildReceptionistInstruction(makeCtx(), { factsBlock: "facts", caps, conversationContext: "" });
    console.log("  [pure] persona omits depth fields when unset:",
      !bare.includes("a , texting") && !bare.includes("HARD GUARDRAILS") && !bare.includes("How the owner describes")
        ? "PASS ✓" : "FAIL ✗");

    // Set → all three shape the prompt.
    const rich = makeCtx();
    rich.aiSettings = {
      ...rich.aiSettings!,
      business_type: "מרפאת שיניים",
      persona_voice: "רגוע ומרגיע, מסביר בסבלנות, אף פעם לא לוחץ",
      things_to_avoid: "אל תיתן ייעוץ רפואי; אל תבטיח שאין כאב",
    };
    const inst = buildReceptionistInstruction(rich, { factsBlock: "facts", caps, conversationContext: "" });
    console.log("  [pure] business_type frames identity:", inst.includes("a מרפאת שיניים, texting") ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] persona_voice injected (outranks preset):", inst.includes("How the owner describes this receptionist") && inst.includes("מסביר בסבלנות") ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] things_to_avoid becomes a hard guardrail:", inst.includes("HARD GUARDRAILS") && inst.includes("ייעוץ רפואי") ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 26: waitlist window matching (pure) ================");
  {
    const { withinWindow } = await import("../lib/booking/waitlist");
    const slot = { dateISO: "2026-06-20", time: "14:30", serviceId: "svc1" };
    // Unbounded entry matches anything.
    console.log("  [pure] unbounded entry matches any slot:",
      withinWindow(slot, { date_from: null, date_to: null, time_from: null, time_to: null }) ? "PASS ✓" : "FAIL ✗");
    // In-window (inclusive bounds).
    console.log("  [pure] slot inside date+time window matches:",
      withinWindow(slot, { date_from: "2026-06-18", date_to: "2026-06-22", time_from: "12:00", time_to: "16:00" }) ? "PASS ✓" : "FAIL ✗");
    // Out of date range / out of time range rejected.
    console.log("  [pure] slot outside date window rejected:",
      !withinWindow(slot, { date_from: "2026-06-21", date_to: "2026-06-25", time_from: null, time_to: null }) ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] slot outside time window rejected:",
      !withinWindow(slot, { date_from: null, date_to: null, time_from: "15:00", time_to: "18:00" }) ? "PASS ✓" : "FAIL ✗");
    // Boundary inclusive.
    console.log("  [pure] window bounds are inclusive:",
      withinWindow({ ...slot, time: "12:00" }, { date_from: "2026-06-20", date_to: "2026-06-20", time_from: "12:00", time_to: "14:00" }) ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 18: Gemini 503 resilience (degraded mode) ================");
  // LAST in the suite — it manipulates the process-global gemini health state.
  resetGeminiHealth();
  process.env.GEMINI_SIMULATE_OVERLOAD = "1";

  // 503 turn 1: helpful overload-specific fallback; cooldown not yet engaged.
  const o1 = await runReceptionistTurn(ctx, { conversationContext: "", message: "היי, אפשר תור?", bookingBlock: "" });
  console.log("  [503 #1] overload-specific helpful fallback, no cooldown yet:",
    o1.fallbackReason === "gemini_overloaded" && o1.replyText.includes("עומס") && !isGeminiCoolingDown()
      ? "PASS ✓" : `FAIL ✗ (reason=${o1.fallbackReason} cooling=${isGeminiCoolingDown()})`);

  // 503 turn 2: cooldown engages (strike threshold = 2).
  const o2 = await runReceptionistTurn(ctx, { conversationContext: "", message: "מה קורה?", bookingBlock: "" });
  console.log("  [503 #2] cooldown engaged after repeated overloads:",
    o2.fallbackReason === "gemini_overloaded" && isGeminiCoolingDown() ? "PASS ✓" : "FAIL ✗");

  // 503 turn 3+: the ENGINE now skips Gemini entirely; replies are composed
  // deterministically. Notice appears once, then never repeats:
  const sess18: BookingSession = { ...emptySession(), active: true, service: "תספורת", serviceId: "svc1", serviceDurationMin: 30 };
  // Transcript accumulates exactly like the engine sees it (notice-once must
  // survive an intermediate non-notice reply like "סבבה").
  let tr18 = "";
  const degradedTurn18 = (msg: string): string => {
    const r = composeDegradedReply(msg, sess18, null, overloadNoticeAlreadyShown(tr18));
    tr18 += `${tr18 ? "\n" : ""}Customer: ${msg}\nAssistant (you, earlier): ${r}`;
    return r;
  };
  const r1 = degradedTurn18("אפשר תור?");
  const r2 = degradedTurn18("אוקי");
  const r3 = degradedTurn18("בסדר");
  console.log("  [cooldown] notice once, then no fallback spam:",
    r1.includes("עומס") && !r2.includes("עומס") && !r3.includes("עומס") ? "PASS ✓" : `FAIL ✗ ("${r1}" → "${r2}" → "${r3}")`);
  console.log("  [cooldown] acks classified as low-value (no AI worthiness):",
    isLowValueAck("אוקי") && isLowValueAck("בסדר") && isLowValueAck("סבבה!") && isLowValueAck("כן") &&
    !isLowValueAck("אני רוצה תור") && !isLowValueAck("לא") /* rejection semantics */
      ? "PASS ✓" : "FAIL ✗");

  // Deterministic booking continuation during the outage (no AI at all):
  const pr18 = probeMessage("אני רוצה תספורת חמישי בחמש וחצי", emptySession(), SERVICES, TZ);
  const m18 = mergeUnderstanding(emptySession(), {}, pr18, SERVICES, TZ, []);
  console.log("  [cooldown] full booking sentence extracted without AI:",
    m18.session.serviceId === "svc1" && m18.session.dateISO === resolveDateText("חמישי", TZ) && m18.session.time === "17:30"
      ? "PASS ✓" : `FAIL ✗ (svc=${m18.session.serviceId} day=${m18.session.dateISO} time=${m18.session.time})`);
  console.log("  [cooldown] continuation drives to *כן* confirmation:",
    composeDegradedReply("אני רוצה תספורת חמישי בחמש וחצי", m18.session, null, true).includes("*כן*")
      ? "PASS ✓" : "FAIL ✗");

  // Fallback lines never feed the AI-facing history (style-contamination guard):
  console.log("  [memory] fallback lines filtered from AI history:",
    isKnownFallbackText(FALLBACK.error) && isKnownFallbackText(FALLBACK.errorAlt) &&
    isKnownFallbackText(FALLBACK.overloaded) && isKnownFallbackText("הייתה לי תקלה קטנה קודם") &&
    !isKnownFallbackText("מעולה, נקבע לך תור לחמישי ב-17:30")
      ? "PASS ✓" : "FAIL ✗");

  // Recovery: overload clears → normal AI behavior resumes (live call).
  delete process.env.GEMINI_SIMULATE_OVERLOAD;
  resetGeminiHealth();
  const o3 = await runReceptionistTurn(ctx, { conversationContext: "", message: "כמה עולה תספורת?", bookingBlock: "" });
  console.log("  [recovery] normal AI behavior resumes after cooldown:",
    o3.ok && o3.replySource === "gemini" && !isGeminiCoolingDown() ? "PASS ✓" : `FAIL ✗ (ok=${o3.ok} src=${o3.replySource})`);

  console.log("\nDONE.");
}

main().catch((e) => { console.error("SIM ERROR:", e?.message ?? e); process.exit(1); });
