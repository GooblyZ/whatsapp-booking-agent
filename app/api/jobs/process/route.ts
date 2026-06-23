import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { processPendingEvents } from "@/lib/events/process";
import { authorizeJobRequest } from "@/lib/jobs/auth";

// Event-processing runner (TRANSITION_PLAN.md phases 4–5). ONE processor, two triggers:
//   - POST /api/jobs/process  with  Authorization: Bearer ${JOBS_SECRET}   (manual / external scheduler)
//   - GET  /api/jobs/process  with  Authorization: Bearer ${CRON_SECRET}   (Vercel Cron, DAILY 03:00 UTC
//     — see vercel.json; daily is the Hobby-plan-safe schedule. CRON_SECRET is set in the Vercel project
//     env and sent automatically on cron requests. The GET also accepts JOBS_SECRET for a manual trigger.
//
// Each run: enqueues due reminders, auto-completes finished confirmed appointments, and processes
// pending events (waitlist + reminders via the outbound layer). Fail-soft before migration 007.
//
// Dynamic so the auth header is always read fresh and the route is never statically cached.
export const dynamic = "force-dynamic";

/** Runs the processor once and returns the summary. The SINGLE shared runner for both triggers. */
async function runProcessor(): Promise<NextResponse> {
  const db = supabaseServer();
  const summary = await processPendingEvents(db);
  return NextResponse.json({ ok: true, ...summary });
}

function deny(auth: "unauthorized" | "disabled", hint: string): NextResponse {
  return auth === "disabled"
    ? NextResponse.json({ error: `jobs runner disabled (${hint})` }, { status: 503 })
    : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

/** Manual / external trigger — unchanged contract: JOBS_SECRET-gated. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = authorizeJobRequest(req.headers.get("authorization"), [process.env.JOBS_SECRET]);
  if (auth !== "ok") return deny(auth, "JOBS_SECRET not set");
  return runProcessor();
}

/** Vercel Cron (GET) — CRON_SECRET-gated, also accepts JOBS_SECRET. Fail-closed if neither is set. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = authorizeJobRequest(req.headers.get("authorization"), [process.env.CRON_SECRET, process.env.JOBS_SECRET]);
  if (auth !== "ok") return deny(auth, "no CRON_SECRET / JOBS_SECRET set");
  return runProcessor();
}
