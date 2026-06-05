import { prisma } from "@/lib/db/prisma";
import {
  ConversationChannel,
  ConversationState,
  MessageDirection,
  Prisma,
} from "@/app/generated/prisma/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SendWhatsAppResult =
  | { success: true; messageId: string | null }
  | { success: false; error: string };

// ─── Public API ───────────────────────────────────────────────────────────────

export async function sendWhatsAppTextMessage({
  to,
  body,
}: {
  to: string;
  body: string;
}): Promise<SendWhatsAppResult> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!accessToken)
    return { success: false, error: "WHATSAPP_ACCESS_TOKEN is not configured." };
  if (!phoneNumberId)
    return { success: false, error: "WHATSAPP_PHONE_NUMBER_ID is not configured." };
  if (!to.trim())
    return { success: false, error: "Recipient phone number is required." };
  if (!body.trim())
    return { success: false, error: "Message body is required." };

  const url = `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`;

  let metaResponse: Response;
  let responseBody: unknown;
  try {
    metaResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Token is only used server-side and never logged
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to.trim(),
        type: "text",
        text: { body: body.trim() },
      }),
    });
    responseBody = await metaResponse.json();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `Network error: ${msg}` };
  }

  if (!metaResponse.ok) {
    return { success: false, error: `Meta API error: ${extractMetaError(responseBody)}` };
  }

  const metaMessageId = extractMetaMessageId(responseBody);

  try {
    await storeOutboundMessage({ to: to.trim(), body: body.trim(), metaMessageId, rawPayload: responseBody });
  } catch (e) {
    // Send succeeded; DB failure is logged but doesn't fail the caller.
    console.error(`[whatsapp] failed to store outbound message: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { success: true, messageId: metaMessageId };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractMetaError(body: unknown): string {
  if (typeof body !== "object" || body === null) return "Unknown error";
  const err = (body as Record<string, unknown>).error;
  if (typeof err === "object" && err !== null) {
    const msg = (err as Record<string, unknown>).message;
    if (typeof msg === "string") return msg;
  }
  return "Unknown error";
}

function extractMetaMessageId(body: unknown): string | null {
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

async function storeOutboundMessage({
  to,
  body,
  metaMessageId,
  rawPayload,
}: {
  to: string;
  body: string;
  metaMessageId: string | null;
  rawPayload: unknown;
}): Promise<void> {
  const conversation = await prisma.conversation.upsert({
    where: { phone_channel: { phone: to, channel: ConversationChannel.WHATSAPP } },
    update: {},
    create: { phone: to, channel: ConversationChannel.WHATSAPP, state: ConversationState.NEW },
    select: { id: true },
  });

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: MessageDirection.OUTBOUND,
      externalMessageId: metaMessageId ?? undefined,
      toPhone: to,
      body,
      rawPayload: (rawPayload as unknown) as Prisma.InputJsonValue,
    },
  });
}
