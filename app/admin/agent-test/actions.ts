"use server";

import {
  analyzeMessage,
  runSuggestedTool,
  runGeminiAgent,
  isGeminiEnabled,
  createConversationState,
  updateStateFromLlm,
  applySlotSelection,
  applyNameFill,
  applyPhoneFill,
  applyDeny,
  applyConfirmPending,
  resolveFollowUpMessage,
} from "@/lib/agent";
import type {
  AgentAnalysisResult,
  ToolRunResult,
  LlmAgentResult,
  ConversationState,
  MessageTurn,
  GeminiConversationContext,
  GeminiStructuredOutput,
  MissingField,
} from "@/lib/agent";
import type { AgentIntent } from "@/lib/agent";

export type AgentMode = "rule" | "llm";

export type AnalyzeState =
  | { mode: "rule"; result: AgentAnalysisResult; toolRun: ToolRunResult | null; message: string }
  | { mode: "llm"; llmResult: LlmAgentResult; message: string; updatedState: ConversationState }
  | { error: string }
  | null;

// ─── Follow-up response composition (kept for emergency fallback) ──────────────

const HE_SERVICE: Record<string, string> = {
  "Haircut":         "תספורת",
  "Beard":           "זקן",
  "Haircut + Beard": "תספורת וזקן",
  "Kids Haircut":    "תספורת ילדים",
};

const HE_DATE: Record<string, string> = {
  tomorrow:             "מחר",
  today:                "היום",
  "day after tomorrow": "מחרתיים",
  Friday:               "ביום שישי",
  "next Friday":        "שישי הבא",
  Sunday:               "ביום ראשון",
  Monday:               "ביום שני",
  Tuesday:              "ביום שלישי",
  Wednesday:            "ביום רביעי",
  Thursday:             "ביום חמישי",
  Saturday:             "ביום שבת",
};

function buildConfirmation(state: ConversationState, isHebrew: boolean): string {
  const svc  = state.selectedService  ?? "?";
  const date = state.datePreference   ?? "?";
  const slot = state.selectedSlot     ?? "?";
  const name = state.customerName     ?? "?";
  if (isHebrew) {
    const svcHe  = HE_SERVICE[svc]  ?? svc;
    const dateHe = HE_DATE[date]    ?? date;
    return `לאשר תור ל${svcHe} ${dateHe} בשעה ${slot} על שם ${name}?`;
  }
  return `Confirm appointment for ${svc} on ${date} at ${slot} for ${name}?`;
}

// ─── Safe JSON parse ───────────────────────────────────────────────────────────

function safeParse<T>(json: string): T | null {
  try { return JSON.parse(json) as T; } catch { return null; }
}

// ─── Phone normalization ───────────────────────────────────────────────────────
// Accepts: 0521234567 | 052-123-4567 | +972521234567 | 972521234567
// Rejects: too short, random text, clearly invalid

function normalizePhone(raw: string): string | null {
  const clean = raw.replace(/[\s\-\.()]/g, "");
  if (/^\+972([1-9]\d{8})$/.test(clean))  return "0" + clean.slice(4);
  if (/^972([1-9]\d{8})$/.test(clean))    return "0" + clean.slice(3);
  if (/^0[1-9]\d{8}$/.test(clean))        return clean;
  return null;
}

// ─── AgentAction state routing ─────────────────────────────────────────────────
// Routes LLM result through state transitions based on actionType.
// Falls back to updateStateFromLlm for normal (non-follow-up) actions.

function applyAgentActionToState(
  llmResult: LlmAgentResult,
  baseState: ConversationState,
  message: string,
): ConversationState {
  const action = llmResult.agentAction;

  if (!action) {
    // Fallback path (analyzer.ts was used): use legacy state updater
    return updateStateFromLlm(baseState, {
      intent:            llmResult.geminiRaw.intent,
      normalizedService: llmResult.normalized.service,
      normalizedDate:    llmResult.normalized.datePreference,
      normalizedTime:    llmResult.normalized.timePreference,
      customerName:      llmResult.geminiRaw.customerName,
      missingFields:     llmResult.geminiRaw.missingFields as MissingField[],
      toolRun:           llmResult.toolRun,
      finalDraft:        llmResult.finalDraft,
    });
  }

  switch (action.actionType) {
    case "SELECT_OFFERED_SLOT": {
      if (!action.selectedSlotCandidate) break;
      const next = applySlotSelection(baseState, action.selectedSlotCandidate);
      return { ...next, lastAgentResponse: llmResult.finalDraft };
    }

    case "CONFIRM_PENDING": {
      // Current stage: write tools disabled → appointmentCreated=false → test_mode_confirmed.
      // Future stage: pass appointmentCreated=true + appointmentId after backend success → confirmed.
      const next = applyConfirmPending(baseState, false /* appointmentCreated */);
      return { ...next, lastAgentResponse: llmResult.finalDraft };
    }

    case "DENY_PENDING": {
      const next = applyDeny(baseState);
      return { ...next, lastAgentResponse: llmResult.finalDraft };
    }

    case "PROVIDE_MISSING_FIELD": {
      // Name provided
      if (action.customerName && baseState.nextRequiredField === "customerName") {
        const next = applyNameFill(baseState, action.customerName);
        return { ...next, lastAgentResponse: llmResult.finalDraft };
      }
      // Phone provided — normalize and validate before storing
      if (action.customerPhone && baseState.nextRequiredField === "customerPhone") {
        const normalized = normalizePhone(action.customerPhone);
        if (normalized) {
          const next = applyPhoneFill(baseState, normalized);
          return { ...next, lastAgentResponse: llmResult.finalDraft };
        }
        // Invalid phone — don't advance state; Phase 2 draft will ask again
        return { ...baseState, lastAgentResponse: llmResult.finalDraft };
      }
      // Otherwise fall through to normal state update (date/service may have been provided)
      break;
    }

    default:
      break;
  }

  // Normal path: service/date/availability update
  return updateStateFromLlm(baseState, {
    intent:            ACTION_TO_INTENT[action.actionType] ?? "UNKNOWN",
    normalizedService: llmResult.normalized.service,
    normalizedDate:    llmResult.normalized.datePreference,
    normalizedTime:    llmResult.normalized.timePreference,
    customerName:      action.customerName ?? llmResult.geminiRaw.customerName,
    missingFields:     action.missingFields as MissingField[],
    toolRun:           llmResult.toolRun,
    finalDraft:        llmResult.finalDraft,
  });
}

const ACTION_TO_INTENT: Record<string, string> = {
  ASK_AVAILABILITY: "ASK_AVAILABILITY", ASK_SERVICES: "ASK_SERVICES",
  ASK_BUSINESS_HOURS: "ASK_BUSINESS_HOURS", SELECT_OFFERED_SLOT: "BOOK_APPOINTMENT",
  CONFIRM_PENDING: "BOOK_APPOINTMENT", DENY_PENDING: "BOOK_APPOINTMENT",
  PROVIDE_MISSING_FIELD: "BOOK_APPOINTMENT", HUMAN_HANDOFF: "HUMAN_HANDOFF", UNKNOWN: "UNKNOWN",
};

// ─── Emergency fallback synthetic result ───────────────────────────────────────
// Used only when Gemini throws AND the follow-up resolver matched.
// In the normal path, Gemini handles follow-ups via AgentAction.

function makeSyntheticLlmResult(
  intent: string,
  finalDraft: string,
  state: ConversationState,
): LlmAgentResult {
  const lang: "he" | "en" | "unknown" = /[א-ת]/.test(finalDraft) ? "he" : "en";
  const geminiRaw: GeminiStructuredOutput = {
    intent,
    confidence: "HIGH",
    service: state.selectedService,
    datePreference: state.datePreference,
    timePreference: state.selectedTimePreference,
    customerName: state.customerName,
    missingFields: state.missingFields as MissingField[],
    requestedTool: null,
    draftResponse: finalDraft,
    language: lang,
    safetyWarnings: [],
    queryStyle: null,
  };
  return {
    mode: "llm",
    modelUsed: "emergency-follow-up-fallback",
    llmStatus: "fallback_used" as const,
    agentAction: null,
    geminiRaw,
    normalized: {
      service: state.selectedService,
      datePreference: state.datePreference,
      timePreference: state.selectedTimePreference,
    },
    toolRun: null,
    finalDraft,
    fallbackUsed: true,
    fallbackReason: "Gemini unavailable — emergency follow-up fallback",
    safetyWarnings: ["Emergency fallback: follow-up resolved locally"],
    autoSelectSlot: null,
    analysis: {
      intent:                (intent as AgentIntent) ?? "BOOK_APPOINTMENT",
      confidence:            "HIGH",
      extractedService:      state.selectedService,
      extractedDate:         state.datePreference,
      extractedTime:         state.selectedTimePreference,
      extractedCustomerName: state.customerName,
      hasExactTime:          false,
      needsAvailabilityCheck: false,
      missingFields:         state.missingFields as MissingField[],
      suggestedToolCall:     { tool: "handoffToHuman", reason: "Emergency fallback" },
      draftResponse:         finalDraft,
      notes:                 "Emergency: follow-up resolved locally when Gemini unavailable",
    },
  };
}

// ─── Main action ───────────────────────────────────────────────────────────────

export async function analyzeWhatsAppMessage(
  _prevState: AnalyzeState,
  formData: FormData,
): Promise<AnalyzeState> {
  const message = formData.get("message");
  if (typeof message !== "string" || !message.trim())
    return { error: "Message is required." };
  if (message.length > 1000)
    return { error: "Message is too long (max 1000 characters)." };

  const phone       = formData.get("phone");
  const modeRaw     = formData.get("mode");
  const mode: AgentMode = modeRaw === "llm" ? "llm" : "rule";

  const convStateJson  = formData.get("conversationStateJson");
  const historyJson    = formData.get("conversationHistoryJson");

  const prevConvState = typeof convStateJson === "string" && convStateJson
    ? safeParse<ConversationState>(convStateJson)
    : null;
  const history: MessageTurn[] = typeof historyJson === "string" && historyJson
    ? (safeParse<MessageTurn[]>(historyJson) ?? [])
    : [];

  const phoneStr =
    typeof phone === "string" && phone.trim()
      ? phone.trim()
      : prevConvState?.customerPhone ?? undefined;

  if (mode === "llm") {
    if (!isGeminiEnabled()) {
      return { error: "Gemini LLM mode is not available. Check GEMINI_API_KEY, LLM_AGENT_ENABLED, and LLM_PROVIDER." };
    }

    // Build conversation context — includes pendingConfirmation + nextRequiredField
    // so Gemini can classify follow-ups (confirm/deny/slot-pick) correctly.
    const geminiContext: GeminiConversationContext | undefined = prevConvState
      ? {
          state: {
            currentIntent:          prevConvState.currentIntent,
            selectedService:        prevConvState.selectedService,
            datePreference:         prevConvState.datePreference,
            selectedTimePreference: prevConvState.selectedTimePreference,
            offeredSlots:           prevConvState.offeredSlots,
            selectedSlot:           prevConvState.selectedSlot,
            customerName:           prevConvState.customerName,
            pendingConfirmation:    prevConvState.pendingConfirmation,
            nextRequiredField:      prevConvState.nextRequiredField,
            lastAgentResponse:      prevConvState.lastAgentResponse, // critical for context
            bookingLifecycle:       prevConvState.bookingLifecycle,
            appointmentCreated:     prevConvState.appointmentCreated,
            customerPhone:          prevConvState.customerPhone,
          },
          history: history.slice(-6),
        }
      : undefined;

    const llmResult = await runGeminiAgent(message.trim(), phoneStr, geminiContext);

    const baseState  = prevConvState ?? createConversationState(phoneStr);
    let updatedState = applyAgentActionToState(llmResult, baseState, message.trim());

    // Server-enforced slot auto-selection: when exact_time_check confirms a slot is
    // available, the server selects it automatically so the booking flow advances
    // to name collection without requiring an extra user turn.
    if (llmResult.autoSelectSlot && updatedState.selectedSlot !== llmResult.autoSelectSlot) {
      updatedState = applySlotSelection(updatedState, llmResult.autoSelectSlot);
      updatedState = { ...updatedState, lastAgentResponse: llmResult.finalDraft };
    }

    // Store phone in state if it came from the form
    if (phoneStr && !updatedState.customerPhone) {
      updatedState = { ...updatedState, customerPhone: phoneStr };
    }

    return { mode: "llm", llmResult, message: message.trim(), updatedState };
  }

  // ── Rule-based mode (single-turn, unchanged) ──────────────────────────────────

  const result = analyzeMessage(message.trim(), phoneStr);
  let toolRun: ToolRunResult | null = null;
  try {
    toolRun = await runSuggestedTool(result, message.trim(), phoneStr);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    toolRun = {
      status: "skipped",
      actualToolName: result.suggestedToolCall.tool,
      args: {},
      result: null,
      skippedReason: `Tool execution error: ${msg}`,
      enrichedDraft: result.draftResponse,
    };
  }

  return { mode: "rule", result, toolRun, message: message.trim() };
}

export async function getGeminiAvailability(): Promise<boolean> {
  return isGeminiEnabled();
}
