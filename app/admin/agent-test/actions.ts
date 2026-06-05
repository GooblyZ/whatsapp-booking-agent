"use server";

import { analyzeMessage } from "@/lib/agent";
import type { AgentAnalysisResult } from "@/lib/agent";

export type AnalyzeState =
  | { result: AgentAnalysisResult; message: string }
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
  return { result, message: message.trim() };
}
