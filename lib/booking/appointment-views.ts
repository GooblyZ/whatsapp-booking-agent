// lib/booking/appointment-views.ts
// PURE — no I/O, no DB, no env, no logging. Classifies an appointment row into the dashboard's two
// operational views: ACTIVE (still needs attention) vs HISTORY (a preserved record). Nothing here
// mutates or deletes a row; history rows stay in the DB untouched for stats / customer history /
// revenue / debugging. This is dashboard SEPARATION, never deletion.
//
// The ACTIVE/HISTORY boundary uses the SAME grace window the jobs runner uses to auto-complete a
// finished confirmed appointment (lib/events/process.ts AUTO_COMPLETE_GRACE_MS). So the dashboard and
// the cron agree on exactly when a past 'confirmed' appointment stops being operationally active —
// even before the cron has flipped its status to 'completed'. The two constants MUST stay equal; the
// reliability eval (§24) asserts ACTIVE_GRACE_MS === AUTO_COMPLETE_GRACE_MS so they can never drift.
// (Kept as a standalone constant rather than importing it, so this pure helper does not drag the
//  whole event-processor module graph into the dashboard server component.)

/** Grace after end_time during which a just-finished appointment is still shown as ACTIVE. */
export const ACTIVE_GRACE_MS = 60 * 60 * 1000; // 1 hour — MUST equal AUTO_COMPLETE_GRACE_MS (eval §24)

/** The two dashboard views. */
export type AppointmentView = "active" | "history";

/** Minimal row shape needed to classify. The dashboard AppRow is a superset of this. */
export interface LifecycleRow {
  status: string;
  start_time: string;
  end_time: string | null;
}

/** Statuses that are still operationally open (not terminal). */
const OPEN_STATUSES = new Set(["pending", "confirmed"]);

/**
 * ACTIVE = still operationally relevant:
 *   - status is OPEN (pending | confirmed), AND
 *   - the appointment has not ended longer than the grace window ago.
 *
 * Terminal statuses (completed | cancelled | no_show) are NEVER active — terminal status wins, even
 * for a future-dated row (a cancelled or completed FUTURE appointment is history). Time reference is
 * end_time, falling back to start_time when end_time is missing. A row whose timestamps can't be
 * parsed but still has an open status is kept ACTIVE — never bury an operational row over a bad
 * timestamp. Absolute-time comparison (never the business timezone), matching the auto-complete job.
 */
export function isActiveAppointment(row: LifecycleRow, now: Date): boolean {
  if (!OPEN_STATUSES.has(row.status)) return false;
  const ref = row.end_time ?? row.start_time;
  const t = ref ? new Date(ref).getTime() : NaN;
  if (Number.isNaN(t)) return true; // open status, unknown/unparseable time → keep visible/operational
  return t >= now.getTime() - ACTIVE_GRACE_MS;
}

/** HISTORY is the exact complement of ACTIVE — every row lands in exactly one view, never both/neither. */
export function isHistoryAppointment(row: LifecycleRow, now: Date): boolean {
  return !isActiveAppointment(row, now);
}

/** Keeps only the rows that belong to `view`. Pure filter; input order is preserved (no row dropped). */
export function filterAppointmentsForView<T extends LifecycleRow>(rows: T[], view: AppointmentView, now: Date): T[] {
  return rows.filter((r) => (view === "active" ? isActiveAppointment(r, now) : isHistoryAppointment(r, now)));
}
