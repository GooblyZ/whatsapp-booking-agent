"use server";

// app/dashboard/ai-debug/actions.ts
// Developer-only AI test panel action.
//
// SAFE BY CONSTRUCTION:
//   - Uses the PURE brain (runReceptionistTurn) — NO DB writes, NO state changes.
//   - Does NOT call logAIEvent(), so test runs never pollute usage counters.
//   - Never creates/cancels/reschedules appointments.
//   - Runs single-turn with an EMPTY booking session (no customer attached).
// It DOES make a real (read-only) Gemini call and a read-only availability query
// when the test message references a concrete date.

import { getDefaultBusinessId } from "@/lib/config";
import { supabaseServer } from "@/lib/supabase/server";
import { getBusinessAIContext } from "@/lib/ai/context";
import { runReceptionistTurn } from "@/lib/ai/brain";
import { auditBusinessContext, buildFacts, formatFacts, type ContextAudit, type Capabilities } from "@/lib/ai/facts";
import { buildReceptionistInstruction } from "@/lib/ai/persona";
import {
  emptySession, probeMessage, mergeUnderstanding, missingFields, renderSession,
  type ServiceLite,
} from "@/lib/ai/booking-session";
import { buildAvailabilityInfo, renderAvailabilityInfo } from "@/lib/ai/availability-facts";
import { isGeminiConfigured, getGeminiModel } from "@/lib/ai/gemini";

export interface AIDebugState {
  ran: boolean;
  error?: string;
  message?: string;
  geminiConfigured?: boolean;
  model?: string;
  geminiCalled?: boolean;
  skipReason?: string;
  branch?: string;
  fallbackReason?: string;
  intent?: string | null;
  conversationGoal?: string | null;
  missingInformation?: string | null;
  responseType?: string;
  replySource?: string;
  grounded?: boolean | null;
  groundingViolations?: string[];
  wantsToCancel?: boolean;
  // Booking-context view (what one turn would extract/build)
  extractedFields?: string;       // JSON of session after merging this turn
  newFields?: string[];
  missingFields?: string[];
  availabilitySource?: string;
  availabilityPreview?: string;
  evaluationCategory?: string | null;
  structured?: string;            // pretty-printed "understanding" block, or a note
  reply?: string;
  audit?: ContextAudit;
  factsPreview?: string;
  systemPrompt?: string;
  appliedSettings?: {
    assistantName: string;
    gender: string;
    language: string;
    responseLength: string;
    emojiUsage: string;
    hasCustomInstructions: boolean;
    aiEnabled: boolean;
    faqEnabled: boolean;
    intentDetectionEnabled: boolean;
  };
  memoryNote?: string;
}

export async function runAIDebug(_prev: AIDebugState, formData: FormData): Promise<AIDebugState> {
  const message = String(formData.get("message") ?? "").trim();
  if (!message) {
    return { ran: false, error: "אנא הזן הודעה לבדיקה." };
  }

  try {
    const businessId = getDefaultBusinessId();
    const db = supabaseServer();
    const ctx = await getBusinessAIContext(businessId);
    const timezone = ctx.business.timezone || "Asia/Jerusalem";

    const services: ServiceLite[] = ctx.services
      .filter((s) => s.active)
      .map((s) => ({ id: s.id, name: s.name, duration_minutes: s.duration_minutes }));

    // Probe + availability exactly like the live engine (single turn, empty session).
    const session0 = emptySession();
    const probe = probeMessage(message, session0, services, timezone);
    const availability = probe.dateISO
      ? await buildAvailabilityInfo(db, businessId, ctx, probe.dateISO, probe.time, probe.service?.duration_minutes ?? null)
      : null;
    const pendingTimeNoDate = !probe.dateISO && probe.time ? probe.time : null;
    const allowedTimes = availability
      ? [...availability.slots, ...(availability.requested?.nearest ?? [])]
      : [];

    const d = await runReceptionistTurn(ctx, {
      conversationContext: "",
      message,
      availabilityBlock: renderAvailabilityInfo(availability, pendingTimeNoDate),
      bookingBlock: renderSession(session0),
      allowedTimes,
      // AI-Test honesty (post-v1 audit Slice 1b): every LIVE customer turn runs the PLATFORM
      // persona variant (platform-turn.ts passes platformMode: true). Without this flag the test
      // silently exercised the LEGACY conversational prompt — a different variant with different
      // appointment rules. Debug-tool-only change; no customer path is affected.
      platformMode: true,
    });

    // Show what the booking context WOULD become after this turn (no persistence).
    let sessionAfter = session0;
    let newFields: string[] = [];
    if (d.turn) {
      const u = d.turn.understanding;
      const merged = mergeUnderstanding(session0, {
        serviceName: u.serviceName, dateText: u.dateText, time: u.time,
        timePreference: u.timePreference, customerReference: u.customerReference,
        conversationGoal: u.conversationGoal, bookingIntent: u.intent === "booking",
      }, probe, services, timezone);
      sessionAfter = merged.session;
      newFields = merged.newFields;
    }

    const facts = buildFacts(ctx);
    const ai = ctx.aiSettings;
    const caps: Capabilities = {
      canAnswer: ai?.faq_enabled !== false,
      canStartBooking: ai?.intent_detection_enabled !== false && facts.bookingEnabled,
      canCancel: false,
      canReschedule: false,
    };

    return {
      ran: true,
      message,
      geminiConfigured: isGeminiConfigured(),
      model: getGeminiModel(),
      geminiCalled: d.geminiCalled,
      skipReason: d.skipReason,
      branch: d.branch,
      fallbackReason: d.fallbackReason,
      intent: d.turn?.understanding.intent ?? null,
      conversationGoal: d.turn?.understanding.conversationGoal ?? null,
      missingInformation: d.turn?.understanding.missingInformation ?? null,
      responseType: d.responseType,
      replySource: d.replySource,
      grounded: d.grounded,
      groundingViolations: d.groundingViolations,
      wantsToCancel: d.wantsToCancel,
      extractedFields: JSON.stringify({
        service: sessionAfter.service ?? sessionAfter.serviceRaw,
        dateText: sessionAfter.dateText,
        dateISO: sessionAfter.dateISO,
        time: sessionAfter.time ?? sessionAfter.timePreference,
        for: sessionAfter.customerReference,
        goal: sessionAfter.conversationGoal,
      }, null, 2),
      newFields,
      missingFields: sessionAfter.active ? missingFields(sessionAfter) : [],
      availabilitySource: availability ? (probe.dateISO ? "message" : "none") : "none",
      availabilityPreview: availability
        ? (availability.slots.length > 0
            ? `${availability.dateISO} (${availability.dayName}): ${availability.slots.join(", ")}${availability.truncated ? ", …" : ""}`
            : `${availability.dateISO} (${availability.dayName}): אין זמינות`)
        : pendingTimeNoDate
          ? `זוהתה שעה ${pendingTimeNoDate} אך ללא יום — הזמינות לא נבדקה`
          : "לא חושבה זמינות (לא זוהה תאריך בהודעה)",
      evaluationCategory: availability?.requested?.category ?? null,
      structured: d.turn
        ? JSON.stringify(d.turn.understanding, null, 2)
        : "(Gemini לא נקרא — הוחלט לפי כללים דטרמיניסטיים)",
      reply: d.replyText,
      audit: auditBusinessContext(ctx),
      factsPreview: formatFacts(facts),
      systemPrompt: buildReceptionistInstruction(ctx, {
        factsBlock: formatFacts(facts),
        caps,
        availabilityBlock: renderAvailabilityInfo(availability, pendingTimeNoDate),
        bookingBlock: renderSession(session0),
        // Match the live variant (see runReceptionistTurn call above): the prompt shown to the
        // developer must be the PLATFORM prompt, not the legacy conversational one. In platform
        // mode the persona correctly omits the availability block — same as production.
        platformMode: true,
      }),
      appliedSettings: {
        assistantName: ai?.assistant_name?.trim() || "Assistant",
        gender: ai?.assistant_gender || "neutral",
        language: ai?.language?.trim() || "he",
        responseLength: ai?.response_length || "medium",
        emojiUsage: ai?.emoji_usage || "low",
        hasCustomInstructions: !!ai?.custom_instructions?.trim(),
        aiEnabled: ai?.ai_enabled !== false,
        faqEnabled: ai?.faq_enabled !== false,
        intentDetectionEnabled: ai?.intent_detection_enabled !== false,
      },
      memoryNote:
        "בדיקה זו רצה ללא זיכרון וללא סשן (אין לקוח). בשיחה חיה: ההקשר נשמר ב-booking_session פר לקוח, הזמינות מחושבת מההקשר המצטבר, וזיהוי לולאות פעיל.",
    };
  } catch (err) {
    return { ran: false, error: err instanceof Error ? err.message : String(err) };
  }
}
