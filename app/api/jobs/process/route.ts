import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

// Event-processing runner (TRANSITION_PLAN.md phase 3 skeleton).
//
// Invoked manually or by an external scheduler (cron / Task Scheduler):
//   POST /api/jobs/process  with  Authorization: Bearer ${JOBS_SECRET}
//
// Today it only REPORTS pending events — the reminder and waitlist
// communicators plug in here (phases 4–5). Designed so adding a processor is
// a switch-case, not an architecture change.

export async function POST(req: NextRequest) {
  const secret = process.env.JOBS_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "jobs runner disabled (JOBS_SECRET not set)" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = supabaseServer();
  const { data, error } = await db
    .from("events")
    .select("id, type")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    // Table missing until migration 007 — report instead of failing.
    return NextResponse.json({ ok: true, pending: 0, note: `events table unavailable: ${error.message}` });
  }

  const byType: Record<string, number> = {};
  for (const e of data ?? []) {
    byType[e.type as string] = (byType[e.type as string] ?? 0) + 1;
  }

  // Future processors dispatch here (reminder_due → WhatsApp reminder,
  // waitlist_opportunity → booking-opportunity message, …).
  return NextResponse.json({ ok: true, pending: data?.length ?? 0, byType, processed: 0 });
}
