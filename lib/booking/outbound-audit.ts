// lib/booking/outbound-audit.ts
// PURE "no unsolicited send" classifier — no I/O, no DB, no network. Observability only.
//
// Invariant: a CONVERSATIONAL (reactive) outbound — one produced in response to a customer message —
// should be tied to a recent inbound from that customer. Proactive SYSTEM sends (reminders, waitlist,
// booking confirmations, dashboard, recovery) are legitimately NOT tied to an inbound → EXEMPT. An
// `unknown` (or any future/unlisted) source is NEVER treated as safe: it is fail-open but always
// surfaced as `unknown_source` so an unlabeled send can't hide.
//
// HEURISTIC, not proof: "an inbound within N seconds" does not PROVE that inbound caused this send, and
// a slow Gemini + retry could push a legitimate reply just past N. The verdict is an INVESTIGATION
// SIGNAL (logged with full metadata at the call site), never a gate — it must never block a send.

import type { OutboundSource } from "./outbound";

/** Sources that MUST be caused by a customer message (a reply). */
export const REACTIVE_SOURCES: ReadonlySet<OutboundSource> = new Set<OutboundSource>(["ai_turn", "deterministic"]);

/** Sources that are legitimately proactive (system-initiated) — exempt from the inbound-recency check. */
export const EXEMPT_SOURCES: ReadonlySet<OutboundSource> = new Set<OutboundSource>([
  "job_reminder", "job_waitlist", "booking_platform", "dashboard", "recovery",
]);

/** A reactive send is "solicited" iff an inbound arrived within this window before it. Covers Gemini
 *  latency + the 60 s burst window + one retry; a true ghost has NO inbound for the whole gap. */
export const DEFAULT_MAX_SOLICIT_GAP_MS = 300_000; // 5 minutes

export type OutboundVerdict = "solicited" | "unsolicited" | "exempt" | "unknown_source";

/** True for the conversational sources that must follow a customer message. */
export function isReactiveSource(source: OutboundSource): boolean {
  return REACTIVE_SOURCES.has(source);
}

export interface ClassifyInput {
  source: OutboundSource;
  /** ms epoch of the most recent inbound from this customer, or null if none in range. */
  lastInboundAtMs: number | null;
  /** ms epoch of the send. */
  nowMs: number;
  maxGapMs?: number;
}

/**
 * PURE verdict for one outbound.
 * - `unknown` (or any source not in REACTIVE ∪ EXEMPT) → "unknown_source" (never assumed safe).
 * - known proactive source → "exempt".
 * - reactive: inbound within maxGapMs (inclusive) → "solicited"; missing or older → "unsolicited".
 */
export function classifyOutbound(input: ClassifyInput): OutboundVerdict {
  const { source, lastInboundAtMs, nowMs } = input;
  const maxGapMs = input.maxGapMs ?? DEFAULT_MAX_SOLICIT_GAP_MS;

  if (EXEMPT_SOURCES.has(source)) return "exempt";
  if (!REACTIVE_SOURCES.has(source)) return "unknown_source"; // unknown + any future/unlisted source

  if (lastInboundAtMs === null) return "unsolicited";
  const gapMs = nowMs - lastInboundAtMs;
  // A future-dated inbound (minor clock skew) still counts as present; only "too old / missing" flags.
  return gapMs <= maxGapMs ? "solicited" : "unsolicited";
}

/** Gap in ms between a send and the last inbound (null when there was none). Logging/reporting only. */
export function solicitGapMs(lastInboundAtMs: number | null, nowMs: number): number | null {
  return lastInboundAtMs === null ? null : nowMs - lastInboundAtMs;
}
