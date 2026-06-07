// AgentAction — the primary LLM output contract.
//
// The LLM classifies the customer's message and conversation state into this
// schema. The server validates, grounds against real data, and runs tools.
// The LLM never picks tools or writes responses directly.

import type { MissingField } from "./types";
import type { ServiceResult } from "./tools";
import { normalizeTimeCandidate } from "./follow-up-resolver";
import type { AvailabilityGoal } from "./time-evaluator";

// ─── Action type ───────────────────────────────────────────────────────────────

export type AgentActionType =
  | "ASK_AVAILABILITY"      // check available slots
  | "ASK_SERVICES"          // list services / prices
  | "ASK_BUSINESS_HOURS"    // business hours query
  | "SELECT_OFFERED_SLOT"   // customer picks a slot from offeredSlots
  | "CONFIRM_PENDING"       // customer confirms booking summary
  | "DENY_PENDING"          // customer declines / wants to change something
  | "PROVIDE_MISSING_FIELD" // customer fills in a required field
  | "HUMAN_HANDOFF"         // out-of-scope or explicit handoff
  | "UNKNOWN";              // cannot classify

// ─── Interface ────────────────────────────────────────────────────────────────

export interface AgentAction {
  actionType:              AgentActionType;
  confidence:              "HIGH" | "MEDIUM" | "LOW";
  language:                "he" | "en" | "unknown";
  serviceCandidate:        string | null;  // canonical name from verified catalog
  dateCandidate:           string | null;  // raw date expression ("מחר", "tomorrow")
  requestedTimeCandidate:  string | null;  // explicit clock time ONLY ("08:00", "09:30") — "מוקדם" alone → null
  timePeriodCandidate:     string | null;  // vague period ("morning", "בוקר", "evening")
  availabilityGoal:        AvailabilityGoal | null; // what user is seeking (earliest, exact check, etc.)
  selectedSlotCandidate:   string | null;  // slot from offeredSlots
  selectionReference:      string | null;  // raw expression used to pick a slot
  customerName:            string | null;  // name provided by customer
  customerPhone:           string | null;  // phone provided by customer
  missingFields:           MissingField[];
  responseGoal:            string;         // phrasing intent for Phase 2
  debugReasoningSummary:   string;         // why this actionType (logging only)
}

// ─── Validation constants ──────────────────────────────────────────────────────

const VALID_ACTION_TYPES = new Set<string>([
  "ASK_AVAILABILITY", "ASK_SERVICES", "ASK_BUSINESS_HOURS",
  "SELECT_OFFERED_SLOT", "CONFIRM_PENDING", "DENY_PENDING",
  "PROVIDE_MISSING_FIELD", "HUMAN_HANDOFF", "UNKNOWN",
]);

const VALID_MISSING = new Set<string>(["service", "date", "time", "customerName", "customerPhone"]);

const VALID_AVAILABILITY_GOALS = new Set<string>([
  "earliest_available", "latest_available", "later_in_period",
  "nearest_to_requested_time", "list_options", "count_availability", "exact_time_check",
]);

// ─── validateAgentAction ──────────────────────────────────────────────────────
// Validates raw LLM JSON output into an AgentAction.

export function validateAgentAction(raw: unknown): AgentAction {
  if (!raw || typeof raw !== "object") throw new Error("AgentAction: not an object");
  const o = raw as Record<string, unknown>;
  const at = o.actionType as string;
  if (!VALID_ACTION_TYPES.has(at)) throw new Error(`AgentAction: invalid actionType "${at}"`);
  if (!["HIGH", "MEDIUM", "LOW"].includes(o.confidence as string))
    throw new Error(`AgentAction: invalid confidence "${o.confidence}"`);
  if (!["he", "en", "unknown"].includes(o.language as string))
    throw new Error(`AgentAction: invalid language "${o.language}"`);
  const str = (k: string): string | null =>
    typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : null;
  const mf = Array.isArray(o.missingFields)
    ? (o.missingFields as unknown[]).filter((f) => VALID_MISSING.has(f as string)) as MissingField[]
    : [];
  const rawGoal = str("availabilityGoal");
  const availabilityGoal = rawGoal && VALID_AVAILABILITY_GOALS.has(rawGoal)
    ? rawGoal as AvailabilityGoal
    : null;

  return {
    actionType:             at as AgentActionType,
    confidence:             o.confidence as "HIGH" | "MEDIUM" | "LOW",
    language:               o.language as "he" | "en" | "unknown",
    serviceCandidate:       str("serviceCandidate"),
    dateCandidate:          str("dateCandidate"),
    requestedTimeCandidate: str("requestedTimeCandidate"),
    timePeriodCandidate:    str("timePeriodCandidate"),
    availabilityGoal,
    selectedSlotCandidate:  str("selectedSlotCandidate"),
    selectionReference:     str("selectionReference"),
    customerName:           str("customerName"),
    customerPhone:          str("customerPhone"),
    missingFields:          mf,
    responseGoal:           str("responseGoal") ?? "",
    debugReasoningSummary:  str("debugReasoningSummary") ?? "",
  };
}

// ─── validateServiceCandidate ─────────────────────────────────────────────────
// Returns canonical name on exact match against the verified catalog; null otherwise.
// Server enforces data-grounding — LLM cannot invent services.

export function validateServiceCandidate(
  candidate: string | null,
  verifiedServices: ServiceResult[],
): string | null {
  if (!candidate) return null;
  const c = candidate.toLowerCase().trim();
  return verifiedServices.find((s) => s.name.toLowerCase() === c)?.name ?? null;
}

// ─── resolveSlotSelection ─────────────────────────────────────────────────────
// Validates selectedSlotCandidate/selectionReference against the offered slots list.
// Falls back to normalizeTimeCandidate on the raw message for robustness.
// This is pure validation — not conversational understanding.

export function resolveSlotSelection(
  action: AgentAction,
  offeredSlots: string[],
  rawMessage: string,
): string | null {
  if (!offeredSlots.length) return null;

  // 1. selectedSlotCandidate exactly matches an offered slot
  if (action.selectedSlotCandidate) {
    const direct = offeredSlots.find((s) => s === action.selectedSlotCandidate);
    if (direct) return direct;
  }

  // 2. Normalize the selection reference or candidate via time normalizer
  const ref = action.selectionReference ?? action.selectedSlotCandidate ?? rawMessage;
  const normalized = normalizeTimeCandidate(ref);
  if (normalized) {
    const found = offeredSlots.find((s) => s === normalized);
    if (found) return found;
  }

  // 3. Try normalizing raw message directly (catches "אני רוצה 9:30")
  if (ref !== rawMessage) {
    const fromMsg = normalizeTimeCandidate(rawMessage);
    if (fromMsg) {
      const found = offeredSlots.find((s) => s === fromMsg);
      if (found) return found;
    }
  }

  return null;
}
