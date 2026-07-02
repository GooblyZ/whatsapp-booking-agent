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
import { handleBookingFlow, hasNewerInbound } from "@/lib/booking/flow";
import { getWhatsAppHealth, attemptWhatsAppRecovery } from "@/lib/integration-health";
import { getAggregationDebounceMs } from "@/lib/config";
import {
  shouldSuppressStaleInbound,
  STALE_INBOUND_SUPPRESS_AFTER_MS,
  OUT_OF_ORDER_MIN_AGE_MS,
} from "@/lib/booking/inbound-staleness";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface IncomingWhatsAppMessage {
  businessId:  string;
  fromPhone:   string;
  messageText: string;
  waMessageId: string;
  waTimestamp: string | null; // Unix timestamp string from Meta payload
  rawPayload:  unknown;
  /** Set when the inbound was a TAP on a clickable menu option — its stable payload id. */
  interactivePayloadId?: string;
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
  // Surface the stable payload id on a menu TAP (proves the tap was handled by id, not title text).
  const payloadPart = msg.interactivePayloadId ? ` payload=${msg.interactivePayloadId}` : "";
  console.log(`[message-handler] received — phone=${maskedPhone} text="${textPreview}"${payloadPart}`);

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

  // 3. Convert WhatsApp Unix timestamp to ISO if present. authorMs (the customer's real send time, in ms)
  //    also feeds the stale/out-of-order guard below.
  let waTimestampISO: string | null = null;
  let authorMs: number | null = null;
  if (msg.waTimestamp) {
    const ts = parseInt(msg.waTimestamp, 10);
    if (!isNaN(ts)) {
      authorMs = ts * 1000;
      waTimestampISO = new Date(authorMs).toISOString();
    }
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

  // 4a. STALE / OUT-OF-ORDER INBOUND GUARD. A Meta webhook can arrive long after the customer actually
  //     sent the message — Meta retries a failed delivery on backoff (the 2026-07-02 incident: authored
  //     16:44, delivered 23:00, ~6h16m late). Replying then reads as a "spontaneous" bot message in the
  //     customer's chat. The inbound is already SAVED above (audit preserved) and wamid-dedup already ran;
  //     here we only decide whether to RUN the turn — a suppress short-circuits BEFORE Gemini, outbound,
  //     link attachment, and conversation-counter mutation (all downstream of handleBookingFlow), and
  //     never touches the recovery probe below. Fail-open: no usable author timestamp → proceed as before.
  if (authorMs !== null) {
    const receivedAtMs = Date.now();
    const latestPriorInboundMs = await latestPriorInboundAuthorMs(db, msg.businessId, customer.id, savedMsg.id as string);
    const staleness = shouldSuppressStaleInbound({
      isDuplicate: false, // wamid dedup already ran above; a duplicate never reaches this point
      authorTimestampMs: authorMs,
      receiptTimeMs: receivedAtMs,
      latestPriorInboundMs,
      maxAgeMs: STALE_INBOUND_SUPPRESS_AFTER_MS,
      outOfOrderMinAgeMs: OUT_OF_ORDER_MIN_AGE_MS,
    });
    if (staleness.suppress) {
      console.warn(
        `[message-handler] stale inbound suppressed — reason=${staleness.reason}` +
        ` business=${msg.businessId.slice(-6)} phone=${maskedPhone} wamid=${msg.waMessageId}` +
        ` authoredAt=${waTimestampISO} receivedAt=${new Date(receivedAtMs).toISOString()} ageMs=${staleness.ageMs}` +
        (latestPriorInboundMs !== null ? ` latestPriorInboundAt=${new Date(latestPriorInboundMs).toISOString()}` : "") +
        ` — SAVED for audit, Gemini + reply SKIPPED`
      );
      return;
    }
  }

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

  // 5. BURST HANDLING. Real users send "אני רוצה תור" / "תספורת" / "מחר" / "בחמש" as
  //    rapid separate messages. Two cooperating mechanisms coalesce them into ONE turn:
  //    (a) a small DEBOUNCE here, then an EARLY supersede check — if a newer fragment
  //        already arrived during the wait, THIS fragment skips entirely (no Gemini, no
  //        reply); a later fragment answers the full combined text. This widens the
  //        coalescing window beyond the model's ~2-4s processing time so slightly slower
  //        typists still merge. Disabled with AGGREGATION_DEBOUNCE_MS=0.
  //    (b) aggregateBurst combines all still-unanswered fragments into one turn text, and
  //        flow.ts keeps its own supersede check right before sending (defense in depth).
  const debounceMs = getAggregationDebounceMs();
  if (debounceMs > 0) {
    await sleep(debounceMs);
    if (await hasNewerInbound(db, msg.businessId, customer.id, savedMsg.created_at as string)) {
      console.log(
        `[message-handler] debounce(${debounceMs}ms): newer inbound arrived — skipping this fragment` +
        ` (a later turn aggregates it); no Gemini call, no reply`
      );
      return;
    }
  }

  const effectiveText = await aggregateBurst(
    db, msg.businessId, customer.id, savedMsg.created_at as string, msg.messageText
  );

  // 6. Run the conversation/booking flow — handles all logic and outbound replies.
  //    Pass THIS fragment's created_at as the supersede anchor so the flow/turn skips
  //    (before Gemini) when a later fragment exists — serializing a burst to ONE turn.
  await handleBookingFlow(
    db, msg.businessId, msg.fromPhone, customer.id, effectiveText, savedMsg.created_at as string,
    msg.interactivePayloadId
  );
}

/**
 * Combines the unanswered burst (inbound messages since the last outbound reply,
 * capped at 60s) into one text, so fragmented input becomes one coherent turn.
 * Exported for unit testing. (The 60s lookback bounds which already-arrived fragments
 * count; the coalescing WINDOW is governed by the debounce in handleIncomingMessage.)
 */
export async function aggregateBurst(
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

/**
 * Newest AUTHOR timestamp (ms) among OTHER inbound messages for this business+customer — the
 * "have we already moved past this?" signal for the out-of-order guard. Excludes the current row and any
 * inbound with no wa_timestamp. Fail-open: any error → null, so the guard never suppresses because of a
 * failed lookup. Read-only.
 */
async function latestPriorInboundAuthorMs(
  db: ReturnType<typeof supabaseServer>,
  businessId: string,
  customerId: string,
  currentMessageId: string
): Promise<number | null> {
  try {
    const { data } = await db
      .from("messages")
      .select("wa_timestamp")
      .eq("business_id", businessId)
      .eq("customer_id", customerId)
      .eq("direction", "inbound")
      .neq("id", currentMessageId)
      .not("wa_timestamp", "is", null)
      .order("wa_timestamp", { ascending: false })
      .limit(1)
      .maybeSingle();
    const ts = data?.wa_timestamp as string | null | undefined;
    if (!ts) return null;
    const ms = new Date(ts).getTime();
    return isNaN(ms) ? null : ms;
  } catch (err) {
    console.error("[message-handler] latestPriorInboundAuthorMs failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return "****";
  return phone.slice(0, -4).replace(/\d/g, "*") + phone.slice(-4);
}
