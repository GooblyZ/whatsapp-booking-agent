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

// ── Interactive (clickable) messages ────────────────────────────────────────────
// WhatsApp Cloud API interactive message shapes, business-agnostic. Limits enforced by
// the BUILDER (lib/ai/continuity-menu.ts): reply buttons ≤3 (title ≤20 chars); list ≤10
// rows total (row title ≤24); cta_url is a single URL button. Each option carries a stable
// `id` (the payload echoed back when the customer taps) so a tap maps to a deterministic
// menu action — independent of the visible label and the UI language.
export type WhatsAppInteractive =
  | { kind: "buttons"; body: string; buttons: { id: string; title: string }[] }
  | { kind: "list"; body: string; button: string; rows: { id: string; title: string; description?: string }[] }
  | { kind: "cta_url"; body: string; buttonText: string; url: string };

/** Translates the business-agnostic interactive shape into the Meta `interactive` payload. */
function buildInteractivePayload(i: WhatsAppInteractive): Record<string, unknown> {
  if (i.kind === "buttons") {
    return {
      type: "button",
      body: { text: i.body },
      action: { buttons: i.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
    };
  }
  if (i.kind === "list") {
    return {
      type: "list",
      body: { text: i.body },
      action: {
        button: i.button,
        sections: [{ rows: i.rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })) }],
      },
    };
  }
  // cta_url — a single tappable URL button (the "לחץ כאן" booking/manage CTA).
  return {
    type: "cta_url",
    body: { text: i.body },
    action: { name: "cta_url", parameters: { display_text: i.buttonText, url: i.url } },
  };
}

/**
 * Sends an INTERACTIVE (clickable buttons / list / URL-button) WhatsApp message via the
 * Meta Graph API. Same auth/error contract as sendWhatsAppTextMessage — never throws. The
 * CALLER is responsible for a text fallback if this returns success:false (older clients or
 * an unsupported interactive type still must get a reply).
 */
export async function sendWhatsAppInteractiveMessage(to: string, interactive: WhatsAppInteractive): Promise<SendResult> {
  const accessToken   = process.env.META_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const apiVersion    = process.env.META_API_VERSION ?? DEFAULT_API_VERSION;
  if (!accessToken)   return { success: false, error: "META_ACCESS_TOKEN is not set", kind: "config" };
  if (!phoneNumberId) return { success: false, error: "META_PHONE_NUMBER_ID is not set", kind: "config" };

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: buildInteractivePayload(interactive),
      }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const { message: errMsg, code: errCode } = extractMetaErrorDetail(errBody);
      const kind = classifySendFailure(res.status, errMsg, errCode);
      console.error(`[whatsapp] interactive send failed — status: ${res.status} kind: ${kind} error: ${errMsg}`);
      return { success: false, error: `Meta API error: ${errMsg}`, kind, httpStatus: res.status };
    }
    const resBody   = await res.json().catch(() => ({}));
    const messageId = extractMessageId(resBody);
    console.log(`[whatsapp] interactive HTTP ${res.status} — wamid: ${messageId ?? "none"} kind=${interactive.kind}`);
    return { success: true, messageId: messageId ?? undefined };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[whatsapp] interactive network error:", msg);
    return { success: false, error: `Network error: ${msg}`, kind: "network" };
  }
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

// ── Inbound parsing (text + interactive replies) ────────────────────────────────
// A WhatsApp inbound message is either plain text OR an interactive reply (the customer
// TAPPED a button/list row). This pure parser normalizes both into { text, payloadId }:
//   - text message            → { text: body }
//   - button_reply / list_reply → { text: <visible title>, payloadId: <stable id> }
// The title is what we save/show (a natural transcript); the payloadId is the machine token
// the menu engine resolves. Returns null for unsupported/empty message types (caller skips).
export interface InboundMessage { text: string; payloadId?: string }
export function extractInboundMessage(msg: unknown): InboundMessage | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  const type = typeof m.type === "string" ? m.type : "";
  if (type === "text") {
    const body = (m.text as { body?: unknown } | undefined)?.body;
    return typeof body === "string" && body.trim() ? { text: body } : null;
  }
  if (type === "interactive") {
    const interactive = m.interactive as Record<string, unknown> | undefined;
    const itype = typeof interactive?.type === "string" ? interactive.type : "";
    const reply = (itype === "button_reply" ? interactive?.button_reply
      : itype === "list_reply" ? interactive?.list_reply
      : undefined) as { id?: unknown; title?: unknown } | undefined;
    if (!reply) return null;
    const id = typeof reply.id === "string" ? reply.id : undefined;
    const title = typeof reply.title === "string" ? reply.title : "";
    // Prefer the visible title for the transcript; fall back to the id if a title is absent.
    const text = title.trim() || (id ?? "");
    return text ? { text, payloadId: id } : null;
  }
  return null;
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
