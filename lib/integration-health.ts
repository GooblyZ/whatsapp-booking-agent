// lib/integration-health.ts
// Server-side only.
//
// Per-business WhatsApp integration health. When Meta auth fails (expired/
// invalid token), NO reply can be delivered — not AI, not rule-based — so the
// right behavior is: keep saving inbound messages, STOP spending Gemini calls,
// alert the owner/developer, and auto-recover via a cheap token probe.
//
// State lives in memory (authoritative at runtime; resets on restart, which is
// safe — the first failed send re-enters degraded mode immediately) and is
// written through to business_settings best-effort so the dashboard can show it
// (requires migration 006; missing columns degrade gracefully to memory-only).

import type { DB } from "@/lib/booking/helpers";
import { checkWhatsAppAuth, type SendResult } from "@/lib/whatsapp";

export type WhatsAppStatus = "healthy" | "degraded" | "auth_failed";

export interface WhatsAppHealth {
  status: WhatsAppStatus;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
}

/** Non-auth failures must repeat this many times before we call it degraded. */
const DEGRADED_THRESHOLD = 3;

const mem = new Map<string, WhatsAppHealth>();
let persistWarned = false;

function fresh(): WhatsAppHealth {
  return { status: "healthy", lastError: null, lastErrorAt: null, consecutiveFailures: 0 };
}

/** Current in-memory health for a business (default: healthy). */
export function getWhatsAppHealth(businessId: string): WhatsAppHealth {
  return mem.get(businessId) ?? fresh();
}

/** Records the outcome of a WhatsApp send and updates health accordingly. */
export async function recordWhatsAppSendResult(
  db: DB | null, businessId: string, result: SendResult
): Promise<void> {
  const h = { ...getWhatsAppHealth(businessId) };

  if (result.success) {
    if (h.status !== "healthy" || h.consecutiveFailures > 0) {
      console.log(`[ALERT] business=${businessId.slice(-6)} whatsapp_recovered — delivery restored, resuming normal AI replies`);
    }
    mem.set(businessId, fresh());
    await persist(db, businessId, fresh());
    return;
  }

  h.consecutiveFailures += 1;
  h.lastError = result.error.slice(0, 300);
  h.lastErrorAt = new Date().toISOString();

  if (result.kind === "auth") {
    h.status = "auth_failed";
  } else if (h.consecutiveFailures >= DEGRADED_THRESHOLD) {
    h.status = "degraded";
  }

  mem.set(businessId, h);
  await persist(db, businessId, h);

  if (h.status === "auth_failed") {
    console.error(
      `[ALERT] business=${businessId.slice(-6)} whatsapp_auth_failed` +
      ` consecutive=${h.consecutiveFailures} at=${h.lastErrorAt}` +
      ` — AI replies suspended (nothing can be delivered).` +
      ` ACTION: refresh/reconnect the Meta access token (META_ACCESS_TOKEN) and restart.`
    );
  } else if (h.status === "degraded") {
    console.error(
      `[ALERT] business=${businessId.slice(-6)} whatsapp_degraded` +
      ` consecutive=${h.consecutiveFailures} at=${h.lastErrorAt} lastError="${h.lastError}"` +
      ` — check Meta API status / network.`
    );
  }
}

/**
 * Auto-recovery: while auth_failed, each inbound message triggers ONE cheap
 * token probe (no message sent, no AI spend). Token fixed → healthy → the
 * current message proceeds through the normal AI flow immediately.
 */
export async function attemptWhatsAppRecovery(db: DB | null, businessId: string): Promise<boolean> {
  const probe = await checkWhatsAppAuth();
  if (probe.ok) {
    await markWhatsAppHealthy(db, businessId);
    return true;
  }
  console.warn(`[integration-health] recovery probe still failing for business=${businessId.slice(-6)}: ${probe.error}`);
  return false;
}

/** Marks the integration healthy (probe passed / manual recovery). */
export async function markWhatsAppHealthy(db: DB | null, businessId: string): Promise<void> {
  const was = getWhatsAppHealth(businessId).status;
  mem.set(businessId, fresh());
  await persist(db, businessId, fresh());
  if (was !== "healthy") {
    console.log(`[ALERT] business=${businessId.slice(-6)} whatsapp_recovered (was ${was}) — normal AI replies resumed`);
  }
}

/** Dashboard read: persisted health (null when migration 006 isn't applied). */
export async function readPersistedWhatsAppHealth(db: DB, businessId: string): Promise<WhatsAppHealth | null> {
  try {
    const { data, error } = await db
      .from("business_settings")
      .select("whatsapp_status, last_whatsapp_error, last_whatsapp_error_at, whatsapp_consecutive_failures")
      .eq("business_id", businessId)
      .maybeSingle();
    if (error || !data) return null;
    const status = data.whatsapp_status as WhatsAppStatus | null;
    if (!status) return null;
    return {
      status,
      lastError: (data.last_whatsapp_error as string) ?? null,
      lastErrorAt: (data.last_whatsapp_error_at as string) ?? null,
      consecutiveFailures: (data.whatsapp_consecutive_failures as number) ?? 0,
    };
  } catch {
    return null;
  }
}

// Best-effort write-through; missing columns (pre-migration) only warn once.
async function persist(db: DB | null, businessId: string, h: WhatsAppHealth): Promise<void> {
  if (!db) return;
  try {
    const { error } = await db
      .from("business_settings")
      .update({
        whatsapp_status: h.status,
        last_whatsapp_error: h.lastError,
        last_whatsapp_error_at: h.lastErrorAt,
        whatsapp_consecutive_failures: h.consecutiveFailures,
      })
      .eq("business_id", businessId);
    if (error && !persistWarned) {
      persistWarned = true;
      console.warn(
        `[integration-health] could not persist health (run supabase/migrations/006_whatsapp_integration_health.sql for dashboard visibility): ${error.message}`
      );
    }
  } catch {
    // memory-only mode — fine
  }
}
