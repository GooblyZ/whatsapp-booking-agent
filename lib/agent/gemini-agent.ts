import { GoogleGenAI } from "@google/genai";
import type { AgentAnalysisResult, AgentIntent, AgentConfidence, MissingField, SuggestedTool, ToolRunResult } from "./types";
import { analyzeMessage } from "./analyzer";
import { runSuggestedTool } from "./tool-runner";
import { normalizeGeminiFields, type NormalizedFields } from "./normalizer";
import { composeLlmResponse } from "./response-composer";

// ─── Config ────────────────────────────────────────────────────────────────────

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

// ─── Gemini structured output types ────────────────────────────────────────────

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
}

export interface LlmAgentResult {
  mode: "llm";
  modelUsed: string;
  geminiRaw: GeminiStructuredOutput;
  normalized: NormalizedFields;
  toolRun: ToolRunResult | null;
  finalDraft: string;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  safetyWarnings: string[];
  // Synthesised AgentAnalysisResult for consistent UI rendering
  analysis: AgentAnalysisResult;
}

// ─── Allowed read-only tools ────────────────────────────────────────────────────

const ALLOWED_LLM_TOOLS = new Set<string>([
  "getServices",
  "getBusinessInfo",
  "checkAvailability",
  "getCustomerAppointments",
]);

const FORBIDDEN_LLM_TOOLS = new Set<string>([
  "createAppointment",
  "cancelAppointment",
  "rescheduleAppointment",
  "sendWhatsAppTextMessage",
]);

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a booking agent for an appointment-based barbershop business.
You ONLY handle: appointments, services, prices, business hours, availability, cancellation/reschedule requests, and human handoff.
You must NOT answer unrelated questions (weather, politics, science, general knowledge, etc.).
You must NOT invent availability, prices, or services.
Availability MUST come only from checkAvailability tool.
Prices and services MUST come only from getServices tool.
Business hours MUST come only from getBusinessInfo tool.
You CANNOT confirm, create, or finalize bookings in this stage.
You CANNOT cancel or reschedule appointments in this stage — only look them up.
Respond naturally in the user's language (Hebrew or English).
Return ONLY valid JSON. No markdown. No explanation outside the JSON.

JSON schema:
{
  "intent": one of: BOOK_APPOINTMENT | CANCEL_APPOINTMENT | RESCHEDULE_APPOINTMENT | ASK_SERVICES | ASK_PRICES | ASK_AVAILABILITY | ASK_BUSINESS_HOURS | HUMAN_HANDOFF | UNKNOWN,
  "confidence": HIGH | MEDIUM | LOW,
  "service": string or null,
  "datePreference": string or null (e.g. "tomorrow", "next Friday", "Friday"),
  "timePreference": string or null (e.g. "evening", "after 4", "10:00"),
  "customerName": string or null,
  "missingFields": array of: service | date | time | customerName | customerPhone,
  "requestedTool": one of: getServices | getBusinessInfo | checkAvailability | getCustomerAppointments | null,
  "draftResponse": string (your natural language response to the customer),
  "language": "he" | "en" | "unknown",
  "safetyWarnings": array of strings (leave empty [] if none)
}`;

// ─── Validation ────────────────────────────────────────────────────────────────

const VALID_INTENTS = new Set([
  "BOOK_APPOINTMENT", "CANCEL_APPOINTMENT", "RESCHEDULE_APPOINTMENT",
  "ASK_SERVICES", "ASK_PRICES", "ASK_AVAILABILITY", "ASK_BUSINESS_HOURS",
  "HUMAN_HANDOFF", "UNKNOWN",
]);
const VALID_CONFIDENCES = new Set(["HIGH", "MEDIUM", "LOW"]);
const VALID_MISSING = new Set(["service", "date", "time", "customerName", "customerPhone"]);

function validateGeminiOutput(raw: unknown): GeminiStructuredOutput {
  if (!raw || typeof raw !== "object") throw new Error("Gemini output is not an object");
  const o = raw as Record<string, unknown>;

  if (!VALID_INTENTS.has(o.intent as string)) throw new Error(`Invalid intent: ${o.intent}`);
  if (!VALID_CONFIDENCES.has(o.confidence as string)) throw new Error(`Invalid confidence: ${o.confidence}`);
  if (typeof o.draftResponse !== "string" || !o.draftResponse.trim()) throw new Error("Missing draftResponse");
  if (!["he", "en", "unknown"].includes(o.language as string)) throw new Error(`Invalid language: ${o.language}`);

  const missingFields = Array.isArray(o.missingFields)
    ? (o.missingFields as unknown[]).filter((f) => VALID_MISSING.has(f as string)) as MissingField[]
    : [];

  const requestedTool = typeof o.requestedTool === "string" ? o.requestedTool : null;
  const safetyWarnings = Array.isArray(o.safetyWarnings)
    ? (o.safetyWarnings as unknown[]).filter((w) => typeof w === "string") as string[]
    : [];

  return {
    intent: o.intent as string,
    confidence: o.confidence as string,
    service: typeof o.service === "string" ? o.service : null,
    datePreference: typeof o.datePreference === "string" ? o.datePreference : null,
    timePreference: typeof o.timePreference === "string" ? o.timePreference : null,
    customerName: typeof o.customerName === "string" ? o.customerName : null,
    missingFields,
    requestedTool,
    draftResponse: o.draftResponse as string,
    language: o.language as "he" | "en" | "unknown",
    safetyWarnings,
  };
}

// ─── Map Gemini output → AgentAnalysisResult (uses normalized fields) ─────────

function mapToAnalysisResult(
  g: GeminiStructuredOutput,
  norm: NormalizedFields,
  resolvedTool: SuggestedTool,
  toolReason: string,
): AgentAnalysisResult {
  // hasExactTime: true only for "at N" / clock patterns, not "after N"
  const hasExactTime = !!(
    norm.timePreference &&
    /^(at\s+\d|.*:\d{2}$)/.test(norm.timePreference) &&
    !/^after\s+/i.test(norm.timePreference)
  );
  return {
    intent: (VALID_INTENTS.has(g.intent) ? g.intent : "UNKNOWN") as AgentIntent,
    confidence: (VALID_CONFIDENCES.has(g.confidence) ? g.confidence : "LOW") as AgentConfidence,
    // Use normalized values so tool-runner can resolve them
    extractedService: norm.service,
    extractedDate: norm.datePreference,
    extractedTime: norm.timePreference,
    extractedCustomerName: g.customerName,
    hasExactTime,
    needsAvailabilityCheck: resolvedTool === "checkAvailability",
    missingFields: g.missingFields as MissingField[],
    suggestedToolCall: { tool: resolvedTool, reason: toolReason },
    draftResponse: g.draftResponse,
    notes: g.safetyWarnings.length > 0 ? g.safetyWarnings.join("; ") : null,
  };
}

// ─── Resolve which tool to actually run ────────────────────────────────────────

function resolveAllowedTool(
  requestedTool: string | null,
  intent: string,
): { tool: SuggestedTool; reason: string; blocked: boolean } {
  if (!requestedTool) {
    return { tool: "handoffToHuman" as SuggestedTool, reason: "No tool requested.", blocked: false };
  }

  if (FORBIDDEN_LLM_TOOLS.has(requestedTool)) {
    // Reroute write intents to a safe read equivalent
    if (intent === "CANCEL_APPOINTMENT" || intent === "RESCHEDULE_APPOINTMENT") {
      return {
        tool: "getCustomerAppointments",
        reason: `${requestedTool} is forbidden. Rerouted to getCustomerAppointments for read-only lookup.`,
        blocked: true,
      };
    }
    return {
      tool: "handoffToHuman" as SuggestedTool,
      reason: `${requestedTool} is a forbidden write tool and was blocked.`,
      blocked: true,
    };
  }

  if (ALLOWED_LLM_TOOLS.has(requestedTool)) {
    return { tool: requestedTool as SuggestedTool, reason: `LLM requested ${requestedTool}.`, blocked: false };
  }

  return { tool: "handoffToHuman" as SuggestedTool, reason: `Unknown tool: ${requestedTool}`, blocked: false };
}

// ─── Main entry point ──────────────────────────────────────────────────────────

export async function runGeminiAgent(
  message: string,
  phone?: string,
): Promise<LlmAgentResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = getModel();
  const safetyWarnings: string[] = [];

  // Phase 1 — call Gemini
  let geminiRaw: GeminiStructuredOutput;
  let fallbackUsed = false;
  let fallbackReason: string | null = null;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: modelName,
      contents: [{ role: "user", parts: [{ text: message }] }],
      config: { systemInstruction: SYSTEM_PROMPT, temperature: 0.1 },
    });

    const text = response.text ?? "";
    // Strip any markdown fences Gemini might add despite instructions
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed: unknown = JSON.parse(cleaned);
    geminiRaw = validateGeminiOutput(parsed);

    if (geminiRaw.safetyWarnings.length > 0) {
      safetyWarnings.push(...geminiRaw.safetyWarnings);
    }
  } catch (e) {
    // Phase 1 failed — fall back to rule-based analyzer
    fallbackUsed = true;
    fallbackReason = e instanceof Error ? e.message : String(e);
    const fallback = analyzeMessage(message, phone);
    const toolRun = await runSuggestedTool(fallback, message, phone).catch(() => null);
    const fbNorm: NormalizedFields = {
      service: fallback.extractedService,
      datePreference: fallback.extractedDate,
      timePreference: fallback.extractedTime,
    };
    return {
      mode: "llm",
      modelUsed: modelName,
      geminiRaw: {
        intent: fallback.intent,
        confidence: fallback.confidence,
        service: fallback.extractedService,
        datePreference: fallback.extractedDate,
        timePreference: fallback.extractedTime,
        customerName: fallback.extractedCustomerName,
        missingFields: fallback.missingFields,
        requestedTool: fallback.suggestedToolCall.tool,
        draftResponse: fallback.draftResponse,
        language: /[א-ת]/.test(message) ? "he" : "en",
        safetyWarnings: [],
      },
      normalized: fbNorm,
      toolRun,
      finalDraft: toolRun?.enrichedDraft ?? fallback.draftResponse,
      fallbackUsed: true,
      fallbackReason,
      safetyWarnings: [],
      analysis: fallback,
    };
  }

  // Phase 2 — normalize, validate tool, run it
  const norm = normalizeGeminiFields(
    geminiRaw.service,
    geminiRaw.datePreference,
    geminiRaw.timePreference,
  );

  const { tool: resolvedTool, reason: toolReason, blocked } = resolveAllowedTool(
    geminiRaw.requestedTool,
    geminiRaw.intent,
  );

  if (blocked) {
    safetyWarnings.push(`Tool blocked: ${geminiRaw.requestedTool} → rerouted to ${resolvedTool}`);
  }

  const analysis = mapToAnalysisResult(geminiRaw, norm, resolvedTool, toolReason);

  let toolRun: ToolRunResult | null = null;
  try {
    toolRun = await runSuggestedTool(analysis, message, phone);
  } catch (e) {
    fallbackUsed = true;
    fallbackReason = `Tool execution error: ${e instanceof Error ? e.message : String(e)}`;
  }

  // Compose a natural, language-aware final draft using the tool result.
  // Falls back to toolRun.enrichedDraft, then geminiRaw.draftResponse.
  const composedDraft = composeLlmResponse(toolRun, geminiRaw, norm, geminiRaw.intent);
  const finalDraft = composedDraft ?? toolRun?.enrichedDraft ?? geminiRaw.draftResponse;

  return {
    mode: "llm",
    modelUsed: modelName,
    geminiRaw,
    normalized: norm,
    toolRun,
    finalDraft,
    fallbackUsed,
    fallbackReason,
    safetyWarnings,
    analysis,
  };
}
