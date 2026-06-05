"use server";

import { analyzeMessage, runSuggestedTool } from "@/lib/agent";
import type { AgentAnalysisResult, ToolRunResult } from "@/lib/agent";

export type AnalyzeState =
  | { result: AgentAnalysisResult; toolRun: ToolRunResult | null; message: string }
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

  return { result, toolRun, message: message.trim() };
}
