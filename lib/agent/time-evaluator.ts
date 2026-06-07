// time-evaluator.ts — general availability reasoning.
//
// Exports:
//   AvailabilityGoal      — what the user is asking for (earliest, latest, etc.)
//   selectSlotByGoal      — picks focus slot(s) based on the goal
//   evaluateRequestedTime — evaluates an exact requested time against available slots

// ─── Availability goal ────────────────────────────────────────────────────────
// Set by Phase 1 (Gemini AgentAction).
// Distinguishes "כמה מוקדם?" (earliest_available) from "ב8:00?" (exact_time_check).
// Rule: "מוקדם" alone → earliest_available, requestedTimeCandidate MUST stay null.

export type AvailabilityGoal =
  | "earliest_available"          // כמה מוקדם / הכי מוקדם / earliest
  | "latest_available"            // הכי מאוחר שיש / the very latest overall
  | "later_in_period"             // מאוחר בבוקר / לקראת סוף הבוקר — later slots within the period
  | "nearest_to_requested_time"   // סביבות X / around X
  | "list_options"                // general — show options (default)
  | "count_availability"          // כמה תורים יש / how many
  | "exact_time_check";           // explicit HH:MM was requested (ב8 → 08:00)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toMins(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// ─── selectSlotByGoal ─────────────────────────────────────────────────────────
// Returns the focus slot and allowed-to-mention list for a given availability goal.
// Server calls this after receiving verified availableSlots from the tool.
// Phase 2 uses focusSlot as THE answer for earliest/latest queries.

export function selectSlotByGoal(
  goal: AvailabilityGoal,
  availableSlots: string[],
  requestedTime?: string | null,
): { focusSlot: string | null; allowedSlots: string[] } {
  if (!availableSlots.length) return { focusSlot: null, allowedSlots: [] };
  const sorted = [...availableSlots].sort((a, b) => toMins(a) - toMins(b));

  switch (goal) {
    case "earliest_available":
      return { focusSlot: sorted[0], allowedSlots: [sorted[0]] };

    case "latest_available":
      // The single latest slot overall (הכי מאוחר שיש)
      return { focusSlot: sorted[sorted.length - 1], allowedSlots: [sorted[sorted.length - 1]] };

    case "later_in_period": {
      // Later slots within the period already filtered by the availability tool
      // (מאוחר בבוקר / לקראת סוף הבוקר). Return up to 3 from the end,
      // keeping chronological order so Phase 2 can present options.
      const laterSlots = sorted.length <= 3 ? sorted : sorted.slice(-3);
      return { focusSlot: sorted[sorted.length - 1] ?? null, allowedSlots: laterSlots };
    }

    case "nearest_to_requested_time": {
      if (!requestedTime) return { focusSlot: sorted[0], allowedSlots: sorted.slice(0, 3) };
      const reqMins = toMins(requestedTime);
      const byDist  = [...sorted].sort(
        (a, b) => Math.abs(toMins(a) - reqMins) - Math.abs(toMins(b) - reqMins),
      );
      const nearest = byDist.slice(0, 3).sort((a, b) => toMins(a) - toMins(b));
      return { focusSlot: nearest[0] ?? null, allowedSlots: nearest };
    }

    case "count_availability":
      return { focusSlot: null, allowedSlots: [] };   // Phase 2 says "X slots available"

    case "exact_time_check":
    case "list_options":
    default:
      return { focusSlot: null, allowedSlots: sorted.slice(0, 5) };
  }
}

// ─── evaluateRequestedTime ────────────────────────────────────────────────────
// Used when availabilityGoal=exact_time_check or nearest_to_requested_time.
// Works for ANY requested time — no hardcoded opening hours or special phrases.

export type UnavailableReason =
  | "available"
  | "before_first_available"
  | "after_last_available"
  | "between_available_slots"
  | "no_slots";

export interface RequestedTimeEvaluation {
  requestedTimeAvailable: boolean;
  exactSlotMatched:       string | null;
  nearestAlternatives:    string[];   // ≤3 closest, sorted chronologically
  earliestAvailableSlot:  string | null;
  latestAvailableSlot:    string | null;
  unavailableReason:      UnavailableReason;
}

export function evaluateRequestedTime(
  requestedTime: string,
  availableSlots: string[],
): RequestedTimeEvaluation {
  if (!availableSlots.length) {
    return {
      requestedTimeAvailable: false,
      exactSlotMatched:       null,
      nearestAlternatives:    [],
      earliestAvailableSlot:  null,
      latestAvailableSlot:    null,
      unavailableReason:      "no_slots",
    };
  }

  const sorted  = [...availableSlots].sort((a, b) => toMins(a) - toMins(b));
  const reqMins = toMins(requestedTime);

  if (sorted.includes(requestedTime)) {
    return {
      requestedTimeAvailable: true,
      exactSlotMatched:       requestedTime,
      nearestAlternatives:    [],
      earliestAvailableSlot:  sorted[0],
      latestAvailableSlot:    sorted[sorted.length - 1],
      unavailableReason:      "available",
    };
  }

  const byDist  = [...availableSlots].sort(
    (a, b) => Math.abs(toMins(a) - reqMins) - Math.abs(toMins(b) - reqMins),
  );
  const nearest = byDist.slice(0, 3).sort((a, b) => toMins(a) - toMins(b));
  const firstMins = toMins(sorted[0]);
  const lastMins  = toMins(sorted[sorted.length - 1]);
  const reason: UnavailableReason =
    reqMins < firstMins ? "before_first_available" :
    reqMins > lastMins  ? "after_last_available"   :
                          "between_available_slots";

  return {
    requestedTimeAvailable: false,
    exactSlotMatched:       null,
    nearestAlternatives:    nearest,
    earliestAvailableSlot:  sorted[0],
    latestAvailableSlot:    sorted[sorted.length - 1],
    unavailableReason:      reason,
  };
}
