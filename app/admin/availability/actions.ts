"use server";

import { getAvailableSlots } from "@/lib/booking/availability";

export type SlotsResult = {
  slots: string[]; // ISO strings (UTC) — format in Jerusalem TZ on the client
  error?: string;
};

export async function fetchSlots(
  serviceId: string,
  staffId: string,
  date: string
): Promise<SlotsResult> {
  try {
    const slots = await getAvailableSlots({ serviceId, staffId, date });
    return { slots: slots.map((s) => s.toISOString()) };
  } catch (e) {
    return {
      slots: [],
      error: e instanceof Error ? e.message : "Failed to fetch slots.",
    };
  }
}
