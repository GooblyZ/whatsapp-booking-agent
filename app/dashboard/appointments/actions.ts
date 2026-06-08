"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { getDefaultBusinessId } from "@/lib/config";

const ALLOWED: readonly string[] = ["completed", "cancelled"];

export async function updateAppointmentStatusAction(formData: FormData): Promise<void> {
  const id     = formData.get("id")     as string;
  const status = formData.get("status") as string;

  if (!id || !ALLOWED.includes(status)) return;

  const db = supabaseServer();
  await db
    .from("appointments")
    .update({ status })
    .eq("id", id)
    .eq("business_id", getDefaultBusinessId());

  revalidatePath("/dashboard/appointments");
}
