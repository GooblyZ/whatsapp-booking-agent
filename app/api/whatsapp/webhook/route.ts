import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import {
  ConversationChannel,
  ConversationState,
  MessageDirection,
  Prisma,
} from "@/app/generated/prisma/client";

// ─── GET: Meta webhook verification ──────────────────────────────────────────
// Meta sends a GET with hub.mode, hub.verify_token, hub.challenge.
// We confirm the token matches our secret and echo back the challenge.
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (
    mode === "subscribe" &&
    verifyToken &&
    token === verifyToken &&
    challenge
  ) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new NextResponse("Forbidden", { status: 403 });
}

// ─── POST: Receive incoming webhook events ────────────────────────────────────
// Meta expects a 200 response quickly. All processing happens synchronously
// in the same request; errors are swallowed so Meta never retries unnecessarily.
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    // Malformed JSON — still return 200 so Meta doesn't keep retrying
    return new NextResponse("OK", { status: 200 });
  }

  try {
    await processWebhookPayload(body);
  } catch (e) {
    // Swallow all processing errors — never surface to Meta
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[webhook] processing error: ${msg}`);
  }

  return new NextResponse("OK", { status: 200 });
}

// ─── WhatsApp payload types ────────────────────────────────────────────────────

interface WaTextMessage {
  id: string;
  from: string;
  type: string;
  timestamp?: string;
  text?: { body: string };
}

interface WaChangeValue {
  messages?: WaTextMessage[];
}

interface WaEntry {
  changes?: { value: WaChangeValue; field: string }[];
}

interface WaPayload {
  object?: string;
  entry?: WaEntry[];
}

// ─── Payload processor ────────────────────────────────────────────────────────

async function processWebhookPayload(body: unknown): Promise<void> {
  // Store every raw webhook payload for audit / replay purposes
  await prisma.webhookEvent.create({
    data: {
      provider: "whatsapp",
      rawPayload: body as Prisma.InputJsonValue,
      eventType: extractEventType(body),
    },
  });

  const payload = body as WaPayload;
  if (payload.object !== "whatsapp_business_account") return;

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      for (const msg of change.value.messages ?? []) {
        if (msg.type !== "text" || !msg.text?.body) continue;
        await storeInboundTextMessage(msg);
      }
    }
  }
}

function extractEventType(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const obj = body as Record<string, unknown>;
  return typeof obj.object === "string" ? obj.object : null;
}

// ─── Inbound message storage ──────────────────────────────────────────────────

async function storeInboundTextMessage(msg: WaTextMessage): Promise<void> {
  // Idempotency — skip if this WhatsApp message ID was already stored.
  // externalMessageId has a @unique DB constraint so this is a cheap index read.
  const exists = await prisma.message.findUnique({
    where: { externalMessageId: msg.id },
    select: { id: true },
  });
  if (exists) return;

  // One conversation per sender phone per channel — create on first contact,
  // then reuse. Empty update is intentional: @updatedAt refreshes automatically.
  const conversation = await prisma.conversation.upsert({
    where: {
      phone_channel: { phone: msg.from, channel: ConversationChannel.WHATSAPP },
    },
    update: {},
    create: {
      phone: msg.from,
      channel: ConversationChannel.WHATSAPP,
      state: ConversationState.NEW,
    },
    select: { id: true },
  });

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: MessageDirection.INBOUND,
      externalMessageId: msg.id,
      fromPhone: msg.from,
      body: msg.text?.body ?? null,
      rawPayload: (msg as unknown) as Prisma.InputJsonValue,
    },
  });
}
