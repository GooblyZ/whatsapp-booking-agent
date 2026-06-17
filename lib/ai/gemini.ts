// lib/ai/gemini.ts
// Server-side only — never import in client components.
//
// Thin client for the Google Gemini API (Generative Language REST API).
// Responsibilities:
//   - read GEMINI_API_KEY / GEMINI_MODEL from the environment
//   - call the generateContent endpoint, forcing JSON output
//   - support BOTH single-turn and multi-turn (conversation memory) calls
//   - never log the API key (URL with the key is never logged; messages are redacted)
//   - never throw — always return a typed GeminiResult
//
// This module knows nothing about the business, the prompt, or intents.
// It only sends a system instruction + conversation turns and returns raw text.

// Single production model (no routing, no classifier, no fallback model).
// Override via GEMINI_MODEL env var.
const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const REQUEST_TIMEOUT_MS = 12_000;
// Generous output budget. On thinking models (gemini-2.5-flash*) thinking tokens
// are charged against this same cap (verified: 800 was consumed almost entirely
// by thinking on heavy turns → truncated JSON). Harmless headroom on flash-lite.
const MAX_OUTPUT_TOKENS = 4096;

export type GeminiErrorCode = "not_configured" | "api_error" | "network" | "empty" | "overloaded";

// ── Overload health (process-global) ──────────────────────────────────────────
//
// Gemini 503 "high demand" is an UPSTREAM condition shared by every business
// served by this process — so the cooldown is process-global, NOT per business
// or per conversation. After OVERLOAD_STRIKES consecutive overload failures,
// callers that check isGeminiCoolingDown() (the conversation engine) stop
// calling Gemini for a short window and serve turns deterministically. Any
// successful response clears the state immediately.
const OVERLOAD_STRIKES = 2;
const RETRY_DELAY_MS = 1_200;

function cooldownMs(): number {
  const n = parseInt(process.env.GEMINI_COOLDOWN_SECONDS ?? "", 10);
  return (Number.isFinite(n) && n > 0 ? n : 60) * 1000;
}

let overloadStrikes = 0;
let cooldownUntil = 0;

/** True while the engine should skip Gemini and serve deterministically. */
export function isGeminiCoolingDown(): boolean {
  return Date.now() < cooldownUntil;
}

export function geminiCooldownRemainingMs(): number {
  return Math.max(0, cooldownUntil - Date.now());
}

// ── Provider-health SNAPSHOT (explainable + testable) ────────────────────────────
// One typed view of the process-global breaker, so callers/observability read a single
// state instead of poking at isGeminiCoolingDown() in scattered places:
//   healthy   — no recent overload; the AI path is fully trusted.
//   transient — ≥1 overload strike but below the cooldown threshold: a brief/ FLAKY blip.
//               The engine keeps the AI experience (soft recovery), NOT deterministic menu.
//   outage    — cooldown active: a SUSTAINED outage → serve deterministically (menu mode).
// AI-disabled / config / parse errors are NOT provider health — they're decision branches
// handled upstream; this snapshot is only about the live provider.
export type GeminiHealthState = "healthy" | "transient" | "outage";
export interface GeminiHealth {
  state: GeminiHealthState;
  strikes: number;
  cooldownRemainingMs: number;
}
export function getGeminiHealth(): GeminiHealth {
  const cooldownRemainingMs = geminiCooldownRemainingMs();
  const state: GeminiHealthState =
    cooldownRemainingMs > 0 ? "outage" : overloadStrikes > 0 ? "transient" : "healthy";
  return { state, strikes: overloadStrikes, cooldownRemainingMs };
}

/** Test/ops hook: clears overload strikes and any active cooldown. */
export function resetGeminiHealth(): void {
  overloadStrikes = 0;
  cooldownUntil = 0;
}

function noteOverload(model: string): void {
  overloadStrikes++;
  if (overloadStrikes >= OVERLOAD_STRIKES) {
    cooldownUntil = Date.now() + cooldownMs();
    // healthy/transient → OUTAGE: a sustained provider problem. The engine now serves
    // deterministic menu mode until a recovery probe succeeds (see RECOVERY PROBE below).
    console.warn(
      `[gemini] OUTAGE — model=${model} overloaded (strike ${overloadStrikes});` +
      ` cooldown ${Math.round(cooldownMs() / 1000)}s — engine serves deterministically until recovery`
    );
  } else {
    // healthy → FLAKY/transient: ONE blip. Stay AI-first (soft recovery / resend), do NOT
    // drop into deterministic menu mode over a single 503.
    console.warn(
      `[gemini] FLAKY — model=${model} transient overload (strike ${overloadStrikes}/${OVERLOAD_STRIKES});` +
      ` staying AI-first (soft recovery)`
    );
  }
}

function noteSuccess(): void {
  // A live call SUCCEEDED. If we were degraded (transient or full outage), this is the
  // RECOVERY transition → clear the breaker and resume normal AI-first behavior. Logged so
  // the healthy → degraded → recovered lifecycle is reconstructable from logs.
  if (cooldownUntil > 0 || overloadStrikes > 0) {
    console.log(
      `[gemini] RECOVERED — provider healthy again (was ${cooldownUntil > 0 ? "outage" : "transient"});` +
      ` overload state cleared, AI-first resumed`
    );
  }
  overloadStrikes = 0;
  cooldownUntil = 0;
}

/** 503 / high-demand / quota-pressure responses — transient and retry-worthy. */
function isOverloadResponse(status: number, msg: string): boolean {
  return status === 503 || status === 429 ||
    /high demand|overloaded|unavailable|resource exhausted/i.test(msg);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Token usage + estimated cost for ONE request (from the API's usageMetadata —
 * exact counts, not estimates; only the $ figure is an estimate from the price
 * table below). Safe metadata: no content, no key.
 */
export interface GeminiUsage {
  model: string;
  promptTokens: number;       // input (system instruction + history turns + message)
  outputTokens: number;       // generated candidates (the JSON we parse)
  thoughtTokens: number;      // thinking tokens (billed at the OUTPUT rate)
  totalTokens: number;        // as reported by the API
  estCostUSD: number | null;  // null when the model isn't in the price table
}

// USD per 1M tokens (paid tier, text, ≤200k context) — ESTIMATES for observability,
// not billing truth. Thinking tokens are billed as output tokens.
const PRICE_PER_M: Record<string, { in: number; out: number }> = {
  "gemini-2.5-flash-lite": { in: 0.10, out: 0.40 },
  "gemini-2.5-flash":      { in: 0.30, out: 2.50 },
  "gemini-2.5-pro":        { in: 1.25, out: 10.00 },
};

export type GeminiResult =
  | { ok: true; text: string; usage: GeminiUsage | null }
  | { ok: false; code: GeminiErrorCode; error: string };

/** One conversation turn for multi-turn (memory) calls. */
export interface GeminiTurn {
  role: "user" | "model";
  text: string;
}

/** True when a Gemini API key is configured. Callers can skip Gemini entirely otherwise. */
export function isGeminiConfigured(): boolean {
  return typeof process.env.GEMINI_API_KEY === "string" && process.env.GEMINI_API_KEY.trim().length > 0;
}

/** Resolves the model name from env, falling back to a safe lightweight default. */
export function getGeminiModel(): string {
  const m = process.env.GEMINI_MODEL?.trim();
  return m && m.length > 0 ? m : DEFAULT_MODEL;
}

/**
 * Single-turn JSON request (kept for callers that don't need memory).
 * Never throws. Never logs the API key.
 */
export async function geminiGenerateJSON(
  systemInstruction: string,
  userMessage: string
): Promise<GeminiResult> {
  return callGemini(systemInstruction, [{ role: "user", parts: [{ text: userMessage }] }]);
}

/**
 * Multi-turn JSON request — `turns` is the bounded conversation history with the
 * current customer message as the final "user" turn. Forces JSON output.
 * Never throws. Never logs the API key.
 */
/** Optional per-call hooks. `abortIfSuperseded` lets the CALLER cancel an obsolete turn on a
 *  503: a superseded turn must not retry and must NOT count toward the (process-global) overload
 *  cooldown — otherwise stale/aggregated burst work amplifies a provider incident. */
export interface GeminiCallOptions {
  abortIfSuperseded?: () => Promise<boolean>;
  /** Caller's supersede signal (per-conversation single-flight). When it fires, the in-flight
   *  request is CANCELLED and returns a benign error — never a 503/overload strike. */
  signal?: AbortSignal;
}

export async function geminiGenerateConversation(
  systemInstruction: string,
  turns: GeminiTurn[],
  opts: GeminiCallOptions = {}
): Promise<GeminiResult> {
  const contents = turns
    .filter((t) => t.text.trim().length > 0)
    .map((t) => ({ role: t.role, parts: [{ text: t.text }] }));
  if (contents.length === 0) {
    return { ok: false, code: "empty", error: "No conversation turns provided" };
  }
  return callGemini(systemInstruction, contents, opts);
}

// ── Core call ─────────────────────────────────────────────────────────────────

interface GeminiContent {
  role: "user" | "model";
  parts: { text: string }[];
}

async function callGemini(
  systemInstruction: string, contents: GeminiContent[], opts: GeminiCallOptions = {}
): Promise<GeminiResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, code: "not_configured", error: "GEMINI_API_KEY is not set" };
  }

  const model = getGeminiModel();
  // The key lives ONLY in this URL string. It is never logged.
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

  // Temperature raised from 0.4 → 0.7: with thinking disabled and a large token
  // budget, the bottleneck on reply naturalness is variation, not stability
  // (extraction fields are enum/string copies, validated downstream).
  const generationConfig: Record<string, unknown> = {
    temperature: 0.7,
    topP: 0.95,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    responseMimeType: "application/json",
  };
  // thinkingBudget: 0 disables thinking on 2.5 Flash models (verified fix for
  // malformed_json). Only applied where valid: 2.5-pro rejects 0, and pre-2.5
  // models reject thinkingConfig entirely.
  if (model.includes("2.5") && model.includes("flash")) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const requestBody = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig,
  };

  // Test hook: forces the overload path without a network call (used by the
  // simulation suite to validate degraded mode end to end).
  if (process.env.GEMINI_SIMULATE_OVERLOAD === "1") {
    console.warn("[gemini] SIMULATED overload (GEMINI_SIMULATE_OVERLOAD=1)");
    noteOverload(model);
    return { ok: false, code: "overloaded", error: "Simulated 503 (high demand)" };
  }

  // HALF-OPEN recovery probe: if we're still carrying overload strikes (the cooldown just
  // expired, or we're in the transient/flaky window) this live call is the probe that decides
  // whether AI is restored (noteSuccess) or we stay degraded (noteOverload). Logged so the
  // recovery attempt is explicit, not implicit.
  if (overloadStrikes > 0) {
    console.log(
      `[gemini] RECOVERY PROBE — live call after degraded state (strikes=${overloadStrikes},` +
      ` cooldown ${isGeminiCoolingDown() ? "active" : "expired"})`
    );
  }

  // One quick in-call retry on overload — most 503s are per-request transients.
  for (let attempt = 1; attempt <= 2; attempt++) {
  // Superseded before this attempt (e.g. during the retry backoff) → stop, benignly.
  if (opts.signal?.aborted) {
    return { ok: false, code: "network", error: "Gemini request superseded (newer turn)" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // Link the caller's supersede signal: a newer turn for the same conversation cancels this
  // in-flight request (no completion, no retry, no overload strike).
  const onSupersede = () => controller.abort();
  if (opts.signal) opts.signal.addEventListener("abort", onSupersede, { once: true });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!res.ok) {
      const safeMsg = await extractApiError(res);
      const overloaded = isOverloadResponse(res.status, safeMsg);
      console.error(
        `[gemini] api error — status=${res.status} model=${model} attempt=${attempt}` +
        `${overloaded ? " (overloaded)" : ""} msg=${safeMsg}`
      );
      if (overloaded) {
        // A turn the caller has already SUPERSEDED (a newer inbound arrived) must not retry and
        // must not count toward the global cooldown — otherwise obsolete/aggregated burst work
        // amplifies the incident. Checked only on the (rare) failure path.
        if (opts.abortIfSuperseded && (await opts.abortIfSuperseded())) {
          console.warn(`[gemini] overloaded turn is SUPERSEDED — aborting (no retry, no cooldown strike)`);
          return { ok: false, code: "overloaded", error: "superseded during overload" };
        }
        if (attempt === 1) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        noteOverload(model);
        return { ok: false, code: "overloaded", error: `Gemini overloaded (${res.status})` };
      }
      return { ok: false, code: "api_error", error: `Gemini API error (${res.status})` };
    }

    // Any successful HTTP round trip means the model is reachable again.
    noteSuccess();

    const json: unknown = await res.json().catch(() => null);
    const text = extractText(json);

    // Permanent diagnostic: a non-STOP finish (MAX_TOKENS, SAFETY, …) is always
    // abnormal here — log safe metadata so truncation is self-diagnosing.
    const meta = extractFinishMeta(json);
    if (meta.finishReason && meta.finishReason !== "STOP") {
      console.warn(
        `[gemini] non-STOP finish — model=${model} finishReason=${meta.finishReason}` +
        ` tokens: prompt=${meta.promptTokens ?? "?"} output=${meta.outputTokens ?? "?"} thoughts=${meta.thoughtTokens ?? 0}`
      );
    }

    // Cost instrumentation: EVERY request logs exact token usage + estimated cost
    // (safe metadata only — counts and model name, never content or the key).
    const usage = buildUsage(model, meta);
    if (usage) {
      console.log(
        `[gemini-usage] model=${usage.model} in=${usage.promptTokens} out=${usage.outputTokens}` +
        ` thoughts=${usage.thoughtTokens} total=${usage.totalTokens}` +
        ` estCost=$${usage.estCostUSD !== null ? usage.estCostUSD.toFixed(6) : "?"}`
      );
    }

    if (!text) {
      const blockReason = extractBlockReason(json);
      console.error(`[gemini] empty/blocked response${blockReason ? ` reason=${blockReason}` : ""}`);
      return { ok: false, code: "empty", error: "Empty Gemini response" };
    }

    return { ok: true, text, usage };
  } catch (err) {
    // A caller-supersede abort is NOT a provider failure — return benign, no retry, no strike.
    if (opts.signal?.aborted) {
      console.warn(`[gemini] request superseded by a newer turn — cancelled (no retry, no cooldown strike)`);
      return { ok: false, code: "network", error: "Gemini request superseded (newer turn)" };
    }
    const msg = redact(err instanceof Error ? err.message : String(err));
    const aborted = err instanceof Error && err.name === "AbortError";
    console.error(`[gemini] request failed${aborted ? " (timeout)" : ""}: ${msg}`);
    return { ok: false, code: "network", error: aborted ? "Gemini request timed out" : "Gemini request failed" };
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onSupersede);
  }
  }
  // Unreachable (the loop always returns) — satisfies the compiler.
  return { ok: false, code: "network", error: "Gemini request failed" };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Removes any `key=...` query value from a string before it is logged. */
function redact(s: string): string {
  return s.replace(/key=[^&\s"']+/gi, "key=***");
}

/** Extracts a safe, redacted error message from a non-2xx response body. */
async function extractApiError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    const message = (body as { error?: { message?: string } })?.error?.message;
    if (typeof message === "string" && message.length > 0) {
      return redact(message.slice(0, 300));
    }
  } catch {
    // ignore — fall through to status text
  }
  return res.statusText || "unknown error";
}

/** Pulls the text out of the first candidate, or null if absent/blocked. */
function extractText(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const candidates = (json as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const first = candidates[0] as { content?: { parts?: unknown } };
  const parts = first?.content?.parts;
  if (!Array.isArray(parts)) return null;

  const text = parts
    .map((p) => (typeof p === "object" && p !== null ? (p as { text?: unknown }).text : undefined))
    .filter((t): t is string => typeof t === "string")
    .join("")
    .trim();

  return text.length > 0 ? text : null;
}

/** Builds the GeminiUsage record from finish metadata (null if the API sent no counts). */
function buildUsage(
  model: string,
  meta: { promptTokens?: number; outputTokens?: number; thoughtTokens?: number }
): GeminiUsage | null {
  if (meta.promptTokens === undefined && meta.outputTokens === undefined) return null;
  const promptTokens = meta.promptTokens ?? 0;
  const outputTokens = meta.outputTokens ?? 0;
  const thoughtTokens = meta.thoughtTokens ?? 0;
  const price = PRICE_PER_M[model];
  const estCostUSD = price
    ? (promptTokens * price.in + (outputTokens + thoughtTokens) * price.out) / 1_000_000
    : null;
  return {
    model,
    promptTokens,
    outputTokens,
    thoughtTokens,
    totalTokens: promptTokens + outputTokens + thoughtTokens,
    estCostUSD,
  };
}

/** finishReason + token usage (safe metadata, no content). */
function extractFinishMeta(json: unknown): {
  finishReason: string | null; promptTokens?: number; outputTokens?: number; thoughtTokens?: number;
} {
  if (typeof json !== "object" || json === null) return { finishReason: null };
  const j = json as {
    candidates?: { finishReason?: unknown }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
  const fr = j.candidates?.[0]?.finishReason;
  return {
    finishReason: typeof fr === "string" ? fr : null,
    promptTokens: j.usageMetadata?.promptTokenCount,
    outputTokens: j.usageMetadata?.candidatesTokenCount,
    thoughtTokens: j.usageMetadata?.thoughtsTokenCount,
  };
}

/** Reads a prompt-feedback / safety block reason for logging, if present. */
function extractBlockReason(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const feedback = (json as { promptFeedback?: { blockReason?: unknown } }).promptFeedback;
  const reason = feedback?.blockReason;
  return typeof reason === "string" ? reason : null;
}
