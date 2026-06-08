// lib/message-handler.ts
// Owns inbound message processing:
//   deduplication → customer upsert → save inbound message → booking flow
//
// Responsibility split:
//   - This file: receive, dedup, persist inbound message, resolve customer ID
//   - lib/booking/flow.ts: conversation state, outbound replies, appointment creation
//
// EXTENSION POINT: AI / Gemini reasoning will be added inside handleBookingFlow
// (lib/booking/flow.ts) in a future phase. The webhook route must NOT change for that.

import { supabaseServer } from "@/lib/supabase/server";
import { handleBookingFlow } from "@/lib/booking/flow";

export interface IncomingWhatsAppMessage {
  businessId:  string;
  fromPhone:   string;
  messageText: string;
  waMessageId: string;
  waTimestamp: string | null; // Unix timestamp string from Meta payload
  rawPayload:  unknown;
}

/**
 * Entry point for every incoming WhatsApp text message.
 *
 * 1. Deduplicates by waMessageId — skips if already processed.
 * 2. Upserts the customer row.
 * 3. Saves the inbound message to the messages table.
 * 4. Delegates to handleBookingFlow for all conversation logic.
 *
 * Inbound messages are saved HERE and nowhere else.
 * Outbound messages are saved inside handleBookingFlow / lib/booking/helpers.ts.
 */
export async function handleIncomingMessage(msg: IncomingWhatsAppMessage): Promise<void> {
  const db = supabaseServer();
  const maskedPhone = maskPhone(msg.fromPhone);
  const textPreview = msg.messageText.slice(0, 40) + (msg.messageText.length > 40 ? "…" : "");
  console.log(`[message-handler] received — phone=${maskedPhone} text="${textPreview}"`);

  // 1. Deduplication — skip if this wamid was already processed.
  const { data: existing } = await db
    .from("messages")
    .select("id")
    .eq("meta_message_id", msg.waMessageId)
    .maybeSingle();

  if (existing) {
    console.log(`[message-handler] duplicate wamid=${msg.waMessageId} — skipped`);
    return;
  }

  // 2. Upsert customer: one record per (business_id, phone).
  const { data: customer, error: customerError } = await db
    .from("customers")
    .upsert(
      { business_id: msg.businessId, phone: msg.fromPhone },
      { onConflict: "business_id,phone", ignoreDuplicates: false }
    )
    .select("id")
    .single();

  if (customerError || !customer) {
    console.error("[message-handler] failed to upsert customer:", customerError?.message);
    return;
  }

  // 3. Convert WhatsApp Unix timestamp to ISO if present.
  let waTimestampISO: string | null = null;
  if (msg.waTimestamp) {
    const ts = parseInt(msg.waTimestamp, 10);
    if (!isNaN(ts)) waTimestampISO = new Date(ts * 1000).toISOString();
  }

  // 4. Save inbound message.
  const { error: msgError } = await db.from("messages").insert({
    business_id:     msg.businessId,
    customer_id:     customer.id,
    direction:       "inbound",
    channel:         "whatsapp",
    from_phone:      msg.fromPhone,
    body:            msg.messageText,
    raw_payload:     msg.rawPayload as Record<string, unknown>,
    meta_message_id: msg.waMessageId,
    wa_timestamp:    waTimestampISO,
  });

  if (msgError) {
    console.error(
      "[message-handler] failed to save inbound message:", msgError.message,
      "— if the error mentions a missing column (send_status, wa_timestamp, external_message_id),",
      "run: supabase/migrations/phase_4_whatsapp_and_booking_hardening.sql"
    );
    return;
  }

  console.log(
    `[message-handler] inbound message saved — phone=${maskedPhone} wamid=${msg.waMessageId}`
  );

  // 5. Run the booking flow — handles all conversation logic and outbound replies.
  await handleBookingFlow(db, msg.businessId, msg.fromPhone, customer.id, msg.messageText);
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return "****";
  return phone.slice(0, -4).replace(/\d/g, "*") + phone.slice(-4);
}
