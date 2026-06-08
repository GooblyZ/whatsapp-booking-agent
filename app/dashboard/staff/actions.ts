"use server";

import { getDefaultBusinessId } from "@/lib/config";
import { createStaffMember, updateStaffMember } from "@/lib/services/staff";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createStaffAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  await createStaffMember(businessId, {
    name:  (formData.get("name") as string)?.trim(),
    phone: (formData.get("phone") as string)?.trim() || null,
  });
  redirect("/dashboard/staff?saved=1");
}

export async function updateStaffAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  const id         = formData.get("id") as string;
  await updateStaffMember(businessId, id, {
    name:  (formData.get("name") as string)?.trim(),
    phone: (formData.get("phone") as string)?.trim() || null,
  });
  redirect("/dashboard/staff?saved=1");
}

export async function toggleStaffActiveAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  const id         = formData.get("id") as string;
  const active     = formData.get("active") === "true";
  await updateStaffMember(businessId, id, { active });
  revalidatePath("/dashboard/staff");
}
