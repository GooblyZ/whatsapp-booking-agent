import { supabaseServer } from "@/lib/supabase/server";
import type { BusinessHour } from "@/types/database";

export const DAY_NAMES: Record<number, string> = {
  0: "ראשון",
  1: "שני",
  2: "שלישי",
  3: "רביעי",
  4: "חמישי",
  5: "שישי",
  6: "שבת",
};

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export async function getBusinessHours(businessId: string): Promise<BusinessHour[]> {
  const db = supabaseServer();
  const { data, error } = await db
    .from("business_hours")
    .select("*")
    .eq("business_id", businessId)
    .order("day_of_week");
  if (error) throw new Error(error.message);
  return (data ?? []) as BusinessHour[];
}

export interface UpsertHourInput {
  day_of_week: number;
  opens_at: string | null;
  closes_at: string | null;
  is_closed: boolean;
}

export async function upsertBusinessHours(
  businessId: string,
  hours: UpsertHourInput[]
): Promise<void> {
  const db = supabaseServer();
  const rows = hours.map((h) => ({
    business_id: businessId,
    day_of_week: h.day_of_week,
    opens_at:   h.is_closed ? null : (h.opens_at  ?? "09:00"),
    closes_at:  h.is_closed ? null : (h.closes_at ?? "18:00"),
    is_closed:  h.is_closed,
  }));

  const { error } = await db
    .from("business_hours")
    .upsert(rows, { onConflict: "business_id,day_of_week" });
  if (error) throw new Error(error.message);
}
