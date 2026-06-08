// app/api/webhook/whatsapp/route.ts
// Receives and verifies Meta WhatsApp Cloud API webhook events.
//
// GET  → webhook verification (Meta sends hub.mode / hub.verify_token / hub.challenge)
// POST → incoming messages; delegates to lib/message-handler.ts
//
// Rules:
// - Always return HTTP 200 to Meta on POST (even on errors) to prevent retries.
// - Never log secrets.
// - Processing runs asynchronously so Meta gets an immediate 200.

import { NextRequest, NextResponse } from "next/server";
import { handleIncomingMessage } from "@/lib/message-handler";

// ── GET: Meta webhook verification ──────────────────────────────────────────

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode      = params.get("hub.mode");
  const token     = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  const verifyToken = process.env.META_VERIFY_TOKEN;

  if (mode === "subscribe" && verifyToken && token === verifyToken && challenge) {
    console.log("[webhook/whatsapp] GET: verification successful");
    return new NextResponse(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  console.warn("[webhook/whatsapp] GET: verification failed — check META_VERIFY_TOKEN");
  return new NextResponse("Forbidden", { status: 403 });
}

// ── POST: Incoming webhook events ────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    console.error("[webhook/whatsapp] POST: malformed JSON body");
    return new NextResponse("OK", { status: 200 });
  }

  console.log("[webhook/whatsapp] POST: received");

  const businessId = process.env.DEFAULT_BUSINESS_ID;
  if (!businessId) {
    console.error("[webhook/whatsapp] DEFAULT_BUSINESS_ID not set — cannot route message");
    return new NextResponse("OK", { status: 200 });
  }
  console.log(`[webhook/whatsapp] routing to business_id=${businessId}`);

  // Process asynchronously — Meta must receive 200 immediately.
  processPayload(body, businessId).catch((err) => {
    console.error(
      "[webhook/whatsapp] processing error:",
      err instanceof Error ? err.message : String(err)
    );
  });

  return new NextResponse("OK", { status: 200 });
}

// ── Payload processing ────────────────────────────────────────────────────────

async function processPayload(body: unknown, businessId: string): Promise<void> {
  const payload = body as WaPayload;
  if (payload?.object !== "whatsapp_business_account") {
    console.log("[webhook/whatsapp] ignoring non-WhatsApp payload:", payload?.object);
    return;
  }

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;

      // Log status updates (delivery receipts, read receipts, errors, etc.)
      for (const rawStatus of change.value?.statuses ?? []) {
        const s = rawStatus as WaStatus;
        const maskedRecipient = s.recipient_id
          ? s.recipient_id.slice(0, -4).replace(/\d/g, "*") + s.recipient_id.slice(-4)
          : "unknown";
        const errorPart = s.errors?.[0]
          ? ` error=[${s.errors[0].code}] ${s.errors[0].title}: ${s.errors[0].message}`
          : "";
        const convPart  = s.conversation?.id   ? ` conv=${s.conversation.id}`                   : "";
        const pricePart = s.pricing?.category  ? ` pricing=${s.pricing.category}`               : "";
        console.log(
          `[webhook/whatsapp] STATUS wamid=${s.id} status=${s.status} ts=${s.timestamp}` +
          ` recipient=${maskedRecipient}${convPart}${pricePart}${errorPart}`
        );
      }

      for (const msg of change.value?.messages ?? []) {
        if (msg.type !== "text" || !msg.text?.body) continue;

        await handleIncomingMessage({
          businessId,
          fromPhone:   msg.from,
          messageText: msg.text.body,
          waMessageId: msg.id,
          waTimestamp: msg.timestamp ?? null,
          rawPayload:  body,
        });
      }
    }
  }
}

// ── WhatsApp payload types ────────────────────────────────────────────────────

interface WaTextMessage {
  id:         string;
  from:       string;
  type:       string;
  timestamp?: string;
  text?:      { body: string };
}

interface WaStatusError {
  code:    number;
  title:   string;
  message: string;
}

interface WaStatus {
  id:           string;
  status:       string;
  timestamp:    string;
  recipient_id: string;
  conversation?: { id: string };
  pricing?:      { category: string };
  errors?:       WaStatusError[];
}

interface WaChangeValue {
  messages?:  WaTextMessage[];
  statuses?:  WaStatus[];
}

interface WaEntry {
  changes?: { value: WaChangeValue; field: string }[];
}

interface WaPayload {
  object?: string;
  entry?:  WaEntry[];
}
