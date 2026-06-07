import type { AvailabilityResult } from "./tools";
import type { ToolRunResult } from "./types";

// ─── Booking lifecycle ─────────────────────────────────────────────────────────
// Truth-grounding policy: the customer-facing response MUST reflect actual backend
// state — never the agent's intention.
//
// Booking-confirmed language ("התור נקבע" / "booked") is permitted ONLY when
//   bookingLifecycle === "confirmed" AND appointmentCreated === true.
//
// Current stage (write tools disabled):
//   Lifecycle ceiling is "test_mode_confirmed"; appointmentCreated stays false.
//
// Future stage (createAppointment implemented):
//   Backend success → applyConfirmPending(true, appointmentId) → "confirmed".
//   Only then may the agent say the appointment is booked.

export type BookingLifecycle =
  | "collecting_details"   // gathering service / date / name
  | "slot_selected"        // slot picked, still need name (or vice-versa)
  | "pending_confirmation" // all details collected — awaiting customer yes/no
  | "test_mode_confirmed"  // customer said yes but write tools disabled — NOT a real booking
  | "confirmed";           // backend created appointment (appointmentCreated=true only)

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ConversationState {
  sessionId: string;
  currentIntent: string | null;
  selectedService: string | null;
  datePreference: string | null;
  selectedTimePreference: string | null;
  offeredSlots: string[];
  selectedSlot: string | null;
  customerName: string | null;
  customerPhone: string | null;
  missingFields: string[];
  nextRequiredField: string | null;
  pendingConfirmation: boolean;
  lastAgentResponse: string | null;
  bookingLifecycle: BookingLifecycle;
  appointmentCreated: boolean;   // true only after backend creates a real appointment
  appointmentId: string | null;  // set by backend on confirmed; null otherwise
}

export interface MessageTurn {
  role: "user" | "agent";
  text: string;
}

// Used by updateStateFromLlm to avoid importing LlmAgentResult (would be circular).
export interface LlmStateUpdate {
  intent: string;
  normalizedService: string | null;
  normalizedDate: string | null;
  normalizedTime: string | null;
  customerName: string | null;
  missingFields: string[];
  toolRun: ToolRunResult | null;
  finalDraft: string;
}

// ─── Factory ───────────────────────────────────────────────────────────────────

export function createConversationState(phone?: string): ConversationState {
  return {
    sessionId: `test-${Date.now()}`,
    currentIntent: null,
    selectedService: null,
    datePreference: null,
    selectedTimePreference: null,
    offeredSlots: [],
    selectedSlot: null,
    customerName: null,
    customerPhone: phone ?? null,
    missingFields: [],
    nextRequiredField: null,
    pendingConfirmation: false,
    lastAgentResponse: null,
    bookingLifecycle: "collecting_details",
    appointmentCreated: false,
    appointmentId: null,
  };
}

// ─── Lifecycle helper ─────────────────────────────────────────────────────────
// Advances lifecycle based on what fields are now filled.
// Never downgrades a terminal state (test_mode_confirmed / confirmed).

function advanceLifecycle(prev: BookingLifecycle, next: ConversationState): BookingLifecycle {
  if (prev === "confirmed" || prev === "test_mode_confirmed") return prev;
  const hasAll = !!(next.selectedService && next.datePreference && next.selectedSlot && next.customerName && next.customerPhone);
  if (hasAll) return "pending_confirmation";
  if (next.selectedSlot || next.customerName) return "slot_selected";
  return "collecting_details";
}

// ─── Next required field ───────────────────────────────────────────────────────

export function computeNextRequiredField(state: ConversationState): string | null {
  const isBooking =
    state.currentIntent === "BOOK_APPOINTMENT" ||
    state.currentIntent === "RESCHEDULE_APPOINTMENT";
  if (!isBooking) return null;
  if (!state.selectedService) return "service";
  if (!state.datePreference) return "date";
  if (state.offeredSlots.length === 0) return null; // waiting for agent to offer slots
  if (!state.selectedSlot) return "slot";
  if (!state.customerName) return "customerName";
  if (!state.customerPhone) return "customerPhone";
  return null;
}

// ─── State updaters ────────────────────────────────────────────────────────────

export function updateStateFromLlm(
  prev: ConversationState,
  u: LlmStateUpdate,
): ConversationState {
  const next: ConversationState = {
    ...prev,
    currentIntent: u.intent,
    selectedService: u.normalizedService ?? prev.selectedService,
    datePreference: u.normalizedDate ?? prev.datePreference,
    selectedTimePreference: u.normalizedTime ?? prev.selectedTimePreference,
    customerName: u.customerName ?? prev.customerName,
    missingFields: u.missingFields,
    lastAgentResponse: u.finalDraft,
  };

  // Extract offered slots from availability tool result
  if (
    u.toolRun?.actualToolName === "checkAvailability" &&
    u.toolRun.status === "executed" &&
    u.toolRun.result
  ) {
    const av = u.toolRun.result as AvailabilityResult;
    const slots =
      (av.filteredSlotTimes?.length ?? 0) > 0
        ? av.filteredSlotTimes
        : (av.allSlotTimes ?? []);
    if (slots.length > 0) {
      next.offeredSlots = slots;
      next.selectedSlot = null;
      next.pendingConfirmation = false;
    }
  }

  // Trigger pendingConfirmation once all booking essentials are collected (including phone)
  if (
    next.currentIntent === "BOOK_APPOINTMENT" &&
    next.selectedService &&
    next.datePreference &&
    next.selectedSlot &&
    next.customerName &&
    next.customerPhone
  ) {
    next.pendingConfirmation = true;
  }

  next.bookingLifecycle = advanceLifecycle(prev.bookingLifecycle, next);
  next.nextRequiredField = computeNextRequiredField(next);
  return next;
}

export function applySlotSelection(prev: ConversationState, slot: string): ConversationState {
  const next: ConversationState = { ...prev, selectedSlot: slot, pendingConfirmation: false };
  if (next.selectedService && next.datePreference && next.customerName && next.customerPhone) {
    next.pendingConfirmation = true;
  }
  next.bookingLifecycle = advanceLifecycle(prev.bookingLifecycle, next);
  next.nextRequiredField = computeNextRequiredField(next);
  return next;
}

export function applyNameFill(prev: ConversationState, name: string): ConversationState {
  const next: ConversationState = { ...prev, customerName: name, pendingConfirmation: false };
  if (next.selectedService && next.datePreference && next.selectedSlot && next.customerPhone) {
    next.pendingConfirmation = true;
  }
  next.bookingLifecycle = advanceLifecycle(prev.bookingLifecycle, next);
  next.nextRequiredField = computeNextRequiredField(next);
  return next;
}

export function applyPhoneFill(prev: ConversationState, phone: string): ConversationState {
  const next: ConversationState = { ...prev, customerPhone: phone, pendingConfirmation: false };
  if (next.selectedService && next.datePreference && next.selectedSlot && next.customerName) {
    next.pendingConfirmation = true;
  }
  next.bookingLifecycle = advanceLifecycle(prev.bookingLifecycle, next);
  next.nextRequiredField = computeNextRequiredField(next);
  return next;
}

export function applyDeny(prev: ConversationState): ConversationState {
  const next: ConversationState = {
    ...prev,
    pendingConfirmation: false,
    selectedSlot: null,
    bookingLifecycle: "collecting_details",
  };
  next.nextRequiredField = computeNextRequiredField(next);
  return next;
}

export function applyChangeDate(prev: ConversationState): ConversationState {
  const next: ConversationState = {
    ...prev,
    datePreference: null,
    offeredSlots: [],
    selectedSlot: null,
    pendingConfirmation: false,
    bookingLifecycle: "collecting_details",
  };
  next.nextRequiredField = computeNextRequiredField(next);
  return next;
}

// ─── Confirmation transition ───────────────────────────────────────────────────
// Truth-grounding policy:
//   The customer-facing response must reflect actual backend state, not intent.
//
// Current stage (write tools disabled):
//   applyConfirmPending(false) → test_mode_confirmed, appointmentCreated=false.
//   Phase 2 must NOT say "booked" — no real appointment was created.
//
// Future stage (createAppointment implemented):
//   Backend creates appointment, returns appointmentId.
//   Caller passes applyConfirmPending(true, appointmentId) → confirmed, appointmentCreated=true.
//   Phase 2 MAY then say "התור נקבע" / "your appointment is booked".
//
// Gate: Phase 2 booking-confirmed language is allowed ONLY when
//   bookingLifecycle === "confirmed" AND appointmentCreated === true.

export function applyConfirmPending(
  prev: ConversationState,
  appointmentCreated: boolean,
  appointmentId?: string,
): ConversationState {
  return {
    ...prev,
    pendingConfirmation: false,
    appointmentCreated,
    appointmentId: appointmentId ?? null,
    bookingLifecycle: appointmentCreated ? "confirmed" : "test_mode_confirmed",
  };
}
