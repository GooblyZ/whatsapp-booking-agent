"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import {
  getAppointmentView,
  getPlatformDaySlots,
  cancelPlatformAppointment,
  reschedulePlatformAppointment,
} from "@/lib/booking/platform";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export type ManageActionResult = { ok: true } | { ok: false; code: "not_changeable" | "slot_taken" | "error"; freshSlots?: string[] };

export async function cancelAppointmentAction(id: string): Promise<ManageActionResult> {
  if (!UUID_RE.test(id)) return { ok: false, code: "error" };
  const db = supabaseServer();
  const res = await cancelPlatformAppointment(db, id);
  if (res.ok) {
    revalidatePath(`/appointment/${id}`);
    return { ok: true };
  }
  return { ok: false, code: res.reason === "not_changeable" ? "not_changeable" : "error" };
}

export async function rescheduleAppointmentAction(
  id: string, dateISO: string, time: string
): Promise<ManageActionResult> {
  if (!UUID_RE.test(id) || !DATE_RE.test(dateISO) || !TIME_RE.test(time)) {
    return { ok: false, code: "error" };
  }
  const db = supabaseServer();
  const res = await reschedulePlatformAppointment(db, id, dateISO, time);
  if (res.ok) {
    revalidatePath(`/appointment/${id}`);
    return { ok: true };
  }
  if (res.reason === "slot_taken") return { ok: false, code: "slot_taken", freshSlots: res.freshSlots };
  if (res.reason === "not_changeable") return { ok: false, code: "not_changeable" };
  return { ok: false, code: "error" };
}

export type ManageSlotsResult = { ok: true; slots: string[] } | { ok: false };

export async function fetchManageSlotsAction(id: string, dateISO: string): Promise<ManageSlotsResult> {
  if (!UUID_RE.test(id) || !DATE_RE.test(dateISO)) return { ok: false };
  const db = supabaseServer();
  const view = await getAppointmentView(db, id);
  if (!view) return { ok: false };
  const slots = await getPlatformDaySlots(
    db, view.business.id, dateISO, view.durationMinutes, view.business.timezone
  );
  return { ok: true, slots };
}
