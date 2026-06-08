import { supabaseServer } from "@/lib/supabase/server";
import type { Service, ServiceCategory } from "@/types/database";

export async function getServices(businessId: string): Promise<Service[]> {
  const db = supabaseServer();
  const { data, error } = await db
    .from("services")
    .select("*")
    .eq("business_id", businessId)
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as Service[];
}

export async function getServiceCategories(
  businessId: string
): Promise<ServiceCategory[]> {
  const db = supabaseServer();
  const { data, error } = await db
    .from("service_categories")
    .select("*")
    .eq("business_id", businessId)
    .eq("active", true)
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as ServiceCategory[];
}

export interface CreateServiceInput {
  name: string;
  description?: string | null;
  duration_minutes: number;
  price?: number | null;
  category_id?: string | null;
}

export async function createService(
  businessId: string,
  data: CreateServiceInput
): Promise<void> {
  const db = supabaseServer();
  const { error } = await db.from("services").insert({
    business_id: businessId,
    name: data.name,
    description: data.description ?? null,
    duration_minutes: data.duration_minutes,
    price: data.price ?? null,
    category_id: data.category_id ?? null,
  });
  if (error) throw new Error(error.message);
}

export interface UpdateServiceInput {
  name?: string;
  description?: string | null;
  duration_minutes?: number;
  price?: number | null;
  category_id?: string | null;
  active?: boolean;
}

export async function updateService(
  businessId: string,
  serviceId: string,
  data: UpdateServiceInput
): Promise<void> {
  const db = supabaseServer();
  const { error } = await db
    .from("services")
    .update(data as Record<string, unknown>)
    .eq("id", serviceId)
    .eq("business_id", businessId);
  if (error) throw new Error(error.message);
}
