"use server";

import { getDefaultBusinessId } from "@/lib/config";
import { createService, updateService } from "@/lib/services/catalog";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createServiceAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  const name       = (formData.get("name") as string)?.trim() ?? "";

  if (name.length < 2) {
    redirect("/dashboard/services?error=invalid_service_name");
  }

  const duration = parseInt(formData.get("duration_minutes") as string, 10);
  const priceRaw = formData.get("price") as string;

  await createService(businessId, {
    name,
    description:      (formData.get("description") as string) || null,
    duration_minutes: Number.isNaN(duration) || duration < 5 ? 30 : duration,
    price:            priceRaw ? Math.max(0, parseFloat(priceRaw)) : null,
    category_id:      (formData.get("category_id") as string) || null,
  });

  redirect("/dashboard/services?saved=1");
}

export async function updateServiceAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  const id         = formData.get("id") as string;
  const name       = (formData.get("name") as string)?.trim() ?? "";

  if (name.length < 2) {
    redirect("/dashboard/services?error=invalid_service_name");
  }

  const duration = parseInt(formData.get("duration_minutes") as string, 10);
  const priceRaw = formData.get("price") as string;

  await updateService(businessId, id, {
    name,
    description:      (formData.get("description") as string) || null,
    duration_minutes: Number.isNaN(duration) || duration < 5 ? 30 : duration,
    price:            priceRaw ? Math.max(0, parseFloat(priceRaw)) : null,
    category_id:      (formData.get("category_id") as string) || null,
  });

  redirect("/dashboard/services?saved=1");
}

export async function toggleServiceActiveAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  const id         = formData.get("id") as string;
  const active     = formData.get("active") === "true";

  await updateService(businessId, id, { active });
  revalidatePath("/dashboard/services");
}
