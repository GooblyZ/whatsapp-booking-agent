// scripts/eval/live-understanding.ts
// Reliability EVAL HARNESS — LIVE-Gemini understanding/property layer (WS D / T4).
//
// SEPARATE, SMALL, TOLERANT. This is the ONLY part of the harness that calls Gemini.
// It catches prompt/settings regressions in the MODEL'S UNDERSTANDING — not the
// deterministic decision logic (that's the golden layer in reliability-eval.ts).
//
// It asserts COARSE PROPERTIES only, never exact text and never a golden snapshot:
//   • clear operations classify with the right intent / appointmentIntent / actionability
//   • clear FAQ / smalltalk are NOT operations and are answered from facts (grounded)
//   • a platform-mode booking reply lists NO slots and claims NO completed booking
//
// ⚠ ALLOWED TO FLAKE. Temperature is 0.7 (see CLAUDE.md). A single miss is likely
//   model variance — RERUN ONCE before treating it as a regression. This command is
//   NEVER a gate on a refactor; the golden layer is. It ALWAYS exits 0.
//
// RUN (needs real GEMINI keys; the ctx is synthetic, NO DB is read):
//   npm run eval:live
//   → node --env-file=.env.local --import tsx scripts/eval/live-understanding.ts

import type { BusinessAIContext } from "../../types/database";
import { runReceptionistTurn } from "../../lib/ai/brain";
import { applyBookingEvidenceGate } from "../../lib/ai/platform-turn";
import { claimsBookingCompleted } from "../../lib/ai/reply-polish";

const TZ = "Asia/Jerusalem";

// A deliberately NON-salon synthetic tenant (CLAUDE.md product principle: the system
// is appointment-business-agnostic). A Pilates / wellness studio exercises the exact
// same operations a salon would, proving the understanding layer isn't salon-shaped.
function makeCtx(): BusinessAIContext {
  return {
    business: { id: "eval-biz", name: "סטודיו אופק", slug: "ofek", phone: "03-7654321", timezone: TZ, created_at: "", updated_at: "" },
    businessSettings: {
      id: "s", business_id: "eval-biz", booking_enabled: true, confirmation_required: true,
      default_slot_duration_minutes: 60, address: "ויצמן 5", city: "רעננה",
      parking_instructions: null, entrance_instructions: null, cancellation_policy_text: null,
      language: "he", created_at: "", updated_at: "",
    },
    aiSettings: {
      id: "a", business_id: "eval-biz", assistant_name: "מאיה",
      tone: "friendly" as never, response_length: "medium" as never, emoji_usage: "low" as never,
      language: "he", custom_instructions: null, assistant_gender: "female" as never,
      ai_enabled: true, faq_enabled: true, intent_detection_enabled: true, created_at: "", updated_at: "",
    },
    services: [
      { id: "svc1", business_id: "eval-biz", category_id: null, name: "שיעור פילאטיס", description: null, duration_minutes: 60, price: 90, active: true, created_at: "", updated_at: "" },
      { id: "svc2", business_id: "eval-biz", category_id: null, name: "אימון אישי", description: null, duration_minutes: 45, price: 150, active: true, created_at: "", updated_at: "" },
    ],
    knowledgeBaseItems: [
      { id: "kb1", business_id: "eval-biz", category: "parking", title: "חניה", content: "יש חניה חופשית ברחוב ויצמן ובחניון הסמוך.", active: true, created_at: "", updated_at: "" },
    ],
    businessHours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      id: `h${d}`, business_id: "eval-biz", day_of_week: d,
      opens_at: d === 6 ? null : "08:00", closes_at: d === 6 ? null : "20:00", is_closed: d === 6,
      created_at: "", updated_at: "",
    })),
  } as BusinessAIContext;
}

const SERVICE_NAMES = ["שיעור פילאטיס", "אימון אישי"];

let calls = 0;
let passed = 0;
const results: string[] = [];

async function ask(message: string, platformMode = true) {
  calls++;
  return runReceptionistTurn(makeCtx(), { conversationContext: "", message, bookingBlock: "", platformMode });
}
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  results.push(`  ${ok ? "PASS ✓" : "FAIL ✗"}  ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}

async function main(): Promise<void> {
  console.log("══════════ Live-Gemini understanding properties (TOLERANT · rerun once on variance) ══════════");

  // 1) Clear BOOK request → an actionable booking operation.
  {
    const d = await ask("אני רוצה לקבוע תור");
    const u = d.turn?.understanding;
    check("'אני רוצה לקבוע תור' → actionable BOOK", !!u && u.requestsBusinessAction === true && (u.appointmentIntent === "BOOK" || u.intent === "booking"),
      `intent=${u?.intent} appt=${u?.appointmentIntent} action=${u?.requestsBusinessAction}`);
  }
  // 2) Clear CANCEL → cancel operation.
  {
    const d = await ask("אני רוצה לבטל את התור שלי");
    const u = d.turn?.understanding;
    check("'לבטל את התור שלי' → CANCEL operation", !!u && u.requestsBusinessAction === true && (u.appointmentIntent === "CANCEL" || u.intent === "cancel_request"),
      `intent=${u?.intent} appt=${u?.appointmentIntent}`);
  }
  // 3) Clear LIST → a view/manage operation (not a fresh booking).
  {
    const d = await ask("אפשר לראות את כל התורים שלי?");
    const u = d.turn?.understanding;
    check("'לראות את כל התורים שלי' → LIST/manage (not BOOK)", !!u && u.appointmentIntent !== "BOOK",
      `intent=${u?.intent} appt=${u?.appointmentIntent}`);
  }
  // 4) Pricing question → FAQ, NOT an operation.
  {
    const d = await ask("כמה עולה שיעור פילאטיס?");
    const u = d.turn?.understanding;
    check("pricing question → FAQ, not an operation", !!u && u.requestsBusinessAction === false && u.intent === "faq",
      `intent=${u?.intent} action=${u?.requestsBusinessAction}`);
  }
  // 5) Parking FAQ → answered FROM FACTS (grounded; not the grounding deflection).
  {
    const d = await ask("יש חניה?");
    const grounded = d.ok && d.grounded === true && !d.replyText.includes("לא בטוח");
    check("parking FAQ answered from facts (grounded)", grounded, `ok=${d.ok} grounded=${d.grounded} reply="${d.replyText.slice(0, 40)}"`);
  }
  // 6) Smalltalk → not an operation.
  {
    const d = await ask("מה שלומך?");
    const u = d.turn?.understanding;
    check("smalltalk → not an operation", !!u && u.requestsBusinessAction === false,
      `intent=${u?.intent} action=${u?.requestsBusinessAction}`);
  }
  // 7) Gibberish → after the evidence gate, NOT an operation (model may hallucinate BOOK).
  {
    const g = "חכלגצג";
    const d = await ask(g);
    if (d.ok && d.turn) applyBookingEvidenceGate(d.turn.understanding, g, SERVICE_NAMES);
    check("gibberish → non-actionable after evidence gate", d.turn?.understanding.requestsBusinessAction !== true,
      `action=${d.turn?.understanding.requestsBusinessAction}`);
  }
  // 8) Platform-mode booking reply: enumerates NO slot list and claims NO completed
  //    booking. NOTE: scope is the BRAIN (runReceptionistTurn) — a single clarifying
  //    question is allowed here and is stripped later by the deterministic fence in
  //    runPlatformTurn (out of scope for this layer). A "slot list" = the model
  //    enumerating multiple concrete clock times, which platform mode must never do.
  {
    const d = await ask("אני רוצה לקבוע שיעור פילאטיס למחר");
    const slotTimes = d.replyText.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/g) ?? [];
    const noSlotList = slotTimes.length < 2;
    const noFakeBooking = !claimsBookingCompleted(d.replyText);
    check("platform booking reply: no enumerated slot list, no completed-booking claim",
      noSlotList && noFakeBooking, `times=[${slotTimes.join(",")}] fakeBooking=${!noFakeBooking} reply="${d.replyText.slice(0, 50)}"`);
  }

  console.log(results.join("\n"));
  console.log("────────────────────────────────────────────────────────────────────────────────────────────");
  console.log(`  ${passed}/${calls} property checks passed  ·  live Gemini calls: ${calls}`);
  if (passed < calls) console.log("  NOTE: temp-0.7 variance is expected — rerun once before treating a single miss as a regression.");
  // Tolerant by design: never gate a refactor on the live layer.
  process.exit(0);
}

main().catch((e) => { console.error("LIVE EVAL ERROR:", e instanceof Error ? e.message : String(e)); process.exit(0); });
