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

import { resolveRoute, linkKindForRoute, modelOperation } from "../../lib/ai/routing";
import {
  hasBookingSignal, applyBookingEvidenceGate, suppressLinkFor, isExplicitLinkRequest,
  isEmojiOnly, looksLikeNoise, lowSignalActionFor, quietModePlan, countsTowardQuiet,
  defuseSchedulingQuestion, mentionsActionRefusal, defuseActionRefusal,
  FENCE_BRIDGE_BOOK, FENCE_BRIDGE_MANAGE,
} from "../../lib/ai/platform-turn";
import { claimsBookingCompleted, sameOutboundText, nearDuplicateText } from "../../lib/ai/reply-polish";
import { verifyGrounding } from "../../lib/ai/grounding";
import { buildBookingLink, buildAppointmentLink } from "../../lib/config";
import { buildMyAppointmentsLink } from "../../lib/booking/appointment-token";
import type { ReceptionistTurn } from "../../lib/ai/brain";
import type { FactIndex } from "../../lib/ai/facts";

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

  // ── summary ────────────────────────────────────────────────────────────────────
  console.log(`\n=== ${pass}/${pass + fail} deterministic checks passed${fail ? ` — ${fail} FAILED: ${failed.join(", ")}` : ""} ===`);
  console.log("(GAP lines are intentional known limitations, not failures — they scope the next reliability work.)");
  process.exitCode = fail > 0 ? 1 : 0;
}

main();
