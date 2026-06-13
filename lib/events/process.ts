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
import { sendOutbound } from "@/lib/booking/outbound";
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

export interface ProcessSummary {
  remindersEnqueued: number;
  scanned: number;
  processed: number;
  skipped: number;
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

function ddmm(dateISO: string): string {
  const [, mo, d] = dateISO.split("-");
  return `${parseInt(d, 10)}/${parseInt(mo, 10)}`;
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
    return enqueued;
  } catch (err) {
    console.error("[events] enqueueDueReminders error:", err instanceof Error ? err.message : String(err));
    return 0;
  }
}

/** Processes all pending events. Fail-soft; returns a summary for the runner. */
export async function processPendingEvents(db: DB, now: Date = new Date()): Promise<ProcessSummary> {
  const summary: ProcessSummary = { remindersEnqueued: 0, scanned: 0, processed: 0, skipped: 0, byType: {} };

  summary.remindersEnqueued = await enqueueDueReminders(db, now);

  const { data, error } = await db
    .from("events")
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(MAX_EVENTS_PER_RUN);

  if (error) {
    summary.note = `events table unavailable: ${error.message}`;
    return summary;
  }

  const events = (data ?? []) as PlatformEvent[];
  summary.scanned = events.length;

  for (const ev of events) {
    summary.byType[ev.type] = (summary.byType[ev.type] ?? 0) + 1;
    try {
      const outcome = await dispatch(db, ev);
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
  return summary;
}

/** Returns the new status for the event: "processed" (acted) or "skipped" (no action needed). */
async function dispatch(db: DB, ev: PlatformEvent): Promise<"processed" | "skipped"> {
  switch (ev.type) {
    case "appointment_cancelled":
    case "appointment_rescheduled":
      return notifyWaitlistForFreedSlot(db, ev);
    case "reminder_due":
      return sendReminder(db, ev);
    case "waitlist_opportunity":
      // Opportunities are emitted already-targeted at a customer; communicate it.
      return sendWaitlistOpportunity(db, ev);
    default:
      // booked / inactive / abandoned have no communicator in this slice.
      return "skipped";
  }
}

/** A slot just freed — notify the earliest matching waitlist customer(s). */
async function notifyWaitlistForFreedSlot(db: DB, ev: PlatformEvent): Promise<"processed" | "skipped"> {
  const p = ev.payload ?? {};
  const dateISO = (p.dateISO as string) ?? (p.fromDateISO as string);
  const time = (p.time as string) ?? (p.fromTime as string);
  if (!dateISO || !time) return "skipped";

  const slot: FreedSlot = { dateISO, time, serviceId: (p.serviceId as string | null) ?? null };
  const matches = await matchWaitlistForSlot(db, ev.business_id, slot);
  if (matches.length === 0) return "skipped";

  // Resolve the business slug once for booking links.
  const { data: biz } = await db.from("businesses").select("slug").eq("id", ev.business_id).maybeSingle();
  const slug = (biz?.slug as string) ?? null;
  if (!slug) return "skipped";

  let notified = 0;
  for (const entry of matches.slice(0, MAX_WAITLIST_NOTIFY_PER_SLOT)) {
    const contact = await getCustomerContact(db, entry.customer_id);
    if (!contact) continue;
    const link = buildBookingLink(slug, contact.phone);
    const msg =
      `התפנה תור ב-${ddmm(dateISO)} בשעה ${time}!\n` +
      `רצינו לעדכן אותך כי ביקשת להיכנס לרשימת ההמתנה. ` +
      `התור פתוח לכל מי שיקבע ראשון:\n${link}`;
    await sendOutbound(db, ev.business_id, entry.customer_id, contact.phone, msg);
    await markWaitlistNotified(db, entry.id);
    notified++;
  }
  return notified > 0 ? "processed" : "skipped";
}

/** Sends a pre-emitted, already-targeted waitlist opportunity. */
async function sendWaitlistOpportunity(db: DB, ev: PlatformEvent): Promise<"processed" | "skipped"> {
  if (!ev.customer_id) return "skipped";
  const contact = await getCustomerContact(db, ev.customer_id);
  if (!contact) return "skipped";
  const { data: biz } = await db.from("businesses").select("slug").eq("id", ev.business_id).maybeSingle();
  const slug = (biz?.slug as string) ?? null;
  if (!slug) return "skipped";
  const p = ev.payload ?? {};
  const when = p.dateISO ? ` ב-${ddmm(p.dateISO as string)}${p.time ? ` בשעה ${p.time}` : ""}` : "";
  const link = buildBookingLink(slug, contact.phone);
  await sendOutbound(
    db, ev.business_id, ev.customer_id, contact.phone,
    `התפנה תור${when}! ביקשת שנעדכן — אפשר לקבוע כאן:\n${link}`
  );
  return "processed";
}

/** Sends an upcoming-appointment reminder. */
async function sendReminder(db: DB, ev: PlatformEvent): Promise<"processed" | "skipped"> {
  if (!ev.appointment_id) return "skipped";
  const view = await getAppointmentView(db, ev.appointment_id);
  // Only remind for an appointment that is still active and still in the future.
  if (!view || !view.isFuture || (view.status !== "confirmed" && view.status !== "pending")) return "skipped";
  if (!view.customerId) return "skipped";
  const contact = await getCustomerContact(db, view.customerId);
  if (!contact) return "skipped";

  const svc = view.serviceName ? ` ל${view.serviceName}` : "";
  const msg =
    `תזכורת ידידותית: יש לך תור${svc} ב-${ddmm(view.dateISO)} בשעה ${view.time}.\n` +
    `אם צריך לשנות או לבטל: ${buildAppointmentLink(view.id)}`;
  await sendOutbound(db, view.business.id, view.customerId, contact.phone, msg);
  return "processed";
}
