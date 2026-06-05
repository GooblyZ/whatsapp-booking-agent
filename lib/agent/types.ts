export type AgentIntent =
  | "BOOK_APPOINTMENT"
  | "CANCEL_APPOINTMENT"
  | "RESCHEDULE_APPOINTMENT"
  | "ASK_SERVICES"
  | "ASK_PRICES"
  | "ASK_AVAILABILITY"
  | "ASK_BUSINESS_HOURS"
  | "HUMAN_HANDOFF"
  | "UNKNOWN";

export type AgentConfidence = "HIGH" | "MEDIUM" | "LOW";

export type SuggestedTool =
  | "getBusinessInfo"
  | "getServices"
  | "checkAvailability"
  | "createAppointment"
  | "cancelAppointment"
  | "rescheduleAppointment"
  | "getCustomerAppointments"
  | "handoffToHuman";

export type MissingField = "service" | "date" | "time" | "customerName" | "customerPhone";

export interface SuggestedToolCall {
  tool: SuggestedTool;
  reason: string;
}

export type ToolStatus = "executed" | "skipped" | "forbidden";

export interface ToolRunResult {
  status: ToolStatus;
  actualToolName: string;
  args: Record<string, unknown>;
  result: unknown | null;
  skippedReason: string | null;
  enrichedDraft: string;
}

export interface AgentAnalysisResult {
  intent: AgentIntent;
  confidence: AgentConfidence;
  extractedService: string | null;
  extractedDate: string | null;
  extractedTime: string | null;
  extractedCustomerName: string | null;
  hasExactTime: boolean;
  needsAvailabilityCheck: boolean;
  missingFields: MissingField[];
  suggestedToolCall: SuggestedToolCall;
  draftResponse: string;
  notes: string | null;
}
