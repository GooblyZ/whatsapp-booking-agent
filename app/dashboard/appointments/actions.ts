"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { getDefaultBusinessId } from "@/lib/config";
import { getAppointmentView } from "@/lib/booking/platform";
import { emitEvent } from "@/lib/events/emit";

const ALLOWED: readonly string[] = ["completed", "cancelled"];

export async function updateAppointmentStatusAction(formData: FormData): Promise<void> {
  const id     = formData.get("id")     as string;
  const status = formData.get("status") as string;

  if (!id || !ALLOWED.includes(status)) return;

  const businessId = getDefaultBusinessId();
  const db = supabaseServer();

  // Capture the slot BEFORE the update so an owner-side cancellation can free it
  // for the waitlist (the event runner notifies the next person). Fail-soft.
  const view = status === "cancelled" ? await getAppointmentView(db, id) : null;

  await db
    .from("appointments")
    .update({ status })
    .eq("id", id)
    .eq("business_id", businessId);

  if (status === "cancelled" && view && view.business.id === businessId) {
    await emitEvent(db, businessId, "appointment_cancelled", {
      customerId: view.customerId,
      appointmentId: id,
      payload: {
        dateISO: view.dateISO, time: view.time, source: "dashboard",
        serviceId: view.serviceId, durationMinutes: view.durationMinutes,
      },
    });
  }

  revalidatePath("/dashboard/appointments");
}
