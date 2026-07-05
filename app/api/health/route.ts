import { NextResponse } from "next/server";
import { getRuntimeInfo, logRuntimeOnce } from "@/lib/runtime-info";

// Runtime fingerprint endpoint — GET /api/health returns which build/mode/model is answering, so a
// stale/mismatched runtime is visible at a glance (never exposes secrets). force-dynamic so it
// reflects the live process env per request rather than a build-time snapshot.
export const dynamic = "force-dynamic";

export async function GET() {
  logRuntimeOnce();
  return NextResponse.json({ ok: true, runtime: getRuntimeInfo() });
}
