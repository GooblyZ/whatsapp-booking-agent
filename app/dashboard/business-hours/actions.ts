"use server";

import { getDefaultBusinessId } from "@/lib/config";
import { upsertBusinessHours } from "@/lib/services/business-hours";
import { redirect } from "next/navigation";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function safeTime(raw: string | null, fallback: string): string {
  const t = raw?.trim() ?? "";
  return TIME_RE.test(t) ? t : fallback;
}

/** Converts "HH:MM" to total minutes. */
function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export async function saveBusinessHoursAction(formData: FormData): Promise<void> {
  const businessId = getDefaultBusinessId();

  const hours = [0, 1, 2, 3, 4, 5, 6].map((day) => {
    const isClosed = formData.get(`day_${day}_closed`) === "on";
    const opensAt  = safeTime(formData.get(`day_${day}_opens`)  as string | null, "09:00");
    const closesAt = safeTime(formData.get(`day_${day}_closes`) as string | null, "18:00");

    // If close <= open for an open day, fix by setting close = open + 1h
    const fixedCloses =
      !isClosed && toMinutes(closesAt) <= toMinutes(opensAt)
        ? `${String(Math.min(Math.floor(toMinutes(opensAt) / 60) + 1, 23)).padStart(2, "0")}:${String(toMinutes(opensAt) % 60).padStart(2, "0")}`
        : closesAt;

    return {
      day_of_week: day,
      opens_at:  isClosed ? null : opensAt,
      closes_at: isClosed ? null : fixedCloses,
      is_closed: isClosed,
    };
  });

  await upsertBusinessHours(businessId, hours);
  redirect("/dashboard/business-hours?saved=1");
}
