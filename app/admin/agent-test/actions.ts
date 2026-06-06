"use server";

import { analyzeMessage, runSuggestedTool, runGeminiAgent, isGeminiEnabled } from "@/lib/agent";
import type { AgentAnalysisResult, ToolRunResult, LlmAgentResult } from "@/lib/agent";

export type AgentMode = "rule" | "llm";

export type AnalyzeState =
  | { mode: "rule"; result: AgentAnalysisResult; toolRun: ToolRunResult | null; message: string }
  | { mode: "llm"; llmResult: LlmAgentResult; message: string }
  | { error: string }
  | null;

export async function analyzeWhatsAppMessage(
  _prevState: AnalyzeState,
  formData: FormData
): Promise<AnalyzeState> {
  const message = formData.get("message");
  if (typeof message !== "string" || !message.trim())
    return { error: "Message is required." };
  if (message.length > 1000)
    return { error: "Message is too long (max 1000 characters)." };

  const phone = formData.get("phone");
  const phoneStr = typeof phone === "string" && phone.trim() ? phone.trim() : undefined;
  const modeRaw = formData.get("mode");
  const mode: AgentMode = modeRaw === "llm" ? "llm" : "rule";

  if (mode === "llm") {
    if (!isGeminiEnabled()) {
      return { error: "Gemini LLM mode is not available. Check GEMINI_API_KEY, LLM_AGENT_ENABLED, and LLM_PROVIDER." };
    }
    const llmResult = await runGeminiAgent(message.trim(), phoneStr);
    return { mode: "llm", llmResult, message: message.trim() };
  }

  // Rule-based mode
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
