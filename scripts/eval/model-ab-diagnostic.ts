// scripts/eval/model-ab-diagnostic.ts
// DIAGNOSTIC-ONLY model A/B harness (Live QA chunk, Phase C). NOT a runtime call site.
//
// Runs the SAME live-failure fixtures through MULTIPLE Gemini models with the SAME system instruction
// (buildReceptionistInstruction, platform mode, the warm_casual pack), the SAME facts, and the SAME
// generation config the runtime uses — so we can measure whether a STRONGER model materially improves
// reply WORDING / persona / Hebrew on the exact cases that failed live.
//
// SAFETY: never sends WhatsApp, never writes the DB, never touches the process-global provider breaker
// (it calls the REST endpoint directly, bypassing lib/ai/gemini.ts state). Reuses only PURE builders.
// It does NOT change the runtime model — the runtime remains gemini-2.5-flash-lite via GEMINI_MODEL.
//
// INTERPRETATION (must stay honest in any report): a stronger model can improve wording/persona/Hebrew,
// but it CANNOT fix route-level link attachment, deterministic copy, or hard gender gates — those are
// solved in code (platform-turn.ts / kb-relevance.ts / persona.ts / the deterministic constants). This
// harness scores the REPLY TEXT only; routing/link/KB-tier are deterministic and model-independent.
//
// Run: node --env-file=.env.local --import tsx scripts/eval/model-ab-diagnostic.ts
//      MODEL_AB_MODELS="gemini-2.5-flash-lite,gemini-2.5-flash,gemini-2.5-pro" node --env-file=.env.local --import tsx scripts/eval/model-ab-diagnostic.ts

import type { BusinessAIContext } from "../../types/database";
import { buildReceptionistInstruction } from "../../lib/ai/persona";
import { buildFacts, formatFacts, type Capabilities } from "../../lib/ai/facts";
import { buildPromptProfile } from "../../lib/ai/prompt-profile";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const PRICE_PER_M: Record<string, { in: number; out: number }> = {
  "gemini-2.5-flash-lite": { in: 0.10, out: 0.40 },
  "gemini-2.5-flash": { in: 0.30, out: 2.50 },
  "gemini-2.5-pro": { in: 1.25, out: 10.0 },
};

// ── Synthetic context: the live test tenant (warm_casual), business-agnostic minimal facts. ──
function makeCtx(): BusinessAIContext {
  return {
    business: { id: "biz", slug: "test-biz", name: "עסק לדוגמה", timezone: "Asia/Jerusalem" },
    businessSettings: { address: "רחוב הדוגמה 1", city: "תל אביב", booking_enabled: true },
    aiSettings: { ai_enabled: true, emoji_usage: "medium", persona_pack: "warm_casual", assistant_name: "אלי", assistant_gender: "neutral", language: "he" },
    services: [
      { id: "s1", name: "תספורת", duration_minutes: 30, price: 80, active: true },
      { id: "s2", name: "פן ועיצוב", duration_minutes: 45, price: 120, active: true },
      { id: "s3", name: "צביעת שיער", duration_minutes: 90, price: 250, active: true },
    ],
    knowledgeBaseItems: [
      { id: "k1", category: "about", title: "על העסק", content: "עסק ותיק ומקצועי שנותן שירות אישי וחם.", active: true },
      { id: "k2", category: "parking", title: "חניה", content: "יש חניה חופשית ברחוב הסמוך.", active: true },
      { id: "k3", category: "pricing", title: "מחירים", content: "המחירים מתחילים מ-80 ש\"ח.", active: true },
    ],
    businessHours: [],
  } as unknown as BusinessAIContext;
}

// ── Fixtures: the live-failure cases (reply-quality-sensitive). Route/link/KB-tier are deterministic. ──
interface Fixture { name: string; message: string; note: string }
const FIXTURES: Fixture[] = [
  { name: "greeting", message: "היי מה קורה", note: "warm, neutral, WhatsApp-native; no masculine address" },
  { name: "booking_no_service", message: "אני רוצה לקבוע תור", note: "warm; ideally asks which service (link withheld deterministically)" },
  { name: "about_business", message: "תסביר לי קצת על העסק", note: "answer from facts/KB, NOT bot self-intro" },
  { name: "price_question", message: "כמה עולה תספורת?", note: "grounded price, warm close" },
  { name: "unclear", message: "אחשלי בקטע של", note: "do NOT guess a topic; ask a short warm clarification" },
  { name: "cancel_manage", message: "אפשר לבטל את התור?", note: "natural, neutral; not a robotic system label" },
];

// ── Reply-text scorers (heuristics — directional, not a grade). ──
const HB = "֐-׿";
const GENDERED_ADDRESS_RE = new RegExp(
  `(?<![${HB}])(?:אתה|תוכלי?|תרצ[יה]|מעוניינת)(?![${HB}])|(?<![${HB}])את\\s+(?:יכולה|רוצה|צריכה|מעדיפה|בטוחה|חייבת)(?![${HB}])`,
  "g"
);
const SLASH_GENDER_RE = /(?:כתוב|שלח|תוכל|תרצה|בוא|קח|תבחר|תכתוב|רוצה)\s*\/\s*[א-ת]{1,6}/g;
const GUESS_RE = /אני\s+מניח|כנראה\s+התכוונת|אני\s+מבין\s+ש|נראה\s+ש?את[הם]?\s+מתכוונ/;
const ROBOTIC_RE = /(?:בהחלט|ניתן|אנא\s+המתן|במסגרת\s+השירותים|לצורך|באמצעות|אשמח\s+לסייע לך בעניין)/g;
const WARM_RE = /(?:סבבה|מעולה|אין בעיה|בכיף|וואלה|בשמחה|כיף|😊|🙂|✨)/g;
const BOT_INTRO_RE = /(?:אני\s+[א-ת]+,?\s+ה?עוזר|עוזר(?:ת)?\s+הוירטואל|העוזר\/ת|assistant|וירטואל)/i;

function count(re: RegExp, s: string): number {
  const m = s.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  return m ? m.length : 0;
}

interface ModelRun {
  model: string; ok: boolean; error?: string; reply: string;
  genderHits: number; slashHits: number; guessing: boolean; robotic: number; warm: number; botIntro: boolean;
  latencyMs: number; inTok: number; outTok: number; estCostUSD: number | null;
}

async function callModel(model: string, systemInstruction: string, message: string, apiKey: string): Promise<ModelRun> {
  const generationConfig: Record<string, unknown> = {
    temperature: 0.7, topP: 0.95, maxOutputTokens: 4096, responseMimeType: "application/json",
  };
  if (model.includes("2.5") && model.includes("flash")) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: message }] }],
    generationConfig,
  };
  const started = Date.now();
  const base: ModelRun = {
    model, ok: false, reply: "", genderHits: 0, slashHits: 0, guessing: false, robotic: 0, warm: 0,
    botIntro: false, latencyMs: 0, inTok: 0, outTok: 0, estCostUSD: null,
  };
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    base.latencyMs = Date.now() - started;
    if (!res.ok) return { ...base, error: `HTTP ${res.status}` };
    const json = await res.json();
    const parts = json?.candidates?.[0]?.content?.parts;
    const raw = Array.isArray(parts) ? parts.map((p: { text?: string }) => p.text ?? "").join("") : "";
    let reply = "";
    try { reply = JSON.parse(raw)?.reply ?? ""; } catch { reply = raw; }
    const um = json?.usageMetadata ?? {};
    const inTok = um.promptTokenCount ?? 0;
    const outTok = (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0);
    const price = PRICE_PER_M[model];
    return {
      ...base, ok: true, reply, latencyMs: base.latencyMs, inTok, outTok,
      estCostUSD: price ? (inTok * price.in + outTok * price.out) / 1_000_000 : null,
      genderHits: count(GENDERED_ADDRESS_RE, reply),
      slashHits: count(SLASH_GENDER_RE, reply),
      guessing: GUESS_RE.test(reply),
      robotic: count(ROBOTIC_RE, reply),
      warm: count(WARM_RE, reply),
      botIntro: BOT_INTRO_RE.test(reply),
    };
  } catch (err) {
    return { ...base, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const models = (process.env.MODEL_AB_MODELS?.trim() || "gemini-2.5-flash-lite,gemini-2.5-flash")
    .split(",").map((m) => m.trim()).filter(Boolean);

  console.log("=== Model A/B diagnostic (reply-text quality on live-failure fixtures) ===");
  console.log(`Models: ${models.join(" vs ")}`);
  console.log("Scores: gender=masc-address hits · slash=slash-gender hits · guess=guessing · robotic/warm=phrase hits · botIntro=self-intro\n");

  if (!apiKey) {
    console.log("⚠ GEMINI_API_KEY is not set — cannot run the live comparison.");
    console.log("  To run: node --env-file=.env.local --import tsx scripts/eval/model-ab-diagnostic.ts");
    console.log("  Provider config needed: GEMINI_API_KEY (already used by the sim suite). The same key");
    console.log("  works for gemini-2.5-flash / gemini-2.5-pro — no new secret, no production config change.");
    return;
  }

  const ctx = makeCtx();
  const profile = buildPromptProfile(ctx.aiSettings, ctx.business.id);
  const caps: Capabilities = { canAnswer: true, canStartBooking: true, canCancel: false, canReschedule: false };

  for (const fx of FIXTURES) {
    const facts = buildFacts(ctx, { message: fx.message });
    const instruction = buildReceptionistInstruction(ctx, { factsBlock: formatFacts(facts), caps, platformMode: true, profile });
    console.log(`\n──────── ${fx.name} — "${fx.message}"  (want: ${fx.note}) ────────`);
    for (const model of models) {
      const r = await callModel(model, instruction, fx.message, apiKey);
      if (!r.ok) { console.log(`  ${model.padEnd(24)} ERROR ${r.error}`); continue; }
      const flags = [
        r.genderHits ? `gender=${r.genderHits}` : null,
        r.slashHits ? `slash=${r.slashHits}` : null,
        r.guessing ? "GUESS" : null,
        r.robotic ? `robotic=${r.robotic}` : null,
        r.warm ? `warm=${r.warm}` : null,
        r.botIntro ? "botIntro" : null,
      ].filter(Boolean).join(" ");
      console.log(`  ${model.padEnd(24)} ${r.latencyMs}ms in=${r.inTok} out=${r.outTok} $${r.estCostUSD?.toFixed(6) ?? "?"} [${flags || "clean"}]`);
      console.log(`    ↳ ${r.reply.replace(/\n/g, " / ")}`);
    }
  }
  console.log("\nNote: route/link attachment, KB tier, and deterministic copy are model-INDEPENDENT (code).");
  console.log("This harness only compares REPLY-TEXT wording/persona/Hebrew across models.");
}

main().catch((e) => { console.error(e); process.exit(1); });
