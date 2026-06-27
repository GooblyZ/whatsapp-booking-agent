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

import { estimateTokens, promptSizeBucket, classifyGeminiError, geminiAttemptLine, kv } from "./telemetry";

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
// or per conversation. POLICY (Phase 3A — AI-first): a single transient blip must
// NOT drop the product into the deterministic menu. A strike is added per fully-failed
// inbound for any TRANSIENT PROVIDER FAILURE — overload (503/429/"high demand"), a transient
// 5xx (500/502/504), or a timeout/network error (Stage 2b). Strikes map to operating state via
// getGeminiHealth():
//   0 strikes            → healthy   (healthy_ai)
//   1–2 strikes          → transient (degraded_ai — STILL AI-lane: soft fallback, Gemini retried)
//   OVERLOAD_STRIKES (3) consecutive within STRIKE_WINDOW_MS (~90s) → cooldown → outage (deterministic)
// The window means stale strikes spaced far apart don't accumulate toward outage; any success
// clears everything. Cooldown DURATION is unchanged (GEMINI_COOLDOWN_SECONDS, default 60s).
export const OVERLOAD_STRIKES = 3;
export const STRIKE_WINDOW_MS = 90_000;
// Retry backoff with BOUNDED jitter. The breaker is process-global / multi-tenant, so a fixed delay
// risks a synchronized retry storm against an already-stressed provider; jitter spreads the retries.
// Bounded so a retry adds at most RETRY_JITTER_MS to the WhatsApp latency budget.
export const RETRY_DELAY_MS = 1_200;
export const RETRY_JITTER_MS = 400;
/** Retry delay = base + [0, RETRY_JITTER_MS) ms. PURE (rand injectable) → testable. Bounds: [1200, 1600). */
export function retryDelayMs(rand: () => number = Math.random): number {
  const r = Math.min(Math.max(rand(), 0), 0.999999);
  return RETRY_DELAY_MS + Math.floor(r * RETRY_JITTER_MS);
}

function cooldownMs(): number {
  const n = parseInt(process.env.GEMINI_COOLDOWN_SECONDS ?? "", 10);
  return (Number.isFinite(n) && n > 0 ? n : 60) * 1000;
}

let overloadStrikes = 0;
let lastStrikeAt = 0;
let cooldownUntil = 0;

// ── Pure policy helpers (exported for deterministic eval; no module state) ───────
/** The next strike count given the prior count + when the last strike happened. A strike older than
 *  the rolling window doesn't count toward outage — the window restarts at 1. */
export function nextStrikeCount(currentStrikes: number, lastStrikeAtMs: number, nowMs: number): number {
  if (lastStrikeAtMs > 0 && nowMs - lastStrikeAtMs > STRIKE_WINDOW_MS) return 1; // window expired → fresh
  return currentStrikes + 1;
}
/** True once the strike count reaches the outage threshold (→ enter cooldown / deterministic menu). */
export function strikesTripOutage(strikes: number): boolean {
  return strikes >= OVERLOAD_STRIKES;
}
/** Maps raw counters to the operating health state (the same logic getGeminiHealth uses). */
export function providerHealthFromCounters(strikes: number, cooldownRemainingMs: number): GeminiHealthState {
  if (cooldownRemainingMs > 0) return "outage";
  if (strikes > 0) return "transient";
  return "healthy";
}

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
  return { state: providerHealthFromCounters(overloadStrikes, cooldownRemainingMs), strikes: overloadStrikes, cooldownRemainingMs };
}

/** Test/ops hook: clears overload strikes, the rolling-window anchor, and any active cooldown. */
export function resetGeminiHealth(): void {
  overloadStrikes = 0;
  lastStrikeAt = 0;
  cooldownUntil = 0;
}

/** Provider-failure KIND for accurate strike logging (the breaker mechanism is identical for all). */
type ProviderStrikeKind = "overload" | "server" | "timeout" | "network";

function noteProviderStrike(model: string, kind: ProviderStrikeKind): void {
  const now = Date.now();
  overloadStrikes = nextStrikeCount(overloadStrikes, lastStrikeAt, now); // rolling-window aware
  lastStrikeAt = now;
  if (strikesTripOutage(overloadStrikes)) {
    cooldownUntil = now + cooldownMs();
    // OUTAGE: OVERLOAD_STRIKES consecutive transient failures within the window → sustained problem.
    // Serve deterministic menu mode until a recovery probe succeeds (see RECOVERY PROBE below).
    console.warn(
      `[gemini] OUTAGE — model=${model} ${kind} (strike ${overloadStrikes}/${OVERLOAD_STRIKES}` +
      ` within ${Math.round(STRIKE_WINDOW_MS / 1000)}s); cooldown ${Math.round(cooldownMs() / 1000)}s — deterministic until recovery`
    );
  } else {
    // FLAKY/degraded_ai: 1–2 blips → STAY AI-first (soft recovery / resend), no deterministic menu.
    console.warn(
      `[gemini] FLAKY — model=${model} transient ${kind} (strike ${overloadStrikes}/${OVERLOAD_STRIKES});` +
      ` staying AI-first (degraded_ai, soft recovery)`
    );
  }
}

function noteSuccess(): void {
  // A live call SUCCEEDED. If we were degraded (transient or full outage), this is the
  // RECOVERY transition → clear the breaker (incl. the rolling-window anchor) and resume AI-first.
  if (cooldownUntil > 0 || overloadStrikes > 0) {
    console.log(
      `[gemini] RECOVERED — provider healthy again (was ${cooldownUntil > 0 ? "outage" : "transient"});` +
      ` overload state cleared, AI-first resumed`
    );
  }
  overloadStrikes = 0;
  lastStrikeAt = 0;
  cooldownUntil = 0;
}

/** LOG-ONLY: emits a structured `[gemini-health]` line when the provider state/strikes actually changed
 *  around a note*() call. Lets us see flapping (healthy↔degraded) and recovery without changing behavior. */
function logHealthTransition(turnId: string, before: GeminiHealth, reason: string, recoveryProbe: boolean): void {
  const after = getGeminiHealth();
  if (before.state === after.state && before.strikes === after.strikes) return; // no real transition → no noise
  console.log(`[gemini-health] ` + kv({
    turn: turnId,
    stateBefore: before.state, stateAfter: after.state,
    strikesBefore: before.strikes, strikesAfter: after.strikes,
    cooldownBeforeMs: before.cooldownRemainingMs, cooldownAfterMs: after.cooldownRemainingMs,
    reason, recoveryProbe,
  }));
}

/** 503 / high-demand / quota-pressure responses — these get the customer-facing "high load" CODE. */
function isOverloadResponse(status: number, msg: string): boolean {
  return status === 503 || status === 429 ||
    /high demand|overloaded|unavailable|resource exhausted/i.test(msg);
}

/** THE retry-once + strike gate for an HTTP failure (Stage 2b): overload OR a TRANSIENT 5xx
 *  (500/502/504 — gateway / generic server / gateway-timeout). Excludes 4xx (client/config/auth) and
 *  non-transient 5xx (e.g. 501). Exported for the policy eval. Timeouts/network errors are handled in the
 *  catch path (they strike but are NOT retried — a 2nd ~12s wait would blow the WhatsApp latency budget). */
export function isTransientProviderStatus(status: number, msg = ""): boolean {
  return isOverloadResponse(status, msg) || status === 500 || status === 502 || status === 504;
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
  /** LOG-ONLY correlation id (e.g. a phone-safe hash from brain.ts) tying this call's `[gemini-attempt]`
   *  / `[gemini-usage]` / `[gemini-health]` lines to its `[gemini-prompt]` line. Never the raw phone. */
  turnId?: string;
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
    noteProviderStrike(model, "overload");
    return { ok: false, code: "overloaded", error: "Simulated 503 (high demand)" };
  }

  // ── Observability (LOG-ONLY): pre-call prompt-size estimate + provider state, captured ONCE so they
  //    are available for BOTH the success and failure paths (failed calls can be analyzed too). No
  //    behavior change — these only feed the structured `[gemini-attempt]` / `[gemini-health]` lines.
  const turnId = opts.turnId ?? "-";
  const promptChars = systemInstruction.length +
    contents.reduce((n, c) => n + c.parts.reduce((m, p) => m + p.text.length, 0), 0);
  const promptTokensEst = estimateTokens(promptChars);
  const promptBucket = promptSizeBucket(promptTokensEst);
  const recoveryProbe = overloadStrikes > 0;
  const providerStateBefore = getGeminiHealth().state;

  // HALF-OPEN recovery probe: if we're still carrying overload strikes (the cooldown just
  // expired, or we're in the transient/flaky window) this live call is the probe that decides
  // whether AI is restored (noteSuccess) or we stay degraded (noteProviderStrike). Logged so the
  // recovery attempt is explicit, not implicit.
  if (recoveryProbe) {
    console.log(
      `[gemini] RECOVERY PROBE — live call after degraded state (strikes=${overloadStrikes},` +
      ` cooldown ${isGeminiCoolingDown() ? "active" : "expired"})`
    );
  }

  // One quick in-call retry on overload — most 503s are per-request transients.
  for (let attempt = 1; attempt <= 2; attempt++) {
  const attemptStartedAt = Date.now(); // per-attempt latency anchor (success + failure)
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
      console.log(geminiAttemptLine({
        turnId, attempt, model, status: "api_error", httpStatus: res.status,
        errorClass: classifyGeminiError(res.status, safeMsg), latencyMs: Date.now() - attemptStartedAt,
        recoveryProbe, providerStateBefore, promptTokensEst, promptBucket,
      }));
      // Retry-once + strike for any TRANSIENT provider failure: overload (503/429/high-demand) OR a
      // transient 5xx (500/502/504). The customer-facing CODE stays accurate so the reply is unchanged —
      // true overload → "overloaded" (the "high load" line); a transient 5xx → "api_error" (the generic
      // soft fallback). What's NEW for 5xx is that it now retries once and counts toward the shared breaker.
      if (isTransientProviderStatus(res.status, safeMsg)) {
        // A turn the caller has already SUPERSEDED (a newer inbound arrived) must not retry and must not
        // count toward the global breaker — otherwise obsolete/aggregated burst work amplifies the incident.
        if (opts.abortIfSuperseded && (await opts.abortIfSuperseded())) {
          console.warn(`[gemini] transient provider failure on a SUPERSEDED turn — aborting (no retry, no strike)`);
          return { ok: false, code: overloaded ? "overloaded" : "api_error", error: "superseded during provider failure" };
        }
        if (attempt === 1) {
          await sleep(retryDelayMs());           // one retry, bounded jitter (overload OR transient 5xx)
          continue;
        }
        // Both attempts failed transiently → ONE provider strike (shared breaker).
        const healthBefore = getGeminiHealth();
        noteProviderStrike(model, overloaded ? "overload" : "server");
        logHealthTransition(turnId, healthBefore, overloaded ? "overloaded" : "server_error", recoveryProbe);
        return overloaded
          ? { ok: false, code: "overloaded", error: `Gemini overloaded (${res.status})` }
          : { ok: false, code: "api_error", error: `Gemini API error (${res.status})` };
      }
      // Non-transient non-2xx (4xx client/config/auth, or a non-retryable 5xx like 501) → no retry, no
      // strike (unchanged): a client/config error is not a provider outage and must not trip the breaker.
      return { ok: false, code: "api_error", error: `Gemini API error (${res.status})` };
    }

    // Any successful HTTP round trip means the model is reachable again.
    const latencyMs = Date.now() - attemptStartedAt;
    const healthBefore = getGeminiHealth();
    noteSuccess();
    logHealthTransition(turnId, healthBefore, "success", recoveryProbe);
    console.log(geminiAttemptLine({
      turnId, attempt, model, status: "success", latencyMs,
      recoveryProbe, providerStateBefore, promptTokensEst, promptBucket,
    }));

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
        `[gemini-usage] turn=${turnId} model=${usage.model} in=${usage.promptTokens} out=${usage.outputTokens}` +
        ` thoughts=${usage.thoughtTokens} total=${usage.totalTokens}` +
        ` estCost=$${usage.estCostUSD !== null ? usage.estCostUSD.toFixed(6) : "?"}` +
        ` latencyMs=${latencyMs} attempt=${attempt}`
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
    console.log(geminiAttemptLine({
      turnId, attempt, model, status: "network_error",
      errorClass: "unknown", latencyMs: Date.now() - attemptStartedAt,
      recoveryProbe, providerStateBefore, promptTokensEst, promptBucket,
    }));
    // A genuine TIMEOUT or network error (NOT a supersede — that returned above) is a transient provider
    // failure → ONE strike on the shared breaker, so repeated timeouts/network errors close together
    // eventually protect the system (3-in-window → cooldown → deterministic). Deliberately NOT retried: a
    // 2nd up-to-12s wait would blow the WhatsApp latency budget, so a single one stays AI-first (soft fallback).
    const healthBefore = getGeminiHealth();
    noteProviderStrike(model, aborted ? "timeout" : "network");
    logHealthTransition(turnId, healthBefore, aborted ? "timeout" : "network_error", recoveryProbe);
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
