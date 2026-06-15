// lib/booking/appointments.ts
// Server-side only. Deterministic appointment-fact retrieval — the single source
// of truth for "what upcoming appointments does this customer have". Reused by:
//   - the WhatsApp working memory (renderUpcomingAppointments)
//   - the platform link decision (0 / 1 / 2+ → booking / single / My Appointments)
//   - the My Appointments page
// so the chat, the link, and the page can never disagree.

import type { DB } from "./helpers";

export interface UpcomingAppt {
  id: string;
  startTime: string;       // ISO
  status: string;          // pending | confirmed
  serviceName: string | null;
}

/** Upcoming (pending/confirmed, future) appointments for a customer, soonest first. */
export async function listUpcomingByCustomer(
  db: DB, businessId: string, customerId: string, limit = 10
): Promise<UpcomingAppt[]> {
  try {
    const { data, error } = await db
      .from("appointments")
      .select("id, start_time, status, services(name)")
      .eq("business_id", businessId)
      .eq("customer_id", customerId)
      .in("status", ["pending", "confirmed"])
      .gte("start_time", new Date().toISOString())
      .order("start_time", { ascending: true })
      .limit(limit);
    if (error || !data) return [];
    return (data as Array<{ id: string; start_time: string; status: string; services: { name?: string } | null }>).map(
      (r) => ({ id: r.id, startTime: r.start_time, status: r.status, serviceName: r.services?.name ?? null })
    );
  } catch {
    return [];
  }
}
