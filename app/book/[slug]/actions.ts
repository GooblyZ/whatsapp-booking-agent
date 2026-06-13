"use server";

import { supabaseServer } from "@/lib/supabase/server";
import {
  getBusinessBySlug,
  getPlatformDaySlots,
  createPlatformBooking,
  ensurePlatformCustomer,
  normalizePhone,
} from "@/lib/booking/platform";
import { joinWaitlist } from "@/lib/booking/waitlist";
import { buildAppointmentLink } from "@/lib/config";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Hebrew/English names, 2–50 chars (same rule as the chat flow).
const NAME_RE = /^[a-zA-Z֐-׿\s'\-]{2,50}$/;

export type SlotsActionResult = { ok: true; slots: string[] } | { ok: false };

export async function fetchDaySlotsAction(
  slug: string, serviceId: string, dateISO: string
): Promise<SlotsActionResult> {
  if (!DATE_RE.test(dateISO)) return { ok: false };
  const db = supabaseServer();
  const business = await getBusinessBySlug(db, slug);
  if (!business) return { ok: false };

  const { data: service } = await db
    .from("services")
    .select("duration_minutes")
    .eq("id", serviceId)
    .eq("business_id", business.id)
    .eq("active", true)
    .maybeSingle();
  if (!service) return { ok: false };

  const slots = await getPlatformDaySlots(
    db, business.id, dateISO, (service.duration_minutes as number) ?? 30, business.timezone
  );
  return { ok: true, slots };
}

export type CreateBookingActionResult =
  | { ok: true; appointmentId: string; manageUrl: string }
  | { ok: false; code: "invalid_name" | "invalid_phone" | "invalid_input" | "slot_taken" | "error"; freshSlots?: string[] };

export async function createBookingAction(input: {
  slug: string; serviceId: string; dateISO: string; time: string; name: string; phone: string;
}): Promise<CreateBookingActionResult> {
  const name = (input.name ?? "").trim();
  if (!NAME_RE.test(name)) return { ok: false, code: "invalid_name" };
  const phone = normalizePhone(input.phone ?? "");
  if (!phone) return { ok: false, code: "invalid_phone" };
  if (!DATE_RE.test(input.dateISO) || !TIME_RE.test(input.time)) return { ok: false, code: "invalid_input" };

  const db = supabaseServer();
  const business = await getBusinessBySlug(db, input.slug);
  if (!business) return { ok: false, code: "invalid_input" };

  const result = await createPlatformBooking(db, {
    businessId: business.id,
    serviceId: input.serviceId,
    dateISO: input.dateISO,
    time: input.time,
    phone,
    name,
  });

  if (result.ok) {
    return { ok: true, appointmentId: result.appointmentId, manageUrl: buildAppointmentLink(result.appointmentId) };
  }
  if (result.reason === "slot_taken" || result.reason === "past_date") {
    return { ok: false, code: "slot_taken", freshSlots: result.freshSlots };
  }
  return { ok: false, code: "error" };
}

export type JoinWaitlistActionResult =
  | { ok: true; alreadyActive: boolean }
  | { ok: false; code: "invalid_name" | "invalid_phone" | "invalid_input" | "unavailable" };

/** Join the waitlist for a specific service on a specific (fully-booked) day. */
export async function joinWaitlistAction(input: {
  slug: string; serviceId: string; dateISO: string; name: string; phone: string;
}): Promise<JoinWaitlistActionResult> {
  const name = (input.name ?? "").trim();
  if (!NAME_RE.test(name)) return { ok: false, code: "invalid_name" };
  const phone = normalizePhone(input.phone ?? "");
  if (!phone) return { ok: false, code: "invalid_phone" };
  if (!DATE_RE.test(input.dateISO)) return { ok: false, code: "invalid_input" };

  const db = supabaseServer();
  const business = await getBusinessBySlug(db, input.slug);
  if (!business) return { ok: false, code: "invalid_input" };

  // Confirm the service belongs to the business (avoid cross-tenant ids).
  const { data: service } = await db
    .from("services")
    .select("id")
    .eq("id", input.serviceId)
    .eq("business_id", business.id)
    .eq("active", true)
    .maybeSingle();
  if (!service) return { ok: false, code: "invalid_input" };

  const customerId = await ensurePlatformCustomer(db, business.id, phone, name);
  if (!customerId) return { ok: false, code: "unavailable" };

  const res = await joinWaitlist(db, {
    businessId: business.id,
    customerId,
    serviceId: input.serviceId,
    dateFrom: input.dateISO,
    dateTo: input.dateISO,
  });
  if (res.ok) return { ok: true, alreadyActive: res.alreadyActive };
  return { ok: false, code: "unavailable" };
}
