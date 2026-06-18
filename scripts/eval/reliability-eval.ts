// scripts/eval/reliability-eval.ts
//
// MINIMAL, DETERMINISTIC reliability eval for the WhatsApp AI receptionist wrapper.
// Protects the CUSTOMER-FACING decisions that must never regress, using only the
// already-pure decision functions — ZERO network, ZERO DB, ZERO Gemini, ZERO cost.
//
// Run:   node --import tsx scripts/eval/reliability-eval.ts
//        npm run eval
//
// Scope (deliberately small): this is a safety net, not a test platform. It asserts
// the DETERMINISTIC fences/routing that the product depends on. Cases that can only be
// judged by the live model (e.g. "a vague booking is nudged, not refused") are NOT
// faked here — they are printed as GAP lines and belong to a separate, tolerant
// live-Gemini probe. Honest gaps beat green-washed assertions.
//
// Exit code: non-zero if any deterministic check FAILS (CI/owner-friendly).

import { resolveRoute, linkKindForRoute, modelOperation, messageOperation } from "../../lib/ai/routing";
import {
  hasBookingSignal, applyBookingEvidenceGate, suppressLinkFor, isExplicitLinkRequest,
  isEmojiOnly, looksLikeNoise, lowSignalActionFor, quietModePlan, countsTowardQuiet,
  defuseSchedulingQuestion, mentionsActionRefusal, defuseActionRefusal,
  FENCE_BRIDGE_BOOK, FENCE_BRIDGE_MANAGE,
  hasFaqSignal, looksLikeContextualReference, lowSignalKind,
  classifyGoodFaithSignal, hasHelpSignal, isGenuineQuestion, isQuestionLike, latestFragment,
  inferOperation, isManageHelpTopic, isBareAffirmation, buildManageHelpReply,
  deriveLastAssistantContract, replyLooksStaleManage,
  hasSoftServiceIntent, mentionsCapabilityPromise, defuseCapabilityPromise,
  looksLikeGreetingOrMeta, collapseElongation,
  looksLikePresenceCheck, looksLikeSocialOpener, isRecoveryFollowup, wasDegradedReply, preGeminiAction,
  readPendingOffer, PENDING_OFFER_TTL_MS,
  hasPoliteInquiry, recentlyDegraded, isAccountabilityChallenge, mentionsRepeatScolding, softenRepeatTone,
  degradedNoticeAllowed, readLastDegradedAt, DEGRADED_NOTICE_MIN_GAP_MS,
  classifyDegradedIntent, continuityText,
  readPendingFailedNeed, PENDING_FAILED_NEED_TTL_MS,
  isDeterministicMenuActive,
} from "../../lib/ai/platform-turn";
import { beginTurn, isCurrentTurn, endTurn, activeTurnCount, resetTurnRegistry } from "../../lib/ai/turn-registry";
import {
  detectInfoTopic, isMenuRequest, isBusinessQuestion, resolveInfoAnswer, findKbAnswer,
  buildMainMenu, buildInfoSubmenu, availableInfoTopics, planContinuityMenu,
  availableMainOptions, resolveMenuNavigation, readMenuState, buildCategoryAnswer, MENU_STATE_TTL_MS,
  resolveMenuPayload, buildInteractiveMainMenu, buildInteractiveFaqMenu, buildInteractiveAnswer, MENU_PAYLOAD,
  mainMenuBody, ctaBody, MENU_HINT,
} from "../../lib/ai/continuity-menu";
import { getGeminiHealth, resetGeminiHealth } from "../../lib/ai/gemini";
import { extractInboundMessage } from "../../lib/whatsapp";
import {
  buildCancellationMessage, buildRescheduleMessage, rescheduleChanged, formatApptDate,
} from "../../lib/booking/notifications";
import { claimsBookingCompleted, sameOutboundText, nearDuplicateText } from "../../lib/ai/reply-polish";
import { verifyGrounding } from "../../lib/ai/grounding";
import { buildBookingLink, buildAppointmentLink } from "../../lib/config";
import { buildMyAppointmentsLink } from "../../lib/booking/appointment-token";
import type { ReceptionistTurn, ReceptionistDecision } from "../../lib/ai/brain";
import type { FactIndex, BusinessFacts } from "../../lib/ai/facts";

// ── tiny harness ────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failed: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
function gap(name: string, note: string): void {
  console.log(`  GAP   ${name}\n        ↳ ${note}`);
}
function section(title: string): void {
  console.log(`\n──────── ${title} ────────`);
}

// Understanding builder (mandatory fields defaulted; rest optional). No `any`.
type U = ReceptionistTurn["understanding"];
const u = (p: Partial<U>): U =>
  ({ requestsBusinessAction: false, intent: "unclear", appointmentIntent: "NONE", ...p });
// Minimal ReceptionistDecision for lowSignalKind() (it reads ok/turn/understanding only).
const dec = (intent: string): ReceptionistDecision =>
  ({ ok: true, geminiCalled: true, turn: { reply: "x", understanding: u({ intent: intent as U["intent"] }) } } as unknown as ReceptionistDecision);

const SERVICES = ["תספורת", "פן ועיצוב", "צביעת שיער"]; // the live test tenant's real services

function main(): void {
  console.log("=== reliability-eval (deterministic, no network/DB/Gemini) ===");

  // ── 1. Routing → correct link family (the core product promise) ────────────────
  section("1. Intent → route → link family");
  check("clear booking → BOOK → booking link",
    resolveRoute(u({ requestsBusinessAction: true, intent: "booking", appointmentIntent: "BOOK" }), "אני רוצה לקבוע תור").route === "BOOK"
    && linkKindForRoute("BOOK") === "booking");
  check("reschedule → RESCHEDULE → manage link",
    resolveRoute(u({ requestsBusinessAction: true, intent: "reschedule_request", appointmentIntent: "RESCHEDULE" }), "אני רוצה לשנות את התור שלי").route === "RESCHEDULE"
    && linkKindForRoute("RESCHEDULE") === "manage");
  check("cancel → CANCEL → manage link",
    resolveRoute(u({ requestsBusinessAction: true, intent: "cancel_request", appointmentIntent: "CANCEL" }), "אפשר לבטל את התור").route === "CANCEL"
    && linkKindForRoute("CANCEL") === "manage");
  check("list → LIST → manage link",
    resolveRoute(u({ requestsBusinessAction: true, intent: "booking", appointmentIntent: "LIST" }), "אפשר לראות את כל התורים שלי?").route === "LIST"
    && linkKindForRoute("LIST") === "manage");
  check("FAQ → NONE → no link",
    resolveRoute(u({ requestsBusinessAction: false, intent: "faq" }), "כמה עולה תספורת?").route === "NONE"
    && linkKindForRoute("NONE") === null);
  check("smalltalk → NONE → no link",
    resolveRoute(u({ requestsBusinessAction: false, intent: "smalltalk" }), "מה שלומך?").route === "NONE");

  // ── 2. Model self-contradiction & message-verb override ────────────────────────
  section("2. Model self-contradiction corrected by routing");
  check("user's verb overrides a wrong model label (appt=LIST but says 'לקבוע') → BOOK",
    resolveRoute(u({ requestsBusinessAction: true, intent: "unclear", appointmentIntent: "LIST" }), "אפשר לקבוע פן?").route === "BOOK");
  check("model fine field wins over coarse (intent=booking+appt=LIST → LIST)",
    modelOperation(u({ requestsBusinessAction: true, intent: "booking", appointmentIntent: "LIST" })) === "LIST");
  check("route depends ONLY on (understanding, message) — existing appts can't distort it",
    resolveRoute(u({ requestsBusinessAction: true, intent: "unclear", appointmentIntent: "LIST" }), "אפשר לקבוע פן?").route
    === resolveRoute(u({ requestsBusinessAction: true, intent: "unclear", appointmentIntent: "BOOK" }), "אפשר לקבוע פן?").route);

  // ── 3. Link control: complaints / bare-meta never get a link ───────────────────
  section("3. Link suppression (no link-spam loops)");
  check("complaint about links → suppressed", suppressLinkFor("תפסיק לשלוח קישורים") === true);
  check("bare meta question → suppressed", suppressLinkFor("מה?") === true);
  check("punctuation-only → suppressed", suppressLinkFor("?") === true);
  check("real booking phrase → NOT suppressed", suppressLinkFor("אני רוצה לקבוע תור") === false);
  check("explicit link request → NOT suppressed (gets exactly one)",
    isExplicitLinkRequest("תשלח לי את הקישור") === true && suppressLinkFor("תשלח לי את הקישור") === false);

  // ── 4. Booking-signal + evidence gate (no hallucinated BOOK) ───────────────────
  section("4. Booking signal + evidence gate");
  check("verb/service signal present", hasBookingSignal("אני רוצה לקבוע תור", []) === true);
  check("unrelated message has no signal", hasBookingSignal("אני טס לחו״ל עוד שבועיים", []) === false);
  check("configured service name is a signal", hasBookingSignal("אני רוצה מניקור", ["מניקור"]) === true);
  check("removed salon term is NOT a built-in generic", hasBookingSignal("אני רוצה מניקור", []) === false);
  {
    const uu = u({ requestsBusinessAction: true, intent: "booking", appointmentIntent: "BOOK" });
    const ev = applyBookingEvidenceGate(uu, "חכלגצג", SERVICES); // gibberish, no signal
    check("hallucinated BOOK on gibberish is downgraded in place",
      ev.evidence === false && uu.appointmentIntent === "NONE" && uu.requestsBusinessAction === false,
      `evidence=${ev.evidence} appt=${uu.appointmentIntent}`);
  }
  {
    const uu = u({ requestsBusinessAction: true, intent: "booking", appointmentIntent: "BOOK" });
    const ev = applyBookingEvidenceGate(uu, "אני רוצה לקבוע תור", SERVICES);
    check("real booking keeps its operation through the evidence gate",
      ev.evidence === true && uu.appointmentIntent === "BOOK");
  }

  // ── 5. No false completed-action claim ─────────────────────────────────────────
  section("5. Booked-claim fence (AI never claims a write that didn't happen)");
  check("'התור נקבע בהצלחה' is caught", claimsBookingCompleted("מעולה! התור נקבע בהצלחה 🎉") === true);
  check("'קבעתי לך תור' is caught", claimsBookingCompleted("קבעתי לך תור מחר") === true);
  check("safe recap is NOT a false claim", claimsBookingCompleted("מה שכבר רשום אצלי: תספורת ביום חמישי") === false);
  check("offer to help is NOT a false claim", claimsBookingCompleted("אשמח לעזור לך לקבוע תור") === false);

  // ── 6. No in-chat scheduling Q&A in platform mode ──────────────────────────────
  section("6. Scheduling-question fence (booking happens on the page)");
  check("'איזה יום נוח לך?' is defused", defuseSchedulingQuestion("איזה יום נוח לך?").defused === true);
  check("'מתי נוח לך להגיע?' is defused", defuseSchedulingQuestion("מתי נוח לך להגיע?").defused === true);
  check("defused text drops the question mark", !defuseSchedulingQuestion("איזה שעה מתאימה לך?").text.includes("?"));
  check("a normal warm line is left untouched",
    defuseSchedulingQuestion("בשמחה! אני כאן לכל שאלה.").defused === false);
  check("soft preference-collection ('יש לך העדפה') is defused",
    defuseSchedulingQuestion("יש לך העדפה לגבי יום או שעה מסוימים?").defused === true);
  check("the live booking reply's preference question is stripped",
    (() => {
      const r = defuseSchedulingQuestion("אני כאן כדי לעזור לך לקבוע תור. יש לך העדפה לגבי יום או שעה מסוימים, או אולי שירות ספציפי שאתה מחפש?");
      return r.defused && !r.text.includes("העדפה") && !r.text.includes("?");
    })());

  // ── 6b. Action-refusal fence (Phase 5: no false "can't book/reschedule/cancel") ─
  section("6b. Action-refusal fence (platform never falsely refuses an operation)");
  check("refusal to cancel in chat is detected", mentionsActionRefusal("אי אפשר לבטל את התור בצ'אט") === true);
  check("refusal to reschedule is detected", mentionsActionRefusal("לא ניתן לשנות תור כאן") === true);
  check("refusal to book is detected", mentionsActionRefusal("אני לא יכולה לקבוע לך תור") === true);
  check("honest 'no appointment' is NOT a refusal", mentionsActionRefusal("אין לך תור פעיל כרגע") === false);
  check("offering to help (no negation) is NOT a refusal", mentionsActionRefusal("אשמח לעזור לך לבטל את התור בקישור") === false);
  check("a genuine non-operation capability limit is NOT caught", mentionsActionRefusal("אני לא יכולה לראות את ההיסטוריה שלך") === false);
  check("cancel-refusal → manage bridge",
    defuseActionRefusal("אי אפשר לבטל פה", "CANCEL").defused === true
    && defuseActionRefusal("אי אפשר לבטל פה", "CANCEL").text === `בטח! ${FENCE_BRIDGE_MANAGE}`);
  check("book-refusal → booking bridge",
    defuseActionRefusal("לא ניתן לקבוע פה", "BOOK").text === `בטח! ${FENCE_BRIDGE_BOOK}`);
  check("a good reply is left untouched by the refusal fence",
    defuseActionRefusal("בשמחה! הנה הקישור לניהול התור.", "CANCEL").defused === false);

  // ── 7. Link safety: no localhost when PUBLIC_BASE_URL is set ────────────────────
  section("7. Link safety (public URLs, never localhost)");
  {
    process.env.PUBLIC_BASE_URL = "https://book.example.com";
    const links = [
      buildBookingLink("test-business", "972500000000"),
      buildAppointmentLink("00000000-0000-0000-0000-000000000001"),
      buildMyAppointmentsLink("00000000-0000-0000-0000-000000000002"),
    ];
    check("no customer link contains 'localhost' when PUBLIC_BASE_URL is set",
      links.every((l) => !l.includes("localhost")), links.join("  "));
    check("all customer links use the configured public origin",
      links.every((l) => l.startsWith("https://book.example.com")));
    delete process.env.PUBLIC_BASE_URL;
    // Informational: this is the M0A P0 risk made concrete (not a FAIL — it's expected).
    const fallback = buildBookingLink("test-business");
    if (fallback.includes("localhost")) {
      gap("PUBLIC_BASE_URL unset → links fall back to localhost",
        `e.g. ${fallback} — confirm PUBLIC_BASE_URL is set in the live env (M0A owner checklist).`);
    }
  }

  // ── 8. Emoji / noise / duplicates (no loops, no double replies) ────────────────
  section("8. Emoji / noise / duplicate handling");
  check("emoji-only is detected", isEmojiOnly("😊😊") === true && isEmojiOnly("🙏🏻") === true);
  check("text+emoji is NOT emoji-only", isEmojiOnly("תודה 😊") === false);
  check("keyboard-smash is noise", looksLikeNoise("חכלגצג", []) === true);
  check("a real word is not noise", looksLikeNoise("מחר", []) === false);
  check("duplicate reply guard is emoji/space-insensitive", sameOutboundText("היי 🙂", "היי") === true);
  check("near-duplicate (containment) is caught",
    nearDuplicateText("כן, מה שכבר רשום אצלי: תספורת ביום חמישי", "מה שכבר רשום אצלי: תספורת ביום חמישי") === true);

  // ── 9. Quiet-mode escalation does not spam ─────────────────────────────────────
  section("9. Low-signal escalation tiers (bounded cost, no spam loop)");
  check("tier ladder: 1→clarify 2→short 3→boundary 4→quiet",
    lowSignalActionFor(1) === "normal_clarify" && lowSignalActionFor(2) === "short_clarify"
    && lowSignalActionFor(3) === "boundary" && lowSignalActionFor(4) === "quiet_mode");
  check("quiet mode mostly suppresses (no repeated identical line)",
    quietModePlan(2).isQuiet === false && quietModePlan(4).isQuiet === true && quietModePlan(4).suppressReply === true
    && quietModePlan(7).suppressReply === false); // a sparse reminder every Nth turn

  // ── 9b. Good-faith signal is PRODUCTIVE, not low-signal (price + contextual ref) ─
  section("9b. Good-faith signal exemptions (price FAQ + contextual reference)");
  check("price questions carry an FAQ signal",
    hasFaqSignal("כמה זה עולה") && hasFaqSignal("מה המחיר") && hasFaqSignal("כמה עולה הפן") && hasFaqSignal("מה העלות"));
  check("a booking phrase is NOT a price-FAQ signal", hasFaqSignal("אני רוצה לקבוע תור") === false);
  check("ordinal follow-ups are contextual references (incl. typo 'הראשו7')",
    looksLikeContextualReference("הראשון") && looksLikeContextualReference("הראשו7")
    && looksLikeContextualReference("הראשון מבניהם כאילו") && looksLikeContextualReference("השני"));
  check("'יום שני' (Monday) is NOT a contextual reference", looksLikeContextualReference("יום שני") === false);
  check("a long ramble is NOT a contextual reference",
    looksLikeContextualReference("אני רוצה לקבוע תור מחר בערב אחרי העבודה שלי") === false);
  check("price question labeled 'unclear' → productive (Failure 1)",
    lowSignalKind(dec("unclear"), "כמה זה עולה", SERVICES) === "productive");
  check("ordinal follow-up labeled 'unclear' → productive (Failure 2)",
    lowSignalKind(dec("unclear"), "הראשון מבניהם כאילו", SERVICES) === "productive");
  check("genuine gibberish is still gibberish (no regression)",
    lowSignalKind(dec("unclear"), "חכלגצג", SERVICES) === "gibberish");
  check("a contentless 'unclear' is still unclear (no over-rescue)",
    lowSignalKind(dec("unclear"), "אהה אולי לא יודע", SERVICES) === "unclear");
  check("productive never counts toward quiet", countsTowardQuiet("productive") === false);

  // ── 9c. Customer Safety Contract v1 — good-faith classifier (latest message wins) ─
  section("9c. Customer Safety Contract v1 (good-faith escapes before suppression)");
  // Category classification (contract priority: action > help > presence > faq > ref)
  check("booking imperative → action ('אוקיי בוא נקבע')", classifyGoodFaithSignal("אוקיי בוא נקבע") === "action");
  check("'אני רוצה לבטל' → action", classifyGoodFaithSignal("אני רוצה לבטל") === "action");
  check("help request → help ('אני צריך עזרה כן')", classifyGoodFaithSignal("אני צריך עזרה כן") === "help");
  check("'איך אני מבטל' → help", classifyGoodFaithSignal("איך אני מבטל") === "help");
  check("conversation repair → help ('אמרת שתוכל לעזור...')", classifyGoodFaithSignal("אמרת שתוכל לעזור לי עם איך מבטלים תור") === "help");
  check("link trouble → help ('לא נפתח לי')", classifyGoodFaithSignal("לא נפתח לי") === "help");
  check("presence check → presence ('אתה פה?')", classifyGoodFaithSignal("אתה פה?") === "presence");
  check("business FAQ → faq ('אפשר לעשן במספרה?')", classifyGoodFaithSignal("אפשר לעשן במספרה?") === "faq");
  check("price → faq ('כמה זה עולה')", classifyGoodFaithSignal("כמה זה עולה") === "faq");
  check("ordinal → contextual_ref ('הראשון מבניהם')", classifyGoodFaithSignal("הראשון מבניהם") === "contextual_ref");
  check("gibberish → none ('במבח')", classifyGoodFaithSignal("במבח") === "none");
  // A QUESTION about an operation must NOT be 'action' (so no forced link)
  check("'כמה עולה לבטל?' is NOT an action (it's a question)", classifyGoodFaithSignal("כמה עולה לבטל?") !== "action");
  check("isGenuineQuestion('אפשר לעשן במספרה?') and NOT a bare meta",
    isGenuineQuestion("אפשר לעשן במספרה?") === true && isQuestionLike("אפשר לעשן במספרה?") === true);
  check("hasHelpSignal catches help + repair, not a plain booking",
    hasHelpSignal("אני צריך עזרה") && hasHelpSignal("אמרת שתעזור") && hasHelpSignal("אני רוצה לקבוע תור") === false);
  // Latest fragment wins inside an aggregated burst
  check("latestFragment picks the last line of a burst",
    latestFragment("במבח\nכחגל\nאוקיי בוא נקבע") === "אוקיי בוא נקבע");
  check("burst latest action wins → productive (Failure B: no silent blackhole)",
    lowSignalKind(dec("unclear"), "במבח\nכחגל\nאוקיי בוא נקבע", SERVICES) === "productive");
  check("help follow-up → productive (Failures D/E: not boundary)",
    lowSignalKind(dec("unclear"), "אני צריך עזרה כן", SERVICES) === "productive"
    && lowSignalKind(dec("unclear"), "אמרת שתוכל לעזור לי עם איך מבטלים תור", SERVICES) === "productive");
  check("business FAQ escapes quiet → productive (Failure F)",
    lowSignalKind(dec("unclear"), "אפשר לעשן במספרה?", SERVICES) === "productive");
  check("pure gibberish still → gibberish on the latest fragment (no regression, Failure A)",
    lowSignalKind(dec("unclear"), "במבח", SERVICES) === "gibberish");
  check("action-escape precondition holds for a missed imperative",
    classifyGoodFaithSignal("אוקיי בוא נקבע") === "action" && suppressLinkFor("אוקיי בוא נקבע") === false);

  // ── 9d. Contract v1 — manage/help trajectory + truth-safe guidance + stale-topic ──
  section("9d. Contract v1 — manage/help trajectory, broad FAQ, truth-safe text");
  check("inferOperation: cancel-help / reschedule-help / book / none",
    inferOperation("איך אני מבטל") === "CANCEL" && inferOperation("אני רוצה לבטל") === "CANCEL"
    && inferOperation("איך מזיזים") === "RESCHEDULE" && inferOperation("אוקיי בוא נקבע") === "BOOK"
    && inferOperation("כמה עולה תספורת?") === null);
  check("frustration/repair are help signals (item 7)",
    hasHelpSignal("אמרת שתוכל לעזור") && hasHelpSignal("אתה לא מבין אותי")
    && hasHelpSignal("למה אתה לא עונה?") && hasHelpSignal("אני לא מצליח") && hasHelpSignal("הקישור לא עובד"));
  check("broad business FAQ recognized (item 6, beyond price/smoking)",
    classifyGoodFaithSignal("אפשר לשלם במספרה?") === "faq" && classifyGoodFaithSignal("מקבלים ביט?") === "faq"
    && classifyGoodFaithSignal("יש חניה?") === "faq" && classifyGoodFaithSignal("מה הכתובת?") === "faq"
    && classifyGoodFaithSignal("אתם פתוחים היום?") === "faq" && classifyGoodFaithSignal("מה כולל השירות?") === "faq");
  check("broad FAQ → productive, never low-signal/quiet (item 5)",
    lowSignalKind(dec("unclear"), "אפשר לשלם במספרה?", SERVICES) === "productive"
    && lowSignalKind(dec("unclear"), "מקבלים ביט?", SERVICES) === "productive"
    && lowSignalKind(dec("unclear"), "יש חניה?", SERVICES) === "productive");
  check("help/repair → productive, never boundary/quiet (items 1/2/3/8)",
    lowSignalKind(dec("unclear"), "איך אני מבטל", SERVICES) === "productive"
    && lowSignalKind(dec("unclear"), "אמרת שתוכל לעזור לי עם איך מבטלים תור", SERVICES) === "productive"
    && lowSignalKind(dec("unclear"), "הקישור לא עובד", SERVICES) === "productive");
  check("TRUTH-SAFE manage text: single-appointment cancel matches the real UI buttons",
    (() => { const r = buildManageHelpReply(1, "CANCEL"); return r.includes("ביטול התור") && r.includes("בעמוד") && !/בוטל|ביטלתי/.test(r); })());
  check("TRUTH-SAFE manage text: 2+ appointments says pick from the list",
    (() => { const r = buildManageHelpReply(3, "CANCEL"); return r.includes("מהרשימה") && r.includes("ביטול התור") && !/בוטל|ביטלתי/.test(r); })());
  check("TRUTH-SAFE manage text: 0 appointments → honest 'no active appointment', no manage claim",
    (() => { const r = buildManageHelpReply(0, "CANCEL"); return r.includes("לא רואה תור פעיל") && !/ביטול התור/.test(r); })());
  check("last-assistant contract: detects a sent manage link + help offer",
    (() => {
      const t = "Customer: היי\nAssistant (you, earlier): בטח, אם תצטרך עזרה רק תגיד. https://x.test/appointments/abc";
      const c = deriveLastAssistantContract(t);
      return c.sentManageLink === true && c.offeredHelp === true;
    })());
  check("isBareAffirmation: 'כן' yes, a real request no (item 10)",
    isBareAffirmation("כן") && isBareAffirmation("כן בבקשה") && isBareAffirmation("אני רוצה לבטל") === false);
  check("stale-topic guard condition (item 4): latest≠manage AND reply is stale-manage",
    isManageHelpTopic("אפשר לעשן במספרה?") === false
    && replyLooksStaleManage("לגבי הביטול, אתה יכול להיכנס לקישור ששלחתי") === true
    && replyLooksStaleManage("יש חניה חינם מאחורי הבניין") === false);

  // ── 9e. Contract v1 — SOFT INTENT, CONTEXTUAL YES, CAPABILITY FENCE ────────────
  section("9e. Soft service intent / contextual yes / capability-promise fence");
  // Soft service intent: indirect "considering a service / coming in" with NO booking
  // verb and NO literal service-name match — must be recognized GENERALLY, cross-business.
  check("soft intent: haircut-before-flight (the live incident, no booking verb/service name)",
    hasSoftServiceIntent("חשבתי על להסתפר, יש לי טיסה ליוון עוד שבוע", SERVICES) === true);
  check("soft intent generalizes across businesses (Pilates / facial / event)",
    hasSoftServiceIntent("חשבתי לבוא לפילאטיס השבוע", SERVICES) === true
    && hasSoftServiceIntent("בא לי לעשות טיפול פנים לפני האירוע", SERVICES) === true
    && hasSoftServiceIntent("אני צריך לסדר את השיער לפני החתונה", SERVICES) === true);
  check("soft intent requires desire AND context — a bare opinion is NOT soft intent",
    hasSoftServiceIntent("חשבתי שאתם יקרים מדי", SERVICES) === false
    && hasSoftServiceIntent("מה המצב", SERVICES) === false
    && hasSoftServiceIntent("חשבתי לבדוק מחירים", SERVICES) === false);
  check("a 'pain → book treatment' message is covered by the booking-signal path (generic 'טיפול')",
    hasBookingSignal("כואב לי הגב, אולי אקבע טיפול", []) === true);
  check("classifyGoodFaithSignal: soft intent ranks ABOVE faq even with a trailing '?'",
    classifyGoodFaithSignal("חשבתי על להסתפר, יש לי טיסה ליוון, מה כדאי?", { serviceNames: SERVICES }) === "soft_intent"
    && classifyGoodFaithSignal("חשבתי לבוא לפילאטיס השבוע", { serviceNames: SERVICES }) === "soft_intent");
  check("soft intent → productive (never low-signal/quiet)",
    lowSignalKind(dec("unclear"), "חשבתי על להסתפר, יש לי טיסה ליוון", SERVICES, "soft_intent") === "productive");

  // Contextual "כן" — the live contradiction: latestSignal=contextual_ref but the
  // low-signal counter independently said unclear → escalated to "לא הצלחתי להבין".
  check("UNIFIED signal: a contextual 'כן' (resolved upstream) is productive, NOT low-signal",
    lowSignalKind(dec("unclear"), "כן", SERVICES, "contextual_ref") === "productive"
    && lowSignalKind(dec("unclear"), "כן", SERVICES, "help") === "productive");
  check("[regression doc] without the resolved signal, a bare 'כן' re-derives to unclear (the OLD bug)",
    lowSignalKind(dec("unclear"), "כן", SERVICES) === "unclear");
  check("isBareAffirmation: 'כן'/'אוקיי'/'בטח' yes; a real request no",
    isBareAffirmation("כן") && isBareAffirmation("אוקיי") && isBareAffirmation("בטח")
    && isBareAffirmation("אני רוצה לבטל") === false);
  check("last-assistant contract detects a BOOKING offer (drives contextual-confirm → booking link)",
    deriveLastAssistantContract("Customer: ...\nAssistant (you, earlier): רוצה שאבדוק לך זמינות לימים הקרובים?").offeredBooking === true);
  check("bare 'כן' with NO booking context → no offeredBooking → no forced action",
    deriveLastAssistantContract("Customer: ...\nAssistant (you, earlier): איזה כיף לשמוע, אמיר!").offeredBooking === false);

  // Capability-promise fence: an unsupported in-chat booking/availability promise.
  check("capability promise detected: 'אבדוק לך זמינות' / 'רק כדי לוודא, אתה רוצה תור?'",
    mentionsCapabilityPromise("אין בעיה! אני אבדוק לך זמינות לימים הקרובים") === true
    && mentionsCapabilityPromise("רק כדי לוודא, אתה רוצה תור למחר?") === true
    && mentionsCapabilityPromise("אני יכול לקבוע לך תור") === true);
  check("a clean link-first reply is NOT a capability promise (untouched)",
    mentionsCapabilityPromise("בשמחה! אפשר לקבוע דרך הקישור כאן.") === false);
  check("defuseCapabilityPromise keeps warmth, drops the promise, bridges to the link",
    (() => {
      const r = defuseCapabilityPromise("הבנתי אותך לגמרי, חשוב שהשיער ייראה טוב. אני אבדוק לך זמינות.");
      return r.defused && r.text.includes("הבנתי") && !r.text.includes("זמינות") && r.text.includes(FENCE_BRIDGE_BOOK);
    })());
  check("defuseCapabilityPromise leaves a good reply untouched",
    defuseCapabilityPromise("בשמחה! אפשר לשאול אותי כל דבר על העסק.").defused === false);

  // FAQ / smalltalk / soft-intent separation (item 5 + the 'מה המצבבב' contamination).
  check("collapseElongation normalizes WhatsApp stretching",
    collapseElongation("מה המצבבב") === "מה המצב" && collapseElongation("נשמעעע") === "נשמע");
  check("smalltalk opener (even elongated) is presence, NOT faq",
    classifyGoodFaithSignal("מה המצבבב") === "presence" && classifyGoodFaithSignal("מה נשמע") === "presence"
    && looksLikeGreetingOrMeta("מה המצבבב") === true && isGenuineQuestion("מה המצבבב") === false);
  check("a real business FAQ is still faq",
    classifyGoodFaithSignal("מה השעות שלכם?", { serviceNames: SERVICES }) === "faq"
    && classifyGoodFaithSignal("מה המחיר?", { serviceNames: SERVICES }) === "faq");

  // ── 9f. Contract v1 — DEGRADED MODE + SOCIAL OPENING contract ──────────────────
  section("9f. Social opener vs presence / recovery follow-up / degraded routing");
  // A. Normal social opener is distinct from a presence/recovery check.
  check("social opener vs presence: 'היי מה קורה' is social, not a presence probe",
    looksLikeSocialOpener("היי מה קורה") === true && looksLikePresenceCheck("היי מה קורה") === false);
  check("presence/recovery checks recognized ('אתה פה?', 'למה לא ענית?', 'הלו?')",
    looksLikePresenceCheck("אתה פה?") && looksLikePresenceCheck("למה לא ענית?") && looksLikePresenceCheck("הלו?"));
  check("a normal social opener does NOT trigger stiff recovery on mere residual low-signal (the live bug)",
    preGeminiAction(2, 0, "היייי מה קורה", SERVICES) === "proceed_to_gemini"
    && preGeminiAction(0, 0, "היי מה קורה", SERVICES) === "proceed_to_gemini");
  check("a presence check DOES use deterministic recovery when there is recovery context",
    preGeminiAction(2, 0, "אתה פה?", SERVICES) === "cheap_reset_reply");
  check("a social opener still short-circuits on a greeting LOOP or active quiet mode (cost cap kept)",
    preGeminiAction(0, 2, "מה קורה", SERVICES) === "cheap_reset_reply"
    && preGeminiAction(3, 0, "מה קורה", SERVICES) === "cheap_reset_reply");

  // B. Degraded fallback ROUTING decision (booking→link, manage→link, else general) — the
  //    building blocks; the full platform-safe reply is validated in sim/manual.
  check("degraded routing: booking-like → booking path, manage-like → manage path, else general",
    hasBookingSignal("אני רוצה לקבוע תור", []) === true            // → booking link
    && inferOperation("איך אני מבטל") === "CANCEL"                 // → manage link
    && hasBookingSignal("כמו מה", []) === false && inferOperation("כמו מה") === null
       && isManageHelpTopic("כמו מה") === false);                 // → safe general (no service/day/time)

  // C. Post-fallback recovery follow-up.
  check("wasDegradedReply detects an overload/error notice, not a normal reply",
    wasDegradedReply("יש לי רגע עומס קטן במערכת 🙏 נסו שוב עוד רגע") === true
    && wasDegradedReply("איזה כיף לשמוע, אמיר!") === false);
  check("isRecoveryFollowup catches 'did it recover?' (incl. 'הסתדר ?' with a space), not 'how are you?'",
    isRecoveryFollowup("הסתדר?") && isRecoveryFollowup("הסתדר ?") && isRecoveryFollowup("עובד עכשיו?")
    && isRecoveryFollowup("עדיין יש עומס?") && isRecoveryFollowup("מה שלומך?") === false);

  // D. Social-drift counter hygiene: content-ful smalltalk must NOT count as a greeting.
  check("greeting-loop counter advances on bare openers only, not content-ful smalltalk",
    looksLikeGreetingOrMeta("מה קורה") === true
    && looksLikeGreetingOrMeta("קיבלתי ציון טוב במתמטיקה היום") === false);

  // ── 9g. Contract v1 — SHORT-TERM PENDING CONTEXT + platform-safe offer wording ──
  section("9g. Pending offer / delayed-cold yes / platform-safe offer wording");
  const NOW = 1_000_000_000_000;
  // Pending offer is read only while within TTL; missing/expired → no pending context.
  check("readPendingOffer: valid within TTL is returned (generic service preserved)",
    (() => {
      const p = readPendingOffer({ pendingOffer: { kind: "BOOK", service: "שיעור פילאטיס", at: NOW } }, NOW + 60_000);
      return p?.kind === "BOOK" && p?.service === "שיעור פילאטיס";
    })());
  check("readPendingOffer: expired offer → null (no stale routing)",
    readPendingOffer({ pendingOffer: { kind: "BOOK", at: NOW } }, NOW + PENDING_OFFER_TTL_MS + 1) === null);
  check("readPendingOffer: no pending context → null (cold)",
    readPendingOffer({}, NOW) === null && readPendingOffer({ pendingOffer: { kind: "x", at: NOW } }, NOW) === null);

  // Delayed YES resolves against a still-valid pending offer; cold YES does not.
  check("delayed 'כן'/'סבבה'/'תשלח' + valid pending BOOK → resolvable booking confirmation",
    isBareAffirmation("כן") && isBareAffirmation("סבבה") && isBareAffirmation("תשלח") && isBareAffirmation("יאללה")
    && readPendingOffer({ pendingOffer: { kind: "BOOK", at: NOW } }, NOW + 5 * 60_000)?.kind === "BOOK");
  check("cold 'כן' (no pending, no last-contract offer) → no booking route",
    isBareAffirmation("כן") && readPendingOffer({}, NOW) === null
    && deriveLastAssistantContract("Assistant (you, earlier): איזה כיף לשמוע!").offeredBooking === false);
  check("a real request is NOT a bare affirmation (no accidental resolve)",
    isBareAffirmation("אני רוצה לבטל") === false && isBareAffirmation("כמה עולה?") === false);

  // Platform-safe offer wording: "נתאם/נקבע לך" implies in-chat scheduling → recognized as a
  // booking OFFER (drives pending context) AND fenced to link-first wording (keeps warmth).
  check("the 'schedule for you' offer class is recognized as a booking offer (pending trigger)",
    deriveLastAssistantContract("Assistant (you, earlier): רוצה שנתאם לך תור לפן?").offeredBooking === true
    && deriveLastAssistantContract("Assistant (you, earlier): נקבע לך תור?").offeredBooking === true);
  check("'רוצה שנתאם לך תור?' is a capability promise → fenced to link-first, warmth kept",
    (() => {
      const r = defuseCapabilityPromise("על פן ועיצוב אנחנו לוקחים 120 שקלים. רוצה שנתאם לך תור לזה?");
      return mentionsCapabilityPromise("רוצה שנתאם לך תור?") && r.defused
        && r.text.includes("120") && !r.text.includes("נתאם") && r.text.includes(FENCE_BRIDGE_BOOK);
    })());
  check("a platform-safe offer ('רוצה לקבוע דרך הקישור?') is NOT flagged as a capability promise",
    mentionsCapabilityPromise("בשמחה! רוצה לקבוע לזה תור דרך הקישור?") === false);

  // ── 9h. Contract v1 — degraded repair, meta context, false-action guard ────────
  section("9h. False-action guard / polite FAQ / repeat tone / recovery+accountability");

  // A. FALSE ACTION/LIST GUARD — a generic view-verb routes to LIST only WITH an appointment ref.
  check("bare discourse 'תראה'/'הנה תראה' does NOT route to LIST",
    messageOperation("הנה תראה") === null && messageOperation("תראה") === null
    && classifyGoodFaithSignal("הנה תראה") !== "action");
  check("real LIST/manage flows still route",
    messageOperation("תראה לי את התורים שלי") === "LIST"
    && messageOperation("אני רוצה לראות את התור שלי") === "LIST"
    && messageOperation("אני רוצה לבטל") === "CANCEL" && messageOperation("אני רוצה להזיז") === "RESCHEDULE"
    && messageOperation("אפשר לקבוע תור") === "BOOK");
  check("generic discourse imperatives are not actions ('תקשיב'/'רגע'/'נו')",
    classifyGoodFaithSignal("תקשיב") !== "action" && classifyGoodFaithSignal("רגע") !== "action"
    && classifyGoodFaithSignal("נו") !== "action");

  // B. POLITE / FRAGMENTED FAQ — recognized as productive even split across messages.
  check("polite inquiry opener → faq ('אשמח לדעת אם יש איפה לשבת')",
    hasPoliteInquiry("אשמח לדעת") && classifyGoodFaithSignal("אשמח לדעת אם יש איפה לשבת") === "faq"
    && classifyGoodFaithSignal("רציתי לשאול אם אפשר לשלם בביט") === "faq");
  check("split polite FAQ aggregate is productive even when the LAST fragment alone is incomplete",
    lowSignalKind(dec("unclear"), "אשמח לדעת\nאם יש איפה לשבת", SERVICES) === "productive");

  // C. REPEAT-ANSWER TONE GUARD — no scolding; answer + vocative kept.
  check("scolding lead-in detected and softened (answer + name kept, 'אמרתי לך' gone)",
    mentionsRepeatScolding("קובי, כבר אמרתי לך שיש לנו שלוש ספות") &&
    (() => { const r = softenRepeatTone("קובי, כבר אמרתי לך שיש לנו שלוש ספות");
             return r.softened && r.text.includes("קובי") && r.text.includes("שלוש ספות")
               && !/אמרתי\s+לך/.test(r.text); })());
  check("a polite answer is left untouched by the tone guard",
    softenRepeatTone("בטח, יש לנו שלוש ספות נוחות 🙂").softened === false);

  // D. DEGRADED RECOVERY broadened + recentlyDegraded scans recent lines.
  check("recentlyDegraded scans recent assistant lines (robust to a following turn)",
    recentlyDegraded("Assistant (you, earlier): יש לי רגע עומס קטן במערכת 🙏\nCustomer: ?\nAssistant (you, earlier): אני כאן 🙂") === true
    && recentlyDegraded("Assistant (you, earlier): בטח, יש חניה מאחור.") === false);
  check("recovery class broadened ('זמין?'/'אתה זמין?'/'אפשר עכשיו?'/'אפשר להמשיך?')",
    isRecoveryFollowup("זמין?") && isRecoveryFollowup("אתה זמין?") && isRecoveryFollowup("אפשר עכשיו?")
    && isRecoveryFollowup("אפשר להמשיך?") && isRecoveryFollowup("מה שלומך?") === false);

  // E. ACCOUNTABILITY repair — user references our prior overload message.
  check("accountability challenge recognized ('שאלתי לגבי הזמינות שלך'/'כי כתבת שיש עומס'/'הנה תראה')",
    isAccountabilityChallenge("שאלתי לגבי הזמינות שלך") && isAccountabilityChallenge("כי כתבת שיש עומס")
    && isAccountabilityChallenge("הנה תראה") && isAccountabilityChallenge("כמה עולה תספורת?") === false);

  // ── 9i. Architecture — degraded rate-limit, inquiry priority, cooldown ordering ─
  section("9i. Degraded rate-limit / inquiry priority / cooldown ordering / supersede isolation");
  const T0 = 1_700_000_000_000;
  // A. Degraded-notice rate limit: one notice per window, then quiet (no overload spam).
  check("degraded notice allowed when none sent; suppressed within the window; allowed again after",
    degradedNoticeAllowed({}, T0) === true
    && degradedNoticeAllowed({ lastDegradedAt: T0 }, T0 + 1000) === false
    && degradedNoticeAllowed({ lastDegradedAt: T0 }, T0 + DEGRADED_NOTICE_MIN_GAP_MS + 1) === true);
  check("readLastDegradedAt round-trips / defaults to 0",
    readLastDegradedAt({ lastDegradedAt: T0 }) === T0 && readLastDegradedAt({}) === 0);

  // B. Inquiry opener outranks greeting/smalltalk ("היי אשמח לדעת" is NOT a social hello).
  check("'היי אשמח לדעת' is an inquiry (faq), not greeting/social",
    looksLikeGreetingOrMeta("היי אשמח לדעת") === false
    && looksLikeSocialOpener("היי אשמח לדעת") === false
    && classifyGoodFaithSignal("היי אשמח לדעת") === "faq");
  check("a plain social hello is still social ('היי מה קורה')",
    looksLikeSocialOpener("היי מה קורה") === true && classifyGoodFaithSignal("היי מה קורה") === "presence");

  // C. Cooldown ORDERING: a meta/system message that also contains "זמינות" must be handled as
  //    accountability/recovery BEFORE the booking branch — so it never grabs a booking link.
  check("meta 'זמינות' is accountability/recovery, and ALSO matches the booking signal — order matters",
    isAccountabilityChallenge("שאלתי לגבי הזמינות שלך") === true
    && hasBookingSignal("שאלתי לגבי הזמינות שלך", []) === true   // both true ⇒ accountability MUST be checked first
    && isRecoveryFollowup("אתה זמין?") === true);

  // D. Integration-level guarantees (cannot be fully unit-asserted here):
  gap("supersede-abort + cooldown-ordering are integration paths",
    "The Gemini supersede-abort (no retry / no cooldown strike for an obsolete turn) lives on the network failure path in gemini.ts, and the cooldown decision ordering lives inside runPlatformTurn (needs DB + active cooldown). Both are covered by build/typecheck + the predicate checks above; a live probe is the only full assertion. Strongest feasible deterministic coverage added.");

  // ── 9j. Per-conversation single-flight turn registry (turn ownership) ──────────
  section("9j. Single-flight turn registry — one authoritative turn per conversation");
  resetTurnRegistry();
  check("a fresh turn is current and not aborted",
    (() => { const t = beginTurn("biz", "cust"); return isCurrentTurn(t) && t.signal.aborted === false; })());
  check("a newer turn SUPERSEDES the older: older aborted + no longer current, newer current",
    (() => {
      resetTurnRegistry();
      const a = beginTurn("biz", "cust");
      const b = beginTurn("biz", "cust");   // same conversation → supersedes a
      return a.signal.aborted === true && isCurrentTurn(a) === false
        && b.signal.aborted === false && isCurrentTurn(b) === true;
    })());
  check("different conversations are independent (no cross-abort)",
    (() => {
      resetTurnRegistry();
      const a = beginTurn("biz", "cust1");
      const b = beginTurn("biz", "cust2");
      return a.signal.aborted === false && b.signal.aborted === false
        && isCurrentTurn(a) && isCurrentTurn(b) && activeTurnCount() === 2;
    })());
  check("endTurn releases only if still owner (a superseded turn cannot evict the newer one)",
    (() => {
      resetTurnRegistry();
      const a = beginTurn("biz", "cust");
      const b = beginTurn("biz", "cust");
      endTurn(a);                            // a is stale → must NOT remove b's entry
      const bStillCurrent = isCurrentTurn(b);
      endTurn(b);                            // b owns → released
      return bStillCurrent && activeTurnCount() === 0;
    })());
  resetTurnRegistry();

  // ── 9k. Deterministic continuity mode — degraded-intent classifier (no AI) ─────
  section("9k. Deterministic continuity mode (Gemini unavailable) — degraded-intent priority");
  // THE live bug: a mixed FAQ/meta/recovery burst became degraded+booking. Must be accountability.
  check("mixed FAQ/meta/recovery burst → accountability (NOT booking) — the live degraded+booking bug",
    classifyDegradedIntent("ואפשר לעשן?\nאתה זמין?\nשאלתי לגבי זמינות כי אמרת\nשיש עומס") === "accountability");
  check("simple FAQ during degraded → continuity menu, never booking ('ואפשר לעשן?')",
    classifyDegradedIntent("ואפשר לעשן?") === "menu");
  check("a price FAQ with a service name is a MENU, not booking (no loose booking-signal)",
    classifyDegradedIntent("כמה עולה פן?") === "menu");
  check("explicit booking op → booking link",
    classifyDegradedIntent("אני רוצה לקבוע תור") === "booking");
  check("explicit manage / link request → manage",
    classifyDegradedIntent("איך אני מבטל את התור") === "manage"
    && classifyDegradedIntent("תוכל לשלוח לי את הקישור") === "manage");
  check("system availability / recovery → recovery (never booking)",
    classifyDegradedIntent("אתה זמין?") === "recovery"
    && classifyDegradedIntent("יש זמינות מחר?") !== "booking");
  check("accountability about our overload → accountability ('שאלתי לגבי זמינות')",
    classifyDegradedIntent("שאלתי לגבי זמינות") === "accountability");

  // ── 9l. Deterministic receptionist — reason-specific continuity wording ─────────
  section("9l. Reason-specific continuity wording (ai_disabled neutral vs provider)");
  check("ai_disabled is NEUTRAL — never mentions overload/limited — but still offers the menu",
    !/עומס|מצומצם/.test(continuityText("ai_disabled", "menu"))
    && continuityText("ai_disabled", "menu").includes("לקבוע תור"));
  check("ai_disabled booking/manage give the link with NO overload notice",
    continuityText("ai_disabled", "booking", "URL").includes("URL")
    && !/עומס/.test(continuityText("ai_disabled", "booking", "URL"))
    && continuityText("ai_disabled", "manage", "URL").includes("URL"));
  check("provider_outage (sustained) mentions a momentary system load (book link still offered)",
    /עומס/.test(continuityText("provider_outage", "menu"))
    && /עומס/.test(continuityText("provider_outage", "booking", "URL")));
  check("ai_error is a soft 'limited mode', not an overload claim",
    /מצומצם/.test(continuityText("ai_error", "menu")) && !/עומס/.test(continuityText("ai_error", "menu")));
  check("no continuity reply asks for service/day/time in chat (platform-safe)",
    (["ai_disabled", "provider_transient", "provider_outage", "ai_error"] as const)
      .every((r) => !/כתוב.*שירות|שירות.*יום.*שעה/.test(continuityText(r, "menu"))));

  // ── 9m. Transient 503 recovery vs sustained outage + message preservation ──────
  section("9m. Transient 503 (soft recovery) vs sustained outage + failed-need preservation");
  check("transient 503 → soft 'resend?' that keeps the AI experience (NOT the full menu, no overload)",
    /לשלוח שוב/.test(continuityText("provider_transient", "menu"))
    && !/עומס/.test(continuityText("provider_transient", "menu")));
  check("transient wording is DISTINCT from the sustained-outage menu (no permanent downgrade)",
    continuityText("provider_transient", "menu") !== continuityText("provider_outage", "menu"));
  check("transient 503 + explicit booking/manage still routes to the link",
    continuityText("provider_transient", "booking", "URL").includes("URL")
    && classifyDegradedIntent("אני רוצה לקבוע תור") === "booking");
  check("a transient-failed FAQ need is PRESERVED within TTL; expired/missing → null (no swallow)",
    (() => {
      const N = 1_700_000_000_000;
      return readPendingFailedNeed({ pendingFailedNeed: { text: "אפשר לעשן שם?", at: N } }, N + 60_000)?.text === "אפשר לעשן שם?"
        && readPendingFailedNeed({ pendingFailedNeed: { text: "x", at: N } }, N + PENDING_FAILED_NEED_TTL_MS + 1) === null
        && readPendingFailedNeed({}, N) === null;
    })());

  // ── 9n. GENERAL deterministic WhatsApp menu / FAQ core (no-AI states) ──────────
  // THE live bug: after a menu, a meaningful business-info FAQ ("אפשר לעשן במספרה?") was
  // SUPPRESSED by the menu rate-limit. The menu core must distinguish a real question
  // (answer from facts/KB, or the info submenu — NEVER suppressed) from a vague repeat.
  section("9n. General deterministic menu / FAQ core (book/manage/info, business-agnostic)");
  // A representative business — kept generic on purpose (a yoga studio, not a salon) so the
  // menu/answer logic is proven vertical-neutral.
  const FACTS: BusinessFacts = {
    businessName: "Flow Studio",
    phone: "03-1234567",
    location: { address: "הרצל 10", city: "תל אביב" },
    timezone: "Asia/Jerusalem",
    bookingEnabled: true,
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
  // A. Topic detection — generic question shapes map to info categories.
  check("topic detection: hours/prices/location/parking (generic shapes)",
    detectInfoTopic("מה השעות שלכם?") === "hours"
    && detectInfoTopic("כמה עולה שיעור?") === "prices"
    && detectInfoTopic("איפה אתם נמצאים?") === "location"
    && detectInfoTopic("יש חניה?") === "parking");
  check("a non-topic question has no structured topic ('אפשר לעשן במספרה?')",
    detectInfoTopic("אפשר לעשן במספרה?") === null);
  check("explicit menu request recognized ('תפריט ראשי'), a question is not a menu request",
    isMenuRequest("תפריט ראשי") && isMenuRequest("תפריט") && isMenuRequest("מה השעות?") === false);
  // B. Deterministic answers come straight from facts (grounded — never invented).
  check("hours answer renders configured days/times + closed day (grounded)",
    (() => { const a = resolveInfoAnswer(FACTS, "hours")!; return a.includes("ראשון") && a.includes("09:00-18:00") && a.includes("סגור"); })());
  check("prices answer renders configured services + ₪ (the business's OWN service names)",
    (() => { const a = resolveInfoAnswer(FACTS, "prices")!; return a.includes("שיעור יוגה") && a.includes("₪70") && a.includes("אימון אישי"); })());
  check("location answer renders address; parking answer comes from KB",
    resolveInfoAnswer(FACTS, "location")!.includes("הרצל 10")
    && resolveInfoAnswer(FACTS, "parking")!.includes("חניון"));
  check("a topic with NO data resolves to null (→ caller offers submenu, never invents)",
    resolveInfoAnswer({ ...FACTS, knowledge: [], hours: [] }, "policy") === null
    && resolveInfoAnswer({ ...FACTS, hours: [] }, "hours") === null);
  // C. THE FIX — a real business-info question is answered/submenu'd, NEVER vague/suppressed.
  check("THE BUG FIX: a meaningful FAQ in a no-AI state is answer/submenu, never vague_menu",
    planContinuityMenu("ai_disabled", "אפשר לעשן במספרה?", FACTS).kind === "submenu"
    && planContinuityMenu("provider_outage", "אפשר לעשן במספרה?", FACTS).kind === "submenu");
  check("a recognized topic question is ANSWERED from facts (kind=answer)",
    planContinuityMenu("ai_disabled", "מה השעות?", FACTS).kind === "answer"
    && planContinuityMenu("ai_disabled", "מה המחירים?", FACTS).kind === "answer"
    && planContinuityMenu("ai_disabled", "איפה אתם?", FACTS).kind === "answer");
  check("a KB-matchable question is answered from KB ('יש חניון קרוב?' → parking KB)",
    planContinuityMenu("ai_disabled", "יש חניון קרוב?", FACTS).kind === "answer");
  check("an explicit menu request → main_menu_explicit (always replies, never rate-limited)",
    planContinuityMenu("ai_disabled", "תפריט", FACTS).kind === "main_menu_explicit");
  check("a vague/greeting repeat → vague_menu (the ONLY rate-limited kind)",
    planContinuityMenu("ai_disabled", "היי", FACTS).kind === "vague_menu");
  // D. Reason-specific wording + capability gating. ai_disabled is neutral & business-aware (the
  //    virtual assistant of the business); provider_outage softly notes the smart assistant is limited.
  check("ai_disabled menu is NEUTRAL + business-aware; provider_outage notes the assistant is limited",
    !/עומס|מצומצם|מוגבל/.test(planContinuityMenu("ai_disabled", "היי", FACTS).text)
    && planContinuityMenu("ai_disabled", "היי", FACTS).text.includes(FACTS.businessName)
    && /מוגבל|עומס|מצומצם/.test(planContinuityMenu("provider_outage", "היי", FACTS).text));
  check("menu hides options the business can't serve (no booking line when booking disabled)",
    !buildMainMenu({ ...FACTS, bookingEnabled: false }).includes("קביעת תור")
    && buildMainMenu(FACTS).includes("קביעת תור"));
  check("info submenu lists only topics with data (parking shown here; policy not — no KB)",
    availableInfoTopics(FACTS).some((t) => t.topic === "parking")
    && availableInfoTopics(FACTS).every((t) => t.topic !== "policy")
    && buildInfoSubmenu(FACTS).includes("שעות פתיחה"));
  // E. No continuity menu/answer asks for service/day/time in chat, and carries no URL (no link off info).
  check("menu/answer text is platform-safe (no in-chat scheduling question, no URL)",
    (["ai_disabled", "provider_outage", "ai_error"] as const).every((r) => {
      const t = planContinuityMenu(r, "מה השעות?", FACTS).text + planContinuityMenu(r, "אפשר לעשן?", FACTS).text;
      return !/איזה\s+(שירות|יום|שעה)/.test(t) && !/https?:\/\//.test(t);
    }));
  check("findKbAnswer is conservative: matches a KB token, returns null on no overlap",
    findKbAnswer(FACTS, "ספרו לי על הסטודיו")?.includes("בוטיק") === true
    && findKbAnswer(FACTS, "אפשר לעשן במספרה?") === null);
  check("isBusinessQuestion: a real multi-word question yes; a bare greeting no",
    isBusinessQuestion("אפשר לעשן במספרה?") && isBusinessQuestion("היי") === false);

  // ── 9o. Real navigable menu state machine + provider-health snapshot ───────────
  // Mission: a true WhatsApp menu FLOW (main → faq → category → answer → nav) with numeric/
  // alias/back/topic navigation, AND a clear provider-health state that decides menu mode —
  // all AI-FIRST (navigation intercepts ONLY on an explicit menu request or an active cursor).
  section("9o. Navigable menu state machine (numeric/alias/back) + AI-first guard + provider health");
  // A. AI-FIRST GUARD — with NO active cursor, free text / bare numbers do NOT enter menu mode.
  check("AI-FIRST: no active menu → free text and bare numbers are NOT intercepted (null → Gemini)",
    resolveMenuNavigation(null, "כמה עולה שיעור?", FACTS, { activeMenu: false }) === null
    && resolveMenuNavigation(null, "3", FACTS, { activeMenu: false }) === null);
  check("explicit menu request enters the menu even with no cursor ('תפריט')",
    resolveMenuNavigation(null, "תפריט", FACTS, { activeMenu: false })?.kind === "main");
  // B. MAIN-node numeric picks map to the SAME capability-gated ordering the customer saw.
  check("main node: 1→book, 2→manage, 3→faq submenu (booking enabled)",
    resolveMenuNavigation("main", "1", FACTS, { activeMenu: true })?.kind === "book"
    && resolveMenuNavigation("main", "2", FACTS, { activeMenu: true })?.kind === "manage"
    && resolveMenuNavigation("main", "3", FACTS, { activeMenu: true })?.kind === "faq");
  check("main node numbering shifts when booking disabled (1→manage)",
    resolveMenuNavigation("main", "1", { ...FACTS, bookingEnabled: false }, { activeMenu: true })?.kind === "manage");
  // C. FAQ-node numeric picks → category ANSWER from facts (the real menu flow).
  check("faq node: 1→hours answer, 2→prices answer, 3→location answer (numbered)",
    (() => {
      const a = resolveMenuNavigation("faq", "1", FACTS, { activeMenu: true });
      const b = resolveMenuNavigation("faq", "2", FACTS, { activeMenu: true });
      const c = resolveMenuNavigation("faq", "3", FACTS, { activeMenu: true });
      return a?.kind === "answer" && a.reply.includes("09:00-18:00")
        && b?.kind === "answer" && b.reply.includes("₪70")
        && c?.kind === "answer" && c.reply.includes("הרצל 10");
    })());
  // D. Alias + back + topic-word navigation.
  check("aliases: 'שאלות נפוצות'→faq, 'תפריט ראשי'→main, 'לקבוע תור'→book, 'לבטל'→manage",
    resolveMenuNavigation("main", "שאלות נפוצות", FACTS, { activeMenu: true })?.kind === "faq"
    && resolveMenuNavigation("faq", "תפריט ראשי", FACTS, { activeMenu: true })?.kind === "main"
    && resolveMenuNavigation("faq", "לקבוע תור", FACTS, { activeMenu: true })?.kind === "book"
    && resolveMenuNavigation("main", "לבטל", FACTS, { activeMenu: true })?.kind === "manage");
  check("topic word inside an active menu → its answer ('חניה' → parking KB)",
    resolveMenuNavigation("faq", "חניה", FACTS, { activeMenu: true })?.kind === "answer");
  check("out-of-range numeric re-shows the current menu, never silence (faq '9' → faq submenu)",
    resolveMenuNavigation("faq", "9", FACTS, { activeMenu: true })?.kind === "faq");
  check("a non-navigation message in an active menu → null (caller falls through; never silent)",
    resolveMenuNavigation("faq", "ספר לי בדיחה על החיים", FACTS, { activeMenu: true }) === null);
  // E. Menu cursor round-trips + TTL; answers carry the nav footer.
  check("readMenuState round-trips a valid cursor; expired/missing → null",
    (() => {
      const N = 1_700_000_000_000;
      return readMenuState({ menu: { node: "faq", at: N } }, N + 1000)?.node === "faq"
        && readMenuState({ menu: { node: "faq", at: N } }, N + MENU_STATE_TTL_MS + 1) === null
        && readMenuState({}, N) === null;
    })());
  check("a category answer carries the navigation footer (menu flow, not a one-off)",
    buildCategoryAnswer("שעות: ...").includes("תפריט") && buildCategoryAnswer("x").includes("שאלות נפוצות"));
  check("main options are capability-gated + stably ordered (book first when enabled)",
    availableMainOptions(FACTS)[0].action === "book"
    && availableMainOptions({ ...FACTS, bookingEnabled: false })[0].action === "manage");
  // F. PROVIDER HEALTH snapshot — the explainable state that decides menu mode.
  check("provider health snapshot: healthy after reset, with a typed shape",
    (() => {
      resetGeminiHealth();
      const h = getGeminiHealth();
      return h.state === "healthy" && h.strikes === 0 && h.cooldownRemainingMs === 0;
    })());
  gap("provider transient→outage→recovery transitions are integration paths",
    "getGeminiHealth() reports healthy/transient/outage from the process-global breaker, but tripping transient/outage strikes requires the live 503 path in gemini.ts (noteOverload is internal). The breaker's recovery (noteSuccess clears + logs RECOVERED; cooldown-expiry → next inbound is the half-open RECOVERY PROBE) is covered by build/typecheck + the healthy-state assertion; a live 503 storm is the only full assertion. Strongest feasible deterministic coverage added.");

  // ── 9p. CLICKABLE WhatsApp menus — interactive builders + inbound tap parsing ──
  // The real product target: tappable buttons/list rows, with stable payload IDs that map a TAP
  // to a deterministic action, plus inbound parsing of button_reply/list_reply. Network delivery
  // is integration-only; these assert the PURE builders/parsers + WhatsApp limit compliance.
  section("9p. Clickable WhatsApp menus (interactive build + inbound payload parse) + limits");
  // A. Inbound parsing — text AND interactive taps normalize to { text, payloadId? }.
  check("inbound parse: text → {text}; button_reply / list_reply → {text:title, payloadId:id}",
    extractInboundMessage({ type: "text", text: { body: "היי" } })?.text === "היי"
    && (() => {
      const b = extractInboundMessage({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "m:book", title: "קביעת תור" } } });
      const l = extractInboundMessage({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "f:hours", title: "שעות פתיחה" } } });
      return b?.payloadId === "m:book" && b?.text === "קביעת תור" && l?.payloadId === "f:hours" && l?.text === "שעות פתיחה";
    })());
  check("inbound parse: unsupported types (image / empty) → null (caller skips, no crash)",
    extractInboundMessage({ type: "image" }) === null
    && extractInboundMessage({ type: "text", text: { body: "  " } }) === null
    && extractInboundMessage(null) === null);
  // B. A TAPPED payload ALWAYS maps to a deterministic action.
  check("tapped payload resolves deterministically: m:book→book, m:manage→manage, m:faq→faq, f:hours→answer",
    resolveMenuPayload(MENU_PAYLOAD.book, FACTS)?.kind === "book"
    && resolveMenuPayload(MENU_PAYLOAD.manage, FACTS)?.kind === "manage"
    && resolveMenuPayload(MENU_PAYLOAD.faq, FACTS)?.kind === "faq"
    && resolveMenuPayload("f:hours", FACTS)?.kind === "answer");
  check("unknown / data-less payload → null (caller falls back to the visible title as text)",
    resolveMenuPayload("bogus", FACTS) === null
    && resolveMenuPayload("f:policy", FACTS) === null);  // no policy KB in FACTS
  // C. Interactive BUILDERS produce the right WhatsApp message kind with stable payload IDs.
  check("main menu → reply buttons (≤3) with MENU_PAYLOAD ids; booking-disabled drops the book button",
    (() => {
      const m = buildInteractiveMainMenu(FACTS);
      const md = buildInteractiveMainMenu({ ...FACTS, bookingEnabled: false });
      return m.kind === "buttons" && m.buttons.length <= 3
        && m.buttons.some((b) => b.id === MENU_PAYLOAD.book)
        && md.kind === "buttons" && !md.buttons.some((b) => b.id === MENU_PAYLOAD.book);
    })());
  check("FAQ submenu → a list with topic rows (f:* ids) + a back-to-main row",
    (() => {
      const f = buildInteractiveFaqMenu(FACTS);
      return f.kind === "list" && f.rows.some((r) => r.id === "f:hours")
        && f.rows.some((r) => r.id === MENU_PAYLOAD.main);
    })());
  check("category answer → buttons (back-to-faq / main / book) carrying the answer body",
    (() => {
      const a = buildInteractiveAnswer("שעות הפתיחה: ...", FACTS);
      return a.kind === "buttons" && a.body.includes("שעות") && a.buttons.some((b) => b.id === MENU_PAYLOAD.main);
    })());
  // D. WhatsApp LIMIT compliance (button title ≤20, list ≤10 rows / title ≤24).
  check("interactive messages respect WhatsApp limits (buttons ≤3/≤20ch; list ≤10 rows/≤24ch)",
    (() => {
      const m = buildInteractiveMainMenu(FACTS);
      const f = buildInteractiveFaqMenu(FACTS);
      const a = buildInteractiveAnswer("x", FACTS);
      const okButtons = (x: typeof m) => x.kind === "buttons" && x.buttons.length <= 3 && x.buttons.every((b) => b.title.length <= 20);
      const okList = f.kind === "list" && f.rows.length <= 10 && f.rows.every((r) => r.title.length <= 24);
      return okButtons(m) && okButtons(a) && okList;
    })());

  // ── 9q. Menu polish — business-aware copy, reason wording, no-dead-end CTA anchoring ──
  // The deterministic menu presents as the business's VIRTUAL ASSISTANT (business-aware, generic),
  // reason wording differs (neutral vs limited), and every action card has a route back to the menu.
  section("9q. Menu copy: business-aware + reason-specific + no-dead-end action anchoring");
  check("main menu is business-aware (uses businessName), generic (no industry/salon words)",
    mainMenuBody(FACTS).includes(FACTS.businessName)
    && /העוזר הווירטואלי/.test(mainMenuBody(FACTS))
    && !/מספרה|תספורת|זקן|סלון/.test(mainMenuBody(FACTS)));
  check("main menu falls back gracefully when businessName is empty (still generic, no crash)",
    mainMenuBody({ ...FACTS, businessName: "" }).includes("העוזר הווירטואלי")
    && !mainMenuBody({ ...FACTS, businessName: "" }).includes("של "));
  check("reason wording: ai_disabled neutral (no limit word); outage/error note a limit",
    !/מוגבל|עומס|מצומצם/.test(mainMenuBody(FACTS, "ai_disabled"))
    && /מוגבל/.test(mainMenuBody(FACTS, "provider_outage"))
    && /מצומצם/.test(mainMenuBody(FACTS, "ai_error")));
  check("interactive main-menu body carries the same business-aware/reason wording",
    (() => {
      const neutral = buildInteractiveMainMenu(FACTS);
      const outage = buildInteractiveMainMenu(FACTS, "provider_outage");
      return neutral.body.includes(FACTS.businessName) && /מוגבל/.test(outage.body);
    })());
  check("NO DEAD END: booking/manage CTA bodies include a clear route back to the main menu",
    ctaBody("book").includes("תפריט") && ctaBody("manage").includes("תפריט")
    && MENU_HINT.includes("תפריט") && ctaBody("book").includes("לקביעת תור"));
  check("'תפריט' (the hinted word) is recognized as a menu request → main menu",
    isMenuRequest("תפריט") && resolveMenuNavigation(null, "תפריט", FACTS, { activeMenu: false })?.kind === "main");

  // ── 9r. OPERATING-MODE GATE — deterministic menu only when AI can't operate ────
  // The mode-boundary fix: the clickable-menu interceptor runs ONLY when the deterministic gate is
  // active. In AI mode (AI enabled + provider healthy + configured) a stale cursor / old button
  // payload must NOT re-enter menu mode — the gate returns false so the interceptor is skipped.
  section("9r. Operating-mode gate (deterministic menu vs AI mode) — stale payload/cursor safety");
  check("AI ENABLED + provider healthy + configured → menu INACTIVE (AI owns the turn)",
    isDeterministicMenuActive({ aiEnabled: true, geminiConfigured: true, providerCoolingDown: false }) === false);
  check("owner DISABLED AI → menu ACTIVE (regardless of provider health)",
    isDeterministicMenuActive({ aiEnabled: false, geminiConfigured: true, providerCoolingDown: false }) === true
    && isDeterministicMenuActive({ aiEnabled: false, geminiConfigured: false, providerCoolingDown: true }) === true);
  check("NO API KEY (not configured) → menu ACTIVE (AI cannot operate)",
    isDeterministicMenuActive({ aiEnabled: true, geminiConfigured: false, providerCoolingDown: false }) === true);
  check("SUSTAINED outage (provider cooling down) → menu ACTIVE",
    isDeterministicMenuActive({ aiEnabled: true, geminiConfigured: true, providerCoolingDown: true }) === true);
  check("a single TRANSIENT 503 is NOT cooling down → menu stays INACTIVE (soft AI recovery, not menu)",
    isDeterministicMenuActive({ aiEnabled: true, geminiConfigured: true, providerCoolingDown: false }) === false);
  // The KEY guarantee, stated as a gate truth-table: only AI-disabled / not-configured / outage flip it on.
  check("gate truth: exactly the three deterministic states activate the menu; AI-mode does not",
    [true, false].every((cfg) =>
      isDeterministicMenuActive({ aiEnabled: true, geminiConfigured: cfg, providerCoolingDown: false }) === !cfg)
    && isDeterministicMenuActive({ aiEnabled: true, geminiConfigured: true, providerCoolingDown: true }) === true);
  gap("interceptor gating + stale-payload-to-AI routing is an integration path",
    "isDeterministicMenuActive() is unit-asserted here; the runPlatformTurn wiring (skip the interceptor in AI mode, route a stale tap's visible text to Gemini/platform, clear the cursor on the healthy persist) needs the DB + a live toggle. Covered by build/typecheck + this gate's truth-table; a live AI off→on toggle is the only full assertion.");

  // ── 10. Grounding of concrete facts (no invented price/time) ───────────────────
  section("10. Grounding fence (concrete business facts)");
  {
    const idx: FactIndex = {
      prices: new Set<number>([80, 120, 250]),
      times: new Set<string>(["09:00", "18:00"]),
      timeRanges: [{ start: 9 * 60, end: 18 * 60 }],
      phoneDigits: null,
    };
    check("invented price (₪999) is rejected", verifyGrounding("המחיר הוא ₪999", idx).ok === false);
    check("configured price (₪80) is allowed", verifyGrounding("תספורת עולה ₪80", idx).ok === true);
    check("time inside open hours (14:00) is allowed", verifyGrounding("אפשר ב 14:00", idx).ok === true);
    check("time outside open hours (22:00) is rejected", verifyGrounding("נתראה ב 22:00", idx).ok === false);
    check("fact-free warmth is always grounded", verifyGrounding("נשמח לראותך! 🙂", idx).ok === true);
    // Singular "שקל" (no yod) — was a gap this eval surfaced; now fenced in grounding.ts.
    check("invented price in singular 'שקל' is rejected", verifyGrounding("המחיר הוא 999 שקל", idx).ok === false);
    check("invented price in plural 'שקלים' is rejected", verifyGrounding("המחיר 999 שקלים", idx).ok === false);
    check("configured price in singular 'שקל' is allowed", verifyGrounding("תספורת עולה 80 שקל", idx).ok === true);
    check("configured price in plural 'שקלים' is allowed", verifyGrounding("תספורת עולה 80 שקלים", idx).ok === true);
  }

  // ── 11. KNOWN GAPS (documented, not faked) ─────────────────────────────────────
  section("11. KNOWN GAPS — marked, not green-washed");
  // 11a. Confused good-faith customer is escalated on the SAME ladder as a key-masher.
  check("[baseline] confused 'unclear' counts toward quiet exactly like 'gibberish'",
    countsTowardQuiet("unclear") === true && countsTowardQuiet("gibberish") === true);
  gap("confused-vs-spam conflation",
    "A confused but good-faith customer ('לא הבנתי', 'מה?') escalates clarify→boundary→quiet on the SAME ladder as a bored key-masher. No Phase/Health separation yet → a real customer can be walked toward silence. Candidate for Phase 4 (only if production/sim data shows it happens).");
  gap("no-false-refusal fence — NOW PARTIALLY CLOSED (Phase 5)",
    "A deterministic fence (defuseActionRefusal, section 6b) now neutralizes a false 'can't book/reschedule/cancel' WHEN a booking/manage link is attached. Remaining edges: LIST-refusals ('לראות') are intentionally excluded, and turns where no link is attached are out of scope. A live probe should still confirm real-world frequency.");
  gap("prose / owner-configured truth is unfenced",
    "Grounding covers prices/times/phones only. Invented capabilities/policies, junk KB, and junk address/city (M0A P1) pass through. Fix is data hygiene (Phase 1) + a future fact-quality gate, not a regex here.");

  // ── 12. Post-action notifications (cancel / reschedule WhatsApp confirmations) ──
  // Deterministic templates sent after a successful website action — no Gemini, summarizing the
  // real appointment details + the right link, with dedupe so a refresh/double-submit can't spam.
  section("12. Cancel/reschedule confirmations — deterministic templates + dedupe");
  check("date formatter: YYYY-MM-DD → DD/MM/YYYY; malformed passes through",
    formatApptDate("2026-06-18") === "18/06/2026" && formatApptDate("garbage") === "garbage");
  check("cancellation message: confirms cancel + date/time + a NEW-BOOKING link (+ service when known)",
    (() => {
      const m = buildCancellationMessage({ serviceName: "שיעור יוגה", dateISO: "2026-06-18", time: "11:15", bookingLink: "https://x/book/flow" });
      return m.includes("בוטל") && m.includes("18/06/2026") && m.includes("11:15")
        && m.includes("https://x/book/flow") && m.includes("שיעור יוגה");
    })());
  check("cancellation omits the service line when service is unknown (no blank/hallucinated field)",
    !buildCancellationMessage({ serviceName: null, dateISO: "2026-06-18", time: "11:15", bookingLink: "L" }).includes("שירות:"));
  check("reschedule message: confirms update + OLD and NEW date/time + a MANAGE link",
    (() => {
      const m = buildRescheduleMessage({ serviceName: "פן", fromDateISO: "2026-06-18", fromTime: "11:15", toDateISO: "2026-06-20", toTime: "09:30", manageLink: "https://x/appointment/abc" });
      return m.includes("עודכן") && m.includes("18/06/2026") && m.includes("11:15")
        && m.includes("20/06/2026") && m.includes("09:30") && m.includes("https://x/appointment/abc");
    })());
  check("reschedule never claims the bot changed it (website did) and carries no in-chat scheduling ask",
    (() => {
      const m = buildRescheduleMessage({ serviceName: null, fromDateISO: "2026-06-18", fromTime: "11:15", toDateISO: "2026-06-20", toTime: "09:30", manageLink: "L" });
      return !/קבעתי|שיניתי|ביטלתי|איזה (יום|שעה|שירות)/.test(m);
    })());
  check("DEDUPE predicate: a real move notifies; a same-slot resubmit does NOT (no duplicate spam)",
    rescheduleChanged("2026-06-18", "11:15", "2026-06-20", "09:30") === true
    && rescheduleChanged("2026-06-18", "11:15", "2026-06-18", "11:15") === false);
  gap("notification SEND path (cancel/reschedule) is an integration path",
    "The pure message builders + dedupe predicates are unit-asserted here. The actual send (sendOutbound after a successful conditional DB update; cancel deduped by the .select('id') rowcount, reschedule by rescheduleChanged) lives in lib/booking/platform.ts and needs a live DB + WhatsApp. It reuses the exact fail-open booking-confirmation pattern; a manual manage-page test is the full assertion.");

  // ── summary ────────────────────────────────────────────────────────────────────
  console.log(`\n=== ${pass}/${pass + fail} deterministic checks passed${fail ? ` — ${fail} FAILED: ${failed.join(", ")}` : ""} ===`);
  console.log("(GAP lines are intentional known limitations, not failures — they scope the next reliability work.)");
  process.exitCode = fail > 0 ? 1 : 0;
}

main();
