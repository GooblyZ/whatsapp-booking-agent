"use server";

import { getDefaultBusinessId } from "@/lib/config";
import { createStaffMember, updateStaffMember } from "@/lib/services/staff";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

const PHONE_RE = /^[\+\d][\d\s\-().]{5,19}$/;

function validatePhone(raw: string): boolean {
  return raw.length === 0 || PHONE_RE.test(raw);
}

export async function createStaffAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  const phone = (formData.get("phone") as string)?.trim() ?? "";

  if (!validatePhone(phone)) {
    redirect("/dashboard/staff?error=invalid_staff_phone");
  }

  await createStaffMember(businessId, {
    name:  (formData.get("name") as string)?.trim(),
    phone: phone.length > 0 ? phone : null,
  });
  redirect("/dashboard/staff?saved=1");
}

export async function updateStaffAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  const id    = formData.get("id") as string;
  const phone = (formData.get("phone") as string)?.trim() ?? "";

  if (!validatePhone(phone)) {
    redirect("/dashboard/staff?error=invalid_staff_phone");
  }

  await updateStaffMember(businessId, id, {
    name:  (formData.get("name") as string)?.trim(),
    phone: phone.length > 0 ? phone : null,
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
