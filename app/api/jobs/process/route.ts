import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { processPendingEvents } from "@/lib/events/process";

// Event-processing runner (TRANSITION_PLAN.md phases 4–5).
//
// Invoked by an external scheduler (cron / Windows Task Scheduler / Vercel cron):
//   POST /api/jobs/process  with  Authorization: Bearer ${JOBS_SECRET}
//
// Each run:
//   1. enqueues reminder_due events for appointments entering the reminder window
//   2. processes pending events — waitlist opportunities (on freed slots) and
//      reminders are sent through the outbound layer
//
// Fail-soft: before migration 007 the events/waitlist tables don't exist, so the
// processor reports zero work instead of erroring.

export async function POST(req: NextRequest) {
  const secret = process.env.JOBS_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "jobs runner disabled (JOBS_SECRET not set)" }, { status: 503 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = supabaseServer();
  const summary = await processPendingEvents(db);
  return NextResponse.json({ ok: true, ...summary });
}
