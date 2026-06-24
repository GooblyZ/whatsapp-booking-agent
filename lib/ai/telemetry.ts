// lib/ai/telemetry.ts
// PURE observability helpers for the Gemini path — NO I/O at module scope, NO secrets, NO raw customer
// message text. They build structured, analyzable log lines (prompt budget, per-attempt status/latency,
// provider-health transitions). LOGGING ONLY — nothing here changes runtime behavior, routing, retry,
// strikes, or cooldown. The Gemini call path imports these solely to format console telemetry.

import { createHash } from "crypto";

/** ~4 chars/token heuristic — a pre-call ESTIMATE for grouping/analysis when no exact API count exists
 *  yet (the API returns exact counts only on success; this lets FAILED calls be analyzed too). */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

/** Coarse size bucket (boundaries in estimated TOKENS) for grouping prompts in later analysis. */
export type PromptSizeBucket = "xs" | "s" | "m" | "l" | "xl";
export function promptSizeBucket(tokens: number): PromptSizeBucket {
  if (!Number.isFinite(tokens) || tokens < 500) return "xs";
  if (tokens < 1500) return "s";
  if (tokens < 3000) return "m";
  if (tokens < 6000) return "l";
  return "xl";
}

/** Short, stable, ONE-WAY hash (sha256 → first 10 hex). Correlates identical prompts / the same turn
 *  across separate log lines WITHOUT logging any content; never reverses to the source text. "" → "0". */
export function safeHash(text: string): string {
  const t = text ?? "";
  if (t.length === 0) return "0";
  return createHash("sha256").update(t).digest("hex").slice(0, 10);
}

/** LOG-ONLY classification of a non-2xx Gemini response. Does NOT drive retry — isOverloadResponse in
 *  gemini.ts stays the behavior authority; this only adds analysis granularity (503 vs 429 vs auth …). */
export type GeminiErrorClass = "overloaded" | "rate_limit" | "auth" | "bad_request" | "server" | "unknown";
export function classifyGeminiError(status: number, msg = ""): GeminiErrorClass {
  if (status === 503 || /high demand|overloaded|unavailable|resource exhausted/i.test(msg)) return "overloaded";
  if (status === 429 || /rate.?limit|quota/i.test(msg)) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 400 || status === 404 || status === 422) return "bad_request";
  if (status >= 500) return "server";
  return "unknown";
}

/** Serializes a flat record to a stable, grep-friendly `k=v k=v` line (insertion order; nullish → "-").
 *  Booleans/numbers stringify as-is. Used by the structured Gemini telemetry lines. */
export function kv(fields: Record<string, string | number | boolean | null | undefined>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null || v === undefined ? "-" : v}`)
    .join(" ");
}

/** One Gemini ATTEMPT outcome (success OR failure) — the data needed to analyze retries, latency, and
 *  whether failed calls used the same prompt size as successful ones. */
export interface GeminiAttempt {
  turnId?: string;
  attempt: number;
  model: string;
  status: "success" | "api_error" | "network_error";
  httpStatus?: number;
  errorClass?: GeminiErrorClass;
  latencyMs: number;
  recoveryProbe: boolean;
  providerStateBefore: string;
  promptTokensEst: number;
  promptBucket: PromptSizeBucket;
}
/** Builds the `[gemini-attempt] …` structured line. Pure → testable; emitted on EVERY attempt outcome
 *  (success AND failure), so per-attempt latency/status exist even for failed calls. */
export function geminiAttemptLine(a: GeminiAttempt): string {
  return `[gemini-attempt] ` + kv({
    turn: a.turnId,
    attempt: a.attempt,
    model: a.model,
    status: a.status,
    http: a.httpStatus,
    errorClass: a.errorClass,
    latencyMs: a.latencyMs,
    recoveryProbe: a.recoveryProbe,
    providerStateBefore: a.providerStateBefore,
    promptTokensEst: a.promptTokensEst,
    promptBucket: a.promptBucket,
  });
}
