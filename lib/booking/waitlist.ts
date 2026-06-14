// lib/booking/waitlist.ts
// Server-side only.
//
// Waitlist service (TRANSITION_PLAN.md phase 4). Deterministic, AI-free.
// Flow: customer joins → a slot frees (cancel/reschedule) → the event runner
// detects matching entries → the AI communicates the opportunity → the customer
// books on the platform. "The system decides; the AI communicates."
//
// All functions FAIL SOFT until migration 007 creates waitlist_entries: a
// missing table is logged and treated as "no waitlist", never an exception.

import type { DB } from "./helpers";
import type { WaitlistEntry } from "@/types/database";

export interface JoinWaitlistInput {
  businessId: string;
  customerId: string;
  serviceId?: string | null;
  dateFrom?: string | null;  // YYYY-MM-DD, business-local
  dateTo?: string | null;
  timeFrom?: string | null;  // "HH:MM"
  timeTo?: string | null;
}

export type JoinResult = { ok: true; alreadyActive: boolean } | { ok: false; reason: "unavailable" };

/** A freed slot the matcher checks active waitlist entries against. */
export interface FreedSlot {
  dateISO: string;          // YYYY-MM-DD
  time: string;             // "HH:MM"
  serviceId?: string | null;
}

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /(relation|table).*(does not exist)|could not find the table/i.test(error.message ?? "");
}

/**
 * Adds the customer to the waitlist. Idempotent-ish: if an identical active
 * entry already exists (same service + window), it is reused rather than
 * duplicated.
 */
export async function joinWaitlist(db: DB, input: JoinWaitlistInput): Promise<JoinResult> {
  try {
    const { data: existing } = await db
      .from("waitlist_entries")
      .select("id")
      .eq("business_id", input.businessId)
      .eq("customer_id", input.customerId)
      .eq("status", "active")
      .limit(20);

    const dupes = (existing ?? []) as Array<{ id: string }>;
    // A customer with any active entry for this service is "already waiting" —
    // good enough to avoid spamming duplicate rows from repeated taps.
    if (dupes.length > 0) {
      // Refine: only treat as duplicate when service matches. Cheap re-query.
      const { data: sameSvc } = await db
        .from("waitlist_entries")
        .select("id")
        .eq("business_id", input.businessId)
        .eq("customer_id", input.customerId)
        .eq("status", "active")
        .is("service_id", input.serviceId ?? null)
        .limit(1);
      if ((sameSvc ?? []).length > 0) return { ok: true, alreadyActive: true };
    }

    const { error } = await db.from("waitlist_entries").insert({
      business_id: input.businessId,
      customer_id: input.customerId,
      service_id: input.serviceId ?? null,
      date_from: input.dateFrom ?? null,
      date_to: input.dateTo ?? null,
      time_from: input.timeFrom ?? null,
      time_to: input.timeTo ?? null,
      status: "active",
    });
    if (error) {
      if (isMissingTable(error)) console.warn("[waitlist] join skipped — waitlist_entries missing (apply migration 007)");
      else console.error("[waitlist] join failed:", error.message);
      return { ok: false, reason: "unavailable" };
    }
    return { ok: true, alreadyActive: false };
  } catch (err) {
    console.error("[waitlist] join error:", err instanceof Error ? err.message : String(err));
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Active waitlist entries whose service + date window + time window contain the
 * freed slot. Window bounds are inclusive; null bounds mean "no constraint".
 * Returns [] (never throws) when the table is missing or on error.
 */
export async function matchWaitlistForSlot(db: DB, businessId: string, slot: FreedSlot): Promise<WaitlistEntry[]> {
  try {
    let q = db
      .from("waitlist_entries")
      .select("*")
      .eq("business_id", businessId)
      .eq("status", "active")
      .order("created_at", { ascending: true });

    // Service: match entries for this service OR service-agnostic entries.
    if (slot.serviceId) q = q.or(`service_id.eq.${slot.serviceId},service_id.is.null`);

    const { data, error } = await q;
    if (error) {
      if (isMissingTable(error)) console.warn("[waitlist] match skipped — waitlist_entries missing (apply migration 007)");
      else console.error("[waitlist] match failed:", error.message);
      return [];
    }

    const rows = (data ?? []) as WaitlistEntry[];
    return rows.filter((e) => withinWindow(slot, e));
  } catch (err) {
    console.error("[waitlist] match error:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** Date/time-window containment (inclusive; null = unbounded). Pure. */
export function withinWindow(slot: FreedSlot, entry: Pick<WaitlistEntry, "date_from" | "date_to" | "time_from" | "time_to">): boolean {
  if (entry.date_from && slot.dateISO < entry.date_from) return false;
  if (entry.date_to && slot.dateISO > entry.date_to) return false;
  if (entry.time_from && slot.time < entry.time_from) return false;
  if (entry.time_to && slot.time > entry.time_to) return false;
  return true;
}

/** Marks an entry as notified (opportunity sent). Fail-soft. */
export async function markWaitlistNotified(db: DB, entryId: string): Promise<void> {
  try {
    await db
      .from("waitlist_entries")
      .update({ status: "notified", notified_at: new Date().toISOString() })
      .eq("id", entryId)
      .eq("status", "active");
  } catch (err) {
    console.error("[waitlist] markNotified error:", err instanceof Error ? err.message : String(err));
  }
}
