import { supabaseServer } from "@/lib/supabase/server";
import type { StaffMember } from "@/types/database";

export async function getStaffMembers(businessId: string): Promise<StaffMember[]> {
  const db = supabaseServer();
  const { data, error } = await db
    .from("staff_members")
    .select("*")
    .eq("business_id", businessId)
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as StaffMember[];
}

export interface CreateStaffMemberInput {
  name: string;
  phone?: string | null;
}

export async function createStaffMember(
  businessId: string,
  data: CreateStaffMemberInput
): Promise<void> {
  const db = supabaseServer();
  const { error } = await db.from("staff_members").insert({
    business_id: businessId,
    name: data.name,
    phone: data.phone ?? null,
  });
  if (error) throw new Error(error.message);
}

export interface UpdateStaffMemberInput {
  name?: string;
  phone?: string | null;
  active?: boolean;
}

export async function updateStaffMember(
  businessId: string,
  staffId: string,
  data: UpdateStaffMemberInput
): Promise<void> {
  const db = supabaseServer();
  const { error } = await db
    .from("staff_members")
    .update(data as Record<string, unknown>)
    .eq("id", staffId)
    .eq("business_id", businessId);
  if (error) throw new Error(error.message);
}
