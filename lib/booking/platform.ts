// lib/booking/platform.ts
// Server-side only.
//
// The deterministic service layer of the BOOKING PLATFORM (TRANSITION_PLAN.md).
// Every function here is AI-free: the web booking pages call these directly,
// and the same availability/INSERT core is shared with the legacy chat path.
// Invariants:
//   - availability for TODAY filters times already in the past (+ lead buffer)
//   - every write re-checks the interval before touching the DB and handles
//     unique-index collisions (concurrent bookings) gracefully
//   - WhatsApp notifications and event emission are fail-open: they never
//     fail the booking action that triggered them

import { type DB, getBusinessTimezone } from "./helpers";
import {
  getAvailableSlots,
  isIntervalFree,
  businessTimeToUTC,
  formatTimeInTZ,
  todayInTZ,
} from "./availability";
import { sendOutbound } from "./outbound";
import { emitEvent } from "@/lib/events/emit";
import { buildAppointmentLink, buildBookingLink } from "@/lib/config";
import { buildCancellationMessage, buildRescheduleMessage, rescheduleChanged } from "./notifications";

/** Customers can't book a slot starting sooner than this from "now". */
const MIN_LEAD_MINUTES = 15;

/** How many days ahead the booking page offers. */
export const BOOKING_WINDOW_DAYS = 14;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PlatformBusiness {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

export interface PlatformService {
  id: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  price: number | null;
}

export type BookingFailure =
  | "invalid_input"
  | "service_not_found"
  | "slot_taken"
  | "past_date"
  | "db_error";

export type BookingResult =
  | { ok: true; appointmentId: string }
  | { ok: false; reason: BookingFailure; freshSlots?: string[] };

export interface AppointmentView {
  id: string;
  status: string;
  dateISO: string;       // business-local YYYY-MM-DD
  time: string;          // business-local HH:MM
  durationMinutes: number;
  serviceId: string | null;
  serviceName: string | null;
  customerId: string | null;
  customerPhone: string | null;
  business: PlatformBusiness;
  customerName: string | null;
  isFuture: boolean;
}

// ── Lookup ─────────────────────────────────────────────────────────────────────

export async function getBusinessBySlug(db: DB, slug: string): Promise<PlatformBusiness | null> {
  const { data } = await db
    .from("businesses")
    .select("id, name, slug, timezone")
    .eq("slug", slug)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id as string,
    name: data.name as string,
    slug: data.slug as string,
    timezone: (data.timezone as string) || "Asia/Jerusalem",
  };
}

export async function listBookableServices(db: DB, businessId: string): Promise<PlatformService[]> {
  const { data } = await db
    .from("services")
    .select("id, name, description, duration_minutes, price")
    .eq("business_id", businessId)
    .eq("active", true)
    .order("name");
  return (data ?? []) as PlatformService[];
}

// ── Availability (with the past-time fix the chat path never had) ─────────────

/**
 * Earliest bookable "HH:MM" for the given date — null when the whole day is
 * bookable (i.e. the date is not today). Lexicographic compare on "HH:MM" is safe.
 */
function bookableCutoff(dateISO: string, timezone: string): string | null {
  if (dateISO !== todayInTZ(timezone)) return null;
  return formatTimeInTZ(new Date(Date.now() + MIN_LEAD_MINUTES * 60_000), timezone);
}

/**
 * Slots for one day, excluding times that already passed today (+ lead buffer).
 */
export async function getPlatformDaySlots(
  db: DB, businessId: string, dateISO: string, durationMinutes: number, timezone: string
): Promise<string[]> {
  const slots = await getAvailableSlots(db, businessId, dateISO, durationMinutes, timezone);
  const cutoff = bookableCutoff(dateISO, timezone);
  return cutoff ? slots.filter((t) => t > cutoff) : slots;
}

/** The next N bookable dates (business-local), starting today. */
export function upcomingDates(timezone: string, days = BOOKING_WINDOW_DAYS): string[] {
  const today = todayInTZ(timezone);
  const base = new Date(today + "T12:00:00Z");
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().split("T")[0]);
  }
  return out;
}

// ── Customer identity ──────────────────────────────────────────────────────────

/**
 * Normalizes a phone number to the digits-only international format the
 * WhatsApp pipeline stores (e.g. "0501234567" → "972501234567").
 * Returns null when the input can't be a valid phone number.
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s\-().+]/g, "");
  if (!/^\d{9,15}$/.test(digits)) return null;
  if (digits.startsWith("0") && digits.length === 10) return "972" + digits.slice(1);
  if (digits.startsWith("9720")) return "972" + digits.slice(4); // "+972 05x…" typo form
  return digits;
}

/** Finds or creates the customer; fills in the name when we learn it. */
export async function ensurePlatformCustomer(
  db: DB, businessId: string, phone: string, name: string
): Promise<string | null> {
  const { data: existing } = await db
    .from("customers")
    .select("id, name")
    .eq("business_id", businessId)
    .eq("phone", phone)
    .maybeSingle();

  if (existing) {
    const hasName = typeof existing.name === "string" && existing.name.trim().length > 0;
    if (!hasName && name) {
      await db.from("customers").update({ name }).eq("id", existing.id as string);
    }
    return existing.id as string;
  }

  const { data: created, error } = await db
    .from("customers")
    .insert({ business_id: businessId, phone, name: name || null })
    .select("id")
    .single();
  if (error) {
    // Race with a concurrent insert → fetch the winner.
    const { data: winner } = await db
      .from("customers")
      .select("id")
      .eq("business_id", businessId)
      .eq("phone", phone)
      .maybeSingle();
    return (winner?.id as string) ?? null;
  }
  return created.id as string;
}

// ── Booking ────────────────────────────────────────────────────────────────────

export interface CreateBookingInput {
  businessId: string;
  serviceId: string;
  dateISO: string;   // business-local YYYY-MM-DD
  time: string;      // business-local HH:MM
  phone: string;     // already normalized
  name: string;      // 2–50 chars, validated by the caller
}

export async function createPlatformBooking(db: DB, input: CreateBookingInput): Promise<BookingResult> {
  const timezone = await getBusinessTimezone(db, input.businessId);

  if (input.dateISO < todayInTZ(timezone)) return { ok: false, reason: "past_date" };

  const { data: service } = await db
    .from("services")
    .select("id, name, duration_minutes")
    .eq("id", input.serviceId)
    .eq("business_id", input.businessId)
    .eq("active", true)
    .maybeSingle();
  if (!service) return { ok: false, reason: "service_not_found" };
  const duration = (service.duration_minutes as number) ?? 30;

  // The same pre-write safety the chat path uses — plus the past-time cutoff
  // (isIntervalFree has no concept of "now", so the cutoff is checked first).
  const cutoff = bookableCutoff(input.dateISO, timezone);
  if (cutoff && input.time <= cutoff) return { ok: false, reason: "past_date" };

  const offered = await getPlatformDaySlots(db, input.businessId, input.dateISO, duration, timezone);
  const stillFree =
    offered.includes(input.time) ||
    (await isIntervalFree(db, input.businessId, input.dateISO, input.time, duration, timezone));
  if (!stillFree) {
    return { ok: false, reason: "slot_taken", freshSlots: offered };
  }

  const customerId = await ensurePlatformCustomer(db, input.businessId, input.phone, input.name);
  if (!customerId) return { ok: false, reason: "db_error" };

  const startTime = businessTimeToUTC(input.dateISO, input.time, timezone);
  const endTime = new Date(startTime.getTime() + duration * 60_000);

  const row = {
    business_id: input.businessId,
    customer_id: customerId,
    service_id: input.serviceId,
    start_time: startTime.toISOString(),
    end_time: endTime.toISOString(),
    status: "confirmed",
    source: "platform",
  };

  let { data: appt, error } = await db.from("appointments").insert(row).select("id").single();
  if (error?.code === "23514") {
    // source CHECK constraint predates migration 007 — fail soft, keep booking.
    console.warn("[platform] source='platform' rejected by CHECK — falling back to 'system' (apply migration 007)");
    ({ data: appt, error } = await db.from("appointments").insert({ ...row, source: "system" }).select("id").single());
  }
  if (error || !appt) {
    if (error?.code === "23505") {
      const freshSlots = await getPlatformDaySlots(db, input.businessId, input.dateISO, duration, timezone);
      return { ok: false, reason: "slot_taken", freshSlots };
    }
    console.error("[platform] booking insert failed:", error?.message);
    return { ok: false, reason: "db_error" };
  }
  const appointmentId = appt.id as string;

  // Observations, not commands — both are fail-open.
  await emitEvent(db, input.businessId, "appointment_booked", {
    customerId,
    appointmentId,
    payload: { source: "platform", dateISO: input.dateISO, time: input.time, serviceId: input.serviceId },
  });
  const [y, mo, d] = input.dateISO.split("-");
  await sendOutbound(
    db, input.businessId, customerId, input.phone,
    `התור נקבע בהצלחה!\n\n` +
    `שירות: ${service.name as string}\n` +
    `תאריך: ${d}/${mo}/${y}\n` +
    `שעה: ${input.time}\n\n` +
    `לצפייה, שינוי או ביטול: ${buildAppointmentLink(appointmentId)}`
  );

  return { ok: true, appointmentId };
}

// ── Self-service (view / cancel / reschedule) ──────────────────────────────────

export async function getAppointmentView(db: DB, appointmentId: string): Promise<AppointmentView | null> {
  const { data } = await db
    .from("appointments")
    .select("id, status, start_time, end_time, business_id, customer_id, service_id, services(name), businesses(id, name, slug, timezone), customers(name, phone)")
    .eq("id", appointmentId)
    .maybeSingle();
  if (!data) return null;

  const biz = data.businesses as unknown as { id: string; name: string; slug: string; timezone: string } | null;
  if (!biz) return null;
  const timezone = biz.timezone || "Asia/Jerusalem";
  const start = new Date(data.start_time as string);
  const end = new Date(data.end_time as string);
  const dateISO = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(start);

  return {
    id: data.id as string,
    status: data.status as string,
    dateISO,
    time: formatTimeInTZ(start, timezone),
    durationMinutes: Math.max(5, Math.round((end.getTime() - start.getTime()) / 60_000)),
    serviceId: (data.service_id as string | null) ?? null,
    serviceName: (data.services as unknown as { name: string } | null)?.name ?? null,
    customerId: (data.customer_id as string | null) ?? null,
    customerPhone: (data.customers as unknown as { name: string | null; phone: string | null } | null)?.phone ?? null,
    business: { id: biz.id, name: biz.name, slug: biz.slug, timezone },
    customerName: (data.customers as unknown as { name: string | null } | null)?.name ?? null,
    isFuture: start.getTime() > Date.now(),
  };
}

export type ManageResult = { ok: true } | { ok: false; reason: "not_found" | "not_changeable" | "slot_taken" | "db_error"; freshSlots?: string[] };

const CHANGEABLE = new Set(["pending", "confirmed"]);

export async function cancelPlatformAppointment(db: DB, appointmentId: string): Promise<ManageResult> {
  const view = await getAppointmentView(db, appointmentId);
  if (!view) return { ok: false, reason: "not_found" };
  if (!CHANGEABLE.has(view.status) || !view.isFuture) return { ok: false, reason: "not_changeable" };

  // CONDITIONAL update — only rows still pending/confirmed flip to cancelled. `.select("id")`
  // returns the rows ACTUALLY transitioned: this is the idempotency key. A double-click / refresh
  // / retry / concurrent request that didn't win the transition gets 0 rows → no duplicate notice.
  const { data: updated, error } = await db
    .from("appointments")
    .update({ status: "cancelled" })
    .eq("id", appointmentId)
    .in("status", ["pending", "confirmed"])
    .select("id");
  if (error) return { ok: false, reason: "db_error" };
  const transitioned = (updated?.length ?? 0) > 0;

  // Freed-slot payload feeds the waitlist matcher (the runner detects matches).
  await emitEvent(db, view.business.id, "appointment_cancelled", {
    customerId: view.customerId,
    appointmentId,
    payload: {
      dateISO: view.dateISO, time: view.time, source: "platform",
      serviceId: view.serviceId, durationMinutes: view.durationMinutes,
    },
  });

  // Deterministic WhatsApp confirmation (fail-open, like the booking confirmation). Sent ONLY when
  // THIS call performed the cancellation and we have a phone — never on a duplicate/no-op.
  if (transitioned && view.customerPhone && view.customerId) {
    await sendOutbound(
      db, view.business.id, view.customerId, view.customerPhone,
      buildCancellationMessage({
        serviceName: view.serviceName, dateISO: view.dateISO, time: view.time,
        bookingLink: buildBookingLink(view.business.slug, view.customerPhone),
      }),
    );
    console.log(`[platform] cancel notification sent appt=${maskId(appointmentId)}`);
  } else {
    console.log(`[platform] cancel notification skipped appt=${maskId(appointmentId)} reason=${!transitioned ? "no_transition_dedupe" : "no_phone"}`);
  }
  return { ok: true };
}

export async function reschedulePlatformAppointment(
  db: DB, appointmentId: string, dateISO: string, time: string
): Promise<ManageResult> {
  const view = await getAppointmentView(db, appointmentId);
  if (!view) return { ok: false, reason: "not_found" };
  if (!CHANGEABLE.has(view.status) || !view.isFuture) return { ok: false, reason: "not_changeable" };

  const timezone = view.business.timezone;
  const duration = view.durationMinutes;

  const cutoff = bookableCutoff(dateISO, timezone);
  if (dateISO < todayInTZ(timezone) || (cutoff && time <= cutoff)) {
    return { ok: false, reason: "slot_taken", freshSlots: [] };
  }

  const offered = await getPlatformDaySlots(db, view.business.id, dateISO, duration, timezone);
  if (!offered.includes(time)) {
    // Off-grid times are allowed when the interval is genuinely free (same rule as chat).
    const free = await isIntervalFree(db, view.business.id, dateISO, time, duration, timezone);
    if (!free) return { ok: false, reason: "slot_taken", freshSlots: offered };
  }

  const startTime = businessTimeToUTC(dateISO, time, timezone);
  const endTime = new Date(startTime.getTime() + duration * 60_000);
  const { error } = await db
    .from("appointments")
    .update({ start_time: startTime.toISOString(), end_time: endTime.toISOString() })
    .eq("id", appointmentId)
    .in("status", ["pending", "confirmed"]);
  if (error) {
    if (error.code === "23505") {
      const freshSlots = await getPlatformDaySlots(db, view.business.id, dateISO, duration, timezone);
      return { ok: false, reason: "slot_taken", freshSlots };
    }
    return { ok: false, reason: "db_error" };
  }

  // The OLD slot is now free → feed the waitlist matcher with it.
  await emitEvent(db, view.business.id, "appointment_rescheduled", {
    customerId: view.customerId,
    appointmentId,
    payload: {
      fromDateISO: view.dateISO, fromTime: view.time, toDateISO: dateISO, toTime: time,
      source: "platform", serviceId: view.serviceId, durationMinutes: view.durationMinutes,
    },
  });

  // Deterministic WhatsApp confirmation (fail-open). Dedupe: send ONLY when the appointment actually
  // MOVED (a refresh/double-submit to the SAME slot is a no-op → skip), and we have a phone. The OLD
  // slot was captured in `view` BEFORE the update, so old → new is reliable.
  const moved = rescheduleChanged(view.dateISO, view.time, dateISO, time);
  if (moved && view.customerPhone && view.customerId) {
    await sendOutbound(
      db, view.business.id, view.customerId, view.customerPhone,
      buildRescheduleMessage({
        serviceName: view.serviceName,
        fromDateISO: view.dateISO, fromTime: view.time, toDateISO: dateISO, toTime: time,
        manageLink: buildAppointmentLink(appointmentId),
      }),
    );
    console.log(`[platform] reschedule notification sent appt=${maskId(appointmentId)}`);
  } else {
    console.log(`[platform] reschedule notification skipped appt=${maskId(appointmentId)} reason=${!moved ? "no_change_dedupe" : "no_phone"}`);
  }
  return { ok: true };
}

/** Masks an appointment UUID for logs (keeps the first 8 chars — enough to correlate, no full id). */
function maskId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
