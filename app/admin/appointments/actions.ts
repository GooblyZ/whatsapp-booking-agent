"use server";

import { revalidatePath } from "next/cache";
import { getAvailableSlots } from "@/lib/booking/availability";
import { createAppointment, cancelAppointment } from "@/lib/booking/appointments";
import { BookingError } from "@/lib/booking/errors";

export type SlotsResult = { slots: string[]; error?: string };
export type CreateResult =
  | { success: true }
  | { success: false; error: string; code?: string };

// ─── Fetch available slots for the admin form ─────────────────────────────────

export async function fetchAdminSlots(
  serviceId: string,
  staffId: string,
  date: string
): Promise<SlotsResult> {
  try {
    const slots = await getAvailableSlots({ serviceId, staffId, date });
    return { slots: slots.map((s) => s.toISOString()) };
  } catch (e) {
    return {
      slots: [],
      error: e instanceof Error ? e.message : "Failed to fetch slots.",
    };
  }
}

// ─── Cancel appointment ───────────────────────────────────────────────────────

export type CancelState = { error: string } | null;

export async function cancelAdminAppointment(
  _prevState: CancelState,
  formData: FormData
): Promise<CancelState> {
  const id = formData.get("appointmentId");
  if (typeof id !== "string" || !id) return { error: "Invalid appointment ID." };

  try {
    await cancelAppointment({ appointmentId: id });
    revalidatePath("/admin/appointments");
    return null;
  } catch (e) {
    if (e instanceof BookingError) return { error: e.message };
    return { error: "An unexpected error occurred." };
  }
}

// ─── Create appointment (admin source) ────────────────────────────────────────
// All booking-rule validation is handled by createAppointment in the engine.
// This action only parses the raw form data and maps engine errors to UI codes.

export async function createAdminAppointment(data: {
  customerName: string;
  customerPhone: string;
  serviceId: string;
  staffId: string;
  startAt: string; // ISO UTC string chosen by the admin
}): Promise<CreateResult> {
  if (!data.startAt) return { success: false, error: "Please select a time slot." };

  const startAt = new Date(data.startAt);
  if (isNaN(startAt.getTime())) return { success: false, error: "Invalid time slot." };

  try {
    await createAppointment({
      customerName: data.customerName,
      customerPhone: data.customerPhone,
      serviceId: data.serviceId,
      staffId: data.staffId,
      startAt,
      source: "ADMIN",
    });
    return { success: true };
  } catch (e) {
    if (e instanceof BookingError) {
      return { success: false, error: e.message, code: e.code };
    }
    return { success: false, error: "An unexpected error occurred. Please try again." };
  }
}
