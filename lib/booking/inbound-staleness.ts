// lib/booking/inbound-staleness.ts
// Server-safe, PURE — no DB, no Gemini, no network, no routing. Unit/eval-friendly.
//
// Guards against a delayed / out-of-order Meta webhook triggering a FRESH AI reply hours after the
// customer actually sent the message. The 2026-07-02 incident: authored 16:44:53 IL, delivered to us at
// 23:00:58 IL (~6h16m late — Meta retried a failed delivery on backoff). The handler replied on receipt,
// so in the customer's chat the bot looked like it messaged them spontaneously at 23:01.
//
// This decides ONLY whether to RUN the conversation turn. The inbound is ALWAYS saved for audit BEFORE
// this runs (lib/message-handler.ts), and wamid de-duplication is a SEPARATE, earlier step — this guard
// never marks anything a duplicate and never fires on one. Fail-open: a missing/unusable author
// timestamp never suppresses.

/** Absolute stale-age backstop: an inbound authored more than this before we received it is not answered
 *  (even when there is no newer message to compare against). 60 min is deliberately conservative — normal
 *  webhook latency is seconds, so this never touches a live conversation, yet it decisively catches a
 *  multi-hour delayed delivery like the incident. Tunable. */
export const STALE_INBOUND_SUPPRESS_AFTER_MS = 60 * 60 * 1000; // 60 minutes

/** Floor for the OUT-OF-ORDER guard: it fires only once the delayed message is at least this old, so a
 *  fast LIVE burst (fragments seconds apart, occasionally delivered out of order by Meta) is NEVER
 *  suppressed — those keep their existing debounce/aggregation behavior. 5 min is well beyond the 60s
 *  burst window and any normal delivery jitter, yet still catches a superseded delayed message that is
 *  under the absolute 60-min bound. Tunable. */
export const OUT_OF_ORDER_MIN_AGE_MS = 5 * 60 * 1000; // 5 minutes

export type StaleSuppressReason = "out_of_order" | "too_old";

export interface StaleInboundInput {
  /** True when the wamid was already seen — handled by the separate dedup step; this guard defers. */
  isDuplicate: boolean;
  /** Meta author time in ms (from messages[].timestamp). null = missing/unparseable → never suppress. */
  authorTimestampMs: number | null;
  /** When we received/processed the webhook, in ms. */
  receiptTimeMs: number;
  /** Max author time (ms) among OTHER inbound messages for this business+customer; null if none known. */
  latestPriorInboundMs: number | null;
  /** Absolute stale-age threshold (STALE_INBOUND_SUPPRESS_AFTER_MS). */
  maxAgeMs: number;
  /** Min age before the out-of-order branch may fire (OUT_OF_ORDER_MIN_AGE_MS) — protects fresh bursts. */
  outOfOrderMinAgeMs: number;
}

export interface StaleInboundDecision {
  suppress: boolean;
  reason: StaleSuppressReason | null;
  /** receiptTimeMs − authorTimestampMs, or null when there is no usable author timestamp. */
  ageMs: number | null;
}

const proceed = (ageMs: number | null): StaleInboundDecision => ({ suppress: false, reason: null, ageMs });

/**
 * Decides whether a saved inbound should still drive a conversation turn, or be suppressed as stale /
 * out-of-order. PURE and conservative: it suppresses only when clearly safe to, and defers entirely on
 * duplicates or a missing author timestamp.
 */
export function shouldSuppressStaleInbound(i: StaleInboundInput): StaleInboundDecision {
  // Duplicates are the dedup step's job — never re-decide or re-label them here.
  if (i.isDuplicate) return proceed(null);
  // No usable author timestamp → fail open to existing behavior (never suppress on missing data).
  if (i.authorTimestampMs === null) return proceed(null);

  const ageMs = i.receiptTimeMs - i.authorTimestampMs;

  // A. OUT-OF-ORDER — a strictly-newer inbound (by AUTHOR time) already exists AND this message is old
  //    enough not to be a live-burst fragment. This is the incident's exact shape (newer inbounds at
  //    17:59 and 21:39 already handled when the 16:44 webhook finally arrived).
  if (
    i.latestPriorInboundMs !== null &&
    i.latestPriorInboundMs > i.authorTimestampMs &&
    ageMs > i.outOfOrderMinAgeMs
  ) {
    return { suppress: true, reason: "out_of_order", ageMs };
  }

  // B. ABSOLUTE STALE AGE — authored more than the threshold before receipt (backstop when there is no
  //    newer message to compare against). Strict '>' so exactly-at-threshold still proceeds.
  if (ageMs > i.maxAgeMs) {
    return { suppress: true, reason: "too_old", ageMs };
  }

  return proceed(ageMs);
}
