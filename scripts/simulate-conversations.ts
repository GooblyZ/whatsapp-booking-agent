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
import { extractExplicitTime, extractTimeTokens, verifyGrounding } from "../lib/ai/grounding";
import { buildFacts, buildFactIndex } from "../lib/ai/facts";
import { findTimeInHistory, applyConversationGap, type ConversationTurn } from "../lib/ai/conversation";
import { isCancelIntent, parseYesNo } from "../lib/booking/flow";

const TZ = "Asia/Jerusalem";

function makeCtx(overrides: Partial<{
  tone: string; emoji: string; length: string; custom: string | null; gender: string;
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
      assistant_gender: (overrides.gender ?? "neutral") as never,
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
    `   meta: action=${u?.requestsBusinessAction ?? "-"} intent=${u?.intent ?? "-"} apptIntent=${u?.appointmentIntent ?? "-"} changeReq=${u?.changeRequest ?? "-"}` +
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
    // The customer never sees the RAW model reply: runPlatformTurn runs
    // defuseSchedulingQuestion first, so validate that FENCED output (the real
    // deterministic guarantee) — not raw model phrasing variance.
    const { defuseSchedulingQuestion } = await import("../lib/ai/platform-turn");
    const fenced22 = defuseSchedulingQuestion(d22.replyText).text;
    const timeTokens = fenced22.match(/\d{1,2}:\d{2}/g) ?? [];
    const slotList = timeTokens.length >= 3;
    const claimsSpecificFree = /\d{1,2}:\d{2}[^.!?\n]{0,12}(פנוי|זמין|מתאים|תפוס)|(פנוי|זמין|תפוס)[^.!?\n]{0,12}\d{1,2}:\d{2}/.test(fenced22);
    const offersSlots = slotList || claimsSpecificFree;
    console.log(`  [live] reply offers no bookable slots (after platform fence): ${!offersSlots ? "PASS ✓" : `FAIL ✗ ("${fenced22}")`}`);
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

  console.log("\n================ SCENARIO 25: 'Define your receptionist' — one description + axes ================");
  {
    const { buildReceptionistInstruction } = await import("../lib/ai/persona");
    const caps = { canAnswer: true, canStartBooking: true, canCancel: false, canReschedule: false };

    // New business: tone column defaults to 'friendly', no description → sensible
    // persona via the back-compat path. No orphan labels; format always present.
    const bare = buildReceptionistInstruction(makeCtx({ custom: null }), { factsBlock: "facts", caps, conversationContext: "" });
    console.log("  [pure] new business (no description) → sensible persona, no hard rules:",
      bare.includes("genuinely likes people") && !bare.includes("HARD RULES")
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] format block always present (length/emoji own their axis):",
      bare.includes("HOW YOU WRITE") && bare.includes("these limits ALWAYS hold") ? "PASS ✓" : "FAIL ✗");

    // Truly empty config (no description AND no legacy tone) → built-in default character.
    const emptyCtx = makeCtx({ custom: null });
    emptyCtx.aiSettings = { ...emptyCtx.aiSettings!, tone: undefined as never };
    const empty = buildReceptionistInstruction(emptyCtx, { factsBlock: "facts", caps, conversationContext: "" });
    console.log("  [pure] empty config (no tone either) → built-in default persona:",
      empty.includes("warm, helpful and professional") ? "PASS ✓" : "FAIL ✗");

    // The description is the SINGLE voice authority; hard rules override; identity has
    // NO business-type clause anymore (the AI learns the business from facts/KB).
    const rich = makeCtx();
    rich.aiSettings = {
      ...rich.aiSettings!,
      business_type: "מרפאת שיניים", // set but must NOT leak into identity now
      custom_instructions: "רגוע ומרגיע, מסביר בסבלנות, אף פעם לא לוחץ",
      things_to_avoid: "אל תיתן ייעוץ רפואי; אל תבטיח שאין כאב",
    };
    const inst = buildReceptionistInstruction(rich, { factsBlock: "facts", caps, conversationContext: "" });
    console.log("  [pure] business_type no longer leaks into identity:",
      !inst.includes("מרפאת שיניים") ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] description is THE character authority (owner's words lead):",
      inst.includes("This is who you are, in the owner's own words") && inst.includes("מסביר בסבלנות") ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] things_to_avoid becomes a hard rule that overrides everything:",
      inst.includes("HARD RULES") && inst.includes("ייעוץ רפואי") ? "PASS ✓" : "FAIL ✗");

    // PRECEDENCE: short length still wins over a wordy character (format owns its axis).
    const shortInst = buildReceptionistInstruction(
      makeCtx({ length: "short", custom: "תמיד מסביר בפירוט רב ובאריכות" }),
      { factsBlock: "facts", caps, conversationContext: "" });
    console.log("  [pure] length wins over a 'be detailed' personality:",
      shortInst.includes("ONE short sentence") && shortInst.includes("these limits ALWAYS hold") ? "PASS ✓" : "FAIL ✗");

    // Assistant gender drives Hebrew SELF-reference only (default neutral = no line).
    const fem = buildReceptionistInstruction(makeCtx({ gender: "female" }), { factsBlock: "facts", caps, conversationContext: "" });
    const masc = buildReceptionistInstruction(makeCtx({ gender: "male" }), { factsBlock: "facts", caps, conversationContext: "" });
    console.log("  [pure] gender self-reference: female→feminine, male→masculine, neutral→none:",
      fem.includes("feminine Hebrew") && masc.includes("masculine Hebrew") && !bare.includes("Hebrew (\"אני")
        ? "PASS ✓" : "FAIL ✗");

    // Back-compat: a config with ONLY a legacy tone (no description) still gets a character.
    const legacy = makeCtx({ custom: null });
    legacy.aiSettings = { ...legacy.aiSettings!, tone: "luxury" as never };
    const legacyInst = buildReceptionistInstruction(legacy, { factsBlock: "facts", caps, conversationContext: "" });
    console.log("  [pure] legacy tone-only config still yields a persona (back-compat):",
      legacyInst.includes("high-end concierge") ? "PASS ✓" : "FAIL ✗");
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

  console.log("\n================ SCENARIO 27: platform link not blocked by customer phone (grounding) ================");
  {
    // Business phone from makeCtx is "03-1234567" → digits "031234567".
    const idx = buildFactIndex(buildFacts(makeCtx()));
    const customerPhone = "972502201340";          // the live customer's number
    const allowed = new Set([customerPhone]);
    // A platform-mode reply that echoes the customer's own number (as happened
    // live, where the booking link carried ?p=<phone> into history).
    const replyWithCustomerPhone = "בטח! שלחתי לך קישור לקביעת תור. אם תרצה, נעדכן את 972502201340.";

    // (a) Customer's own phone is allowed → grounded → no fallback → link can attach.
    console.log("  [pure] customer's own phone does NOT fail grounding:",
      verifyGrounding(replyWithCustomerPhone, idx, new Set(), new Set(), allowed).ok ? "PASS ✓" : "FAIL ✗");

    // (b) Root-cause proof: WITHOUT the allowance the same reply was being rejected
    //     (this is the live bug — fence flagged the customer phone).
    console.log("  [pure] (root cause) same reply WAS rejected before the fix:",
      !verifyGrounding(replyWithCustomerPhone, idx).ok ? "PASS ✓" : "FAIL ✗");

    // (c) Protection preserved: an INVENTED/other number (not business, not allowed)
    //     still fails — the fence still catches wrong-business contact claims.
    console.log("  [pure] invented/other phone STILL fails (wrong-business protection):",
      !verifyGrounding("תתקשרו אלינו למספר 0509999999 לפרטים.", idx, new Set(), new Set(), allowed).ok ? "PASS ✓" : "FAIL ✗");

    // (d) The real business phone is still quotable.
    console.log("  [pure] business phone still passes grounding:",
      verifyGrounding("אפשר להתקשר אלינו: 03-1234567", idx, new Set(), new Set(), allowed).ok ? "PASS ✓" : "FAIL ✗");

    // (d2) Root-cause class fix: a long id/token (>15 digits — never an E.164 phone)
    //      must NOT trip the phone fence. Live bug: "phone 8766797264654787882 does
    //      not match business phone" → reply discarded → confused fallback chain.
    console.log("  [pure] 19-digit id/token is NOT treated as a phone:",
      verifyGrounding("התור אושר, מס' אסמכתא 8766797264654787882.", idx).ok ? "PASS ✓" : "FAIL ✗");

    // (d3) URLs are stripped before grounding — appointment links, the My-Appointments
    //      token and the booking link's ?p=<phone> must never be grounding-checked.
    console.log("  [pure] URL with ids/?p= does NOT fail grounding:",
      verifyGrounding("הקישור: https://x.vercel.app/appointment/98f1fa0d-c017?p=972502201340", idx).ok ? "PASS ✓" : "FAIL ✗");

    // (e) customerPhone threads to the brain without breaking normal platform routing.
    const dPlat = await runReceptionistTurn(makeCtx(), {
      conversationContext: "", message: "אפשר לקבוע תור לתספורת?", bookingBlock: "",
      platformMode: true, customerPhone,
    });
    const uPlat = dPlat.turn?.understanding;
    console.log(`  [live] booking intent still detected with customerPhone set: ${dPlat.ok && (uPlat?.appointmentIntent === "BOOK" || uPlat?.intent === "booking") ? "PASS ✓" : `FAIL ✗ (ok=${dPlat.ok} intent=${uPlat?.intent})`}`);
  }

  console.log("\n================ SCENARIO 28: assistant-gender enforcement (deterministic, 0 drift) ================");
  {
    const { enforceAssistantGender, countWrongGenderForms } = await import("../lib/ai/gender");
    const femDrift = [
      "אני שמחה לעזור לך!", "אני יודעת בדיוק מה שאת צריכה", "אני מבינה אותך לגמרי",
      "אני לא בטוחה, אבל אבדוק", "אני ממליצה על זה", "אני מנילה, העוזרת הוירטואלית של המספרה",
      "שמחה לעזור בכל שאלה", "אני מצטערת על הבלבול",
    ];
    const mascDrift = [
      "אני שמח לעזור!", "אני יודע מה לעשות", "אני מבין אותך", "אני בטוח שכן",
      "אני העוזר הוירטואלי", "שמח לעזור בכל שאלה", "אני מצטער על הבלבול",
    ];
    let maleWrong = 0;
    for (const s of femDrift) maleWrong += countWrongGenderForms(enforceAssistantGender(s, "male"), "male");
    console.log("  [pure] MALE setting: feminine drift → 0 wrong forms:", maleWrong === 0 ? "PASS ✓" : `FAIL ✗ (${maleWrong})`);
    let femWrong = 0;
    for (const s of mascDrift) femWrong += countWrongGenderForms(enforceAssistantGender(s, "female"), "female");
    console.log("  [pure] FEMALE setting: masculine drift → 0 wrong forms:", femWrong === 0 ? "PASS ✓" : `FAIL ✗ (${femWrong})`);
    console.log("  [pure] 'אני שמחה לעזור' →male→ 'אני שמח לעזור':",
      enforceAssistantGender("אני שמחה לעזור", "male") === "אני שמח לעזור" ? "PASS ✓" : `FAIL ✗ ("${enforceAssistantGender("אני שמחה לעזור", "male")}")`);
    console.log("  [pure] 'מנילה, העוזרת הוירטואלית' →male→ '…העוזר הוירטואלי':",
      enforceAssistantGender("מנילה, העוזרת הוירטואלית", "male") === "מנילה, העוזר הוירטואלי" ? "PASS ✓" : `FAIL ✗ ("${enforceAssistantGender("מנילה, העוזרת הוירטואלית", "male")}")`);
    // Exact live-failure sentence (RB Hair Studio greeting) — must become masculine.
    {
      const liveIn = "אני מנילה, העוזרת הוירטואלית של RB Hair Studio, כאן כדי לעזור לך בכל מה שתצטרך.";
      const liveWant = "אני מנילה, העוזר הוירטואלי של RB Hair Studio, כאן כדי לעזור לך בכל מה שתצטרך.";
      const liveGot = enforceAssistantGender(liveIn, "male");
      console.log("  [pure] live greeting 'העוזרת הוירטואלית' →male→ 'העוזר הוירטואלי':",
        liveGot === liveWant ? "PASS ✓" : `FAIL ✗ ("${liveGot}")`);
    }
    const custFem = "מתי נוח לך? את רוצה תספורת? תכתבי לי";
    console.log("  [pure] customer-directed feminine NOT altered (male setting):",
      enforceAssistantGender(custFem, "male") === custFem ? "PASS ✓" : `FAIL ✗ ("${enforceAssistantGender(custFem, "male")}")`);
    console.log("  [pure] neutral gender = no-op:",
      enforceAssistantGender("אני שמחה לעזור", "neutral") === "אני שמחה לעזור" ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 29: booking-signal gate (deterministic) ================");
  {
    const { hasBookingSignal } = await import("../lib/ai/platform-turn");
    const services = ["תספורת", "צבע", "פן"];
    const shouldNot = [
      "אני טס לחו״ל עוד שבועיים", "רציתי לאכול", "אפשר גם לאכול?", "לא תעזרי לי בזה?",
      "מה עוד?", "אתה בן או בת?", "יש לך באג", "שלחת שני קישורים", "מה שלומך?", "למה?",
      "כואבת לי האצבע", "אני בפנים",
    ];
    const shouldYes = [
      "אני רוצה לקבוע תור", "אפשר לקבוע תור?", "אשמח לקבוע תור", "אני רוצה תספורת",
      "אני רוצה צבע", "בא לי פן", "אני רוצה טיפול", "אני רוצה להספיק תספורת לפני הטיסה",
      "צריך לקבוע משהו לפני שאני טס", "אני רוצה לבטל", "אני רוצה להזיז", "איזה תורים יש לי?",
      "שלח לי את הקישור לתורים",
    ];
    const falsePos = shouldNot.filter((m) => hasBookingSignal(m, services));
    console.log(`  [pure] SHOULD-NOT-BOOK carry no signal (${shouldNot.length - falsePos.length}/${shouldNot.length}):`,
      falsePos.length === 0 ? "PASS ✓" : `FAIL ✗ [${falsePos.join(" | ")}]`);
    const missed = shouldYes.filter((m) => !hasBookingSignal(m, services));
    console.log(`  [pure] SHOULD-BOOK carry a signal (${shouldYes.length - missed.length}/${shouldYes.length}):`,
      missed.length === 0 ? "PASS ✓" : `FAIL ✗ [${missed.join(" | ")}]`);

    // BUSINESS-AGNOSTIC matrix (CLAUDE.md "Product principle"): the gate must fire for
    // ANY appointment vertical — through generic nouns/verbs OR the business's own
    // configured service names — and must stay quiet on unrelated chatter. Proves the
    // salon-term removal from GENERIC_SERVICE left every vertical covered.
    const industries: { label: string; services: string[]; yes: string[]; no: string[] }[] = [
      { label: "hair salon",    services: ["תספורת", "צבע", "פן"],
        yes: ["אני רוצה לקבוע תור לתספורת מחר", "בא לי תספורת"],
        no:  ["כמה עולה אצלכם?", "איפה אתם נמצאים?"] },
      { label: "pilates/yoga",  services: ["שיעור פילאטיס", "יוגה"],
        yes: ["אני רוצה שיעור פילאטיס מחר", "אפשר לקבוע יוגה לשבוע הבא?"],
        no:  ["מתי אתם פתוחים?", "תודה רבה!"] },
      { label: "physio/clinic", services: ["טיפול פיזיותרפיה", "ייעוץ"],
        yes: ["אני צריך טיפול לגב", "אפשר לקבוע ייעוץ?"],
        no:  ["יש לכם חניה לנכים?", "הכאב עבר, תודה"] },
      { label: "nail/beauty",   services: ["מניקור", "פדיקור"],
        yes: ["אני רוצה מניקור מחר", "אפשר לקבוע פדיקור?"],
        no:  ["כמה זמן לוקח?", "אתם פתוחים בשבת?"] },
    ];
    for (const ind of industries) {
      const yMissed = ind.yes.filter((m) => !hasBookingSignal(m, ind.services));
      const nFalse = ind.no.filter((m) => hasBookingSignal(m, ind.services));
      console.log(
        `  [pure] ${ind.label}: booking msgs signal (${ind.yes.length - yMissed.length}/${ind.yes.length}), chatter quiet (${ind.no.length - nFalse.length}/${ind.no.length}):`,
        yMissed.length === 0 && nFalse.length === 0
          ? "PASS ✓"
          : `FAIL ✗ [yes-missed: ${yMissed.join(" | ")}] [no-fired: ${nFalse.join(" | ")}]`);
    }
    // Salon terms are no longer hardcoded as "generic": a nail service signals ONLY via
    // the business's configured name, never a built-in list.
    console.log("  [pure] removed salon terms are NOT built-in generics (מניקור needs a configured service):",
      !hasBookingSignal("אני רוצה מניקור מחר", []) && hasBookingSignal("אני רוצה מניקור מחר", ["מניקור"]) ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 30: actionability gate is authoritative (parser coercion) ================");
  {
    const { parseReceptionistTurn } = await import("../lib/ai/brain");
    const mk = (rba: boolean, intent: string, appt: string) =>
      JSON.stringify({ reply: "תשובה כלשהי", understanding: { requestsBusinessAction: rba, intent, appointmentIntent: appt } });
    // The exact reported bug: not actionable, yet model labeled booking/BOOK → coerced.
    const t1 = parseReceptionistTurn(mk(false, "booking", "BOOK"))!;
    console.log("  [pure] action=false coerces BOOK→NONE and booking→unclear:",
      t1.understanding.appointmentIntent === "NONE" && t1.understanding.intent === "unclear" ? "PASS ✓" : `FAIL ✗ (${t1.understanding.intent}/${t1.understanding.appointmentIntent})`);
    // Not actionable + cancel_request → also neutralized.
    const t2 = parseReceptionistTurn(mk(false, "cancel_request", "CANCEL"))!;
    console.log("  [pure] action=false neutralizes manage intents too:",
      t2.understanding.appointmentIntent === "NONE" && t2.understanding.intent === "unclear" ? "PASS ✓" : `FAIL ✗ (${t2.understanding.intent}/${t2.understanding.appointmentIntent})`);
    // Conversational categories are preserved when not actionable.
    const t3 = parseReceptionistTurn(mk(false, "smalltalk", "NONE"))!;
    console.log("  [pure] action=false keeps a conversational intent:",
      t3.understanding.intent === "smalltalk" && t3.understanding.appointmentIntent === "NONE" ? "PASS ✓" : "FAIL ✗");
    // Actionable but operation unnamed → derived (booking→BOOK, cancel→CANCEL).
    const t4 = parseReceptionistTurn(mk(true, "booking", "NONE"))!;
    const t5 = parseReceptionistTurn(mk(true, "cancel_request", "NONE"))!;
    console.log("  [pure] action=true derives the operation when unnamed:",
      t4.understanding.appointmentIntent === "BOOK" && t5.understanding.appointmentIntent === "CANCEL" ? "PASS ✓" : `FAIL ✗ (${t4.understanding.appointmentIntent}/${t5.understanding.appointmentIntent})`);
    // Missing field defaults to non-actionable (safe default).
    const t6 = parseReceptionistTurn(JSON.stringify({ reply: "היי", understanding: { intent: "booking", appointmentIntent: "BOOK" } }))!;
    console.log("  [pure] missing actionability defaults to NOT an operation:",
      t6.understanding.requestsBusinessAction === false && t6.understanding.appointmentIntent === "NONE" ? "PASS ✓" : `FAIL ✗ (${t6.understanding.requestsBusinessAction}/${t6.understanding.appointmentIntent})`);
  }

  console.log("\n================ SCENARIO 31: robust AI JSON parsing (BUG-001) ================");
  {
    const { parseAiJsonResponse } = await import("../lib/ai/json-parse");
    const { parseReceptionistTurn } = await import("../lib/ai/brain");
    const valid = `{"reply":"היי","understanding":{"requestsBusinessAction":false,"intent":"smalltalk","appointmentIntent":"NONE"}}`;
    const replyOf = (d: unknown) => (d as { reply?: string }).reply ?? "";

    const r1 = parseAiJsonResponse(valid);
    console.log("  [pure] clean JSON parses (recovered=clean):", r1.ok && r1.recovered === "clean" ? "PASS ✓" : "FAIL ✗");
    const r2 = parseAiJsonResponse("```json\n" + valid + "\n```");
    console.log("  [pure] ```json fence stripped:", r2.ok && r2.recovered === "fence-stripped" ? "PASS ✓" : "FAIL ✗");
    const r3 = parseAiJsonResponse("בטח, הנה:\n" + valid);
    console.log("  [pure] prose BEFORE json sliced out:", r3.ok && r3.recovered === "sliced" ? "PASS ✓" : "FAIL ✗");
    const r4 = parseAiJsonResponse(valid + "\nמקווה שעזרתי!");
    console.log("  [pure] prose AFTER json sliced out:", r4.ok && r4.recovered === "sliced" ? "PASS ✓" : "FAIL ✗");
    const shc = `{"reply":"תספורת (80 ש"ח), פן (120 ש"ח)","understanding":{"requestsBusinessAction":true,"intent":"booking","appointmentIntent":"BOOK"}}`;
    const r5 = parseAiJsonResponse(shc);
    console.log("  [pure] Hebrew unescaped ש\"ח quotes repaired (content preserved):",
      r5.ok && r5.recovered === "quote-repaired" && replyOf(r5.data).includes("ש\"ח") ? "PASS ✓" : `FAIL ✗ (${r5.ok ? r5.recovered : r5.reason})`);
    const r6 = parseAiJsonResponse(`{"reply":"היי","understanding":{"intent":"booking"}`);
    console.log("  [pure] truncated JSON → classified truncated_json:", !r6.ok && r6.reason === "truncated_json" ? "PASS ✓" : `FAIL ✗ (${r6.ok ? "ok" : r6.reason})`);
    const r7 = parseAiJsonResponse("מצטער, לא הצלחתי לעזור");
    console.log("  [pure] non-JSON prose → failure (no fabrication):", !r7.ok ? "PASS ✓" : "FAIL ✗");

    // The EXACT live BUG-001 response shape → must recover a usable turn (no generic error).
    const exact = `{ "reply": "בטח, קובי! אנחנו מציעים תספורת (80 ש"ח), פן ועיצוב שיער (120 ש"ח), וצביעת שיער (250 ש"ח). מה תרצה להזמין?", "understanding": { "conversationGoal": "לקבוע תור", "requestsBusinessAction": true, "intent": "booking", "appointmentIntent": "BOOK", "serviceName": null } }`;
    const turn = parseReceptionistTurn(exact);
    console.log("  [pure] BUG-001 exact response recovers a valid turn:",
      turn !== null && turn.reply.includes("תספורת") && turn.understanding.appointmentIntent === "BOOK"
        ? "PASS ✓" : `FAIL ✗ (${turn === null ? "null" : turn.reply.slice(0, 40)})`);
  }

  console.log("\n================ SCENARIO 32: low-signal guard + link-wording fence (BUG-002) ================");
  {
    const pt = await import("../lib/ai/platform-turn");
    const { runReceptionistTurn } = await import("../lib/ai/brain");

    console.log("  [pure] escalation tiers 1→normal, 2→short, 3→boundary, 4→quiet_mode:",
      pt.lowSignalActionFor(0) === "none" && pt.lowSignalActionFor(1) === "normal_clarify" &&
      pt.lowSignalActionFor(2) === "short_clarify" && pt.lowSignalActionFor(3) === "boundary" &&
      pt.lowSignalActionFor(4) === "quiet_mode" ? "PASS ✓" : "FAIL ✗");

    // Counter state machine: escalate over consecutive low-signal turns, RESET on a productive one.
    {
      const seq = [true, true, true, true, false, true]; // low ×4, productive, low
      let c = 0; const acts: string[] = [];
      for (const low of seq) { c = low ? c + 1 : 0; acts.push(pt.lowSignalActionFor(c)); }
      const want = ["normal_clarify", "short_clarify", "boundary", "quiet_mode", "none", "normal_clarify"];
      console.log("  [pure] counter escalates then RESETS on a productive turn:",
        JSON.stringify(acts) === JSON.stringify(want) ? "PASS ✓" : `FAIL ✗ (${acts.join(",")})`);
    }

    console.log("  [pure] phantom 'בקישור למטה' detected; future 'אשלח קישור' NOT:",
      pt.mentionsPhantomLink("לקבוע תור בקישור למטה") && !pt.mentionsPhantomLink("בכיף אשלח לך קישור כשתרצה") ? "PASS ✓" : "FAIL ✗");

    const ex = "אני כאן 🙂 אפשר לשאול אותי הכל על העסק, או לקבוע תור בקישור למטה.";
    const stripped = pt.stripPhantomLinkWording(ex);
    console.log("  [pure] link wording removed, content preserved:",
      !/קישור|לינק/.test(stripped) && stripped.includes("העסק") ? `PASS ✓ ("${stripped}")` : `FAIL ✗ ("${stripped}")`);

    console.log("  [pure] 'בקישור ששלחתי' fenced with no prior link, allowed once a link was sent:",
      pt.shouldFenceLinkWording(null, false, "צפה בקישור ששלחתי") === true &&
      pt.shouldFenceLinkWording(null, true, "צפה בקישור ששלחתי") === false ? "PASS ✓" : "FAIL ✗");

    const dec = (u: Record<string, unknown>) =>
      ({ ok: true, turn: { reply: "r", understanding: u } }) as unknown as Parameters<typeof pt.isLowSignalTurn>[0];
    console.log("  [pure] isLowSignalTurn: unclear=low; smalltalk/meta/faq/operation NOT low (BUG-005):",
      pt.isLowSignalTurn(dec({ requestsBusinessAction: false, intent: "unclear", appointmentIntent: "NONE" })) &&
      !pt.isLowSignalTurn(dec({ requestsBusinessAction: false, intent: "smalltalk", appointmentIntent: "NONE" })) &&
      !pt.isLowSignalTurn(dec({ requestsBusinessAction: false, intent: "meta", appointmentIntent: "NONE" })) &&
      !pt.isLowSignalTurn(dec({ requestsBusinessAction: false, intent: "faq", appointmentIntent: "NONE" })) &&
      !pt.isLowSignalTurn(dec({ requestsBusinessAction: true, intent: "booking", appointmentIntent: "BOOK" })) ? "PASS ✓" : "FAIL ✗");

    // Light-live: the RUNTIME counter uses lowSignalKind (catches gibberish
    // structurally regardless of the model's intent label). No-vowel smash counts;
    // a pricing question is productive (resets).
    const svc = ["תספורת", "צבע", "פן"];
    const dg = await runReceptionistTurn(makeCtx(), { conversationContext: "", message: "חכלגתד", bookingBlock: "", platformMode: true });
    const dq = await runReceptionistTurn(makeCtx(), { conversationContext: "", message: "כמה עולה תספורת?", bookingBlock: "", platformMode: true });
    console.log("  [live] gibberish → counts toward quiet, pricing question → productive (resets):",
      pt.countsTowardQuiet(pt.lowSignalKind(dg, "חכלגתד", svc)) && !pt.countsTowardQuiet(pt.lowSignalKind(dq, "כמה עולה תספורת?", svc))
        ? "PASS ✓" : `FAIL ✗ (gib=${pt.lowSignalKind(dg, "חכלגתד", svc)} price=${pt.lowSignalKind(dq, "כמה עולה תספורת?", svc)})`);
  }

  console.log("\n================ SCENARIO 33: low-signal QUIET MODE — cost control (BUG-003) ================");
  {
    const pt = await import("../lib/ai/platform-turn");
    const { runReceptionistTurn } = await import("../lib/ai/brain");
    const services = ["תספורת", "צבע", "פן"];

    // Cheap LOCAL noise detector (no Gemini): obvious nonsense → true.
    const noise = ["כ", "ח", "....", "לגךדכחע", "כחדטלךע", "חכלגתד", "כללסתג"];
    const noiseMisses = noise.filter((m) => !pt.looksLikeNoise(m, services));
    console.log(`  [pure] obvious nonsense detected locally (${noise.length - noiseMisses.length}/${noise.length}):`,
      noiseMisses.length === 0 ? "PASS ✓" : `FAIL ✗ [${noiseMisses.join(" | ")}]`);

    // Real / productive / conversational messages must NOT be flagged as local noise
    // (they go to Gemini — quiet mode never blocks them).
    const notNoise = [
      "אני רוצה פן", "אפשר לקבוע תור", "אני רוצה תספורת", "איזה תורים יש לי", "אני רוצה לבטל",
      "יש חניה", "כמה עולה", "מה שעות הפעילות", "מה נשמע", "אתה בן או בת", "אני טס לחו״ל",
      "אני רעב", "שלום", "מחר", "כן", "לא", "תודה",
    ];
    const falseNoise = notNoise.filter((m) => pt.looksLikeNoise(m, services));
    console.log(`  [pure] real/convo messages NOT flagged as noise (${notNoise.length - falseNoise.length}/${notNoise.length}):`,
      falseNoise.length === 0 ? "PASS ✓" : `FAIL ✗ [${falseNoise.join(" | ")}]`);

    // Sparse-reply planner: quiet starts at count 4; mostly suppressed, rare reminder.
    const plans = [4, 5, 6, 7, 8].map((c) => pt.quietModePlan(c));
    const suppressedCount = plans.filter((p) => p.isQuiet && p.suppressReply).length;
    console.log("  [pure] quiet mode is sparse (mostly suppressed, occasional reminder):",
      plans.every((p) => p.isQuiet) && suppressedCount >= 3 && suppressedCount < 5 ? "PASS ✓" : `FAIL ✗ (suppressed ${suppressedCount}/5)`);
    console.log("  [pure] below threshold (count<4) is NOT quiet mode:",
      !pt.quietModePlan(3).isQuiet && !pt.quietModePlan(1).isQuiet ? "PASS ✓" : "FAIL ✗");

    // Light-live RECOVERY: a meaningful message after nonsense is NOT local-noise and
    // classifies productive (resets) — quiet mode releases immediately.
    const dBook = await runReceptionistTurn(makeCtx(), { conversationContext: "", message: "אשמח לקבוע תור", bookingBlock: "", platformMode: true });
    const dFaq = await runReceptionistTurn(makeCtx(), { conversationContext: "", message: "יש חניה?", bookingBlock: "", platformMode: true });
    console.log("  [live] recovery: booking + FAQ are not noise and reset (not low-signal):",
      !pt.looksLikeNoise("אשמח לקבוע תור", services) && !pt.isLowSignalTurn(dBook) &&
      !pt.looksLikeNoise("יש חניה?", services) && !pt.isLowSignalTurn(dFaq) ? "PASS ✓" : `FAIL ✗ (book=${dBook.turn?.understanding.intent} faq=${dFaq.turn?.understanding.intent})`);
  }

  console.log("\n================ SCENARIO 34: evidence gate — hallucinated BOOK on gibberish (BUG-004) ================");
  {
    const pt = await import("../lib/ai/platform-turn");
    const { runReceptionistTurn } = await import("../lib/ai/brain");
    const services = ["תספורת", "צבע", "פן"];
    const GIBBERISH = ["חכלגצג", "חבצב", "חגלגגצמגמד"]; // exact messages from the BUG-004 logs
    type U = Parameters<typeof pt.applyBookingEvidenceGate>[0];
    const mkU = (over: Record<string, unknown>): U =>
      ({ requestsBusinessAction: false, intent: "unclear", appointmentIntent: "NONE", ...over }) as unknown as U;
    const mkDec = (u: U) =>
      ({ ok: true, turn: { reply: "r", understanding: u } }) as unknown as Parameters<typeof pt.isLowSignalTurn>[0];

    // PURE: a hallucinated BOOK on gibberish is downgraded to non-actionable + low-signal.
    let pureOk = 0;
    for (const g of GIBBERISH) {
      const u = mkU({ requestsBusinessAction: true, intent: "booking", appointmentIntent: "BOOK" });
      const ev = pt.applyBookingEvidenceGate(u, g, services);
      const downgraded = u.requestsBusinessAction === false && u.appointmentIntent === "NONE" && u.intent === "unclear";
      const low = pt.isLowSignalTurn(mkDec(u));
      if (!ev.evidence && downgraded && low) pureOk++;
    }
    console.log(`  [pure] gibberish+hallucinated-BOOK → action=false, low_signal=true (${pureOk}/${GIBBERISH.length}):`,
      pureOk === GIBBERISH.length ? "PASS ✓" : "FAIL ✗");

    // PURE: a GENUINE operation with evidence is NOT downgraded.
    const ub = mkU({ requestsBusinessAction: true, intent: "booking", appointmentIntent: "BOOK" });
    const evb = pt.applyBookingEvidenceGate(ub, "אני רוצה פן", services);
    console.log("  [pure] genuine 'אני רוצה פן' keeps BOOK (evidence present, stays productive):",
      evb.evidence && ub.requestsBusinessAction === true && !pt.isLowSignalTurn(mkDec(ub)) ? "PASS ✓" : "FAIL ✗");

    // PURE: FAQ is productive and untouched (not an operation).
    const uf = mkU({ requestsBusinessAction: false, intent: "faq", appointmentIntent: "NONE" });
    const evf = pt.applyBookingEvidenceGate(uf, "יש חניה?", services);
    console.log("  [pure] FAQ untouched by evidence gate (productive):",
      evf.reason === "faq_productive" && uf.intent === "faq" ? "PASS ✓" : "FAIL ✗");

    // LIVE: regardless of what Gemini emits for these exact messages, after the gate
    // they MUST be action=false + low_signal=true (counter would increment, not reset).
    let liveOk = 0; const liveDetail: string[] = [];
    for (const g of GIBBERISH) {
      const d = await runReceptionistTurn(makeCtx(), { conversationContext: "", message: g, bookingBlock: "", platformMode: true });
      const rawAction = d.turn?.understanding.requestsBusinessAction === true;
      if (d.ok && d.turn) pt.applyBookingEvidenceGate(d.turn.understanding, g, services);
      const action = d.turn?.understanding.requestsBusinessAction === true;
      // The runtime counts via lowSignalKind (gibberish caught structurally even if
      // the model labeled it smalltalk/unclear) — that's what holds quiet mode.
      const low = pt.countsTowardQuiet(pt.lowSignalKind(d, g, services));
      if (!action && low) liveOk++; else liveDetail.push(`"${g}"(rawBOOK=${rawAction}→action=${action}/low=${low})`);
    }
    console.log(`  [live] exact log gibberish → action=false + low_signal=true after gate (${liveOk}/${GIBBERISH.length}):`,
      liveOk === GIBBERISH.length ? "PASS ✓" : `FAIL ✗ ${liveDetail.join(" ")}`);
  }

  console.log("\n================ SCENARIO 35: softer quiet mode + pre-Gemini guard (BUG-005) ================");
  {
    const pt = await import("../lib/ai/platform-turn");
    const { runReceptionistTurn } = await import("../lib/ai/brain");
    const services = ["תספורת", "צבע", "פן"];

    // Greetings / meta / "are you there?" are NOT gibberish.
    const greetings = ["היי", "שלום", "מה קורה?", "הלו?", "יש תשובה?", "למה לא ענית?", "מה קורה פה?", "היי מה קורה?", "מה קורה"];
    const flaggedNoise = greetings.filter((m) => pt.looksLikeNoise(m, services));
    console.log(`  [pure] greetings/meta NOT flagged as gibberish (${greetings.length - flaggedNoise.length}/${greetings.length}):`,
      flaggedNoise.length === 0 ? "PASS ✓" : `FAIL ✗ [${flaggedNoise.join(" | ")}]`);
    const recognized = greetings.filter((m) => pt.looksLikeGreetingOrMeta(m, services));
    console.log(`  [pure] greetings/meta recognized for cheap handling (${recognized.length}/${greetings.length}):`,
      recognized.length === greetings.length ? "PASS ✓" : `FAIL ✗ [${greetings.filter((m) => !pt.looksLikeGreetingOrMeta(m, services)).join(" | ")}]`);
    const notGreeting = ["אני רוצה לקבוע תור", "יש חניה", "כמה עולה תספורת", "חכלגצג"].filter((m) => pt.looksLikeGreetingOrMeta(m, services));
    console.log("  [pure] real/booking/gibberish NOT mistaken for greeting:",
      notGreeting.length === 0 ? "PASS ✓" : `FAIL ✗ [${notGreeting.join(" | ")}]`);

    // PRE-GEMINI guard decisions (the cost fix). greetingCount=0 here (no loop).
    const pa = (n: number, m: string) => pt.preGeminiAction(n, 0, m, services);
    console.log("  [pure] quiet+gibberish → skip Gemini; quiet+greeting → cheap reset; quiet+booking → Gemini:",
      pa(3, "חכלגצג") === "skip_gemini_gibberish" &&
      pa(4, "היי") === "cheap_reset_reply" &&
      pa(4, "יש תשובה?") === "cheap_reset_reply" &&
      pa(4, "מה קורה פה") === "cheap_reset_reply" &&
      pa(4, "אני רוצה לקבוע תור") === "proceed_to_gemini" ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] NOT in quiet mode → always proceed to Gemini (no false short-circuit):",
      pa(0, "היי") === "proceed_to_gemini" && pa(2, "חכלגצג") === "proceed_to_gemini" ? "PASS ✓" : "FAIL ✗");

    // KIND classification: greetings/meta are not counted; gibberish/unclear are.
    const dec = (u: Record<string, unknown>) =>
      ({ ok: true, turn: { reply: "r", understanding: u } }) as unknown as Parameters<typeof pt.lowSignalKind>[0];
    const sm = pt.lowSignalKind(dec({ requestsBusinessAction: false, intent: "smalltalk", appointmentIntent: "NONE" }), "מה נשמע", services);
    const mt = pt.lowSignalKind(dec({ requestsBusinessAction: false, intent: "meta", appointmentIntent: "NONE" }), "אתה בוט?", services);
    const gb = pt.lowSignalKind(dec({ requestsBusinessAction: false, intent: "unclear", appointmentIntent: "NONE" }), "חכלגצג", services);
    const fq = pt.lowSignalKind(dec({ requestsBusinessAction: false, intent: "faq", appointmentIntent: "NONE" }), "יש חניה", services);
    console.log("  [pure] kind: smalltalk/meta NOT counted, gibberish counted, faq productive:",
      sm === "smalltalk" && !pt.countsTowardQuiet(sm) && mt === "meta" && !pt.countsTowardQuiet(mt) &&
      gb === "gibberish" && pt.countsTowardQuiet(gb) && fq === "productive" && !pt.countsTowardQuiet(fq) ? "PASS ✓" : "FAIL ✗");

    // LIVE: a greeting at the START is not low-signal (doesn't increment the counter).
    const dHi = await runReceptionistTurn(makeCtx(), { conversationContext: "", message: "היי", bookingBlock: "", platformMode: true });
    const kindHi = pt.lowSignalKind(dHi, "היי", services);
    console.log("  [live] 'היי' at conversation start is not counted toward quiet:",
      !pt.countsTowardQuiet(kindHi) ? "PASS ✓" : `FAIL ✗ (kind=${kindHi}, intent=${dHi.turn?.understanding.intent})`);
  }

  console.log("\n================ SCENARIO 36: emoji-only → low-signal flow (BUG-005 emoji) ================");
  {
    const pt = await import("../lib/ai/platform-turn");
    const { enforceAssistantGender } = await import("../lib/ai/gender");

    // Emoji-only detection (general, no blacklist) — the exact live examples + variants.
    const emojiOnly = ["🙏🏻", "🥹", "😙", "🤩", "😄", "😊", "😊😊😊", "👍", "🙂!", "🙏🏻 "];
    const missed = emojiOnly.filter((m) => !pt.isEmojiOnly(m));
    console.log(`  [pure] emoji-only detected (${emojiOnly.length - missed.length}/${emojiOnly.length}):`,
      missed.length === 0 ? "PASS ✓" : `FAIL ✗ [${missed.join(" | ")}]`);

    // Mixed text+emoji and plain text are NOT emoji-only (normal flow).
    const notEmoji = ["תודה 😊", "אני רוצה תור 😊", "יש חניה? 🙏", "כמה עולה טיפול? 🙂", "היי", "חכלגצג", "יש חניה?"];
    const falseEmoji = notEmoji.filter((m) => pt.isEmojiOnly(m));
    console.log(`  [pure] mixed text+emoji / plain NOT treated as emoji-only (${notEmoji.length - falseEmoji.length}/${notEmoji.length}):`,
      falseEmoji.length === 0 ? "PASS ✓" : `FAIL ✗ [${falseEmoji.join(" | ")}]`);

    // Escalation reuses the SAME tiers (this mirrors the emoji block's reply choice):
    const emojiReply = (count: number): { reply: string; suppressed: boolean } => {
      const action = pt.lowSignalActionFor(count);
      if (action === "boundary") return { reply: pt.LOW_SIGNAL_BOUNDARY, suppressed: false };
      if (action === "quiet_mode") { const p = pt.quietModePlan(count); return { reply: p.suppressReply ? "" : pt.LOW_SIGNAL_QUIET_REMINDER, suppressed: p.suppressReply }; }
      return { reply: pt.LOW_SIGNAL_SHORT, suppressed: false };
    };
    const r1 = emojiReply(1), r2 = emojiReply(2), r3 = emojiReply(3), r4 = emojiReply(4), r7 = emojiReply(7);
    console.log("  [pure] repeated emoji escalate: 1-2 short, 3 boundary, 4+ mostly suppressed (no spam):",
      !r1.suppressed && r1.reply === pt.LOW_SIGNAL_SHORT && !r2.suppressed &&
      !r3.suppressed && r3.reply === pt.LOW_SIGNAL_BOUNDARY &&
      r4.suppressed && r7.reply === pt.LOW_SIGNAL_QUIET_REMINDER ? "PASS ✓" : "FAIL ✗");

    // Recovery: meaningful messages after emoji quiet are NOT emoji-only (→ normal flow).
    const recovery = ["יש חניה?", "אני רוצה לקבוע תור", "איזה תורים יש לי?"];
    console.log("  [pure] recovery messages not emoji-only (proceed to normal flow):",
      recovery.every((m) => !pt.isEmojiOnly(m)) ? "PASS ✓" : "FAIL ✗");

    // GENDER on the boundary reply (fixed at the outbound chokepoint).
    const maleBoundary = enforceAssistantGender(pt.LOW_SIGNAL_BOUNDARY, "male");
    const femBoundary = enforceAssistantGender(pt.LOW_SIGNAL_BOUNDARY, "female");
    console.log("  [pure] boundary gender: male→'אני לא מצליח', female→'אני לא מצליחה':",
      maleBoundary.includes("אני לא מצליח ") && !maleBoundary.includes("מצליחה") && femBoundary.includes("מצליחה")
        ? "PASS ✓" : `FAIL ✗ (male="${maleBoundary.slice(0, 30)}")`);
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

  console.log("\n================ SCENARIO 37: low-signal lines kept OUT of AI history (Risk A) ================");
  {
    const pt = await import("../lib/ai/platform-turn");
    // Every deterministic confusion / quiet / reset line must be filtered from the
    // AI-facing transcript so the model never mimics "I didn't understand" after recovery.
    const canned = [
      pt.LOW_SIGNAL_SHORT, pt.LOW_SIGNAL_BOUNDARY, pt.LOW_SIGNAL_QUIET_REMINDER,
      pt.QUIET_RESET, pt.COMPLAINT_ACK, pt.META_FALLBACK,
    ];
    const filtered = canned.filter((s) => isKnownFallbackText(s));
    console.log(`  [pure] canned low-signal/quiet lines filtered from AI history (${filtered.length}/${canned.length}):`,
      filtered.length === canned.length ? "PASS ✓" : "FAIL ✗");
    // Gender-swapped boundary (outbound enforcement rewrites מצליחה→מצליח for male) too.
    const maleBoundary = pt.LOW_SIGNAL_BOUNDARY.replace("מצליחה", "מצליח");
    console.log("  [pure] gender-swapped (male) boundary still filtered:",
      isKnownFallbackText(maleBoundary) ? "PASS ✓" : `FAIL ✗ ("${maleBoundary}")`);
    // Real business answers must NEVER be dropped from history (no over-filtering).
    const real = ["כן, אנחנו עושים פן בשמחה 🙂", "מעולה, נקבע לך תור לחמישי ב-17:30",
      "שעות הפעילות שלנו הן 9:00-19:00", "אפשר לשאול אותי מה תרצי על העסק"];
    const wronglyFiltered = real.filter((s) => isKnownFallbackText(s));
    console.log("  [pure] genuine business answers NOT filtered:",
      wronglyFiltered.length === 0 ? "PASS ✓" : `FAIL ✗ [${wronglyFiltered.join(" | ")}]`);
  }

  console.log("\n================ SCENARIO 38: greeting/meta reset BEFORE quiet mode (Risk B) ================");
  {
    const pt = await import("../lib/ai/platform-turn");
    const services = ["תספורת", "צבע", "פן"];
    // REFINED by BUG-013 (degraded/social contract): a PRESENCE/recovery check after
    // low-signal history resets cheaply (the customer is probing a stuck line); a warm
    // SOCIAL opener at the same counts now goes to Gemini for a NATURAL reply (it no longer
    // sounds like a stiff system-recovery line). Risk B's goal — never ESCALATE a greeting
    // toward the boundary — still holds: at Gemini the opener is smalltalk → counter resets.
    const presenceResets: Array<[string, number]> = [
      ["את פה?", 2], ["יש תשובה?", 2], ["מה קורה פה?", 2], ["למה לא ענית?", 1],
    ];
    const pHit = presenceResets.filter(([m, n]) => pt.preGeminiAction(n, 0, m, services) === "cheap_reset_reply");
    console.log(`  [pure] PRESENCE/recovery check after low-signal → cheap reset (${pHit.length}/${presenceResets.length}):`,
      pHit.length === presenceResets.length ? "PASS ✓" : `FAIL ✗ [${presenceResets.filter(([m, n]) => pt.preGeminiAction(n, 0, m, services) !== "cheap_reset_reply").map(([m, n]) => `${m}@${n}`).join(" | ")}]`);
    // A warm SOCIAL opener at low-signal 1-2 stays natural (Gemini), but a greeting LOOP
    // (prevGreeting≥2) and active quiet mode (prevLowSignal≥3) still short-circuit (cost cap).
    console.log("  [pure] social opener natural at low-signal 1-2, still capped on loop/quiet:",
      pt.preGeminiAction(2, 0, "היי מה קורה?", services) === "proceed_to_gemini" &&
      pt.preGeminiAction(1, 0, "היי", services) === "proceed_to_gemini" &&
      pt.preGeminiAction(0, 2, "מה קורה", services) === "cheap_reset_reply" &&
      pt.preGeminiAction(3, 0, "מה קורה", services) === "cheap_reset_reply" ? "PASS ✓" : "FAIL ✗");
    // Booking/FAQ at the same counts must STILL reach Gemini (never short-circuited).
    const proceeds: Array<[string, number]> = [["אני רוצה לקבוע תור", 2], ["כמה עולה פן?", 2], ["יש חניה?", 2]];
    const ok2 = proceeds.every(([m, n]) => pt.preGeminiAction(n, 0, m, services) === "proceed_to_gemini");
    console.log("  [pure] booking/FAQ at low-signal count still proceed to Gemini:",
      ok2 ? "PASS ✓" : `FAIL ✗ [${proceeds.filter(([m, n]) => pt.preGeminiAction(n, 0, m, services) !== "proceed_to_gemini").map(([m]) => m).join(" | ")}]`);
    // A clean conversation's first greeting (no history, no loop) stays warm (Gemini).
    console.log("  [pure] first greeting in a clean conversation still goes to Gemini (warm):",
      pt.preGeminiAction(0, 0, "היי", services) === "proceed_to_gemini" &&
      pt.preGeminiAction(0, 0, "היי מה קורה?", services) === "proceed_to_gemini" ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 39: repeated-greeting Gemini cost cap + de-spam (Risk C + BUG-009) ================");
  {
    const pt = await import("../lib/ai/platform-turn");
    const services = ["תספורת", "צבע", "פן"];
    // Model a greeting loop: greetings that reach Gemini advance the greeting counter;
    // once it hits the threshold, further greetings are answered deterministically.
    let greeting = 0, geminiCalls = 0;
    const actions: string[] = [];
    for (let i = 0; i < 8; i++) {
      const a = pt.preGeminiAction(0, greeting, "היי", services);
      actions.push(a);
      greeting++; // every greeting (Gemini or cheap) advances the loop counter
      if (a === "proceed_to_gemini") geminiCalls++;
    }
    console.log(`  [pure] 8 repeated greetings → Gemini called only ${geminiCalls}× (cap=${pt.GREETING_DETERMINISTIC_AT}):`,
      geminiCalls === pt.GREETING_DETERMINISTIC_AT ? "PASS ✓" : `FAIL ✗ [${actions.join(",")}]`);
    // First couple of greetings stay warm (model-generated), not cold from turn one.
    console.log("  [pure] first greetings (#1,#2) still warm via Gemini:",
      actions[0] === "proceed_to_gemini" && actions[1] === "proceed_to_gemini" ? "PASS ✓" : "FAIL ✗");
    // A productive turn resets the greeting loop → the next greeting is warm again.
    console.log("  [pure] greeting loop resets after a productive turn:",
      pt.preGeminiAction(0, 0, "היי", services) === "proceed_to_gemini" ? "PASS ✓" : "FAIL ✗");

    // BUG-009: the deterministic greeting reply must NOT be the identical full line every
    // turn — full friendly reset once, then mostly suppressed / a short distinct reminder.
    const plans = [3, 4, 5, 6, 7, 8, 9].map((n) => pt.greetingResetPlan(n));
    const full = plans.filter((p) => !p.suppressReply && p.reply === pt.QUIET_RESET).length;
    const suppressed = plans.filter((p) => p.suppressReply).length;
    const sparse = plans.filter((p) => !p.suppressReply && p.reply === pt.GREETING_SPARSE_REMINDER).length;
    console.log(`  [pure] deep greeting loop de-spams (full=${full} sparse=${sparse} suppressed=${suppressed}/7):`,
      full === 1 && suppressed >= 4 && sparse >= 1 ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] first cheap reset is the full friendly line (never cold/empty):",
      pt.greetingResetPlan(3).reply === pt.QUIET_RESET && !pt.greetingResetPlan(3).suppressReply ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] sparse reminder is shorter than the full reset:",
      pt.GREETING_SPARSE_REMINDER.length < pt.QUIET_RESET.length ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 40: burst-aware greeting recovery (Risk D) ================");
  {
    const pt = await import("../lib/ai/platform-turn");
    const services = ["תספורת", "צבע", "פן"];
    // aggregateBurst joins fragments with "\n"; a noise burst whose tail is a clear
    // greeting/meta must recover cheaply (no Gemini) even at low-signal count 0.
    const recover = ["חבצב\nאת פה?", "גכלדמ\nהיי מה קורה?", "חכלגצג\nיש תשובה?"];
    const hit = recover.filter((m) => pt.preGeminiAction(0, 0, m, services) === "cheap_reset_reply");
    console.log(`  [pure] noise-burst + greeting tail → cheap reset (${hit.length}/${recover.length}):`,
      hit.length === recover.length ? "PASS ✓" : `FAIL ✗ [${recover.filter((m) => pt.preGeminiAction(0, 0, m, services) !== "cheap_reset_reply").join(" | ")}]`);
    // Real booking/FAQ split across a burst must STILL reach Gemini (meaning preserved).
    const booking = ["אני רוצה\nלקבוע פן", "מה המחיר\nשל פן", "היי\nאני רוצה לקבוע תור"];
    const ok2 = booking.every((m) => pt.preGeminiAction(0, 0, m, services) === "proceed_to_gemini");
    console.log("  [pure] booking/FAQ split across a burst still proceeds to Gemini:",
      ok2 ? "PASS ✓" : `FAIL ✗ [${booking.filter((m) => pt.preGeminiAction(0, 0, m, services) !== "proceed_to_gemini").join(" | ")}]`);
  }

  console.log("\n================ SCENARIO 41: superseded turns + context merge (Risks E + F) ================");
  {
    const pt = await import("../lib/ai/platform-turn");
    // Mock DB that records upserts — NO live write (suite contract: no DB writes).
    let upserts = 0;
    let lastCtx: Record<string, unknown> = {};
    const mockDb = {
      from: () => ({
        upsert: async (row: { context: Record<string, unknown> }) => { upserts++; lastCtx = row.context; return { data: null, error: null }; },
      }),
    } as unknown as Parameters<typeof pt.persistPlatformState>[0];

    // Risk E: a superseded turn must NOT persist (no counter mutation, no write).
    const wroteSuperseded = await pt.persistPlatformState(mockDb, "b", "c", 3, 0, { consecutiveLowSignalTurns: 2 }, async () => true);
    console.log("  [pure] superseded turn does NOT persist the counter:",
      wroteSuperseded === false && upserts === 0 ? "PASS ✓" : `FAIL ✗ (wrote=${wroteSuperseded} upserts=${upserts})`);

    // Risk E: a non-superseded turn DOES persist + advance both counters.
    const wrote = await pt.persistPlatformState(mockDb, "b", "c", 4, 1, { consecutiveLowSignalTurns: 2, keepMe: "x" }, async () => false);
    console.log("  [pure] non-superseded turn persists + advances counters:",
      wrote === true && upserts === 1 && lastCtx.consecutiveLowSignalTurns === 4 && lastCtx.consecutiveGreetingTurns === 1 ? "PASS ✓" : `FAIL ✗ (wrote=${wrote} upserts=${upserts} ctx=${JSON.stringify(lastCtx)})`);

    // Risk F: unrelated context fields survive the low-signal update (merge, not clobber).
    console.log("  [pure] persist MERGES priorContext (unrelated fields survive):",
      lastCtx.keepMe === "x" ? "PASS ✓" : `FAIL ✗ (ctx=${JSON.stringify(lastCtx)})`);
  }

  console.log("\n================ SCENARIO 42: routing integrity — single source of truth (LIST→booking-link + BUG-010) ================");
  {
    const rt = await import("../lib/ai/routing");
    const u = (intent: string, appt: string, action = true) =>
      ({ requestsBusinessAction: action, intent, appointmentIntent: appt }) as unknown as Parameters<typeof rt.resolveRoute>[0];
    const R = (intent: string, appt: string, msg: string, action = true) => rt.resolveRoute(u(intent, appt, action), msg).route;

    // THE LIVE BUG: model self-contradicts (intent=booking + appt=LIST) on "show my appts".
    // Route must be LIST and the link 'manage' — NEVER a booking link.
    console.log("  [pure] 'אפשר לראות את כל התורים שלי?' (model intent=booking/appt=LIST) → LIST → manage link:",
      R("booking", "LIST", "אפשר לראות את כל התורים שלי?") === "LIST" && rt.linkKindForRoute("LIST") === "manage"
        ? "PASS ✓" : `FAIL ✗ (route=${R("booking", "LIST", "אפשר לראות את כל התורים שלי?")})`);

    // BUG-010 (opposite direction): an explicit booking verb wins over a model LIST mislabel.
    console.log("  [pure] 'אפשר לקבוע פן?' (model appt=LIST) → BOOK → booking link:",
      R("unclear", "LIST", "אפשר לקבוע פן?") === "BOOK" && rt.linkKindForRoute("BOOK") === "booking"
        ? "PASS ✓" : `FAIL ✗ (route=${R("unclear", "LIST", "אפשר לקבוע פן?")})`);

    // Full operation matrix from the USER'S OWN WORDS — robust to a deliberately WRONG
    // model appt label ("LIST") on every row (proves the message decides, not the model).
    const matrix: Array<[string, string]> = [
      ["אפשר לקבוע פן?", "BOOK"],
      ["אני רוצה לקבוע תור נוסף", "BOOK"],
      ["אפשר לראות את כל התורים שלי?", "LIST"],
      ["מה התורים שלי?", "LIST"],
      ["אני רוצה לשנות את התור שלי", "RESCHEDULE"],
      ["אפשר להזיז את התור?", "RESCHEDULE"],
      ["אני רוצה לבטל את התור", "CANCEL"],
      ["לבטל ולקבוע מחדש", "RESCHEDULE"], // cancel+re-book = reschedule, not a fresh booking
    ];
    const bad = matrix.filter(([m, w]) => R("unclear", "LIST", m) !== w);
    console.log(`  [pure] operation matrix from user's words, robust to a wrong model label (${matrix.length - bad.length}/${matrix.length}):`,
      bad.length === 0 ? "PASS ✓" : `FAIL ✗ [${bad.map(([m, w]) => `${m}→${R("unclear", "LIST", m)}≠${w}`).join(" | ")}]`);

    // FAQ / smalltalk / questions ABOUT an operation never route to an operation.
    console.log("  [pure] FAQ/smalltalk never route to an operation (even with an op verb):",
      R("faq", "NONE", "כמה עולה לבטל תור?", false) === "NONE" &&
      R("smalltalk", "NONE", "מה שלומך?", false) === "NONE" &&
      R("faq", "NONE", "יש חניה?", false) === "NONE" ? "PASS ✓" : "FAIL ✗");

    // Model self-contradiction is reconciled deterministically: appointmentIntent (fine)
    // wins over the coarse `intent` so the two can never disagree silently.
    console.log("  [pure] model field disagreement reconciled (appt wins over coarse intent):",
      rt.modelOperation(u("booking", "LIST")) === "LIST" && rt.modelOperation(u("booking", "CANCEL")) === "CANCEL" &&
      rt.modelOperation(u("unclear", "BOOK")) === "BOOK" ? "PASS ✓" : "FAIL ✗");

    // No-verb message falls back to the (reconciled) model route.
    console.log("  [pure] no-verb message falls back to model route:",
      R("booking", "BOOK", "פן בבקשה") === "BOOK" && R("unclear", "NONE", "אוקיי") === "NONE" ? "PASS ✓" : "FAIL ✗");

    // Link kind agrees with route for EVERY route (no link/intent disagreement possible).
    console.log("  [pure] link kind agrees with route for all 5 routes:",
      rt.linkKindForRoute("BOOK") === "booking" && rt.linkKindForRoute("LIST") === "manage" &&
      rt.linkKindForRoute("RESCHEDULE") === "manage" && rt.linkKindForRoute("CANCEL") === "manage" &&
      rt.linkKindForRoute("NONE") === null ? "PASS ✓" : "FAIL ✗");

    // Existing appointments / prior links / conversation state do NOT enter routing:
    // resolveRoute takes only (understanding, message). Same message ⇒ same route, whatever
    // the model's appt label — structurally there is no appointment/state input to distort it.
    console.log("  [pure] route depends ONLY on understanding + message (existing appts can't distort it):",
      R("unclear", "LIST", "אפשר לקבוע פן?") === R("unclear", "BOOK", "אפשר לקבוע פן?") &&
      R("booking", "BOOK", "אפשר לראות את כל התורים שלי?") === R("unclear", "CANCEL", "אפשר לראות את כל התורים שלי?") ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 43: burst aggregation + debounce (split-message coalescing) ================");
  {
    const mh = await import("../lib/message-handler");
    const flow = await import("../lib/booking/flow");
    const cfg = await import("../lib/config");
    const pt = await import("../lib/ai/platform-turn");
    const rt = await import("../lib/ai/routing");
    const services = ["תספורת", "צבע", "פן"];

    // Chainable mock DB (no real I/O). The lastOut query ends in .maybeSingle(); the burst
    // query is awaited directly on .order() — so the two are distinguished by terminator.
    const mkBurstDb = (lastOut: string | null, rows: Array<{ body: string }>) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gt", "lte", "order", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: lastOut ? { created_at: lastOut } : null });
      (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve({ data: rows });
      return { from: () => chain } as unknown as Parameters<typeof mh.aggregateBurst>[0];
    };
    const agg = (rows: string[], fallback: string) =>
      mh.aggregateBurst(mkBurstDb(null, rows.map((body) => ({ body }))), "b", "c", "2026-06-15T10:00:00Z", fallback);

    // 1) Fragmented booking → aggregates; the user's words route to BOOK.
    const b1 = await agg(["אני רוצה", "לקבוע פן"], "FB");
    console.log("  [pure] fragmented booking aggregates + routes BOOK:",
      b1 === "אני רוצה\nלקבוע פן" && rt.messageOperation(b1) === "BOOK" &&
      pt.preGeminiAction(0, 0, b1, services) === "proceed_to_gemini" ? "PASS ✓" : `FAIL ✗ ("${b1}" op=${rt.messageOperation(b1)})`);

    // 2) Fragmented FAQ → aggregates; has a service signal but is NOT forced to an operation.
    const b2 = await agg(["מה המחיר", "של פן"], "FB");
    console.log("  [pure] fragmented FAQ aggregates + stays FAQ/productive (no op forced):",
      b2 === "מה המחיר\nשל פן" && pt.hasBookingSignal(b2, services) && rt.messageOperation(b2) === null &&
      pt.preGeminiAction(0, 0, b2, services) === "proceed_to_gemini" ? "PASS ✓" : `FAIL ✗ ("${b2}")`);

    // 3) Greeting split → ONE aggregated turn → ONE deterministic friendly reply (no duplicate).
    const b3 = await agg(["היי", "מה קורה?"], "FB");
    console.log("  [pure] greeting split aggregates + single friendly reply (no duplicate):",
      b3 === "היי\nמה קורה?" && pt.preGeminiAction(0, 0, b3, services) === "cheap_reset_reply"
        ? "PASS ✓" : `FAIL ✗ ("${b3}" → ${pt.preGeminiAction(0, 0, b3, services)})`);

    // 4) Repeated "היי" spam → ONE aggregated turn → cheap reset → ZERO Gemini calls.
    const b4 = await agg(Array(8).fill("היי"), "FB");
    console.log("  [pure] repeated-greeting burst aggregates + 0 Gemini (cheap reset):",
      b4.split("\n").length === 8 && pt.preGeminiAction(0, 0, b4, services) === "cheap_reset_reply" ? "PASS ✓" : "FAIL ✗");

    // 5) Early supersede: a newer inbound during the debounce → skip (no Gemini, no reply).
    const mkNewerDb = (rows: unknown[]) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gt", "limit"]) chain[m] = () => chain;
      (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve({ data: rows });
      return { from: () => chain } as unknown as Parameters<typeof flow.hasNewerInbound>[0];
    };
    const newer = await flow.hasNewerInbound(mkNewerDb([{ id: "x" }]), "b", "c", "2026-06-15T10:00:00Z");
    const noNewer = await flow.hasNewerInbound(mkNewerDb([]), "b", "c", "2026-06-15T10:00:00Z");
    console.log("  [pure] early supersede skips when newer inbound exists, proceeds otherwise:",
      newer === true && noNewer === false ? "PASS ✓" : `FAIL ✗ (newer=${newer} noNewer=${noNewer})`);

    // 6) Single normal message → NOT aggregated (returns the message text as-is) → normal flow.
    const b6 = await agg(["שלום"], "FALLBACK_MSG");
    console.log("  [pure] single message is not aggregated (unchanged behavior):",
      b6 === "FALLBACK_MSG" ? "PASS ✓" : `FAIL ✗ ("${b6}")`);

    // Config: default 2000, disable with 0, env override honored, invalid → default, cap 10s.
    const restore = process.env.AGGREGATION_DEBOUNCE_MS;
    delete process.env.AGGREGATION_DEBOUNCE_MS;
    const dDefault = cfg.getAggregationDebounceMs();
    process.env.AGGREGATION_DEBOUNCE_MS = "0";
    const dZero = cfg.getAggregationDebounceMs();
    process.env.AGGREGATION_DEBOUNCE_MS = "1500";
    const dSet = cfg.getAggregationDebounceMs();
    process.env.AGGREGATION_DEBOUNCE_MS = "abc";
    const dBad = cfg.getAggregationDebounceMs();
    process.env.AGGREGATION_DEBOUNCE_MS = "999999";
    const dCap = cfg.getAggregationDebounceMs();
    if (restore === undefined) delete process.env.AGGREGATION_DEBOUNCE_MS; else process.env.AGGREGATION_DEBOUNCE_MS = restore;
    console.log(`  [pure] debounce config default=${dDefault} "0"→${dZero} "1500"→${dSet} invalid→${dBad} cap→${dCap}:`,
      dDefault === 2000 && dZero === 0 && dSet === 1500 && dBad === 2000 && dCap === 10_000 ? "PASS ✓" : "FAIL ✗");

    // 3-fragment burst serialization (race fix): with the triggering-fragment anchor, only
    // the LAST fragment has no newer inbound → only it proceeds; the older two skip BEFORE
    // Gemini. Proves a burst is exactly ONE Gemini/flow execution regardless of timing.
    const mkSerialDb = (times: string[]) => {
      let gtArg: string | null = null;
      const chain: Record<string, unknown> = {};
      chain.select = () => chain; chain.eq = () => chain; chain.limit = () => chain;
      chain.gt = (_c: string, v: string) => { gtArg = v; return chain; };
      (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
        resolve({ data: times.filter((t) => gtArg !== null && t > gtArg).map((t) => ({ id: t })) });
      return { from: () => chain } as unknown as Parameters<typeof flow.hasNewerInbound>[0];
    };
    const fragTimes = ["2026-06-16T10:00:00.000Z", "2026-06-16T10:00:00.700Z", "2026-06-16T10:00:01.400Z"];
    let proceeds = 0;
    for (const ti of fragTimes) {
      if (!(await flow.hasNewerInbound(mkSerialDb(fragTimes), "b", "c", ti))) proceeds++;
    }
    console.log(`  [pure] 3-fragment burst → exactly ONE turn proceeds to Gemini (got ${proceeds}):`,
      proceeds === 1 ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 44: false action-refusal fence (platform link-first, BUG-011) ================");
  {
    const pt = await import("../lib/ai/platform-turn");
    const rt = await import("../lib/ai/routing");
    const route = (intent: string, appt: string, msg: string) =>
      rt.resolveRoute(
        ({ requestsBusinessAction: true, intent, appointmentIntent: appt }) as unknown as Parameters<typeof rt.resolveRoute>[0],
        msg,
      ).route;

    // CANCEL turn: user clearly asks to cancel → system resolves CANCEL → a MANAGE link is
    // the correct behavior. The model drifts into the legacy "אי אפשר לבטל בצ'אט" refusal.
    // The fence must neutralize the refusal while the link decision stays UNCHANGED.
    const cancelRoute = route("cancel_request", "CANCEL", "אני רוצה לבטל את התור שלי");
    const cancelReply = "מצטערת, אי אפשר לבטל תור דרך הצ'אט.";
    const cancelFixed = pt.defuseActionRefusal(cancelReply, cancelRoute);
    console.log("  [pure] cancel-refusal neutralized; final reply has NO refusal; link stays MANAGE:",
      pt.mentionsActionRefusal(cancelReply) === true &&
      cancelFixed.defused === true &&
      pt.mentionsActionRefusal(cancelFixed.text) === false &&   // final customer-facing reply: no refusal
      rt.linkKindForRoute(cancelRoute) === "manage"             // correct link behavior remains
        ? "PASS ✓" : `FAIL ✗ (route=${cancelRoute} text="${cancelFixed.text}")`);

    // BOOK turn: "לקבוע" → BOOK → booking link. Model wrongly says "לא ניתן לקבוע פה".
    const bookRoute = route("booking", "BOOK", "אפשר לקבוע תור?");
    const bookFixed = pt.defuseActionRefusal("אשמח, אבל לא ניתן לקבוע תור כאן.", bookRoute);
    console.log("  [pure] book-refusal neutralized; link stays BOOKING:",
      bookFixed.defused === true && pt.mentionsActionRefusal(bookFixed.text) === false &&
      rt.linkKindForRoute(bookRoute) === "booking" ? "PASS ✓" : `FAIL ✗ (route=${bookRoute})`);

    // Reschedule refusal is detected too.
    console.log("  [pure] reschedule-refusal detected:",
      pt.mentionsActionRefusal("לא ניתן לשנות תור בצ'אט") === true ? "PASS ✓" : "FAIL ✗");

    // FALSE-POSITIVE guards — honest 'no appointment', an offer to help (no negation), and a
    // genuine NON-operation capability limit ('לראות' excluded) must all be LEFT UNTOUCHED.
    const honest = [
      "אין לך תור פעיל כרגע, רוצה שאזמין לך?",
      "אשמח לעזור לך לבטל את התור דרך הקישור.",
      "אני לא יכולה לראות את היסטוריית התשלומים שלך.",
    ];
    const wronglyFlagged = honest.filter((r) => pt.mentionsActionRefusal(r));
    console.log("  [pure] honest non-refusals are NOT touched (no false positives):",
      wronglyFlagged.length === 0 ? "PASS ✓" : `FAIL ✗ [${wronglyFlagged.join(" | ")}]`);

    // A clean reply with no refusal is returned unchanged.
    console.log("  [pure] a clean reply is returned unchanged:",
      pt.defuseActionRefusal("בשמחה! הנה הקישור לניהול התור.", "CANCEL").defused === false ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 45: soft intent + contextual yes + capability fence (BUG-012) ================");
  // Live WhatsApp replay: "חשבתי על להסתפר, יש לי טיסה ליוון" → bot promised in-chat
  // availability; customer "כן" twice → escalated to "לא הצלחתי להבין". General fix:
  // soft service intent is a first-class signal → booking link; a contextual "כן" is
  // productive (single source of truth) and resolves to the link; capability promises
  // are fenced on every turn. Pure (no Gemini cost) — exercises the deterministic core.
  {
    const pt = await import("../lib/ai/platform-turn");
    const SVC = ["תספורת", "פן", "צביעת שיער"];

    // 1) Soft service intent — recognized GENERALLY, business-agnostically (no booking
    //    verb / service-name in the haircut+flight message; works for Pilates/facial too).
    console.log("  [pure] soft service intent recognized across businesses:",
      pt.hasSoftServiceIntent("חשבתי על להסתפר, יש לי טיסה ליוון עוד שבוע", SVC) &&
      pt.hasSoftServiceIntent("חשבתי לבוא לפילאטיס השבוע", SVC) &&
      pt.hasSoftServiceIntent("בא לי לעשות טיפול פנים לפני האירוע", SVC) &&
      pt.hasSoftServiceIntent("חשבתי שאתם יקרים מדי", SVC) === false
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] soft intent classified ABOVE faq (even with a trailing '?'):",
      pt.classifyGoodFaithSignal("חשבתי על להסתפר, יש לי טיסה ליוון, מה כדאי?", { serviceNames: SVC }) === "soft_intent"
        ? "PASS ✓" : "FAIL ✗");

    // 2) Contextual "כן": single source of truth — productive, never escalated to a
    //    boundary line (the live contradiction was latestSignal=contextual_ref but the
    //    counter independently said unclear → "לא הצלחתי להבין").
    const decUnclear = ({ ok: true, geminiCalled: true, turn: { reply: "x", understanding:
      { requestsBusinessAction: false, intent: "unclear", appointmentIntent: "NONE" } } }) as unknown as Parameters<typeof pt.lowSignalKind>[0];
    console.log("  [pure] contextual 'כן' is productive (not low-signal):",
      pt.lowSignalKind(decUnclear, "כן", SVC, "contextual_ref") === "productive" &&
      pt.lowSignalKind(decUnclear, "כן", SVC, "help") === "productive"
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] a bare 'כן' after a BOOKING offer is a confirmation; with no context it is not:",
      pt.isBareAffirmation("כן") &&
      pt.deriveLastAssistantContract("Assistant (you, earlier): רוצה שאבדוק לך זמינות?").offeredBooking === true &&
      pt.deriveLastAssistantContract("Assistant (you, earlier): איזה כיף לשמוע!").offeredBooking === false
        ? "PASS ✓" : "FAIL ✗");

    // 3) Capability-promise fence — the unsupported in-chat promise is detected and
    //    rewritten link-first while keeping warmth; a clean reply is left untouched.
    const promised = pt.defuseCapabilityPromise("הבנתי אותך לגמרי, חשוב שהשיער ייראה טוב. אני אבדוק לך זמינות.");
    console.log("  [pure] capability promise fenced (warmth kept, promise dropped, bridge added):",
      pt.mentionsCapabilityPromise("אני אבדוק לך זמינות לימים הקרובים") &&
      pt.mentionsCapabilityPromise("רק כדי לוודא, אתה רוצה תור למחר?") &&
      promised.defused && promised.text.includes("הבנתי") && !promised.text.includes("זמינות") &&
      pt.defuseCapabilityPromise("בשמחה! אפשר לקבוע דרך הקישור.").defused === false
        ? "PASS ✓" : `FAIL ✗ ("${promised.text}")`);

    // 4) FAQ / smalltalk separation — a social opener (even elongated) is presence, not FAQ.
    console.log("  [pure] 'מה המצבבב' is smalltalk (presence), real FAQ stays faq:",
      pt.classifyGoodFaithSignal("מה המצבבב") === "presence" &&
      pt.classifyGoodFaithSignal("מה השעות שלכם?", { serviceNames: SVC }) === "faq"
        ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 46: degraded-mode + social-opening contract (BUG-013) ================");
  // Live WhatsApp replay: a normal social opener got a stiff recovery line; a 503 fallback
  // asked for "service, day, hour" (illegal in platform mode); and "הסתדר?" after the overload
  // was misread as "how are you?". Pure (no Gemini cost) — exercises the deterministic core.
  {
    const pt = await import("../lib/ai/platform-turn");
    const SVC = ["תספורת", "פן", "צביעת שיער"];

    // 1) Social opener vs presence/recovery — a warm "מה קורה" is natural smalltalk, not a probe.
    console.log("  [pure] social opener distinguished from presence/recovery check:",
      pt.looksLikeSocialOpener("היי מה קורה") && !pt.looksLikePresenceCheck("היי מה קורה") &&
      pt.looksLikePresenceCheck("אתה פה?") && pt.looksLikePresenceCheck("למה לא ענית?")
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] normal opener no longer forced into stiff recovery by residual low-signal:",
      pt.preGeminiAction(2, 0, "היייי מה קורה", SVC) === "proceed_to_gemini" &&
      pt.preGeminiAction(2, 0, "אתה פה?", SVC) === "cheap_reset_reply" &&        // presence still recovers
      pt.preGeminiAction(0, 2, "מה קורה", SVC) === "cheap_reset_reply"           // greeting loop still capped
        ? "PASS ✓" : "FAIL ✗");

    // 2) Degraded fallback ROUTING is platform-safe (booking→link / manage→link / general).
    console.log("  [pure] degraded routing chooses booking/manage/general (never asks service-day-hour):",
      pt.hasBookingSignal("אני רוצה לקבוע תור", []) === true &&
      pt.inferOperation("איך אני מבטל") === "CANCEL" &&
      pt.hasBookingSignal("כמו מה", []) === false && pt.inferOperation("כמו מה") === null
        ? "PASS ✓" : "FAIL ✗");

    // 3) Post-fallback recovery follow-up — "הסתדר?" after an overload notice is recovery, not smalltalk.
    console.log("  [pure] recovery follow-up recognized after a degraded reply:",
      pt.wasDegradedReply("יש לי רגע עומס קטן במערכת 🙏 נסו שוב עוד רגע") &&
      !pt.wasDegradedReply("איזה כיף לשמוע!") &&
      pt.isRecoveryFollowup("הסתדר ?") && pt.isRecoveryFollowup("עובד עכשיו?") &&
      !pt.isRecoveryFollowup("מה שלומך?")
        ? "PASS ✓" : "FAIL ✗");

    // 4) Social-drift counter hygiene — content-ful smalltalk must not inflate the greeting loop.
    console.log("  [pure] content-ful smalltalk does not count as a greeting (no counter poisoning):",
      pt.looksLikeGreetingOrMeta("מה קורה") && !pt.looksLikeGreetingOrMeta("קיבלתי ציון טוב במתמטיקה היום")
        ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 47: short-term pending context + platform-safe offer (BUG-014) ================");
  // Live WhatsApp replay: price answered + "רוצה שנתאם לך תור?" (implies in-chat scheduling);
  // a later "כן" arrived cold and was treated as a fresh greeting. Fix: the offer is fenced to
  // link-first wording, and a short-term pending offer lets a delayed "כן" resolve to it. Pure.
  {
    const pt = await import("../lib/ai/platform-turn");
    const NOW = 1_700_000_000_000;

    // 1) Platform-safe offer wording — "נתאם/נקבע לך" is recognized + fenced to link-first.
    console.log("  [pure] 'schedule for you' offer is fenced to link-first (warmth + price kept):",
      pt.mentionsCapabilityPromise("רוצה שנתאם לך תור?") &&
      (() => { const r = pt.defuseCapabilityPromise("על פן אנחנו לוקחים 120 שקלים. רוצה שנתאם לך תור לזה?");
               return r.defused && r.text.includes("120") && !r.text.includes("נתאם"); })() &&
      pt.mentionsCapabilityPromise("רוצה לקבוע דרך הקישור?") === false
        ? "PASS ✓" : "FAIL ✗");

    // 2) The offer is recorded as a pending BOOK (so a later confirmation resolves to it).
    console.log("  [pure] booking offer (incl. 'נתאם לך') recognized → drives pending context:",
      pt.deriveLastAssistantContract("Assistant (you, earlier): רוצה שנתאם לך תור לפן?").offeredBooking &&
      pt.deriveLastAssistantContract("Assistant (you, earlier): נקבע לך תור?").offeredBooking
        ? "PASS ✓" : "FAIL ✗");

    // 3) Delayed confirmation within TTL resolves; expired/cold does not — business-agnostic service.
    console.log("  [pure] delayed 'כן'/'סבבה'/'תשלח' + valid pending BOOK resolves; expired/cold does not:",
      pt.isBareAffirmation("כן") && pt.isBareAffirmation("סבבה") && pt.isBareAffirmation("תשלח") &&
      pt.readPendingOffer({ pendingOffer: { kind: "BOOK", service: "פיזיותרפיה", at: NOW } }, NOW + 60_000)?.kind === "BOOK" &&
      pt.readPendingOffer({ pendingOffer: { kind: "BOOK", at: NOW } }, NOW + pt.PENDING_OFFER_TTL_MS + 1) === null &&
      pt.readPendingOffer({}, NOW) === null
        ? "PASS ✓" : "FAIL ✗");

    // 4) Cold "כן" with no pending context and no last-offer → not an action.
    console.log("  [pure] cold 'כן' is protected (no pending, no last-contract offer → no route):",
      pt.isBareAffirmation("כן") && pt.readPendingOffer({}, NOW) === null &&
      pt.deriveLastAssistantContract("Assistant (you, earlier): איזה כיף לשמוע!").offeredBooking === false
        ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 48: degraded repair + meta context + false-action guard (BUG-015) ================");
  // Live WhatsApp replay: "הנה תראה" false-routed to a manage link; "זמין?" after an overload
  // was answered about appointments; the bot denied its own overload; a repeated FAQ was scolded
  // ("כבר אמרתי לך"). Pure (no Gemini cost) — exercises the deterministic core.
  {
    const pt = await import("../lib/ai/platform-turn");
    const rt = await import("../lib/ai/routing");

    // 1) False-action guard: bare discourse verbs don't route; real appointment flows still do.
    console.log("  [pure] 'הנה תראה'/'תראה' no longer route to LIST; real flows intact:",
      rt.messageOperation("הנה תראה") === null && rt.messageOperation("תראה") === null &&
      rt.messageOperation("תראה לי את התורים שלי") === "LIST" &&
      rt.messageOperation("אני רוצה לראות את התור שלי") === "LIST" &&
      rt.messageOperation("אני רוצה לבטל") === "CANCEL"
        ? "PASS ✓" : "FAIL ✗");

    // 2) Polite / fragmented FAQ recognized as productive.
    console.log("  [pure] split polite FAQ ('אשמח לדעת'/'אם יש איפה לשבת') is productive:",
      pt.classifyGoodFaithSignal("אשמח לדעת אם יש איפה לשבת") === "faq" &&
      pt.lowSignalKind(({ ok: true, geminiCalled: true, turn: { reply: "x", understanding:
        { requestsBusinessAction: false, intent: "unclear", appointmentIntent: "NONE" } } }) as unknown as Parameters<typeof pt.lowSignalKind>[0],
        "אשמח לדעת\nאם יש איפה לשבת", ["תספורת"]) === "productive"
        ? "PASS ✓" : "FAIL ✗");

    // 3) Repeat-answer tone guard: scolding softened, answer kept.
    console.log("  [pure] repeated-FAQ scolding softened ('כבר אמרתי לך' removed, answer kept):",
      (() => { const r = pt.softenRepeatTone("קובי, כבר אמרתי לך שיש לנו שלוש ספות");
               return r.softened && r.text.includes("שלוש ספות") && !/אמרתי\s+לך/.test(r.text); })() &&
      pt.softenRepeatTone("בטח, יש לנו שלוש ספות 🙂").softened === false
        ? "PASS ✓" : "FAIL ✗");

    // 4) Degraded recovery broadened + accountability repair recognized (gated on recentlyDegraded).
    console.log("  [pure] 'זמין?'/'אפשר עכשיו?' are recovery; 'כי כתבת שיש עומס'/'הנה תראה' are accountability:",
      pt.isRecoveryFollowup("זמין?") && pt.isRecoveryFollowup("אתה זמין?") && pt.isRecoveryFollowup("אפשר עכשיו?") &&
      pt.recentlyDegraded("Assistant (you, earlier): יש לי רגע עומס קטן במערכת 🙏\nCustomer: ?\nAssistant (you, earlier): אני כאן 🙂") &&
      pt.isAccountabilityChallenge("שאלתי לגבי הזמינות שלך") && pt.isAccountabilityChallenge("כי כתבת שיש עומס") &&
      pt.isAccountabilityChallenge("הנה תראה") && pt.isAccountabilityChallenge("כמה עולה תספורת?") === false
        ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 49: degraded loop + pipeline integrity (BUG-016, architecture) ================");
  // Regression: a global Gemini cooldown spammed overload messages; meta "זמינות" after an
  // overload stole a booking link; "היי אשמח לדעת" became smalltalk; superseded turns could
  // poison the cooldown. Pure (no Gemini cost — and we must NOT hammer Gemini during a 503 storm).
  {
    const pt = await import("../lib/ai/platform-turn");
    const T0 = 1_700_000_000_000;

    // 1) Degraded notice is rate-limited (one per window, then quiet — no overload spam).
    console.log("  [pure] degraded notice rate-limited (one per window, then suppressed):",
      pt.degradedNoticeAllowed({}, T0) === true &&
      pt.degradedNoticeAllowed({ lastDegradedAt: T0 }, T0 + 1000) === false &&
      pt.degradedNoticeAllowed({ lastDegradedAt: T0 }, T0 + pt.DEGRADED_NOTICE_MIN_GAP_MS + 1) === true
        ? "PASS ✓" : "FAIL ✗");

    // 2) Inquiry opener outranks greeting/smalltalk.
    console.log("  [pure] 'היי אשמח לדעת' is an inquiry (faq), not social smalltalk:",
      pt.looksLikeGreetingOrMeta("היי אשמח לדעת") === false &&
      pt.looksLikeSocialOpener("היי אשמח לדעת") === false &&
      pt.classifyGoodFaithSignal("היי אשמח לדעת") === "faq" &&
      pt.looksLikeSocialOpener("היי מה קורה") === true
        ? "PASS ✓" : "FAIL ✗");

    // 3) Cooldown ordering: meta "זמינות" is accountability/recovery (handled before booking).
    console.log("  [pure] meta 'זמינות' after overload is accountability/recovery, never a booking link:",
      pt.isAccountabilityChallenge("שאלתי לגבי הזמינות שלך") &&
      pt.hasBookingSignal("שאלתי לגבי הזמינות שלך", []) &&   // both true → accountability MUST win the ordering
      pt.isRecoveryFollowup("אתה זמין?")
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [note] supersede-abort (gemini.ts) + cooldown decision ordering (runPlatformTurn) are integration paths — covered by build/typecheck + predicates; a live probe is the full assertion (NOT run during the 503 storm).");
  }

  console.log("\n================ SCENARIO 50: deterministic continuity mode under 503 (BUG-017) ================");
  // Live replay: under a Gemini 503, a mixed "ואפשר לעשן? / אתה זמין? / שאלתי לגבי זמינות כי אמרת /
  // שיש עומס" burst became degraded+BOOKING (no booking intent). The shared degraded-intent
  // classifier now follows one priority and never attaches a link off the loose "זמינות" signal. Pure.
  {
    const pt = await import("../lib/ai/platform-turn");
    console.log("  [pure] mixed FAQ/meta/recovery burst → accountability, NOT degraded+booking:",
      pt.classifyDegradedIntent("ואפשר לעשן?\nאתה זמין?\nשאלתי לגבי זמינות כי אמרת\nשיש עומס") === "accountability"
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] simple/price FAQ under 503 → continuity menu, never booking:",
      pt.classifyDegradedIntent("ואפשר לעשן?") === "menu" &&
      pt.classifyDegradedIntent("כמה עולה פן?") === "menu"
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] explicit ops still route under 503; recovery never books:",
      pt.classifyDegradedIntent("אני רוצה לקבוע תור") === "booking" &&
      pt.classifyDegradedIntent("תוכל לשלוח לי את הקישור") === "manage" &&
      pt.classifyDegradedIntent("אתה זמין?") === "recovery" &&
      pt.classifyDegradedIntent("יש זמינות מחר?") !== "booking"
        ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 51: general deterministic receptionist (no-AI) (BUG-018) ================");
  // Live replay: with AI disabled in the dashboard, every message got the SAME canned line — even
  // "אני רוצה לקבוע תור" produced no booking link. Now ALL no-AI states (ai_disabled / 503 / cooldown
  // / internal error) share one deterministic core: explicit ops route to links; ai_disabled wording
  // is neutral (never says "overload"); FAQ/unknown → a menu. Pure (no Gemini cost).
  {
    const pt = await import("../lib/ai/platform-turn");
    console.log("  [pure] ai_disabled wording is neutral (no overload), still offers the menu/links:",
      !/עומס|מצומצם/.test(pt.continuityText("ai_disabled", "menu")) &&
      pt.continuityText("ai_disabled", "menu").includes("לקבוע תור") &&
      pt.continuityText("ai_disabled", "booking", "URL").includes("URL") &&
      !/עומס/.test(pt.continuityText("ai_disabled", "booking", "URL"))
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] explicit booking/manage route to links in no-AI mode; meta/FAQ does not:",
      pt.classifyDegradedIntent("אני רוצה לקבוע תור") === "booking" &&
      pt.classifyDegradedIntent("אני רוצה לבטל תור") === "manage" &&
      pt.classifyDegradedIntent("ואפשר לעשן?") === "menu" &&
      pt.classifyDegradedIntent("היי") === "menu"
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] sustained outage explains a load; transient 503 is a soft 'resend?' (not menu):",
      /עומס/.test(pt.continuityText("provider_outage", "menu")) &&
      /לשלוח שוב/.test(pt.continuityText("provider_transient", "menu")) &&
      pt.continuityText("provider_transient", "menu") !== pt.continuityText("provider_outage", "menu")
        ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 52: general deterministic menu / FAQ core (no-AI) (BUG-019) ================");
  // Live replay: with AI disabled, a neutral menu was shown for "היי"; the NEXT meaningful FAQ
  // ("אפשר לעשן במספרה?", "יש חניה?") was SUPPRESSED by the menu rate-limit (customerVisible=false,
  // no outbound). Now a real business-info question is ANSWERED from facts/KB (or gets the info
  // submenu) and is NEVER rate-limited; only a vague/greeting repeat hits the limit. Business-
  // agnostic — proven on a yoga studio, not a salon. Pure (no Gemini cost).
  {
    const cm = await import("../lib/ai/continuity-menu");
    const facts = {
      businessName: "Flow Studio", phone: "03-1234567",
      location: { address: "הרצל 10", city: "תל אביב" }, timezone: "Asia/Jerusalem", bookingEnabled: true,
      hours: [
        { day: "ראשון", closed: false, opens: "09:00", closes: "18:00" },
        { day: "שבת", closed: true, opens: null, closes: null },
      ],
      services: [
        { name: "שיעור יוגה", durationMin: 60, price: 70, description: null },
        { name: "אימון אישי", durationMin: 45, price: 150, description: null },
      ],
      knowledge: [
        { category: "parking", title: "חניה", content: "יש חניון ציבורי במרחק 2 דקות הליכה." },
        { category: "about", title: "על הסטודיו", content: "סטודיו בוטיק לתנועה ונשימה." },
      ],
    };
    console.log("  [pure] THE BUG: a meaningful FAQ after a menu is answer/submenu, NEVER suppressed:",
      cm.planContinuityMenu("ai_disabled", "אפשר לעשן במספרה?", facts).kind === "submenu" &&
      cm.planContinuityMenu("ai_disabled", "יש חניה?", facts).kind === "answer" &&
      cm.planContinuityMenu("ai_disabled", "היי", facts).kind === "vague_menu"
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] hours/prices/location answered from the business's OWN facts (grounded):",
      cm.resolveInfoAnswer(facts, "hours")!.includes("09:00-18:00") &&
      cm.resolveInfoAnswer(facts, "prices")!.includes("שיעור יוגה") &&
      cm.resolveInfoAnswer(facts, "prices")!.includes("₪70") &&
      cm.resolveInfoAnswer(facts, "location")!.includes("הרצל 10")
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] menu is reason-aware + capability-gated (ai_disabled neutral; hides disabled options):",
      !/עומס|מוגבל/.test(cm.buildMainMenu(facts)) &&
      /מוגבל|עומס/.test(cm.planContinuityMenu("provider_outage", "היי", facts).text) &&
      !cm.buildMainMenu({ ...facts, bookingEnabled: false }).includes("קביעת תור")
        ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 53: navigable WhatsApp menu flow + provider health (BUG-020) ================");
  // Product goal: a REAL menu flow (main → faq → category → answer → nav) navigable by number/
  // alias/back/topic — AI-FIRST (intercept only on explicit menu or an active cursor), and a clear
  // provider-health state that decides menu mode and self-heals back to AI. Pure (no Gemini cost).
  {
    const cm = await import("../lib/ai/continuity-menu");
    const g = await import("../lib/ai/gemini");
    const facts = {
      businessName: "Flow Studio", phone: "03-1234567",
      location: { address: "הרצל 10", city: "תל אביב" }, timezone: "Asia/Jerusalem", bookingEnabled: true,
      hours: [{ day: "ראשון", closed: false, opens: "09:00", closes: "18:00" }],
      services: [{ name: "שיעור יוגה", durationMin: 60, price: 70, description: null }],
      knowledge: [{ category: "parking", title: "חניה", content: "יש חניון ציבורי במרחק 2 דקות הליכה." }],
    };
    // Flow: תפריט → 3 (faq) → 1 (hours answer) → תפריט ראשי → 1 (book)
    const main = cm.resolveMenuNavigation(null, "תפריט", facts, { activeMenu: false });
    const faq = cm.resolveMenuNavigation("main", "3", facts, { activeMenu: true });
    const hours = cm.resolveMenuNavigation("faq", "1", facts, { activeMenu: true });
    const backMain = cm.resolveMenuNavigation("faq", "תפריט ראשי", facts, { activeMenu: true });
    const book = cm.resolveMenuNavigation("main", "1", facts, { activeMenu: true });
    console.log("  [pure] main → 3 → 1 → תפריט ראשי → 1 navigates main/faq/answer/main/book:",
      main?.kind === "main" && faq?.kind === "faq" &&
      hours?.kind === "answer" && hours.reply.includes("09:00-18:00") &&
      backMain?.kind === "main" && book?.kind === "book"
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] AI-FIRST: no active cursor → free text / bare number are NOT intercepted:",
      cm.resolveMenuNavigation(null, "כמה עולה שיעור?", facts, { activeMenu: false }) === null &&
      cm.resolveMenuNavigation(null, "3", facts, { activeMenu: false }) === null
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] provider health snapshot is healthy after reset (state that decides menu mode):",
      (() => { g.resetGeminiHealth(); const h = g.getGeminiHealth(); return h.state === "healthy" && h.strikes === 0; })()
        ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 54: clickable WhatsApp menu (interactive) end-to-end (BUG-021) ================");
  // Product target: TAPPABLE WhatsApp menus. The bot sends interactive buttons/list rows with
  // stable payload IDs; a tap echoes the id back; the engine resolves it deterministically and
  // sends the next interactive message. Pure (no Gemini/Meta network).
  {
    const cm = await import("../lib/ai/continuity-menu");
    const wa = await import("../lib/whatsapp");
    const facts = {
      businessName: "Flow Studio", phone: "03-1234567",
      location: { address: "הרצל 10", city: "תל אביב" }, timezone: "Asia/Jerusalem", bookingEnabled: true,
      hours: [{ day: "ראשון", closed: false, opens: "09:00", closes: "18:00" }],
      services: [{ name: "שיעור יוגה", durationMin: 60, price: 70, description: null }],
      knowledge: [{ category: "parking", title: "חניה", content: "יש חניון ציבורי במרחק 2 דקות הליכה." }],
    };
    // Bot sends main menu (buttons) → customer taps "מידע ושאלות" (f payload) → bot sends FAQ list →
    // customer taps "שעות פתיחה" (f:hours) → bot answers + nav buttons.
    const mainMenu = cm.buildInteractiveMainMenu(facts);
    const tapFaq = wa.extractInboundMessage({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: cm.MENU_PAYLOAD.faq, title: "מידע ושאלות" } } });
    const navFaq = tapFaq?.payloadId ? cm.resolveMenuPayload(tapFaq.payloadId, facts) : null;
    const tapHours = wa.extractInboundMessage({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "f:hours", title: "שעות פתיחה" } } });
    const navHours = tapHours?.payloadId ? cm.resolveMenuPayload(tapHours.payloadId, facts) : null;
    console.log("  [pure] tap flow: main(buttons) → tap מידע → faq(list) → tap שעות → hours answer:",
      mainMenu.kind === "buttons" && mainMenu.buttons.some((b) => b.id === cm.MENU_PAYLOAD.faq) &&
      navFaq?.kind === "faq" && navHours?.kind === "answer" && navHours.reply.includes("09:00-18:00")
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] interactive messages respect WhatsApp limits (buttons ≤3/≤20ch; list ≤10 rows):",
      (() => {
        const f = cm.buildInteractiveFaqMenu(facts);
        const okBtn = mainMenu.kind === "buttons" && mainMenu.buttons.length <= 3 && mainMenu.buttons.every((b) => b.title.length <= 20);
        const okList = f.kind === "list" && f.rows.length <= 10 && f.rows.every((r) => r.title.length <= 24);
        return okBtn && okList;
      })()
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] booking action → cta_url ('לחץ כאן' URL button), business-agnostic:",
      (() => {
        const book = cm.resolveMenuPayload(cm.MENU_PAYLOAD.book, facts);
        return book?.kind === "book"; // platform-turn wraps this as a cta_url interactive with the real URL
      })()
        ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 55: menu polish — business-aware copy + no-dead-end anchoring (BUG-022) ================");
  // Live observation: entering AI-disabled mode with a booking intent ("אולי נקבע תור") sent a
  // booking link with no visible way back to the menu (a dead end), and the menu copy was generic.
  // Polish: business-aware/reason-specific copy + a "כתבו תפריט" hint on every action card.
  // The booking/manage intent is recognized DETERMINISTICALLY (no Gemini) via classifyDegradedIntent.
  {
    const cm = await import("../lib/ai/continuity-menu");
    const pt = await import("../lib/ai/platform-turn");
    const facts = {
      businessName: "סטודיו פלואו", phone: "03-1234567",
      location: { address: "הרצל 10", city: "תל אביב" }, timezone: "Asia/Jerusalem", bookingEnabled: true,
      hours: [{ day: "ראשון", closed: false, opens: "09:00", closes: "18:00" }],
      services: [{ name: "שיעור יוגה", durationMin: 60, price: 70, description: null }], knowledge: [],
    };
    console.log("  [pure] main menu presents as the business's virtual assistant (business-aware, generic):",
      cm.mainMenuBody(facts).includes("סטודיו פלואו") && /העוזר הווירטואלי/.test(cm.mainMenuBody(facts)) &&
      !/מספרה|תספורת/.test(cm.mainMenuBody(facts))
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] reason wording differs: ai_disabled neutral; provider_outage softly limited:",
      !/מוגבל|עומס/.test(cm.mainMenuBody(facts, "ai_disabled")) && /מוגבל/.test(cm.mainMenuBody(facts, "provider_outage"))
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] NO DEAD END: 'אולי נקבע תור' → deterministic booking (no AI) + a route back to the menu:",
      pt.classifyDegradedIntent("אולי נקבע תור") === "booking" &&
      cm.ctaBody("book").includes("תפריט") && cm.ctaBody("manage").includes("תפריט")
        ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 56: mode boundary — menu must not leak into AI mode (BUG-023) ================");
  // Live bug: after AI was re-enabled, a STALE button payload (m:book) and 'תפריט ראשי' still ran
  // as menu_navigation. Fix: the clickable-menu interceptor is GATED by the current operating mode.
  // In AI mode (AI enabled + provider healthy + configured) the gate is INACTIVE → the stale payload
  // is ignored and the turn flows to AI; menus stay active only when AI genuinely can't operate.
  {
    const pt = await import("../lib/ai/platform-turn");
    const active = (aiEnabled: boolean, geminiConfigured: boolean, providerCoolingDown: boolean) =>
      pt.isDeterministicMenuActive({ aiEnabled, geminiConfigured, providerCoolingDown });
    console.log("  [pure] AI enabled + provider healthy + configured → menu INACTIVE (stale m:book ignored):",
      active(true, true, false) === false ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] AI disabled / no-key / sustained outage → menu ACTIVE (deterministic menus work):",
      active(false, true, false) === true && active(true, false, false) === true && active(true, true, true) === true
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] a single transient 503 (not cooling) stays AI mode (not menu):",
      active(true, true, false) === false ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\n================ SCENARIO 57: post-cancel / post-reschedule WhatsApp confirmations (FEATURE) ================");
  // Additive notification polish: after a successful website cancel/reschedule the customer gets a
  // deterministic WhatsApp summary (no Gemini), mirroring the booking confirmation. Pure builders +
  // dedupe predicate (the live send path lives in platform.ts and reuses sendOutbound, fail-open).
  {
    const n = await import("../lib/booking/notifications");
    const cancel = n.buildCancellationMessage({ serviceName: "שיעור יוגה", dateISO: "2026-06-18", time: "11:15", bookingLink: "https://x/book/flow" });
    const resched = n.buildRescheduleMessage({ serviceName: "פן", fromDateISO: "2026-06-18", fromTime: "11:15", toDateISO: "2026-06-20", toTime: "09:30", manageLink: "https://x/appointment/abc" });
    console.log("  [pure] cancellation summary: confirms cancel + date/time + new-booking link:",
      cancel.includes("בוטל") && cancel.includes("18/06/2026") && cancel.includes("11:15") && cancel.includes("https://x/book/flow")
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] reschedule summary: old → new date/time + manage link, never claims the bot did it:",
      resched.includes("עודכן") && resched.includes("18/06/2026") && resched.includes("20/06/2026") &&
      resched.includes("https://x/appointment/abc") && !/קבעתי|שיניתי/.test(resched)
        ? "PASS ✓" : "FAIL ✗");
    console.log("  [pure] dedupe: a real move notifies; a same-slot resubmit does not (no duplicate spam):",
      n.rescheduleChanged("2026-06-18", "11:15", "2026-06-20", "09:30") === true &&
      n.rescheduleChanged("2026-06-18", "11:15", "2026-06-18", "11:15") === false
        ? "PASS ✓" : "FAIL ✗");
  }

  console.log("\nDONE.");
}

main().catch((e) => { console.error("SIM ERROR:", e?.message ?? e); process.exit(1); });
