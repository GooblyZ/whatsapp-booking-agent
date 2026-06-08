// GET /api/health/whatsapp
// Checks that all required Meta WhatsApp env vars are configured.
// Never makes network calls or exposes secret values.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const REQUIRED_VARS = [
  "META_VERIFY_TOKEN",
  "META_ACCESS_TOKEN",
  "META_PHONE_NUMBER_ID",
] as const;

export async function GET() {
  const checks: Record<string, boolean> = {};

  for (const name of REQUIRED_VARS) {
    checks[name] = !!process.env[name];
  }

  const ok = Object.values(checks).every(Boolean);

  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503 });
}
