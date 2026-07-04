// lib/events/process.ts
// Server-side only.
//
// THE EVENT PROCESSOR (TRANSITION_PLAN.md phases 4–5). Invoked by the jobs
// runner (POST /api/jobs/process). Pure architecture principle:
//
//   The SYSTEM decides (detects matches, due reminders) — here, deterministically.
//   The AI/outbound layer COMMUNICATES — every message goes through sendOutbound,
//   so owner settings (emoji, etc.) are always enforced.
//
// Everything FAILS SOFT until migration 007 creates the events/waitlist tables:
// a missing table is logged and the runner reports zero work, never throws.

import type { DB } from "@/lib/booking/helpers";
import { emitEvent } from "./emit";
import { sendOutboundInteractive } from "@/lib/booking/outbound";
import { confirmationCta } from "@/lib/booking/notifications";
import {
  buildReminderMessage, buildWaitlistFreedSlotMessage, buildWaitlistOpportunityMessage,
} from "@/lib/messaging/templates";
import { sendWindowDecision, SEND_WINDOW_START_HOUR, SEND_WINDOW_END_HOUR } from "@/lib/messaging/send-window";
import { getAppointmentView } from "@/lib/booking/platform";
import { matchWaitlistForSlot, markWaitlistNotified, type FreedSlot } from "@/lib/booking/waitlist";
import { buildBookingLink, buildAppointmentLink } from "@/lib/config";
import type { PlatformEvent } from "@/types/database";

/** Send reminders this many hours before the appointment. */
const REMINDER_LEAD_HOURS = 24;
/** Per freed slot, notify only the first N waitlist entries (FIFO fairness, avoids overbooking races). */
const MAX_WAITLIST_NOTIFY_PER_SLOT = 1;
/** Safety cap per runner invocation. */
const MAX_EVENTS_PER_RUN = 200;
/** Grace after end_time before a finished appointment is auto-completed — so a just-ended (or
 *  slightly-running-over) appointment is never flipped prematurely. Absolute time, not business TZ. */
export const AUTO_COMPLETE_GRACE_MS = 60 * 60 * 1000; // 1 hour

export interface ProcessSummary {
  remindersEnqueued: number;
  appointmentsCompleted: number;
  scanned: number;
  processed: number;
  skipped: number;
  /** Quiet-hours deferrals: the event stayed 'pending' and will send on the first in-window run. */
  deferred: number;
  byType: Record<string, number>;
  note?: string;
}

interface Contact { phone: string; name: string | null; }

async function getCustomerContact(db: DB, customerId: string | null): Promise<Contact | null> {
  if (!customerId) return null;
  const { data } = await db.from("customers").select("phone, name").eq("id", customerId).maybeSingle();
  const phone = (data?.phone as string | null)?.trim();
  return phone ? { phone, name: (data?.name as string | null) ?? null } : null;
}

/** Business timezone for job-driven sends (slug is needed for booking links anyway — one query). */
async function getBusinessSendContext(db: DB, businessId: string): Promise<{ slug: string | null; timezone: string | null }> {
  const { data } = await db.from("businesses").select("slug, timezone").eq("id", businessId).maybeSingle();
  return { slug: (data?.slug as string | null) ?? null, timezone: (data?.timezone as string | null) ?? null };
}

/** Quiet-hours gate for PROACTIVE (job-driven) sends. Returns true when the send must be
 *  DEFERRED (outside the business-local window). Logs every defer + any tz_error (fail-open). */
function shouldDeferProactiveSend(ev: PlatformEvent, timezone: string | null, now: Date): boolean {
  const d = sendWindowDecision(now, timezone);
  if (d.reason === "tz_error") {
    console.warn(`[events] send-window tz_error (business=${ev.business_id}) — failing open (sending)`);
    return false;
  }
  if (!d.allow) {
    console.log(
      `[events] defer type=${ev.type} id=${ev.id} reason=${d.reason} localHour=${d.localHour}` +
      ` window=${SEND_WINDOW_START_HOUR}-${SEND_WINDOW_END_HOUR}`
    );
    return true;
  }
  return false;
}

/**
 * Scans for appointments inside the reminder window with no reminder yet and
 * emits a reminder_due event each (idempotent via existing-event check).
 * Returns the number enqueued. Fail-soft.
 */
export async function enqueueDueReminders(db: DB, now: Date): Promise<number> {
  try {
    const horizon = new Date(now.getTime() + REMINDER_LEAD_HOURS * 3600_000);
    const { data: appts, error } = await db
      .from("appointments")
      .select("id, business_id, customer_id, start_time")
      .in("status", ["pending", "confirmed"])
      .gte("start_time", now.toISOString())
      .lte("start_time", horizon.toISOString())
      .limit(MAX_EVENTS_PER_RUN);
    if (error || !appts || appts.length === 0) return 0;

    const ids = appts.map((a) => a.id as string);
    const { data: existing, error: exErr } = await db
      .from("events")
      .select("appointment_id")
      .eq("type", "reminder_due")
      .in("appointment_id", ids);
    // If the events table is missing, emitEvent below will fail soft anyway.
    const have = new Set((exErr ? [] : existing ?? []).map((e) => e.appointment_id as string));

    let enqueued = 0;
    for (const a of appts) {
      if (have.has(a.id as string)) continue;
      await emitEvent(db, a.business_id as string, "reminder_due", {
        customerId: a.customer_id as string,
        appointmentId: a.id as string,
        payload: { startTime: a.start_time as string },
      });
      enqueued++;
    }
    // Observability: make the idempotency guard auditable — how many due appts were newly enqueued vs.
    // already had a reminder_due event (skipped). Log-only; never changes what gets enqueued.
    const skippedExisting = appts.length - enqueued;
    if (enqueued > 0 || skippedExisting > 0) {
      console.log(`[events] reminders: window=${REMINDER_LEAD_HOURS}h scanned=${appts.length} enqueued=${enqueued} skipped_existing=${skippedExisting}`);
    }
    return enqueued;
  } catch (err) {
    console.error("[events] enqueueDueReminders error:", err instanceof Error ? err.message : String(err));
    return 0;
  }
}

/**
 * PURE eligibility for auto-completion: a CONFIRMED appointment whose end_time is older than
 * (now − grace) is finished and should become 'completed'. ONLY 'confirmed' transitions — every other
 * status (pending / cancelled / completed / no_show) is left untouched, and future / in-progress /
 * within-grace appointments are excluded. Absolute-time comparison (never the business timezone).
 */
export function isAutoCompletable(status: string, endTimeISO: string | null, now: Date): boolean {
  if (status !== "confirmed" || !endTimeISO) return false;
  const end = new Date(endTimeISO).getTime();
  if (Number.isNaN(end)) return false;
  return end < now.getTime() - AUTO_COMPLETE_GRACE_MS;
}

/**
 * Auto-completes finished appointments: status='confirmed' AND end_time < (now − grace) → 'completed'.
 * Deterministic, idempotent (the conditional update only matches still-'confirmed' past rows, so a
 * re-run flips nothing more), and fail-soft (a missing table / error is logged and reported as 0, never
 * thrown). UTC comparison against the timestamptz column — completion is based on absolute time having
 * passed, never the business timezone. Touches ONLY 'confirmed' rows. Returns how many were completed.
 */
export async function completePastAppointments(db: DB, now: Date): Promise<number> {
  try {
    const cutoff = new Date(now.getTime() - AUTO_COMPLETE_GRACE_MS).toISOString();
    const { data, error } = await db
      .from("appointments")
      .update({ status: "completed" })
      .eq("status", "confirmed")
      .lt("end_time", cutoff)
      .select("id");
    if (error) {
      console.warn(`[events] completePastAppointments skipped: ${error.message}`);
      return 0;
    }
    const n = data?.length ?? 0;
    if (n > 0) console.log(`[events] auto-completed ${n} past confirmed appointment(s) (end_time < now − ${AUTO_COMPLETE_GRACE_MS / 60000}m)`);
    return n;
  } catch (err) {
    console.error("[events] completePastAppointments error:", err instanceof Error ? err.message : String(err));
    return 0;
  }
}

/** One compact, auditable line per runner invocation — every job run leaves a trace of what it decided
 *  (completed / reminders enqueued / events scanned·processed·skipped, by type). Observability only:
 *  it reads the already-computed summary and never changes any decision or send. */
function logProcessSummary(s: ProcessSummary): void {
  const byType = Object.entries(s.byType).map(([t, n]) => `${t}=${n}`).join(",") || "none";
  console.log(
    `[events] run summary completed=${s.appointmentsCompleted} remindersEnqueued=${s.remindersEnqueued}` +
    ` scanned=${s.scanned} processed=${s.processed} skipped=${s.skipped} deferred=${s.deferred} byType={${byType}}` +
    (s.note ? ` note="${s.note}"` : "")
  );
}

/** Processes all pending events. Fail-soft; returns a summary for the runner. */
export async function processPendingEvents(db: DB, now: Date = new Date()): Promise<ProcessSummary> {
  const summary: ProcessSummary = { remindersEnqueued: 0, appointmentsCompleted: 0, scanned: 0, processed: 0, skipped: 0, deferred: 0, byType: {} };

  // Lifecycle hygiene: flip finished confirmed appointments to 'completed' so the dashboard no longer
  // shows them as active/approved (the chatbot already ignores past appointments). Fail-soft + idempotent.
  summary.appointmentsCompleted = await completePastAppointments(db, now);
  summary.remindersEnqueued = await enqueueDueReminders(db, now);

  const { data, error } = await db
    .from("events")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(MAX_EVENTS_PER_RUN);

  if (error) {
    summary.note = `events table unavailable: ${error.message}`;
    logProcessSummary(summary);
    return summary;
  }

  const events = (data ?? []) as PlatformEvent[];
  summary.scanned = events.length;

  for (const ev of events) {
    summary.byType[ev.type] = (summary.byType[ev.type] ?? 0) + 1;
    try {
      const outcome = await dispatch(db, ev, now);
      if (outcome === "deferred") {
        // Quiet hours: DEFER, never drop — no status write, the event stays 'pending' and
        // is re-scanned on the next run (delivered on the first in-window run).
        summary.deferred++;
        continue;
      }
      await db
        .from("events")
        .update({ status: outcome, processed_at: new Date().toISOString() })
        .eq("id", ev.id);
      if (outcome === "processed") summary.processed++;
      else summary.skipped++;
    } catch (err) {
      // A single bad event must never abort the batch; leave it pending for retry.
      console.error(`[events] processing ${ev.type} (${ev.id}) failed:`, err instanceof Error ? err.message : String(err));
      summary.skipped++;
    }
  }
  logProcessSummary(summary);
  return summary;
}

/** Returns the new status for the event — "processed" (acted) / "skipped" (no action needed) —
 *  or "deferred" (quiet hours: leave 'pending', send on the first in-window run). */
async function dispatch(db: DB, ev: PlatformEvent, now: Date): Promise<"processed" | "skipped" | "deferred"> {
  switch (ev.type) {
    case "appointment_cancelled":
    case "appointment_rescheduled":
      return notifyWaitlistForFreedSlot(db, ev, now);
    case "reminder_due":
      return sendReminder(db, ev, now);
    case "waitlist_opportunity":
      // Opportunities are emitted already-targeted at a customer; communicate it.
      return sendWaitlistOpportunity(db, ev, now);
    default:
      // booked / inactive / abandoned have no communicator in this slice.
      return "skipped";
  }
}

/** A slot just freed — notify the earliest matching waitlist customer(s). */
async function notifyWaitlistForFreedSlot(db: DB, ev: PlatformEvent, now: Date): Promise<"processed" | "skipped" | "deferred"> {
  const p = ev.payload ?? {};
  const dateISO = (p.dateISO as string) ?? (p.fromDateISO as string);
  const time = (p.time as string) ?? (p.fromTime as string);
  if (!dateISO || !time) return "skipped";

  const slot: FreedSlot = { dateISO, time, serviceId: (p.serviceId as string | null) ?? null };
  const matches = await matchWaitlistForSlot(db, ev.business_id, slot);
  if (matches.length === 0) return "skipped";

  // One query resolves booking-link slug + the quiet-hours timezone.
  const { slug, timezone } = await getBusinessSendContext(db, ev.business_id);
  if (!slug) return "skipped";
  if (shouldDeferProactiveSend(ev, timezone, now)) return "deferred"; // entries stay 'active' — re-matched next run

  let notified = 0;
  for (const entry of matches.slice(0, MAX_WAITLIST_NOTIFY_PER_SLOT)) {
    const contact = await getCustomerContact(db, entry.customer_id);
    if (!contact) continue;
    const link = buildBookingLink(slug, contact.phone);
    const msg = buildWaitlistFreedSlotMessage({ dateISO, time, bookingLink: link });
    // Same clean cta_url mechanism as booking confirmations (URL in the button; text fallback keeps it).
    const cta = confirmationCta(msg, link);
    await sendOutboundInteractive(db, ev.business_id, entry.customer_id, contact.phone, cta.interactive, cta.fallbackText,
      { source: "job_waitlist", reason: "freed_slot", triggerRef: ev.id });
    await markWaitlistNotified(db, entry.id);
    notified++;
  }
  return notified > 0 ? "processed" : "skipped";
}

/** Sends a pre-emitted, already-targeted waitlist opportunity. */
async function sendWaitlistOpportunity(db: DB, ev: PlatformEvent, now: Date): Promise<"processed" | "skipped" | "deferred"> {
  if (!ev.customer_id) return "skipped";
  const contact = await getCustomerContact(db, ev.customer_id);
  if (!contact) return "skipped";
  const { slug, timezone } = await getBusinessSendContext(db, ev.business_id);
  if (!slug) return "skipped";
  if (shouldDeferProactiveSend(ev, timezone, now)) return "deferred";
  const p = ev.payload ?? {};
  const link = buildBookingLink(slug, contact.phone);
  const msg = buildWaitlistOpportunityMessage({
    dateISO: (p.dateISO as string | null) ?? null, time: (p.time as string | null) ?? null, bookingLink: link,
  });
  const cta = confirmationCta(msg, link);
  await sendOutboundInteractive(db, ev.business_id, ev.customer_id, contact.phone, cta.interactive, cta.fallbackText,
    { source: "job_waitlist", reason: "opportunity", triggerRef: ev.id });
  return "processed";
}

/** True when a reminder for this appointment was ALREADY persisted as an outbound message — the
 *  send-level duplicate guard for the pending-retry window (an event left 'pending' after a send whose
 *  status write-back failed would otherwise re-send next run). Reads the migration-012 trace columns;
 *  FAIL-OPEN: any error (columns missing, table quirk) → false, so a guard failure can only ever mean
 *  "behave exactly as before this slice", never a dropped reminder. */
async function reminderAlreadySent(db: DB, businessId: string, appointmentId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("messages")
      .select("id")
      .eq("business_id", businessId)
      .eq("reason", "reminder_due")
      .eq("trigger_ref", appointmentId)
      .limit(1);
    if (error) return false;
    return (data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Sends an upcoming-appointment reminder (quiet-hours gated, duplicate-guarded). */
async function sendReminder(db: DB, ev: PlatformEvent, now: Date): Promise<"processed" | "skipped" | "deferred"> {
  if (!ev.appointment_id) return "skipped";
  const view = await getAppointmentView(db, ev.appointment_id);
  // Only remind for an appointment that is still active and still in the future.
  if (!view || !view.isFuture || (view.status !== "confirmed" && view.status !== "pending")) return "skipped";
  if (!view.customerId) return "skipped";
  const contact = await getCustomerContact(db, view.customerId);
  if (!contact) return "skipped";

  if (shouldDeferProactiveSend(ev, view.business.timezone, now)) return "deferred";
  if (await reminderAlreadySent(db, view.business.id, view.id)) {
    console.log(`[events] reminder already sent (trigger_ref=${view.id}) — skipping duplicate`);
    return "skipped";
  }

  const link = buildAppointmentLink(view.id);
  const msg = buildReminderMessage({
    serviceName: view.serviceName, dateISO: view.dateISO, time: view.time, manageLink: link,
  });
  const cta = confirmationCta(msg, link);
  await sendOutboundInteractive(db, view.business.id, view.customerId, contact.phone, cta.interactive, cta.fallbackText,
    { source: "job_reminder", reason: "reminder_due", triggerRef: view.id });
  return "processed";
}
