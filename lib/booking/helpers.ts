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

export async function saveOutboundMessage(
  db: DB,
  businessId: string,
  customerId: string,
  toPhone: string,
  body: string,
  sendStatus: "pending" | "sent" | "failed" = "pending"
): Promise<void> {
  await db.from("messages").insert({
    business_id: businessId,
    customer_id: customerId,
    direction: "outbound",
    channel: "whatsapp",
    to_phone: toPhone,
    body,
    send_status: sendStatus,
  });
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
