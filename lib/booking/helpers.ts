import { supabaseServer } from "@/lib/supabase/server";

export type DB = ReturnType<typeof supabaseServer>;

/** Booking sessions expire after 24 h of inactivity. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface ConversationCtx {
  state: string;
  context: Record<string, unknown>;
  expiresAt: Date | null;
}

export async function getConversationState(
  db: DB,
  businessId: string,
  customerId: string
): Promise<ConversationCtx> {
  const { data } = await db
    .from("conversation_states")
    .select("state, context, expires_at")
    .eq("business_id", businessId)
    .eq("customer_id", customerId)
    .maybeSingle();

  if (!data) return { state: "idle", context: {}, expiresAt: null };
  return {
    state:     (data.state   as string)                  ?? "idle",
    context:   (data.context as Record<string, unknown>) ?? {},
    expiresAt: data.expires_at ? new Date(data.expires_at as string) : null,
  };
}

/**
 * Upserts conversation state.
 * Non-idle states automatically set expires_at = NOW + 24 h (lazy session TTL).
 * Idle resets clear expires_at so completed/cancelled sessions don't linger.
 */
export async function upsertConversationState(
  db: DB,
  businessId: string,
  customerId: string,
  state: string,
  context: Record<string, unknown>
): Promise<void> {
  const expiresAt = state === "idle" ? null : new Date(Date.now() + SESSION_TTL_MS);
  await db.from("conversation_states").upsert(
    {
      business_id: businessId,
      customer_id: customerId,
      state,
      context,
      expires_at:  expiresAt ? expiresAt.toISOString() : null,
    },
    { onConflict: "business_id,customer_id" }
  );
}

/** Durable outbound traceability (migration 012) — all fields OPTIONAL/nullable. `wamid` is the Meta
 *  outbound wamid (stored in the existing meta_message_id column); `triggerRef` is an optional correlation
 *  id (e.g. an appointment id). Observability only — never affects routing/send behavior. */
export interface OutboundTraceMeta {
  source?: string;
  reason?: string;
  wamid?: string | null;
  triggerRef?: string | null;
}

/** The pre-012 (always-valid) outbound row. */
function baseOutboundRow(
  businessId: string, customerId: string, toPhone: string, body: string, sendStatus: string
): Record<string, unknown> {
  return { business_id: businessId, customer_id: customerId, direction: "outbound", channel: "whatsapp", to_phone: toPhone, body, send_status: sendStatus };
}

/** The base row PLUS migration-012 trace columns (nullish fields omitted). PURE — unit-tested. */
export function buildOutboundRow(
  businessId: string, customerId: string, toPhone: string, body: string, sendStatus: string,
  meta: OutboundTraceMeta = {}
): Record<string, unknown> {
  const row = baseOutboundRow(businessId, customerId, toPhone, body, sendStatus);
  if (meta.source) row.source = meta.source;
  if (meta.reason) row.reason = meta.reason;
  if (meta.wamid) row.meta_message_id = meta.wamid;   // outbound wamid → existing column
  if (meta.triggerRef) row.trigger_ref = meta.triggerRef;
  return row;
}

/** True for a "column does not exist / not in schema cache" error — i.e. migration 012 not yet applied. */
export function isMissingColumnError(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === "42703" || e.code === "PGRST204") return true; // undefined_column / PostgREST schema-cache miss
  const m = (e.message ?? "").toLowerCase();
  return m.includes("does not exist") || m.includes("could not find") || m.includes("schema cache");
}

// One-time warning so a not-yet-applied migration is VISIBLE without spamming every send.
let warnedMissingTraceColumns = false;

/**
 * Persists an outbound message. Additive trace metadata (migration 012) is included when present; if the
 * trace columns are NOT YET in the DB (migration unapplied), it FALLS BACK to the legacy row so a message
 * is NEVER dropped — byte-identical to pre-012 persistence. No behavior change to the send path.
 */
export async function saveOutboundMessage(
  db: DB,
  businessId: string,
  customerId: string,
  toPhone: string,
  body: string,
  sendStatus: "pending" | "sent" | "failed" = "pending",
  meta: OutboundTraceMeta = {}
): Promise<void> {
  const base = baseOutboundRow(businessId, customerId, toPhone, body, sendStatus);
  const full = buildOutboundRow(businessId, customerId, toPhone, body, sendStatus, meta);

  // Nothing extra to persist → single insert, identical to pre-012 behavior.
  if (Object.keys(full).length === Object.keys(base).length) {
    await db.from("messages").insert(base);
    return;
  }

  const { error } = await db.from("messages").insert(full);
  if (!error) return;

  // FAIL-OPEN: migration 012 not applied yet → retry with the legacy row so the message is still saved.
  if (isMissingColumnError(error)) {
    if (!warnedMissingTraceColumns) {
      warnedMissingTraceColumns = true;
      console.warn("[outbound] ⚠ messages.source/reason/trigger_ref not found — apply migration 012_outbound_trace_metadata.sql; persisting WITHOUT trace until then");
    }
    await db.from("messages").insert(base);
    return;
  }
  // A different insert error (not a missing column): leave the legacy contract (ignored, like before).
}

export interface ServiceRow {
  id: string;
  name: string;
  duration_minutes: number;
  price: number | null;
}

export async function loadActiveServices(db: DB, businessId: string): Promise<ServiceRow[]> {
  const { data } = await db
    .from("services")
    .select("id, name, duration_minutes, price")
    .eq("business_id", businessId)
    .eq("active", true)
    .order("name");

  return (data ?? []) as ServiceRow[];
}

/**
 * Returns true if booking is enabled for this business.
 * Defaults to true when no business_settings row exists.
 */
export async function isBookingEnabled(db: DB, businessId: string): Promise<boolean> {
  const { data } = await db
    .from("business_settings")
    .select("booking_enabled")
    .eq("business_id", businessId)
    .maybeSingle();
  return data?.booking_enabled !== false;
}

export async function getBusinessTimezone(db: DB, businessId: string): Promise<string> {
  const { data } = await db
    .from("businesses")
    .select("timezone")
    .eq("id", businessId)
    .single();

  return (data?.timezone as string) || "Asia/Jerusalem";
}

/** Returns the customer's name if set and non-empty, otherwise null. */
export async function getCustomerName(db: DB, customerId: string): Promise<string | null> {
  const { data } = await db
    .from("customers")
    .select("name")
    .eq("id", customerId)
    .single();
  const name = (data as Record<string, unknown> | null)?.name as string | null | undefined;
  return name && name.trim().length > 0 ? name.trim() : null;
}

/** Persists a validated name to the customers row. */
export async function updateCustomerName(db: DB, customerId: string, name: string): Promise<void> {
  await db.from("customers").update({ name }).eq("id", customerId);
}
