// scripts/audit-token-usage.ts
// Token & cost investigation harness — NOT part of the app build.
//
// Measures (READ-ONLY, no optimization, no state writes):
//   A. EXACT per-component prompt token counts (free :countTokens endpoint)
//      using the REAL business context from the live DB.
//   B. "Before" architecture approximation (Phase-1 shape: persona + facts +
//      embedded transcript, no availability / booking / guidance / native turns).
//   C. LIVE replay of a realistic 5-turn Hebrew conversation through the real
//      brain, capturing exact usageMetadata per call (≈5 cheap flash-lite calls).
//   D. Historical call volume from ai_events vs inbound messages (per day) —
//      verifies "one Gemini call per customer message" empirically.
//
// PRIVACY: prints ONLY counts and component names — never message content,
// never phone numbers, never the API key.
//
// Run:  node --env-file=.env.local --import tsx scripts/audit-token-usage.ts

import type { BusinessAIContext } from "../types/database";
import { buildFacts, formatFacts, type Capabilities } from "../lib/ai/facts";
import { buildReceptionistInstruction } from "../lib/ai/persona";
import { runReceptionistTurn } from "../lib/ai/brain";
import {
  emptySession, probeMessage, overlayProbe, mergeUnderstanding, renderSession,
  applyChangeRequests, applyOfferRejection, captureOfferedSlots,
  type BookingSession, type ServiceLite,
} from "../lib/ai/booking-session";
import { renderAvailabilityInfo, buildAvailabilityInfo, type AvailabilityInfo } from "../lib/ai/availability-facts";
import { getGeminiModel, type GeminiUsage } from "../lib/ai/gemini";
import { getBusinessAIContext } from "../lib/ai/context";
import { getConversationContext } from "../lib/ai/conversation";
import { supabaseServer } from "../lib/supabase/server";

const KEY = process.env.GEMINI_API_KEY?.trim();
if (!KEY) { console.error("GEMINI_API_KEY not set"); process.exit(1); }
const MODEL = getGeminiModel();
const API = "https://generativelanguage.googleapis.com/v1beta/models";

// ── exact token counting (free endpoint) ─────────────────────────────────────

async function countText(text: string): Promise<number> {
  if (!text || text.trim().length === 0) return 0;
  const res = await fetch(`${API}/${MODEL}:countTokens?key=${KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text }] }] }),
  });
  const j = (await res.json()) as { totalTokens?: number; error?: { message?: string } };
  if (!res.ok) throw new Error(`countTokens failed: ${j.error?.message ?? res.status}`);
  return j.totalTokens ?? 0;
}

/** Counts the FULL request exactly as generateContent sees it (system + turns). */
async function countFullRequest(
  system: string, turns: { role: "user" | "model"; text: string }[]
): Promise<number | null> {
  const res = await fetch(`${API}/${MODEL}:countTokens?key=${KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      generateContentRequest: {
        model: `models/${MODEL}`,
        systemInstruction: { parts: [{ text: system }] },
        contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
      },
    }),
  });
  const j = (await res.json()) as { totalTokens?: number };
  return res.ok ? (j.totalTokens ?? null) : null;
}

function pct(part: number, total: number): string {
  return total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "-";
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const db = supabaseServer();

  // Real business context (facts, services, KB, AI settings, hours).
  const { data: biz } = await db.from("businesses").select("id, timezone").limit(1).single();
  if (!biz) { console.error("no business row found"); process.exit(1); }
  const ctx: BusinessAIContext = await getBusinessAIContext(biz.id);
  const tz = (biz.timezone as string) || "Asia/Jerusalem";
  const services: ServiceLite[] = ctx.services.filter((s) => s.active)
    .map((s) => ({ id: s.id, name: s.name, duration_minutes: s.duration_minutes }));

  console.log(`model=${MODEL}`);
  console.log(`business ctx: services=${ctx.services.length} kb_items=${ctx.knowledgeBaseItems.length}` +
    ` custom_instructions_len=${ctx.aiSettings?.custom_instructions?.trim().length ?? 0}`);

  // Real recent history for the most recently active customer (counts only — content never printed).
  const { data: recentMsg } = await db.from("messages")
    .select("customer_id").eq("business_id", biz.id)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  let historyTurns: { role: "user" | "model"; text: string }[] = [];
  if (recentMsg?.customer_id) {
    const mem = await getConversationContext(db, biz.id, recentMsg.customer_id as string);
    historyTurns = mem.turns;
  }
  if (historyTurns.length === 0) {
    // Synthetic fallback — typical Hebrew lengths.
    historyTurns = [
      { role: "user", text: "היי, אפשר לקבוע תור?" },
      { role: "model", text: "היי! בטח 🙂 איזה שירות מתאים לך?" },
      { role: "user", text: "פן" },
      { role: "model", text: "מעולה. איזה יום נוח לך?" },
      { role: "user", text: "יום שלישי" },
      { role: "model", text: "יום שלישי פתוח אצלנו 09:00-18:00. איזו שעה בערך מתאימה לך?" },
      { role: "user", text: "סביב 11" },
      { role: "model", text: "ב-11:00 תפוס, אבל יש מקום ב-10:30 או ב-11:15. מה מתאים?" },
    ];
  }

  // Representative mid-conversation booking turn (heaviest realistic shape).
  const session: BookingSession = {
    ...emptySession(), active: true, lifecycle: "book",
    service: services[0]?.name ?? "תספורת", serviceId: services[0]?.id ?? "svc1",
    serviceDurationMin: services[0]?.duration_minutes ?? 30,
    dateISO: tomorrowISO(tz), dateText: "מחר",
    conversationGoal: "לקבוע תור למחר",
  };
  const message = "יש משהו בסביבות 11 בבוקר?";

  const pre = applyChangeRequests(session, message);
  const rej = applyOfferRejection(pre.session, message);
  const probe = probeMessage(message, rej.session, services, tz);
  const preview = overlayProbe(rej.session, probe);

  let avail: AvailabilityInfo | null = null;
  if (probe.dateISO) {
    avail = await buildAvailabilityInfo(db, biz.id, ctx, probe.dateISO, probe.time, probe.service?.duration_minutes ?? null);
  }
  const upcomingBlock =
    "EXISTING APPOINTMENTS (system-checked): this customer has NO upcoming appointment. If they ask to cancel/change one, say honestly that you don't see an active appointment under this number.";
  const bookingBlock = [renderSession(preview), upcomingBlock].filter(Boolean).join("\n\n");
  const availabilityBlock = renderAvailabilityInfo(avail, null, rej.session.rejectedSlots);
  const replyGuidance =
    `Already settled: service=${session.service}, day=${session.dateISO} — do NOT ask about these again.\n` +
    `When it fits naturally — after you've responded to what they actually said — the next helpful step is finding out what time of day suits them. If they asked or raised something else, that comes first; the booking can advance on a later turn.`;

  const facts = buildFacts(ctx);
  const factsBlock = formatFacts(facts);
  const caps: Capabilities = { canAnswer: true, canStartBooking: true, canCancel: false, canReschedule: false };
  const custom = ctx.aiSettings?.custom_instructions?.trim() ?? "";

  const fullInstruction = buildReceptionistInstruction(ctx, {
    factsBlock, caps, conversationContext: "", nativeHistory: true,
    availabilityBlock, bookingBlock, replyGuidance,
  });
  // Persona base = instruction with every injected block empty (and no custom).
  const ctxNoCustom: BusinessAIContext = {
    ...ctx,
    aiSettings: ctx.aiSettings ? { ...ctx.aiSettings, custom_instructions: null } : ctx.aiSettings,
  };
  const baseInstruction = buildReceptionistInstruction(ctxNoCustom, {
    factsBlock: "", caps, conversationContext: "", nativeHistory: true,
  });

  // ── A. component breakdown (exact) ──────────────────────────────────────────
  console.log("\n=== A. PROMPT COMPONENT BREAKDOWN (exact tokens, current architecture) ===");
  const [tFull, tBase, tFacts, tAvail, tBooking, tGuidance, tCustom, tMsg] = await Promise.all([
    countText(fullInstruction), countText(baseInstruction), countText(factsBlock),
    countText(availabilityBlock), countText(bookingBlock), countText(replyGuidance),
    countText(custom), countText(message),
  ]);
  let tHistory = 0;
  for (const t of historyTurns) tHistory += await countText(t.text);
  const fullRequest = await countFullRequest(fullInstruction, [...historyTurns, { role: "user", text: message }]);
  const total = fullRequest ?? tFull + tHistory + tMsg;

  const rows: [string, number][] = [
    ["persona base (voice/rules/schema, fixed)", tBase],
    ["business facts (services+hours+KB+policies)", tFacts],
    ["availability block (system-checked)", tAvail],
    ["booking session + existing appts", tBooking],
    ["reply guidance (system note)", tGuidance],
    ["owner custom instructions", tCustom],
    [`conversation history (${historyTurns.length} turns, native)`, tHistory],
    ["current customer message", tMsg],
  ];
  for (const [name, n] of rows) console.log(`  ${name.padEnd(46)} ${String(n).padStart(6)} tok  ${pct(n, total)}`);
  console.log(`  ${"-".repeat(64)}`);
  console.log(`  system instruction total (exact)               ${String(tFull).padStart(6)} tok`);
  console.log(`  FULL REQUEST as sent (exact)                   ${String(total).padStart(6)} tok${fullRequest === null ? " (sum approx — full-request count unavailable)" : ""}`);
  const structureOverhead = tFull - (tBase + tFacts + tAvail + tBooking + tGuidance + tCustom);
  console.log(`  (instruction framing/joins not in components:  ${String(structureOverhead).padStart(6)} tok)`);

  // ── B. "before" architecture approximation ──────────────────────────────────
  console.log("\n=== B. BEFORE-PIVOT PROMPT SHAPE (approximation, same builder) ===");
  const transcript = historyTurns
    .map((t) => `${t.role === "user" ? "Customer" : "Assistant (you, earlier)"}: ${t.text}`).join("\n");
  const beforeInstruction = buildReceptionistInstruction(ctxNoCustom, {
    factsBlock, caps, conversationContext: transcript, nativeHistory: false,
  });
  const tBefore = await countText(beforeInstruction);
  const beforeTotal = tBefore + tMsg;
  console.log(`  Phase-1 shape (persona+facts+transcript, no availability/booking/guidance/custom):`);
  console.log(`  input ≈ ${beforeTotal} tok per call  vs  current ${total} tok per call  → x${(total / beforeTotal).toFixed(2)}`);
  console.log(`  NOTE: before the AI-first pivot most booking turns were handled by the`);
  console.log(`  deterministic menu (0 Gemini tokens); now EVERY message is a Gemini call.`);

  // ── C. live replay — real usage per call ────────────────────────────────────
  console.log("\n=== C. LIVE REPLAY (5 realistic turns — exact usageMetadata) ===");
  const usages: GeminiUsage[] = [];
  const st: { session: BookingSession; turns: { role: "user" | "model"; text: string }[] } =
    { session: emptySession(), turns: [] };
  const liveMessages = [
    "היי, כמה עולה תספורת?",
    "סבבה. אפשר לקבוע תור למחר?",
    "תספורת",
    "בסביבות 11 בבוקר",
    "ואיפה אפשר לחנות אצלכם?",
  ];
  for (const msg of liveMessages) {
    const p = applyChangeRequests(st.session, msg);
    const r = applyOfferRejection(p.session, msg);
    st.session = r.session;
    const pr = probeMessage(msg, st.session, services, tz);
    let av: AvailabilityInfo | null = null;
    if (pr.dateISO) {
      av = await buildAvailabilityInfo(db, biz.id, ctx, pr.dateISO, pr.time, pr.service?.duration_minutes ?? null);
    }
    const pv = overlayProbe(st.session, pr);
    const d = await runReceptionistTurn(ctx, {
      historyTurns: st.turns, conversationContext: "", message: msg,
      bookingBlock: [renderSession(pv), upcomingBlock].filter(Boolean).join("\n\n"),
      availabilityBlock: renderAvailabilityInfo(av, !pr.dateISO && pr.time ? pr.time : null, st.session.rejectedSlots),
      allowedTimes: av ? [...av.slots, ...(av.requested?.nearest ?? []), ...st.session.rejectedSlots] : st.session.rejectedSlots,
    });
    if (d.turn) {
      const u = d.turn.understanding;
      st.session = mergeUnderstanding(st.session, {
        serviceName: u.serviceName, dateText: u.dateText, time: u.time,
        timePreference: u.timePreference, customerReference: u.customerReference,
        conversationGoal: u.conversationGoal, bookingIntent: u.intent === "booking",
        appointmentIntent: u.appointmentIntent, changeRequest: u.changeRequest,
      }, pr, services, tz, p.cleared).session;
    }
    if (av) st.session = captureOfferedSlots(st.session, d.replyText, av.slots, av.requested?.nearest ?? []);
    st.turns.push({ role: "user", text: msg });
    st.turns.push({ role: "model", text: d.replyText.replace(/\s*\n\s*/g, " ") });
    if (d.usage) usages.push(d.usage);
  }
  if (usages.length > 0) {
    const avgIn = Math.round(usages.reduce((n, u) => n + u.promptTokens, 0) / usages.length);
    const avgOut = Math.round(usages.reduce((n, u) => n + u.outputTokens + u.thoughtTokens, 0) / usages.length);
    const totCost = usages.reduce((n, u) => n + (u.estCostUSD ?? 0), 0);
    console.log(`  calls=${usages.length} avg_in=${avgIn} avg_out=${avgOut}` +
      ` per-call est ≈ $${(totCost / usages.length).toFixed(6)} | per-conversation(5 turns) ≈ $${totCost.toFixed(6)}`);
    console.log(`  per 1,000 conversations of this shape ≈ $${(totCost * 1000).toFixed(2)}`);
  } else {
    console.log("  no usage captured (all calls failed?)");
  }

  // ── D. historical volume: inbound messages vs Gemini calls per day ─────────
  console.log("\n=== D. CALL VOLUME (last 21 days, live DB) ===");
  const sinceISO = new Date(Date.now() - 21 * 86_400_000).toISOString();
  const [{ data: events }, { data: inbound }] = await Promise.all([
    db.from("ai_events").select("created_at, called").eq("business_id", biz.id).gte("created_at", sinceISO),
    db.from("messages").select("created_at").eq("business_id", biz.id).eq("direction", "inbound").gte("created_at", sinceISO),
  ]);
  const byDay = new Map<string, { calls: number; events: number; inbound: number }>();
  const bump = (day: string, k: "calls" | "events" | "inbound") => {
    const r = byDay.get(day) ?? { calls: 0, events: 0, inbound: 0 };
    r[k] += 1; byDay.set(day, r);
  };
  for (const e of events ?? []) {
    const day = (e.created_at as string).slice(0, 10);
    bump(day, "events");
    if (e.called) bump(day, "calls");
  }
  for (const m of inbound ?? []) bump((m.created_at as string).slice(0, 10), "inbound");
  const days = [...byDay.keys()].sort();
  console.log("  day         inbound  ai_events  gemini_calls  calls/inbound");
  for (const day of days) {
    const r = byDay.get(day)!;
    const ratio = r.inbound > 0 ? (r.calls / r.inbound).toFixed(2) : "-";
    console.log(`  ${day}   ${String(r.inbound).padStart(5)}    ${String(r.events).padStart(6)}      ${String(r.calls).padStart(6)}        ${ratio}`);
  }
  console.log("  NOTE: ai_events covers PRODUCTION calls only. Simulation/diagnostic script");
  console.log("  runs and the ai-debug panel call Gemini on the SAME API key but are NOT");
  console.log("  logged to ai_events — they appear in billing, not in this table.");
}

function tomorrowISO(tz: string): string {
  const now = new Date(Date.now() + 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

main().catch((err) => {
  console.error("audit failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
