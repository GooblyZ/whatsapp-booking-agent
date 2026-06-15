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
import { getWhatsAppHealth, attemptWhatsAppRecovery } from "@/lib/integration-health";

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

  // 1+2. Dedup check and customer upsert are independent — run them in PARALLEL
  //       to shave a DB round-trip off the hot path (every real message lands
  //       here). A duplicate still upserts the customer first (idempotent,
  //       harmless); the win is for the common non-duplicate case.
  const [dedup, customerResult] = await Promise.all([
    db.from("messages").select("id").eq("meta_message_id", msg.waMessageId).maybeSingle(),
    db
      .from("customers")
      .upsert(
        { business_id: msg.businessId, phone: msg.fromPhone },
        { onConflict: "business_id,phone", ignoreDuplicates: false }
      )
      .select("id")
      .single(),
  ]);

  if (dedup.data) {
    console.log(`[message-handler] duplicate wamid=${msg.waMessageId} — skipped`);
    return;
  }

  const { data: customer, error: customerError } = customerResult;
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

  // 4. Save inbound message (returning created_at for burst aggregation).
  const { data: savedMsg, error: msgError } = await db.from("messages").insert({
    business_id:     msg.businessId,
    customer_id:     customer.id,
    direction:       "inbound",
    channel:         "whatsapp",
    from_phone:      msg.fromPhone,
    body:            msg.messageText,
    raw_payload:     msg.rawPayload as Record<string, unknown>,
    meta_message_id: msg.waMessageId,
    wa_timestamp:    waTimestampISO,
  }).select("id, created_at").single();

  if (msgError || !savedMsg) {
    console.error(
      "[message-handler] failed to save inbound message:", msgError?.message,
      "— if the error mentions a missing column (send_status, wa_timestamp, external_message_id),",
      "run: supabase/migrations/phase_4_whatsapp_and_booking_hardening.sql"
    );
    return;
  }

  console.log(
    `[message-handler] inbound message saved — phone=${maskedPhone} wamid=${msg.waMessageId}`
  );

  // 4b. DEGRADED MODE GATE. When Meta auth is broken, NO reply can be delivered
  //     (AI or rule-based alike) — so don't burn Gemini tokens. The inbound is
  //     already saved above (owner can review it; memory picks it up later).
  //     Each inbound triggers ONE cheap token probe so we auto-recover the
  //     moment the owner fixes the token — and then THIS message proceeds.
  const waHealth = getWhatsAppHealth(msg.businessId);
  if (waHealth.status === "auth_failed") {
    const recovered = await attemptWhatsAppRecovery(db, msg.businessId);
    if (!recovered) {
      console.warn(
        `[message-handler] WhatsApp delivery unavailable (auth_failed, ${waHealth.consecutiveFailures} consecutive failures)` +
        ` — inbound SAVED, AI SKIPPED for business=${msg.businessId.slice(-6)}.` +
        ` ACTION: refresh/reconnect META_ACCESS_TOKEN.`
      );
      return;
    }
    console.log(`[message-handler] WhatsApp auth recovered — resuming normal flow for this message`);
  }

  // 5. ZERO-LATENCY BURST HANDLING. Real users send "אני רוצה תור" / "תספורת" /
  //    "מחר" / "בחמש" as rapid separate messages. We add NO artificial waiting:
  //    - here, all still-unanswered fragments are combined into one turn text
  //    - in flow.ts, a SUPERSEDE check right before sending skips this turn's
  //      reply if a newer message has arrived meanwhile (the newest turn then
  //      answers with the full combined context). The model's own processing
  //      time (~2-4s) acts as the natural coalescing window.
  const effectiveText = await aggregateBurst(
    db, msg.businessId, customer.id, savedMsg.created_at as string, msg.messageText
  );

  // 6. Run the conversation/booking flow — handles all logic and outbound replies.
  await handleBookingFlow(db, msg.businessId, msg.fromPhone, customer.id, effectiveText);
}

/**
 * Combines the unanswered burst (inbound messages since the last outbound reply,
 * capped at 60s) into one text, so fragmented input becomes one coherent turn.
 */
async function aggregateBurst(
  db: ReturnType<typeof supabaseServer>,
  businessId: string,
  customerId: string,
  currentCreatedAt: string,
  fallbackText: string
): Promise<string> {
  try {
    const { data: lastOut } = await db
      .from("messages")
      .select("created_at")
      .eq("business_id", businessId)
      .eq("customer_id", customerId)
      .eq("direction", "outbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const windowStart = new Date(Date.now() - 60_000).toISOString();
    const since = lastOut?.created_at && (lastOut.created_at as string) > windowStart
      ? (lastOut.created_at as string)
      : windowStart;

    const { data: burst } = await db
      .from("messages")
      .select("body, created_at")
      .eq("business_id", businessId)
      .eq("customer_id", customerId)
      .eq("direction", "inbound")
      .gt("created_at", since)
      .lte("created_at", currentCreatedAt)
      .order("created_at", { ascending: true });

    const texts = (burst ?? [])
      .map((b) => ((b.body as string) ?? "").trim())
      .filter((t) => t.length > 0);

    if (texts.length > 1) {
      console.log(`[message-handler] burst: aggregating ${texts.length} messages into one turn`);
      return texts.join("\n");
    }
    return fallbackText;
  } catch (err) {
    console.error("[message-handler] burst aggregation failed:", err instanceof Error ? err.message : String(err));
    return fallbackText;
  }
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return "****";
  return phone.slice(0, -4).replace(/\d/g, "*") + phone.slice(-4);
}
