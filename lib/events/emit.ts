import type { DB } from "@/lib/booking/helpers";

/**
 * Event layer (TRANSITION_PLAN.md phase 3).
 *
 * The booking platform DETECTS events; the AI COMMUNICATES them. Events are
 * observations, not commands: emitting must never fail or delay the action
 * that produced the event. Until migration 007 creates the `events` table,
 * inserts fail and are logged — the calling action proceeds normally.
 */
export type PlatformEventType =
  | "appointment_booked"
  | "appointment_cancelled"
  | "appointment_rescheduled"
  | "reminder_due"
  | "waitlist_opportunity"
  | "abandoned_booking"
  | "customer_inactive";

export interface EmitEventInput {
  customerId?: string | null;
  appointmentId?: string | null;
  /** Safe metadata only — NEVER message text, prompts, or full phone numbers. */
  payload?: Record<string, unknown>;
}

export async function emitEvent(
  db: DB, businessId: string, type: PlatformEventType, input: EmitEventInput = {}
): Promise<void> {
  try {
    const { error } = await db.from("events").insert({
      business_id: businessId,
      customer_id: input.customerId ?? null,
      appointment_id: input.appointmentId ?? null,
      type,
      payload: input.payload ?? {},
      status: "pending",
    });
    if (error) {
      // Expected until migration 007 is applied (42P01 = undefined_table).
      console.warn(`[events] emit skipped (${type}): ${error.message}`);
    } else {
      console.log(`[events] emitted ${type} business=${businessId.slice(0, 8)}…`);
    }
  } catch (err) {
    console.warn(`[events] emit failed (${type}):`, err instanceof Error ? err.message : String(err));
  }
}
