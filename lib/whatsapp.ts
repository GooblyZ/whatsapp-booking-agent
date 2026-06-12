// lib/whatsapp.ts
// Server-side only — never import in client components.
// Canonical WhatsApp sender. Uses META_* environment variables.

const DEFAULT_API_VERSION = "v20.0";

/** Why a send failed — drives integration-health handling. */
export type SendFailureKind = "auth" | "api" | "network" | "config";

export type SendResult =
  | { success: true;  messageId?: string }
  | { success: false; error: string; kind: SendFailureKind; httpStatus?: number };

/**
 * Classifies a Meta send failure. "auth" = token expired/invalid/revoked —
 * NOTHING can be delivered until the owner reconnects, so the caller should
 * enter degraded mode instead of burning AI tokens.
 */
export function classifySendFailure(httpStatus: number | null, errorMessage: string, errorCode: number | null): SendFailureKind {
  if (httpStatus === 401 || errorCode === 190) return "auth"; // 190 = OAuthException
  const m = errorMessage.toLowerCase();
  if (
    m.includes("authentication") || m.includes("oauth") || m.includes("access token") ||
    m.includes("session has expired") || m.includes("error validating")
  ) {
    return "auth";
  }
  return "api";
}

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
    return { success: false, error: "META_ACCESS_TOKEN is not set", kind: "config" };
  }
  if (!phoneNumberId) {
    console.error("[whatsapp] META_PHONE_NUMBER_ID is not set — cannot send message");
    return { success: false, error: "META_PHONE_NUMBER_ID is not set", kind: "config" };
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
      const { message: errMsg, code: errCode } = extractMetaErrorDetail(errBody);
      const kind = classifySendFailure(res.status, errMsg, errCode);
      console.error(`[whatsapp] send failed — status: ${res.status} kind: ${kind} error: ${errMsg}`);
      return { success: false, error: `Meta API error: ${errMsg}`, kind, httpStatus: res.status };
    }

    const resBody   = await res.json().catch(() => ({}));
    const messageId = extractMessageId(resBody);
    console.log(`[whatsapp] HTTP ${res.status} — wamid: ${messageId ?? "none"}`);
    return { success: true, messageId: messageId ?? undefined };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[whatsapp] network error:", msg);
    return { success: false, error: `Network error: ${msg}`, kind: "network" };
  }
}

/**
 * Cheap token health probe — GET the phone-number object (no message sent).
 * Used to auto-recover from auth_failed once the owner fixes the token.
 */
export async function checkWhatsAppAuth(): Promise<{ ok: boolean; error?: string }> {
  const accessToken   = process.env.META_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const apiVersion    = process.env.META_API_VERSION ?? DEFAULT_API_VERSION;
  if (!accessToken || !phoneNumberId) {
    return { ok: false, error: "META_ACCESS_TOKEN / META_PHONE_NUMBER_ID not set" };
  }
  try {
    const res = await fetch(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}?fields=id`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: `HTTP ${res.status}: ${extractMetaErrorDetail(body).message}` };
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function extractMetaErrorDetail(body: unknown): { message: string; code: number | null } {
  if (typeof body !== "object" || body === null) return { message: "Unknown error", code: null };
  const err = (body as Record<string, unknown>).error;
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    return {
      message: typeof e.message === "string" ? e.message : "Unknown error",
      code: typeof e.code === "number" ? e.code : null,
    };
  }
  return { message: "Unknown error", code: null };
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
