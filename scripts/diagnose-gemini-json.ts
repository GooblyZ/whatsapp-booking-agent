// scripts/diagnose-gemini-json.ts
// TEMP diagnostic — investigates malformed_json after the model switch.
// Calls the Gemini API directly with the REAL production system instruction
// (synthetic business facts — no customer data) under several configs, and
// prints finishReason / token usage / parseability. No DB, no WhatsApp.
//
// Run: node --env-file=.env.local --import tsx scripts/diagnose-gemini-json.ts

import type { BusinessAIContext } from "../types/database";
import { buildReceptionistInstruction } from "../lib/ai/persona";
import { buildFacts, formatFacts, type Capabilities } from "../lib/ai/facts";

const ctx = {
  business: { id: "sim", name: "מספרת השכונה", slug: "sim", phone: "03-1234567", timezone: "Asia/Jerusalem", created_at: "", updated_at: "" },
  businessSettings: {
    id: "s", business_id: "sim", booking_enabled: true, confirmation_required: true,
    default_slot_duration_minutes: 30, address: "הרצל 12", city: "תל אביב",
    parking_instructions: null, entrance_instructions: null, cancellation_policy_text: null,
    language: "he", created_at: "", updated_at: "",
  },
  aiSettings: {
    id: "a", business_id: "sim", assistant_name: "נועה", tone: "friendly" as const,
    response_length: "medium" as const, emoji_usage: "low" as const, language: "he",
    custom_instructions: null, ai_enabled: true, faq_enabled: true, intent_detection_enabled: true,
    created_at: "", updated_at: "",
  },
  services: [
    { id: "svc1", business_id: "sim", category_id: null, name: "תספורת", description: null, duration_minutes: 30, price: 80, active: true, created_at: "", updated_at: "" },
    { id: "svc2", business_id: "sim", category_id: null, name: "פן", description: null, duration_minutes: 45, price: 120, active: true, created_at: "", updated_at: "" },
  ],
  knowledgeBaseItems: [
    { id: "kb1", business_id: "sim", category: "about" as const, title: "על העסק", content: "מספרה שכונתית חמה ברחוב הרצל 12, תל אביב.", active: true, created_at: "", updated_at: "" },
    { id: "kb2", business_id: "sim", category: "parking" as const, title: "חניה", content: "יש חניה חינם מאחורי הבניין.", active: true, created_at: "", updated_at: "" },
  ],
  businessHours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
    id: `h${d}`, business_id: "sim", day_of_week: d,
    opens_at: d === 0 ? null : "09:00", closes_at: d === 0 ? null : "18:00",
    is_closed: d === 0, created_at: "", updated_at: "",
  })),
} as BusinessAIContext;

const caps: Capabilities = { canAnswer: true, canStartBooking: true, canCancel: false, canReschedule: false };
const instruction = buildReceptionistInstruction(ctx, {
  factsBlock: formatFacts(buildFacts(ctx)), caps,
  conversationContext: "", availabilityBlock: "", bookingBlock: "",
});

const KEY = process.env.GEMINI_API_KEY?.trim();
if (!KEY) { console.error("GEMINI_API_KEY missing"); process.exit(1); }

interface Part { text?: string; thought?: boolean }

async function probe(label: string, model: string, genCfg: Record<string, unknown>): Promise<void> {
  const body = {
    systemInstruction: { parts: [{ text: instruction }] },
    contents: [{ role: "user", parts: [{ text: "אני רוצה תספורת מחר בחמש" }] }],
    generationConfig: genCfg,
  };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    const j = await res.json() as {
      error?: { message?: string };
      candidates?: { finishReason?: string; content?: { parts?: Part[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
    };
    console.log(`\n=== ${label} [${model}] ===`);
    if (!res.ok) { console.log(`HTTP ${res.status}: ${j?.error?.message?.slice(0, 160)}`); return; }
    const cand = j.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("");
    let parsed = "PARSE_FAIL";
    try {
      JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
      parsed = "OK";
    } catch { /* keep PARSE_FAIL */ }
    const u = j.usageMetadata;
    console.log(`finishReason=${cand?.finishReason} parts=${parts.length} thoughtParts=${parts.filter((p) => p.thought).length}`);
    console.log(`tokens: prompt=${u?.promptTokenCount} output=${u?.candidatesTokenCount ?? 0} thoughts=${u?.thoughtsTokenCount ?? 0} total=${u?.totalTokenCount}`);
    console.log(`textLen=${text.length} parse=${parsed}`);
    console.log(`head: ${text.slice(0, 110).replace(/\n/g, " ")}`);
    console.log(`tail: ${text.slice(-110).replace(/\n/g, " ")}`);
  } catch (e) {
    console.log(`${label}: FETCH ERROR ${(e as Error).message}`);
  }
}

// HEAVY variant: realistic loaded turn — long response setting, full memory
// transcript, active booking block, availability block, complex correction
// message that demands more reasoning (== more thinking tokens).
const ctxLong = {
  ...ctx,
  aiSettings: { ...(ctx.aiSettings as object), response_length: "long" },
} as BusinessAIContext;

const MEMORY = Array.from({ length: 8 }, (_, i) =>
  `Customer: הודעה מספר ${i + 1} על תיאום תור ושאלות על העסק\nAssistant (you, earlier): תשובה מפורטת מספר ${i + 1} עם הסברים על שירותים, מחירים ושעות פעילות של המספרה שלנו`
).join("\n");

const BOOKING_BLOCK = [
  "A booking is being put together. Details can arrive in ANY order — never force a sequence.",
  "- service: פן",
  "- day: 2026-06-15 (יום שני)",
  "- time: not mentioned yet",
  "- goal: לקבוע פן ליום שני",
  "- still needed: time",
  "⚠ NEVER ask the customer again for: service (פן), day (שני) — these are ALREADY KNOWN.",
  "",
  "EXISTING APPOINTMENTS (system-checked) for this customer:",
  "• 12/06 בשעה 16:00 — תספורת (confirmed)",
].join("\n");

const AVAIL_BLOCK = [
  "Checked date: 2026-06-15 (יום שני) — open 09:00-18:00.",
  "Open slots by part of day (45 min grid): בוקר: 09:00, 09:45, 10:30 (+2) | צהריים: 12:00, 12:45 | אחר הצהריים: 15:00, 15:45, 16:30 (+1).",
  "Present availability NATURALLY: say which parts of the day have room and offer at most 2-3 concrete times.",
].join("\n");

const heavyInstruction = buildReceptionistInstruction(ctxLong, {
  factsBlock: formatFacts(buildFacts(ctxLong)), caps,
  conversationContext: MEMORY, availabilityBlock: AVAIL_BLOCK, bookingBlock: BOOKING_BLOCK, stuckTurns: 2,
});

const HEAVY_MSG =
  "למה את שוב שואלת אותי? אמרתי לך כבר שאני רוצה פן ביום שני, ותסבירי לי גם למה אין מקום בערב, מה בדיוק המדיניות ביטולים שלכם, והאם אפשר להזיז את התור הקיים שלי מיום חמישי";

async function probeHeavy(label: string, model: string, genCfg: Record<string, unknown>): Promise<void> {
  const body = {
    systemInstruction: { parts: [{ text: heavyInstruction }] },
    contents: [{ role: "user", parts: [{ text: HEAVY_MSG }] }],
    generationConfig: genCfg,
  };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  const j = await res.json() as {
    error?: { message?: string };
    candidates?: { finishReason?: string; content?: { parts?: Part[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
  };
  console.log(`\n=== ${label} [${model}] ===`);
  if (!res.ok) { console.log(`HTTP ${res.status}: ${j?.error?.message?.slice(0, 160)}`); return; }
  const cand = j.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("");
  let parsed = "PARSE_FAIL";
  try { JSON.parse(text.trim()); parsed = "OK"; } catch { /* */ }
  const u = j.usageMetadata;
  console.log(`finishReason=${cand?.finishReason} | tokens: prompt=${u?.promptTokenCount} output=${u?.candidatesTokenCount ?? 0} thoughts=${u?.thoughtsTokenCount ?? 0}`);
  console.log(`textLen=${text.length} parse=${parsed}`);
  console.log(`tail: ${text.slice(-130).replace(/\n/g, " ")}`);
}

(async () => {
  console.log(`GEMINI_MODEL env = ${process.env.GEMINI_MODEL ?? "(unset)"}`);
  console.log(`instruction size = ${instruction.length} chars | heavy = ${heavyInstruction.length} chars`);

  const prod = { temperature: 0.4, topP: 0.9, maxOutputTokens: 800, responseMimeType: "application/json" };
  await probe("A: PROD config on flash", "gemini-2.5-flash", prod);
  await probe("B: PROD config on flash-lite (old baseline)", "gemini-2.5-flash-lite", prod);
  await probe("C: flash, maxOutputTokens=4096", "gemini-2.5-flash", { ...prod, maxOutputTokens: 4096 });
  await probe("D: flash, thinkingBudget=0, 800 tokens", "gemini-2.5-flash", { ...prod, thinkingConfig: { thinkingBudget: 0 } });
  await probe("E: flash, thinkingBudget=0, 2048 tokens", "gemini-2.5-flash", { ...prod, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } });

  console.log("\n──────── HEAVY TURN (memory + booking + availability + long setting + complex correction) ────────");
  for (let i = 1; i <= 3; i++) {
    await probeHeavy(`H${i}: HEAVY, PROD config (run ${i})`, "gemini-2.5-flash", prod);
  }
  await probeHeavy("H4: HEAVY on flash-lite", "gemini-2.5-flash-lite", prod);
  await probeHeavy("H5: HEAVY, flash, 4096 tokens", "gemini-2.5-flash", { ...prod, maxOutputTokens: 4096 });
  await probeHeavy("H6: HEAVY, flash, thinkingBudget=0 @800", "gemini-2.5-flash", { ...prod, thinkingConfig: { thinkingBudget: 0 } });
  console.log("\nDONE.");
})();
