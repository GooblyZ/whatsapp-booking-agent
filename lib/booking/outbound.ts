import { sendWhatsAppTextMessage } from "@/lib/whatsapp";
import { stripEmojis } from "@/lib/ai/reply-polish";
import { recordWhatsAppSendResult } from "@/lib/integration-health";
import { type DB, saveOutboundMessage } from "./helpers";

/**
 * THE single outbound chokepoint, shared by the chat router (flow.ts) and the
 * booking platform. Owner AI settings (emoji_usage=none) apply to EVERY
 * customer-facing message — model-written, guard, deterministic strings, and
 * platform notifications alike. Fail-open: if settings can't be read, the text
 * is sent unmodified.
 */
export async function applyOutboundSettings(db: DB, businessId: string, text: string): Promise<string> {
  try {
    const { data } = await db
      .from("ai_settings")
      .select("emoji_usage")
      .eq("business_id", businessId)
      .maybeSingle();
    if (data?.emoji_usage === "none") return stripEmojis(text);
  } catch {
    // settings unavailable → send as-is
  }
  return text;
}

/**
 * Sends a WhatsApp message with settings enforcement, health recording, and
 * message persistence. Never throws — messaging-path errors are logged and
 * swallowed (telemetry and notifications must never fail the calling action).
 */
export async function sendOutbound(
  db: DB, businessId: string, customerId: string, toPhone: string, rawText: string
): Promise<void> {
  const text = await applyOutboundSettings(db, businessId, rawText);
  let sendStatus: "sent" | "failed" = "sent";
  console.log(`[outbound] reply → "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);

  const result = await sendWhatsAppTextMessage(toPhone, text);
  if (!result.success) {
    sendStatus = "failed";
    console.error(`[outbound] WhatsApp send failed: ${result.error}`);
  }

  // Integration health: auth failures suspend AI for this business (nothing can
  // be delivered); successes reset the state. Never blocks the message save.
  try {
    await recordWhatsAppSendResult(db, businessId, result);
  } catch (err) {
    console.error("[outbound] failed to record send health:", err instanceof Error ? err.message : String(err));
  }

  // Always save the outbound message regardless of send outcome so no reply is lost.
  try {
    await saveOutboundMessage(db, businessId, customerId, toPhone, text, sendStatus);
  } catch (err) {
    console.error("[outbound] failed to save outbound message:", err instanceof Error ? err.message : String(err));
  }
}
