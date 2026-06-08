import { supabaseServer } from "@/lib/supabase/server";
import type { Business, BusinessSettings } from "@/types/database";

export interface BusinessWithSettings {
  business: Business;
  settings: BusinessSettings | null;
}

export async function getBusinessWithSettings(
  businessId: string
): Promise<BusinessWithSettings> {
  const db = supabaseServer();

  const { data: business, error } = await db
    .from("businesses")
    .select("*")
    .eq("id", businessId)
    .single();

  if (error || !business) {
    throw new Error(error?.message ?? "Business not found");
  }

  const { data: settings } = await db
    .from("business_settings")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();

  return {
    business: business as Business,
    settings: settings as BusinessSettings | null,
  };
}

export interface UpdateBusinessInput {
  name?: string;
  phone?: string | null;
  timezone?: string;
  language?: string;
  booking_enabled?: boolean;
  confirmation_required?: boolean;
  default_slot_duration_minutes?: number;
  cancellation_policy_text?: string | null;
  // Location
  address?: string | null;
  city?: string | null;
  parking_instructions?: string | null;
  entrance_instructions?: string | null;
}

export async function updateBusinessSettings(
  businessId: string,
  data: UpdateBusinessInput
): Promise<void> {
  const db = supabaseServer();

  const bizFields: Record<string, unknown> = {};
  if (data.name !== undefined) bizFields.name = data.name;
  if (data.phone !== undefined) bizFields.phone = data.phone;
  if (data.timezone !== undefined) bizFields.timezone = data.timezone;

  if (Object.keys(bizFields).length > 0) {
    const { error } = await db
      .from("businesses")
      .update(bizFields)
      .eq("id", businessId);
    if (error) throw new Error(error.message);
  }

  const settingsFields: Record<string, unknown> = { business_id: businessId };
  if (data.language !== undefined) settingsFields.language = data.language;
  if (data.booking_enabled !== undefined) settingsFields.booking_enabled = data.booking_enabled;
  if (data.confirmation_required !== undefined) settingsFields.confirmation_required = data.confirmation_required;
  if (data.default_slot_duration_minutes !== undefined) settingsFields.default_slot_duration_minutes = data.default_slot_duration_minutes;
  if (data.cancellation_policy_text !== undefined) settingsFields.cancellation_policy_text = data.cancellation_policy_text;
  if (data.address !== undefined)              settingsFields.address              = data.address;
  if (data.city !== undefined)                 settingsFields.city                 = data.city;
  if (data.parking_instructions !== undefined) settingsFields.parking_instructions = data.parking_instructions;
  if (data.entrance_instructions !== undefined) settingsFields.entrance_instructions = data.entrance_instructions;

  const { error } = await db
    .from("business_settings")
    .upsert(settingsFields, { onConflict: "business_id" });
  if (error) throw new Error(error.message);
}
