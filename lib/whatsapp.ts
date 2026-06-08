// lib/whatsapp.ts
// Server-side only — never import in client components.
// Canonical WhatsApp sender. Uses META_* environment variables.

const DEFAULT_API_VERSION = "v20.0";

export type SendResult =
  | { success: true;  messageId?: string }
  | { success: false; error: string };

/**
 * Sends a plain-text WhatsApp message via the Meta Graph API.
 * Returns a result object — never throws.
 */
export async function sendWhatsAppTextMessage(to: string, text: string): Promise<SendResult> {
  const accessToken   = process.env.META_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const apiVersion    = process.env.META_API_VERSION ?? DEFAULT_API_VERSION;

  if (!accessToken) {
    console.error("[whatsapp] META_ACCESS_TOKEN is not set — cannot send message");
    return { success: false, error: "META_ACCESS_TOKEN is not set" };
  }
  if (!phoneNumberId) {
    console.error("[whatsapp] META_PHONE_NUMBER_ID is not set — cannot send message");
    return { success: false, error: "META_PHONE_NUMBER_ID is not set" };
  }

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const errMsg  = extractMetaError(errBody);
      console.error(`[whatsapp] send failed — status: ${res.status} error: ${errMsg}`);
      return { success: false, error: `Meta API error: ${errMsg}` };
    }

    const resBody   = await res.json().catch(() => ({}));
    const messageId = extractMessageId(resBody);
    console.log(`[whatsapp] HTTP ${res.status} — wamid: ${messageId ?? "none"}`);
    return { success: true, messageId: messageId ?? undefined };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[whatsapp] network error:", msg);
    return { success: false, error: `Network error: ${msg}` };
  }
}

function extractMetaError(body: unknown): string {
  if (typeof body !== "object" || body === null) return "Unknown error";
  const err = (body as Record<string, unknown>).error;
  if (typeof err === "object" && err !== null) {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string") return msg;
  }
  return "Unknown error";
}

function extractMessageId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const first = messages[0];
  if (typeof first === "object" && first !== null) {
    const id = (first as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  return null;
}
