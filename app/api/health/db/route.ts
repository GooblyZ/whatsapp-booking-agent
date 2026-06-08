// GET /api/health/db
// Checks whether required database columns and constraints exist.
// Returns JSON — never exposes secrets.
// Use this after running a migration to confirm the DB is ready.

import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface Checks {
  messages_send_status:         boolean | null;
  messages_wa_timestamp:        boolean | null;
  messages_external_message_id: boolean | null;
  conversation_states_unique:   boolean | null;
}

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return NextResponse.json(
      { ok: false, error: "Supabase env vars not configured" },
      { status: 500 }
    );
  }

  const [
    messages_send_status,
    messages_wa_timestamp,
    messages_external_message_id,
    conversation_states_unique,
  ] = await Promise.all([
    columnExists(url, key, "messages", "send_status"),
    columnExists(url, key, "messages", "wa_timestamp"),
    columnExists(url, key, "messages", "external_message_id"),
    uniqueConstraintExists(),
  ]);

  const checks: Checks = {
    messages_send_status,
    messages_wa_timestamp,
    messages_external_message_id,
    conversation_states_unique,
  };

  const ok = Object.values(checks).every(Boolean);

  return NextResponse.json({ ok, checks }, { status: ok ? 200 : 503 });
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Checks whether a column exists in a Supabase table by trying to SELECT it.
 * PostgREST returns 400 when the column is unknown to the schema cache.
 */
async function columnExists(
  url: string, key: string, table: string, column: string
): Promise<boolean | null> {
  try {
    const res = await fetch(
      `${url}/rest/v1/${table}?select=${encodeURIComponent(column)}&limit=0`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        cache: "no-store",
      }
    );
    return res.ok;
  } catch {
    return null;
  }
}

/**
 * Detects whether conversation_states has the unique constraint on (business_id, customer_id).
 *
 * Strategy: attempt an upsert with `onConflict: "business_id,customer_id"` using a
 * sentinel UUID. PostgreSQL evaluates the ON CONFLICT clause before attempting the insert:
 *
 *  42P10 — no unique constraint matching the ON CONFLICT spec → constraint missing → false
 *  23503 — FK violation on the INSERT attempt → constraint exists, row rejected by FK → true
 *  no error — probe row actually inserted (no FK guard); we delete it and return true
 *  anything else → null (unexpected error, treat as inconclusive)
 */
async function uniqueConstraintExists(): Promise<boolean | null> {
  const sentinel = "00000000-0000-0000-0000-000000000000";
  const db = supabaseServer();

  const { error } = await db
    .from("conversation_states")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .upsert({ business_id: sentinel, customer_id: sentinel, state: "idle", context: {} } as any, {
      onConflict: "business_id,customer_id",
    });

  // No unique constraint matching the ON CONFLICT spec
  if (error?.code === "42P10") return false;

  // FK violation: the INSERT was attempted (constraint exists) but rejected by FK
  if (error?.code === "23503") return true;

  // No error: probe row was inserted (table has no FK constraints). Clean up.
  if (!error) {
    await db
      .from("conversation_states")
      .delete()
      .eq("business_id", sentinel)
      .eq("customer_id", sentinel);
    return true;
  }

  // Unexpected error — inconclusive
  return null;
}
