// lib/messaging/send-window.ts
// PURE quiet-hours decision for JOB-DRIVEN (proactive) customer messages — appointment
// reminders and waitlist notifications. Replying to a customer is always allowed; this
// window only governs messages the SYSTEM initiates on its own schedule, so a cron run
// at 03:00 UTC can never wake a customer at 05:00–06:00 local (the 2026-07 incident).
//
// Deliberately schema-free (Slice A): one hardcoded default window in BUSINESS-local time
// (businesses.timezone). Per-business configurability is a later, approved-design slice —
// when it lands, only the two constants move into settings; the decision shape stays.
//
// Deferral semantics live in the CALLER (lib/events/process.ts): outside the window an
// event is left 'pending' (defer, never drop) and delivers on the first in-window run.
// PURE: no DB, no network, no Date.now() — the caller passes `now`.

/** Earliest business-local hour a proactive message may be sent (inclusive). */
export const SEND_WINDOW_START_HOUR = 8;
/** Business-local hour from which proactive sends stop (exclusive — 21:00 itself is too late). */
export const SEND_WINDOW_END_HOUR = 21;
/** Fallback when a business has no timezone configured (matches platform.ts's display fallback). */
export const DEFAULT_SEND_TIMEZONE = "Asia/Jerusalem";

export type SendWindowReason = "in_window" | "before_window" | "after_window" | "tz_error";

export interface SendWindowDecision {
  allow: boolean;
  /** Business-local hour (0–23) the decision was made for; null only on tz_error. */
  localHour: number | null;
  reason: SendWindowReason;
}

/** Business-local hour (0–23) of `now` in `timezone`. Throws only on an invalid timezone string. */
export function localHourIn(now: Date, timezone: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" })
    .format(now);
  return parseInt(h, 10) % 24; // some ICU builds emit "24" for midnight even under h23
}

/**
 * Decides whether a proactive (job-driven) message may be sent right now.
 * A null/empty timezone falls back to DEFAULT_SEND_TIMEZONE; an INVALID timezone string
 * fails OPEN (allow, reason "tz_error") — a bad settings row must never silently disable
 * reminders; the caller logs the reason so the bad row is visible.
 */
export function sendWindowDecision(now: Date, timezone: string | null | undefined): SendWindowDecision {
  const tz = timezone?.trim() || DEFAULT_SEND_TIMEZONE;
  let hour: number;
  try {
    hour = localHourIn(now, tz);
  } catch {
    return { allow: true, localHour: null, reason: "tz_error" };
  }
  if (hour < SEND_WINDOW_START_HOUR) return { allow: false, localHour: hour, reason: "before_window" };
  if (hour >= SEND_WINDOW_END_HOUR) return { allow: false, localHour: hour, reason: "after_window" };
  return { allow: true, localHour: hour, reason: "in_window" };
}
