// lib/ai/turn-registry.ts
// Server-side only. PURE in-process state (no DB, no I/O) — safe in a single-process
// runtime (the webhook is served by one `next start` process; see WhatsApp runtime notes).
//
// PER-CONVERSATION SINGLE-FLIGHT (turn ownership).
//
// The pipeline (debounce → aggregate → runPlatformTurn) coalesces most rapid fragments, but
// it relied on DB supersede polls and could NOT cancel an already-in-flight Gemini call. So an
// obsolete fragment's call still completed, could 503 + retry, and could poison the (process-
// global) overload cooldown — app-amplifying a provider incident (live evidence: a 2nd
// "היי אשמח לדעת" reached `[gemini-prompt]` and was only then superseded by the burst).
//
// This makes ONE turn authoritative per (business, customer): starting a new turn ABORTS the
// previous turn's AbortSignal. Wired into the Gemini client, that signal CANCELS the obsolete
// in-flight request — no completion, no retry, no provider-health side effect — and gives every
// guard a race-free, in-process supersede check (`isCurrentTurn`) instead of a DB poll.
//
// This does NOT serialize execution (it is not a mutex): overlapping turns may briefly run, but
// only the LATEST is authoritative and the older one's model call is cancelled. The outbound
// send is still gated by the existing supersede check in the router, so an obsolete turn never
// replies. Cleanup is best-effort: each conversation keeps at most ONE entry (overwritten per
// turn), so the map is bounded by the number of distinct active conversations.

type Key = string;
interface Entry {
  token: number;
  controller: AbortController;
}

const active = new Map<Key, Entry>();
let seq = 0;

export interface TurnHandle {
  key: Key;
  token: number;
  /** Aborts when a NEWER turn for the same conversation begins — pass to the Gemini client. */
  signal: AbortSignal;
}

const keyFor = (businessId: string, customerId: string): Key => `${businessId}:${customerId}`;

/**
 * Claims the conversation for a new turn and ABORTS the previous in-flight turn (if any). The
 * returned `signal` fires when a still-newer turn supersedes THIS one. Call once at turn entry.
 */
export function beginTurn(businessId: string, customerId: string): TurnHandle {
  const key = keyFor(businessId, customerId);
  const prev = active.get(key);
  if (prev) prev.controller.abort(); // supersede the older turn — cancels its in-flight model call
  const controller = new AbortController();
  const token = ++seq;
  active.set(key, { token, controller });
  return { key, token, signal: controller.signal };
}

/** True iff this turn is still the authoritative (latest) one for its conversation. Race-free,
 *  in-process — use anywhere a turn must decide whether to keep doing work / send a reply. */
export function isCurrentTurn(h: TurnHandle): boolean {
  return active.get(h.key)?.token === h.token;
}

/** Releases the slot IFF we still own it (a newer turn may already have replaced us). Optional
 *  cleanup — `beginTurn` overwrites a stale entry anyway, so a missed call only retains one
 *  (tiny) entry per conversation. */
export function endTurn(h: TurnHandle): void {
  const cur = active.get(h.key);
  if (cur && cur.token === h.token) active.delete(h.key);
}

/** Number of conversations with a live entry — test/observability only. */
export function activeTurnCount(): number {
  return active.size;
}

/** Test hook: clears all registry state. */
export function resetTurnRegistry(): void {
  active.clear();
  seq = 0;
}
