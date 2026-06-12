// lib/ai/platform-turn.ts
// Server-side only.
//
// PLATFORM-MODE conversation turn (TRANSITION_PLAN.md): the AI converses,
// answers FAQs from facts, and DETECTS appointment intent — it never collects
// scheduling details. The SYSTEM (this module, deterministically) attaches the
// booking / self-service link after the model's reply. One Gemini call per
// turn, same as always; the conversational-scheduling machinery in
// idle-handler.ts is bypassed entirely.

import type { DB } from "@/lib/booking/helpers";
import { upsertConversationState } from "@/lib/booking/helpers";
import { getBusinessAIContext } from "./context";
import {
  getConversationContext, renderUpcomingAppointments, didLastReplyFailToSend,
} from "./conversation";
import { isGeminiCoolingDown, geminiCooldownRemainingMs } from "./gemini";
import {
  runReceptionistTurn, FALLBACK, classifyInput, type ReceptionistDecision,
} from "./brain";
import { stripEmojis, sameOutboundText, claimsBookingCompleted } from "./reply-polish";
import { logAIEvent } from "./events";
import { buildBookingLink, buildAppointmentLink } from "@/lib/config";

export type PlatformLink = "booking" | "manage" | null;

export interface PlatformTurnOutcome {
  replyText: string;
  decision: ReceptionistDecision;
  linkAttached: PlatformLink;
}

const BOOK_LINE = "לקביעת תור:";
const MANAGE_LINE = "לצפייה, שינוי או ביטול התור:";

/**
 * Runs one platform-mode turn. Persists nothing except a state reset for
 * legacy non-idle states; the router sends `replyText`.
 */
export async function runPlatformTurn(
  db: DB,
  businessId: string,
  customerId: string,
  customerPhone: string,
  messageText: string,
  rawState: string
): Promise<PlatformTurnOutcome> {
  // Legacy conversational-booking states cannot continue in platform mode —
  // reset once so the customer starts clean after the flip.
  if (rawState !== "idle") {
    console.log(`[platform-turn] resetting legacy state "${rawState}" → idle`);
    await upsertConversationState(db, businessId, customerId, "idle", {});
  }

  let ctx;
  try {
    ctx = await getBusinessAIContext(businessId);
  } catch (err) {
    console.error("[platform-turn] failed to load business context:", err instanceof Error ? err.message : String(err));
    const decision = errorDecision("context_load_error");
    await safeLog(businessId, customerId, decision);
    return { replyText: FALLBACK.error, decision, linkAttached: null };
  }

  const timezone = ctx.business.timezone || "Asia/Jerusalem";
  const [memory, upcomingBlock, lastSendFailed] = await Promise.all([
    getConversationContext(db, businessId, customerId),
    renderUpcomingAppointments(db, businessId, customerId, timezone),
    didLastReplyFailToSend(db, businessId, customerId),
  ]);
  const lastAssistant = lastAssistantLine(memory.transcript);

  // DEGRADED MODE: during a Gemini overload cooldown the platform story is
  // simple — the booking page IS the deterministic path. Route to it directly.
  if (isGeminiCoolingDown() && classifyInput(messageText) === "ok") {
    console.warn(`[platform-turn] DEGRADED MODE — cooldown ${Math.ceil(geminiCooldownRemainingMs() / 1000)}s left; deterministic link reply`);
    const link = buildBookingLink(ctx.business.slug, customerPhone);
    let replyText = `יש לי רגע עומס קטן במערכת 🙏 אפשר בינתיים לקבוע, לשנות או לבדוק זמינות כאן:\n${link}`;
    if (ctx.aiSettings?.emoji_usage === "none") replyText = stripEmojis(replyText);
    const decision = errorDecision("gemini_cooldown", true);
    await safeLog(businessId, customerId, decision);
    return { replyText, decision, linkAttached: "booking" };
  }

  let replyGuidance: string | undefined;
  if (lastSendFailed) {
    replyGuidance =
      `NOTE: your PREVIOUS reply FAILED to deliver (technical issue on our side — the customer never saw it). Open with a brief, warm acknowledgement of a small hiccup ("הייתה לי תקלה קטנה קודם") before continuing.`;
  }

  const decision = await runReceptionistTurn(ctx, {
    historyTurns: memory.turns,
    conversationContext: memory.transcript,
    message: messageText,
    bookingBlock: upcomingBlock,
    replyGuidance,
    platformMode: true,
  });

  let replyText = decision.replyText;

  // The model must never claim a booking action happened — in platform mode it
  // structurally can't have. Replace the lie with an honest router line.
  if (decision.ok && claimsBookingCompleted(replyText)) {
    replyText = "את התור עצמו קובעים בקישור — שניה ושולח לך אותו 🙂";
  }
  // Never send the exact same reply twice in a row.
  if (decision.ok && sameOutboundText(replyText, lastAssistant)) {
    replyText = "אני כאן 🙂 אפשר לשאול אותי הכל על העסק, או לקבוע תור בקישור למטה.";
  }

  // ── Deterministic intent routing — the system attaches links, never the model.
  const u = decision.turn?.understanding;
  let linkAttached: PlatformLink = null;
  if (decision.ok && u) {
    const wantsBooking = u.appointmentIntent === "BOOK" || u.intent === "booking";
    const wantsManage =
      u.appointmentIntent === "CANCEL" || u.appointmentIntent === "RESCHEDULE" ||
      u.appointmentIntent === "MODIFY" || u.intent === "cancel_request" || u.intent === "reschedule_request";

    if (wantsManage) {
      const apptId = await nearestUpcomingAppointmentId(db, businessId, customerId);
      const url = apptId ? buildAppointmentLink(apptId) : buildBookingLink(ctx.business.slug, customerPhone);
      if (!lastAssistant?.includes(url)) {
        replyText = `${replyText}\n\n${apptId ? MANAGE_LINE : BOOK_LINE}\n${url}`;
        linkAttached = apptId ? "manage" : "booking";
      }
    } else if (wantsBooking) {
      const url = buildBookingLink(ctx.business.slug, customerPhone);
      if (!lastAssistant?.includes(url)) {
        replyText = `${replyText}\n\n${BOOK_LINE}\n${url}`;
        linkAttached = "booking";
      }
    }
  }

  if (ctx.aiSettings?.emoji_usage === "none") {
    replyText = stripEmojis(replyText);
  }

  await safeLog(businessId, customerId, decision);
  console.log(
    `[platform-turn] ai_called=${decision.geminiCalled} intent=${u?.intent ?? "-"}` +
    ` appt_intent=${u?.appointmentIntent ?? "-"} link=${linkAttached ?? "-"}` +
    ` src=${decision.replySource} memLines=${memory.turnsUsed}`
  );

  return { replyText, decision, linkAttached };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function nearestUpcomingAppointmentId(
  db: DB, businessId: string, customerId: string
): Promise<string | null> {
  const { data } = await db
    .from("appointments")
    .select("id")
    .eq("business_id", businessId)
    .eq("customer_id", customerId)
    .in("status", ["pending", "confirmed"])
    .gt("start_time", new Date().toISOString())
    .order("start_time", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data?.id as string) ?? null;
}

function lastAssistantLine(transcript: string): string | null {
  const lines = transcript.split("\n").filter((l) => l.startsWith("Assistant (you, earlier): "));
  if (lines.length === 0) return null;
  return lines[lines.length - 1].replace("Assistant (you, earlier): ", "").replace(/\s+/g, " ").trim();
}

function errorDecision(branch: string, ok = false): ReceptionistDecision {
  return {
    geminiCalled: false, ok, turn: null,
    replyText: FALLBACK.error, responseType: ok ? "degraded" : "error",
    grounded: null, replySource: "fallback", wantsToCancel: false,
    branch, fallbackReason: ok ? undefined : branch,
  };
}

async function safeLog(businessId: string, customerId: string, d: ReceptionistDecision): Promise<void> {
  await logAIEvent({
    businessId,
    customerId,
    called: d.geminiCalled,
    intent: d.turn?.understanding.intent ?? null,
    confidence: null,
    success: d.responseType !== "error",
    responseType: d.responseType,
  });
}
