import { GoogleGenAI } from "@google/genai";
import type { AgentAnalysisResult, AgentIntent, AgentConfidence, MissingField, SuggestedTool, ToolRunResult } from "./types";
import { analyzeMessage } from "./analyzer";
import { runSuggestedTool } from "./tool-runner";
import { normalizeExactTime, normalizeDatePreference, normalizeTimePreference, type NormalizedFields } from "./normalizer";
import { composeLlmResponse } from "./response-composer";
import { runPhase2Phrasing, sanitizeResponseLanguage, validateBookingTruth, getServiceDisplayHe, getDateDisplayHe, getPeriodDisplayHe } from "./phase2-phrasing";
import type { Phase2Input } from "./phase2-phrasing";
import { getServicesTool } from "./tools";
import type { ServiceResult, AvailabilityResult } from "./tools";
import { evaluateRequestedTime, selectSlotByGoal } from "./time-evaluator";
import type { RequestedTimeEvaluation, AvailabilityGoal } from "./time-evaluator";
import {
  validateAgentAction,
  validateServiceCandidate,
  resolveSlotSelection,
  type AgentAction,
  type AgentActionType,
} from "./agent-action";

export type { AgentAction, AgentActionType };

// ─── Config ───────────────────────────────────────────────────────────────────

export function isGeminiEnabled(): boolean {
  return (
    process.env.LLM_AGENT_ENABLED === "true" &&
    process.env.LLM_PROVIDER === "gemini" &&
    !!process.env.GEMINI_API_KEY
  );
}

function getModel(): string {
  return process.env.LLM_MODEL || "gemini-2.5-flash-lite";
}

// ─── LLM status ───────────────────────────────────────────────────────────────

export type LlmStatus =
  | "ok"
  | "invalid_json_recovered"
  | "fallback_used"
  | "quota_exceeded"
  | "provider_error";

function classifyGeminiError(e: unknown): LlmStatus {
  const msg = e instanceof Error ? e.message : String(e);
  if (/429|quota|too many requests|rate.?limit/i.test(msg)) return "quota_exceeded";
  return "fallback_used";
}

// ─── Output types (kept for UI/actions.ts compatibility) ──────────────────────

export interface GeminiStructuredOutput {
  intent: string;
  confidence: string;
  service: string | null;
  datePreference: string | null;
  timePreference: string | null;
  customerName: string | null;
  missingFields: string[];
  requestedTool: string | null;
  draftResponse: string;
  language: "he" | "en" | "unknown";
  safetyWarnings: string[];
  queryStyle: "count" | "list" | null;
}

export interface LlmAgentResult {
  mode: "llm";
  modelUsed: string;
  llmStatus: LlmStatus;              // quota_exceeded | fallback_used | ok | …
  agentAction: AgentAction | null;    // primary: validated LLM output
  geminiRaw: GeminiStructuredOutput;  // bridged for UI/state compatibility
  normalized: NormalizedFields;
  toolRun: ToolRunResult | null;
  finalDraft: string;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  safetyWarnings: string[];
  analysis: AgentAnalysisResult;
  // Server auto-selected this slot (exact_time_check confirmed available).
  // actions.ts must call applySlotSelection with this value after state update.
  autoSelectSlot: string | null;
}

const AGENT_ACTION_PROMPT = `You are a booking agent for a barbershop. Classify the customer message into an AgentAction JSON object.
CRITICAL: Return ONLY valid JSON. No markdown. No text outside JSON. Uncertain → LOW confidence.
SAFETY: Classify intent only. Never suggest write tools.
ACTIONS: ASK_AVAILABILITY | ASK_SERVICES | ASK_BUSINESS_HOURS | SELECT_OFFERED_SLOT | CONFIRM_PENDING | DENY_PENDING | PROVIDE_MISSING_FIELD | HUMAN_HANDOFF | UNKNOWN
SCHEMA (all required): {"actionType":"","confidence":"HIGH|MEDIUM|LOW","language":"he|en|unknown","serviceCandidate":"<CATALOG or null>","dateCandidate":"<as said or null>","requestedTimeCandidate":"<explicit HH:MM ONLY or null>","timePeriodCandidate":"<morning/evening/בוקר/ערב or null>","availabilityGoal":"<earliest_available|latest_available|nearest_to_requested_time|list_options|count_availability|exact_time_check|null>","selectedSlotCandidate":"<from offeredSlots or null>","selectionReference":"<user raw or null>","customerName":"<name or null>","customerPhone":"<phone or null>","missingFields":[],"responseGoal":"<phrasing intent>","debugReasoningSummary":"<why>"}
RULES: 1. serviceCandidate from CATALOG only. 2. requestedTimeCandidate: explicit clock ONLY (ב8→"08:00",ב9:30→"09:30"); "מוקדם/הכי מוקדם/early/earliest"→null (not a clock time). 3. availabilityGoal: מוקדם/כמה מוקדם/הכי מוקדם/earliest→earliest_available; מאוחר בבוקר/מאוחר בערב/לקראת סוף הבוקר/later in period→later_in_period (timePeriodCandidate must also be set); הכי מאוחר שיש/the very latest overall→latest_available; סביבות/בערך/around+time→nearest_to_requested_time; explicit HH:MM→exact_time_check; כמה/count→count_availability; default→list_options; null if not an availability query. 4. SELECT_OFFERED_SLOT only when offeredSlots non-empty. 5. CONFIRM_PENDING only when pendingConfirmation=true; strong yes (כן/מאשר/סבבה/אחלה/sure)→CONFIRM_PENDING; ambiguous (מעולה/תודה alone)→UNKNOWN with responseGoal re-asking confirmation. 6. customerPhone: if nextRequiredField=customerPhone and message is phone-like→PROVIDE_MISSING_FIELD+customerPhone. 7. Acknowledgement mid-flow with missing fields→ask next field. 8. responseGoal: for earliest_available state "offer earliest slot"; for exact_time_check address that time first; for later_in_period "offer later slots in the requested period".
EXAMPLES:
{"actionType":"ASK_AVAILABILITY","confidence":"HIGH","language":"he","serviceCandidate":"Beard","dateCandidate":"מחר","requestedTimeCandidate":null,"timePeriodCandidate":"morning","availabilityGoal":"earliest_available","selectedSlotCandidate":null,"selectionReference":null,"customerName":null,"customerPhone":null,"missingFields":[],"responseGoal":"Find earliest available Beard slot tomorrow morning","debugReasoningSummary":"כמה מוקדם/הכי מוקדם = goal not clock time"}
{"actionType":"ASK_AVAILABILITY","confidence":"HIGH","language":"he","serviceCandidate":"Beard","dateCandidate":"מחר","requestedTimeCandidate":null,"timePeriodCandidate":"morning","availabilityGoal":"later_in_period","selectedSlotCandidate":null,"selectionReference":null,"customerName":null,"customerPhone":null,"missingFields":[],"responseGoal":"Offer later morning slots for Beard tomorrow","debugReasoningSummary":"מאוחר בבוקר = later slots within morning period, timePeriodCandidate=morning required"}
{"actionType":"ASK_AVAILABILITY","confidence":"HIGH","language":"he","serviceCandidate":"Beard","dateCandidate":"מחר","requestedTimeCandidate":"08:00","timePeriodCandidate":null,"availabilityGoal":"exact_time_check","selectedSlotCandidate":null,"selectionReference":null,"customerName":null,"customerPhone":null,"missingFields":[],"responseGoal":"Check if 08:00 is available; if not offer nearest alternatives","debugReasoningSummary":"ב8 = explicit clock time"}
{"actionType":"ASK_AVAILABILITY","confidence":"HIGH","language":"he","serviceCandidate":"Kids Haircut","dateCandidate":"מחר","requestedTimeCandidate":null,"timePeriodCandidate":null,"availabilityGoal":"list_options","selectedSlotCandidate":null,"selectionReference":null,"customerName":null,"customerPhone":null,"missingFields":[],"responseGoal":"List available slots for Kids Haircut tomorrow","debugReasoningSummary":"No time qualifier — list options"}
{"actionType":"SELECT_OFFERED_SLOT","confidence":"HIGH","language":"he","serviceCandidate":null,"dateCandidate":null,"requestedTimeCandidate":null,"timePeriodCandidate":null,"availabilityGoal":null,"selectedSlotCandidate":"09:30","selectionReference":"9:30","customerName":null,"customerPhone":null,"missingFields":[],"responseGoal":"Confirm 09:30 selected, ask for customer name","debugReasoningSummary":"User picked 09:30"}
{"actionType":"PROVIDE_MISSING_FIELD","confidence":"HIGH","language":"he","serviceCandidate":null,"dateCandidate":null,"requestedTimeCandidate":null,"timePeriodCandidate":null,"availabilityGoal":null,"selectedSlotCandidate":null,"selectionReference":null,"customerName":"אמיר","customerPhone":null,"missingFields":[],"responseGoal":"Acknowledge name, ask for phone number","debugReasoningSummary":"User provided name, nextRequiredField=customerPhone"}
{"actionType":"PROVIDE_MISSING_FIELD","confidence":"HIGH","language":"he","serviceCandidate":null,"dateCandidate":null,"requestedTimeCandidate":null,"timePeriodCandidate":null,"availabilityGoal":null,"selectedSlotCandidate":null,"selectionReference":null,"customerName":null,"customerPhone":"0521234567","missingFields":[],"responseGoal":"Acknowledge phone, summarize all booking details and ask for confirmation","debugReasoningSummary":"nextRequiredField=customerPhone, message is phone-like"}
{"actionType":"CONFIRM_PENDING","confidence":"HIGH","language":"he","serviceCandidate":null,"dateCandidate":null,"requestedTimeCandidate":null,"timePeriodCandidate":null,"availabilityGoal":null,"selectedSlotCandidate":null,"selectionReference":null,"customerName":null,"customerPhone":null,"missingFields":[],"responseGoal":"Acknowledge confirmation; test mode — no real appointment created","debugReasoningSummary":"כן with pendingConfirmation=true"}
{"actionType":"ASK_AVAILABILITY","confidence":"HIGH","language":"he","serviceCandidate":null,"dateCandidate":"מחר","requestedTimeCandidate":null,"timePeriodCandidate":"evening","availabilityGoal":"list_options","selectedSlotCandidate":null,"selectionReference":null,"customerName":null,"customerPhone":null,"missingFields":["service"],"responseGoal":"Ask which service before checking availability","debugReasoningSummary":"Date+period set but service missing"}`;

// ─── Conversation context ──────────────────────────────────────────────────────

export interface GeminiConversationContext {
  state: {
    currentIntent: string | null;
    selectedService: string | null;
    datePreference: string | null;
    selectedTimePreference: string | null;
    offeredSlots: string[];
    selectedSlot: string | null;
    customerName: string | null;
    pendingConfirmation: boolean;
    nextRequiredField: string | null;
    lastAgentResponse: string | null;   // what the agent said last turn
    bookingLifecycle: string | null;    // truth-grounding lifecycle stage
    appointmentCreated: boolean;        // true only after backend creates real appointment
    customerPhone: string | null;       // collected phone (for acknowledgement reasoning)
  };
  history: Array<{ role: "user" | "agent"; text: string }>;
}

function buildContextBlock(ctx: GeminiConversationContext): string {
  const s = ctx.state;
  const lines = ["## Conversation context (known facts — do not re-ask unless user corrects)"];
  if (s.currentIntent)            lines.push(`- currentIntent: ${s.currentIntent}`);
  if (s.selectedService)          lines.push(`- selectedService: ${s.selectedService}`);
  if (s.datePreference)           lines.push(`- datePreference: ${s.datePreference}`);
  if (s.selectedTimePreference)   lines.push(`- timePreference: ${s.selectedTimePreference}`);
  if (s.offeredSlots.length > 0)  lines.push(`- offeredSlots: ${s.offeredSlots.join(", ")} — if user picks one use SELECT_OFFERED_SLOT`);
  if (s.selectedSlot)             lines.push(`- selectedSlot: ${s.selectedSlot}`);
  if (s.customerName)             lines.push(`- customerName: ${s.customerName}`);
  if (s.pendingConfirmation)      lines.push(`- pendingConfirmation: true — user saying yes/כן → CONFIRM_PENDING`);
  if (s.nextRequiredField)        lines.push(`- nextRequiredField: ${s.nextRequiredField}`);
  if (s.lastAgentResponse)        lines.push(`- lastAgentResponse: "${s.lastAgentResponse.slice(0, 220)}"`);
  if (s.customerPhone)            lines.push(`- customerPhone: collected`);
  if (s.bookingLifecycle)         lines.push(`- bookingLifecycle: ${s.bookingLifecycle}`);
  if (!s.appointmentCreated && s.bookingLifecycle === "test_mode_confirmed")
    lines.push(`- appointmentCreated: false — write tools disabled; no real appointment exists; do NOT say "booked"`);
  return lines.join("\n");
}

// ─── Parsing ───────────────────────────────────────────────────────────────────

function parseGeminiResponse(text: string): unknown {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch { /* fall through */ } }
  throw new Error(`Cannot parse Gemini JSON. Preview: ${text.slice(0, 300)}`);
}

// ─── Response helpers ──────────────────────────────────────────────────────────

const PROCESS_LANG_RE =
  /^(אני\s*בודק|אני\s*מבדוק|let\s+me\s+(check|look)|i('m|\s+am)\s+(checking|looking)|one\s+moment|רגע\s+אחד)/i;

function hasProcessLanguage(s: string): boolean {
  return PROCESS_LANG_RE.test(s.trim());
}

function ensureLanguageMatch(draft: string, isHebrew: boolean): string {
  if (!isHebrew) return draft;
  const englishOnly = /^[A-Za-z]/.test(draft.trim()) && !/[א-ת]/.test(draft);
  return englishOnly
    ? "לא בטוח שהבנתי. רוצה לבחור שעה, לבדוק זמינות, או לשאול על מחיר?"
    : draft;
}

function buildDirectDraft(action: AgentAction): string {
  const isHe = action.language === "he";
  if (action.missingFields.includes("service")) {
    return isHe
      ? "באיזה שירות אתה מעוניין? (תספורת, זקן, תספורת וזקן, תספורת ילדים)"
      : "Which service? (Haircut, Beard, Haircut + Beard, Kids Haircut)";
  }
  if (action.missingFields.includes("date")) {
    const svc = action.serviceCandidate ?? (isHe ? "השירות" : "the service");
    return isHe ? `לאיזה יום תרצה לבדוק זמינות ל${svc}?` : `What day for ${svc}?`;
  }
  return isHe ? "כיצד אוכל לעזור?" : "How can I help you?";
}

// ─── Phone candidate validation ───────────────────────────────────────────────
// Mirrors normalizePhone in actions.ts. Used here to validate before passing
// the candidate to Phase 2 — prevents raw invalid values from leaking.

function normalizePhoneCandidate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw.replace(/[\s\-\.()]/g, "");
  if (/^\+972([1-9]\d{8})$/.test(clean))  return "0" + clean.slice(4);
  if (/^972([1-9]\d{8})$/.test(clean))    return "0" + clean.slice(3);
  if (/^0[1-9]\d{8}$/.test(clean))        return clean;
  return null;
}

// ─── Tool resolution ───────────────────────────────────────────────────────────
// Server decides which tool to run based on actionType.
// LLM never picks tools directly.

function resolveToolFromActionType(actionType: AgentActionType, missingFields: string[]): SuggestedTool {
  if (actionType === "ASK_AVAILABILITY")
    return missingFields.includes("service") ? "getServices" : "checkAvailability";
  if (actionType === "ASK_SERVICES")      return "getServices";
  if (actionType === "ASK_BUSINESS_HOURS") return "getBusinessInfo";
  return "handoffToHuman";
}

const ACTION_TO_INTENT: Record<string, string> = {
  ASK_AVAILABILITY: "ASK_AVAILABILITY", ASK_SERVICES: "ASK_SERVICES", ASK_BUSINESS_HOURS: "ASK_BUSINESS_HOURS",
  SELECT_OFFERED_SLOT: "BOOK_APPOINTMENT", CONFIRM_PENDING: "BOOK_APPOINTMENT", DENY_PENDING: "BOOK_APPOINTMENT",
  PROVIDE_MISSING_FIELD: "BOOK_APPOINTMENT", HUMAN_HANDOFF: "HUMAN_HANDOFF", UNKNOWN: "UNKNOWN",
};

function bridgeToGeminiOutput(
  action: AgentAction,
  resolvedService: string | null,
  resolvedTool: string | null,
  requestedTime: string | null,
): GeminiStructuredOutput {
  const timePref = requestedTime ? `at ${requestedTime}` : action.timePeriodCandidate;
  return {
    intent:         ACTION_TO_INTENT[action.actionType] ?? "UNKNOWN",
    confidence:     action.confidence,
    service:        resolvedService,
    datePreference: action.dateCandidate,
    timePreference: timePref ?? null,
    customerName:   action.customerName,
    missingFields:  action.missingFields,
    requestedTool:  resolvedTool,
    draftResponse:  action.responseGoal || "כיצד אוכל לעזור?",
    language:       action.language,
    safetyWarnings: [],
    queryStyle:     null,
  };
}

function mapToAnalysisResult(
  action: AgentAction,
  resolvedService: string | null,
  resolvedDate: string | null,
  resolvedTime: string | null,
  tool: SuggestedTool,
): AgentAnalysisResult {
  const hasExactTime = !!(
    resolvedTime &&
    /^(at\s+\d|.*:\d{2}$)/.test(resolvedTime) &&
    !/^after\s+/i.test(resolvedTime)
  );
  return {
    intent:                 (ACTION_TO_INTENT[action.actionType] ?? "UNKNOWN") as AgentIntent,
    confidence:             action.confidence as AgentConfidence,
    extractedService:       resolvedService,
    extractedDate:          resolvedDate,
    extractedTime:          resolvedTime,
    extractedCustomerName:  action.customerName,
    hasExactTime,
    needsAvailabilityCheck: tool === "checkAvailability",
    missingFields:          action.missingFields,
    suggestedToolCall:      { tool, reason: `AgentAction:${action.actionType}` },
    draftResponse:          action.responseGoal || "כיצד אוכל לעזור?",
    notes:                  action.debugReasoningSummary || null,
  };
}

const AVAIL_CONCEPTS = /פנוי|זמינות|תורים?|מקום|slots?|available|availability|appointments?|how many/i;
const COUNT_CONCEPTS  = /כמה\s*(תורים|מקומות|פנויים?)|יש\s*הרבה|how many|count/i;

function enrichFallbackAnalysis(analysis: AgentAnalysisResult, text: string): AgentAnalysisResult {
  if ((analysis.intent !== "UNKNOWN" && analysis.intent !== "HUMAN_HANDOFF") || !AVAIL_CONCEPTS.test(text)) return analysis;
  const isHe = /[א-ת]/.test(text);
  const missing: MissingField[] = [];
  if (!analysis.extractedService) missing.push("service");
  if (!analysis.extractedDate) missing.push("date");
  const tool: SuggestedTool = !analysis.extractedService ? "getServices" : "checkAvailability";
  return { ...analysis, intent: "ASK_AVAILABILITY", confidence: "MEDIUM", missingFields: missing,
    suggestedToolCall: { tool, reason: "Fallback enrichment" },
    draftResponse: !analysis.extractedService ? (isHe ? "באיזה שירות אתה מעוניין?" : "Which service?") : (isHe ? "לאיזה יום?" : "Which day?") };
}

// ─── Main entry point ──────────────────────────────────────────────────────────

export async function runGeminiAgent(
  message: string,
  phone?: string,
  context?: GeminiConversationContext,
): Promise<LlmAgentResult> {
  const apiKey    = process.env.GEMINI_API_KEY;
  const modelName = getModel();
  const safetyWarnings: string[] = [];
  const msgIsHebrew = /[א-ת]/.test(message);
  const showAllSlots = /כל השעות|כל הזמינות|כל האפשרויות|show all|all slots|all times/i.test(message);
  const ai = new GoogleGenAI({ apiKey });

  // Pre-load verified services for catalog injection (grounds LLM in real DB data)
  const verifiedServices: ServiceResult[] = await getServicesTool().catch(() => []);
  const svcsBlock = verifiedServices.length > 0
    ? `\n\n## VERIFIED SERVICE CATALOG (database — these are the ONLY valid services)\n` +
      verifiedServices.map((s) => `- ${s.name} (${s.durationMinutes}min ₪${s.price})`).join("\n") +
      `\nAliases: Haircut→תספורת | Beard→זקן/עיצוב זקן | Haircut+Beard→תספורת וזקן/תספורת+זקן | Kids Haircut→תספורת ילדים/תספורת לילד/ילדים\nserviceCandidate MUST be a canonical name from this list or null.`
    : "";

  // ── Phase 1: Gemini → AgentAction ──────────────────────────────────────────

  let agentAction: AgentAction | null = null;
  let fallbackUsed = false;
  let fallbackReason: string | null = null;
  let llmStatus: LlmStatus = "ok";

  try {
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    if (context?.history.length) {
      for (const turn of context.history.slice(-6)) {
        contents.push({
          role:  turn.role === "agent" ? "model" : "user",
          parts: [{ text: turn.text }],
        });
      }
    }
    contents.push({ role: "user", parts: [{ text: message }] });

    const systemInstruction =
      `${AGENT_ACTION_PROMPT}${svcsBlock}` +
      (context ? `\n\n${buildContextBlock(context)}` : "");

    const response = await ai.models.generateContent({
      model:    modelName,
      contents,
      config:   { systemInstruction, temperature: 0.1 },
    });

    const parsed = parseGeminiResponse(response.text ?? "");
    agentAction = validateAgentAction(parsed);
  } catch (e) {
    // Emergency fallback — LLM unavailable (quota, network, parse error, etc.)
    fallbackUsed   = true;
    fallbackReason = e instanceof Error ? e.message : String(e);
    llmStatus = classifyGeminiError(e);
    const rawFallback = analyzeMessage(message, phone);
    const fallback    = enrichFallbackAnalysis(rawFallback, message);
    const toolRun     = await runSuggestedTool(fallback, message, phone).catch(() => null);
    const fbNorm: NormalizedFields = {
      service:        fallback.extractedService,
      datePreference: fallback.extractedDate,
      timePreference: fallback.extractedTime,
    };
    const fbDraft = ensureLanguageMatch(toolRun?.enrichedDraft ?? fallback.draftResponse, msgIsHebrew);
    return {
      mode: "llm", modelUsed: modelName, llmStatus, agentAction: null,
      geminiRaw: {
        intent: fallback.intent, confidence: fallback.confidence,
        service: fallback.extractedService, datePreference: fallback.extractedDate,
        timePreference: fallback.extractedTime, customerName: fallback.extractedCustomerName,
        missingFields: fallback.missingFields, requestedTool: fallback.suggestedToolCall.tool,
        draftResponse: fbDraft, language: msgIsHebrew ? "he" : "en", safetyWarnings: [],
        queryStyle: COUNT_CONCEPTS.test(message) ? "count" : null,
      },
      normalized: fbNorm, toolRun, finalDraft: fbDraft,
      fallbackUsed: true, fallbackReason, safetyWarnings: [], analysis: fallback,
      autoSelectSlot: null,
    };
  }

  // ── Server-side validation of AgentAction ──────────────────────────────────

  // 1. Validate serviceCandidate against verified catalog
  const resolvedService = validateServiceCandidate(agentAction.serviceCandidate, verifiedServices);
  if (agentAction.serviceCandidate && !resolvedService) {
    safetyWarnings.push(`serviceCandidate "${agentAction.serviceCandidate}" not in verified catalog — cleared`);
  }

  // 2. Normalize date and time fields
  const resolvedDate    = normalizeDatePreference(agentAction.dateCandidate);
  const rawTimePref     = agentAction.requestedTimeCandidate
    ? `at ${agentAction.requestedTimeCandidate}`               // exact → preserve as "at HH:mm"
    : normalizeTimePreference(agentAction.timePeriodCandidate); // vague → normalize period label
  const requestedTime   = normalizeExactTime(rawTimePref);     // "at HH:mm" → "HH:mm" or null

  const norm: NormalizedFields = {
    service:        resolvedService,
    datePreference: resolvedDate,
    timePreference: rawTimePref,
  };

  // 3. Validate SELECT_OFFERED_SLOT — resolved slot must exist in offeredSlots
  const offeredSlots = context?.state.offeredSlots ?? [];
  if (agentAction.actionType === "SELECT_OFFERED_SLOT") {
    const resolvedSlot = resolveSlotSelection(agentAction, offeredSlots, message);
    if (!resolvedSlot) {
      safetyWarnings.push("SELECT_OFFERED_SLOT: slot not found in offeredSlots — downgraded to UNKNOWN");
      agentAction = { ...agentAction, actionType: "UNKNOWN" };
    } else {
      agentAction = { ...agentAction, selectedSlotCandidate: resolvedSlot };
    }
  }

  // 4. Rescue: if UNKNOWN and offeredSlots exist, try server-side slot match
  if (agentAction.actionType === "UNKNOWN" && offeredSlots.length > 0) {
    const rescuedSlot = resolveSlotSelection(
      { ...agentAction, selectionReference: message },
      offeredSlots,
      message,
    );
    if (rescuedSlot) {
      agentAction = { ...agentAction, actionType: "SELECT_OFFERED_SLOT", selectedSlotCandidate: rescuedSlot };
      safetyWarnings.push(`UNKNOWN rescued to SELECT_OFFERED_SLOT (slot: ${rescuedSlot})`);
    }
  }

  // 5. Validate CONFIRM_PENDING — only valid if pendingConfirmation is true in state
  if (agentAction.actionType === "CONFIRM_PENDING" && !context?.state.pendingConfirmation) {
    safetyWarnings.push("CONFIRM_PENDING without pendingConfirmation=true — treated as UNKNOWN");
    agentAction = { ...agentAction, actionType: "UNKNOWN" };
  }

  // 6. Server resolves tool — LLM never picks tools directly
  const resolvedTool = resolveToolFromActionType(agentAction.actionType, agentAction.missingFields);

  // 7. Build compatibility bridges
  const geminiRaw = bridgeToGeminiOutput(
    agentAction, resolvedService,
    resolvedTool === "handoffToHuman" ? null : resolvedTool,
    requestedTime,
  );
  const analysis = mapToAnalysisResult(agentAction, resolvedService, resolvedDate, rawTimePref, resolvedTool);

  // ── Tool execution ────────────────────────────────────────────────────────────

  let toolRun: ToolRunResult | null = null;
  if (resolvedTool !== "handoffToHuman") {
    try {
      toolRun = await runSuggestedTool(analysis, message, phone);
    } catch (e) {
      fallbackUsed   = true;
      fallbackReason = `Tool error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ── Response composition ──────────────────────────────────────────────────────

  const composedDraft  = composeLlmResponse(toolRun, geminiRaw, norm, geminiRaw.intent);
  const rawDraft       = composedDraft ?? toolRun?.enrichedDraft ?? agentAction.responseGoal;
  const deterministicDraft = ensureLanguageMatch(
    hasProcessLanguage(rawDraft) ? buildDirectDraft(agentAction) : rawDraft,
    msgIsHebrew,
  );

  // ── Compute language-safe Phase 2 facts ──────────────────────────────────────

  // Language-safe display names — Phase 2 uses these, never raw canonical names
  const serviceDisplayNameHe = getServiceDisplayHe(resolvedService);
  const dateDisplayHe        = getDateDisplayHe(resolvedDate, agentAction.dateCandidate);
  const timePeriodDisplayHe  = getPeriodDisplayHe(agentAction.timePeriodCandidate);

  // Availability evaluation
  const av          = toolRun?.actualToolName === "checkAvailability"
    ? (toolRun.result as AvailabilityResult | null)
    : null;
  const allAvSlots  = av ? ((av.filteredSlotTimes?.length ? av.filteredSlotTimes : av.allSlotTimes) ?? []) : [];
  const totalAvailable = av?.allSlotTimes?.length ?? 0;

  // Availability goal from Phase 1
  const availabilityGoal: AvailabilityGoal | null = agentAction.availabilityGoal ?? null;

  // Requested-time evaluation — only for exact_time_check / nearest_to_requested_time goals
  const needsTimeEval = !!requestedTime && allAvSlots.length > 0 &&
    (!availabilityGoal || availabilityGoal === "exact_time_check" || availabilityGoal === "nearest_to_requested_time");
  const requestedTimeEval: RequestedTimeEvaluation | null = needsTimeEval
    ? evaluateRequestedTime(requestedTime!, allAvSlots)
    : null;

  // Server decides how many slots Phase 2 may mention based on availability goal
  let allowedSlotsToMention: string[];
  let focusSlot: string | null = null;

  if (showAllSlots) {
    allowedSlotsToMention = allAvSlots;
  } else if (availabilityGoal === "earliest_available" || availabilityGoal === "latest_available" || availabilityGoal === "later_in_period" || availabilityGoal === "nearest_to_requested_time") {
    const { focusSlot: fs, allowedSlots } = selectSlotByGoal(availabilityGoal, allAvSlots, requestedTime);
    focusSlot = fs;
    allowedSlotsToMention = allowedSlots;
  } else if (requestedTime) {
    allowedSlotsToMention = requestedTimeEval?.nearestAlternatives ?? allAvSlots.slice(0, 3);
  } else {
    allowedSlotsToMention = allAvSlots.slice(0, 5);
  }

  // ── Project post-action booking state for Phase 2 lifecycle directive ─────────
  // Phase 2 runs before actions.ts applies state transitions. We compute what
  // the state WILL be so Phase 2 can ask the correct next question.

  const prevState = context?.state ?? null;

  // Auto-select slot when exact time confirmed available (user said "ב9" and 9:00 is free)
  const autoSelectSlot: string | null = (
    agentAction.actionType === "ASK_AVAILABILITY" &&
    availabilityGoal === "exact_time_check" &&
    requestedTimeEval?.requestedTimeAvailable === true &&
    !!requestedTimeEval.exactSlotMatched
  ) ? requestedTimeEval.exactSlotMatched! : null;

  // Projected fields (what state WILL contain after this turn)
  const projService   = resolvedService    ?? prevState?.selectedService  ?? null;
  const projDate      = resolvedDate       ?? prevState?.datePreference   ?? null;
  const projName      = (agentAction.actionType === "PROVIDE_MISSING_FIELD" ? agentAction.customerName : null)
                        ?? prevState?.customerName ?? null;

  // Phone validation — never pass a raw invalid candidate to Phase 2.
  // rawPhoneCandidate is what the LLM extracted; validatedPhone is what we'll actually use.
  const rawPhoneCandidate = agentAction.actionType === "PROVIDE_MISSING_FIELD"
    ? agentAction.customerPhone
    : null;
  const validatedPhoneCandidate = normalizePhoneCandidate(rawPhoneCandidate);
  // invalidPhoneAttempt: user sent something that looked phone-like while phone was required,
  // but it failed validation. Phase 2 must ask for a valid number, not echo the invalid one.
  const invalidPhoneAttempt = !!(
    rawPhoneCandidate &&
    !validatedPhoneCandidate &&
    prevState?.nextRequiredField === "customerPhone"
  );
  const projPhone = validatedPhoneCandidate ?? prevState?.customerPhone ?? null;
  const projSlot      = autoSelectSlot
                        ?? (agentAction.actionType === "SELECT_OFFERED_SLOT" ? agentAction.selectedSlotCandidate : null)
                        ?? prevState?.selectedSlot
                        ?? null;
  const projOffered   = allAvSlots.length > 0 ? allAvSlots : (prevState?.offeredSlots ?? []);
  const slotDetermined = !!projSlot;
  const slotOffered    = projOffered.length > 0;

  // Determine if we're in any kind of booking context
  const isBookingContext = (
    agentAction.actionType === "ASK_AVAILABILITY" ||
    agentAction.actionType === "SELECT_OFFERED_SLOT" ||
    agentAction.actionType === "PROVIDE_MISSING_FIELD" ||
    agentAction.actionType === "CONFIRM_PENDING" ||
    prevState?.currentIntent === "BOOK_APPOINTMENT" ||
    (!!projService && !!projDate)
  );

  // Compute what the server will require next (drives Phase 2 lifecycle directive)
  let projectedNextRequired: string | null = null;
  if (isBookingContext) {
    if (!projService)                            projectedNextRequired = "service";
    else if (!projDate)                          projectedNextRequired = "date";
    else if (!slotDetermined && !slotOffered)    projectedNextRequired = null; // waiting for avail check
    else if (!slotDetermined && slotOffered)     projectedNextRequired = "slot";
    else if (!projName)                          projectedNextRequired = "customerName";
    else if (!projPhone)                         projectedNextRequired = "customerPhone";
    else                                         projectedNextRequired = "confirmation";
  }
  const projectedPendingConfirmation = projectedNextRequired === "confirmation";

  // Project what bookingLifecycle WILL be after this action is applied.
  // Critical for CONFIRM_PENDING: the previous lifecycle is "pending_confirmation"
  // but after the action fires it becomes "test_mode_confirmed" (write tools disabled)
  // or "confirmed" (future: when backend createAppointment succeeds).
  // Phase 2 must see the projected lifecycle, not the pre-action one.
  const projectedBookingLifecycle: string = (() => {
    if (agentAction.actionType === "CONFIRM_PENDING") {
      // Current stage: appointmentCreated=false → test_mode_confirmed.
      // Future stage: caller passes appointmentCreated=true → "confirmed" (handled in actions.ts).
      return "test_mode_confirmed";
    }
    if (agentAction.actionType === "DENY_PENDING") return "collecting_details";
    return prevState?.bookingLifecycle ?? "collecting_details";
  })();

  // ── Phase 2: LLM natural phrasing from verified facts ────────────────────────

  let finalDraft = deterministicDraft;
  try {
    const p2: Phase2Input = {
      toolName:             toolRun?.actualToolName ?? "",
      toolResult:           toolRun?.result ?? null,
      intent:               geminiRaw.intent,
      lang:                 agentAction.language,
      userMessage:          message,
      history:              context?.history ?? [],
      deterministicDraft,
      responseGoal:         agentAction.responseGoal || null,
      // Language-safe display names
      serviceDisplayNameHe,
      dateDisplayHe,
      timePeriodDisplayHe,
      // Raw values for English / non-Hebrew contexts
      normalizedService:    resolvedService,
      origDate:             agentAction.dateCandidate,
      origTime:             agentAction.timePeriodCandidate ?? agentAction.requestedTimeCandidate,
      missingFields:        agentAction.missingFields,
      queryStyle:           null,
      // Requested-time evaluation
      requestedTime,
      requestedTimeEval,
      // Slot display
      allowedSlotsToMention,
      totalAvailableSlots:  totalAvailable,
      showAllSlots,
      // Availability goal (from Phase 1 reasoning)
      availabilityGoal,
      focusSlot,
      // Booking lifecycle truth-grounding — use PROJECTED state, not previous
      bookingLifecycle:     projectedBookingLifecycle,
      appointmentCreated:   context?.state.appointmentCreated ?? false,
      // Booking summary fields (for pending_confirmation phrasing)
      selectedSlot:         projSlot,
      customerPhone:        projPhone,
      // Lifecycle directive — server projects what WILL be required after this turn
      projectedNextRequired,
      projectedPendingConfirmation,
      projectedCustomerName: projName,
      // Accumulated validated booking state (VALIDATED_BOOKING_STATE authority)
      projectedService: projService,
      projectedDate:    projDate,
      // Phone validation status — prevents invalid raw values from reaching Phase 2
      invalidPhoneAttempt,
    };
    const p2Draft = await runPhase2Phrasing(ai, modelName, p2);
    if (p2Draft) finalDraft = p2Draft;
  } catch { /* Phase 2 failure: keep deterministic draft */ }

  // ── Final safety/quality sanitizer ───────────────────────────────────────────
  finalDraft = sanitizeResponseLanguage(
    ensureLanguageMatch(finalDraft, msgIsHebrew),
    agentAction.language,
  );

  // ── Hard truth-grounding validator (runs last — overrides everything) ──────────
  // Replaces any response that uses booking-confirmed language when the backend
  // has NOT created a real appointment. State-based, not phrase-based.
  // Phrase matching is only the secondary safety net.
  finalDraft = validateBookingTruth(
    finalDraft,
    projectedBookingLifecycle,
    context?.state.appointmentCreated ?? false,
    serviceDisplayNameHe,
    dateDisplayHe,
    projSlot,
    projName,
    projPhone,
    agentAction.language,
  );

  return {
    mode: "llm", modelUsed: modelName, llmStatus, agentAction,
    geminiRaw, normalized: norm, toolRun, finalDraft,
    fallbackUsed, fallbackReason, safetyWarnings, analysis,
    autoSelectSlot,
  };
}
