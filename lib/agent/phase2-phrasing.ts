// Phase 2: LLM-powered natural response phrasing from server-verified facts.
//
// Safety model: this module receives ONLY data the server has already validated
// and executed. The LLM's role is purely linguistic — it cannot invent facts.
// If Phase 2 fails, the caller falls back to the deterministic draft.

import { GoogleGenAI } from "@google/genai";
import type { ServiceResult, BusinessInfoResult } from "./tools";
import type { RequestedTimeEvaluation } from "./time-evaluator";

// ─── Display name tables ───────────────────────────────────────────────────────
// Language-safe mappings used in the facts block.
// Phase 2 uses these — NEVER the raw canonical English names for Hebrew users.

const HE_SERVICE: Record<string, string> = {
  "Haircut":         "תספורת",
  "Beard":           "עיצוב זקן",
  "Haircut + Beard": "תספורת וזקן",
  "Kids Haircut":    "תספורת ילדים",
};

const HE_DATE: Record<string, string> = {
  "today":               "היום",
  "tomorrow":            "מחר",
  "day after tomorrow":  "מחרתיים",
  "Sunday": "ביום ראשון", "Monday": "ביום שני",    "Tuesday":  "ביום שלישי",
  "Wednesday": "ביום רביעי", "Thursday": "ביום חמישי", "Friday": "ביום שישי",
  "Saturday": "ביום שבת",
  "next Sunday": "ביום ראשון הבא", "next Monday": "ביום שני הבא",
  "next Tuesday": "ביום שלישי הבא", "next Wednesday": "ביום רביעי הבא",
  "next Thursday": "ביום חמישי הבא", "next Friday": "ביום שישי הבא",
  "next Saturday": "ביום שבת הבא",
};

const HE_PERIOD: Record<string, string> = {
  "morning": "בבוקר", "afternoon": "אחר הצהריים",
  "evening": "בערב",  "night": "בלילה",
};

export function getServiceDisplayHe(canonical: string | null): string | null {
  return canonical ? (HE_SERVICE[canonical] ?? canonical) : null;
}

export function getDateDisplayHe(normalizedDate: string | null, rawDateCandidate: string | null): string | null {
  if (normalizedDate && HE_DATE[normalizedDate]) return HE_DATE[normalizedDate];
  // Fall back to raw candidate (may already be Hebrew)
  if (rawDateCandidate && /[א-ת]/.test(rawDateCandidate)) return rawDateCandidate;
  return null;
}

export function getPeriodDisplayHe(normalizedPeriod: string | null): string | null {
  return normalizedPeriod ? (HE_PERIOD[normalizedPeriod] ?? null) : null;
}

// ─── Input contract ────────────────────────────────────────────────────────────

export interface Phase2Input {
  toolName: string;
  toolResult: unknown;
  intent: string;
  lang: "he" | "en" | "unknown";
  userMessage: string;
  history: Array<{ role: "user" | "agent"; text: string }>;
  deterministicDraft: string;
  responseGoal?: string | null;

  // Language-safe display names (server-computed — never pass raw canonical to Phase 2)
  serviceDisplayNameHe: string | null;   // "עיצוב זקן"
  dateDisplayHe: string | null;          // "מחר"
  timePeriodDisplayHe: string | null;    // "בבוקר"

  // Raw values for English responses and non-Hebrew contexts
  normalizedService: string | null;      // "Beard"
  origDate: string | null;
  origTime: string | null;
  missingFields: string[];
  queryStyle: "count" | "list" | null;

  // Requested-time evaluation (server-grounded — general, works for any time)
  requestedTime: string | null;
  requestedTimeEval: RequestedTimeEvaluation | null;

  // Slot display — server decides how many to show based on query type
  allowedSlotsToMention: string[];  // already limited by server
  totalAvailableSlots: number;
  showAllSlots: boolean;

  // Availability goal — drives phrasing style
  availabilityGoal: string | null;
  focusSlot: string | null;  // server-selected slot for earliest/latest/nearest goals

  // Booking lifecycle — truth-grounding (server-authoritative)
  // Phase 2 may ONLY use "booked/confirmed" language when:
  //   bookingLifecycle === "confirmed" AND appointmentCreated === true
  bookingLifecycle: string;
  appointmentCreated: boolean;

  // Booking summary for pending_confirmation phrasing
  selectedSlot: string | null;
  customerPhone: string | null;

  // Lifecycle directive — server-projected state after this turn (mandatory for Phase 2)
  // Phase 2 MUST ask the correct next question based on these values.
  projectedNextRequired: string | null;       // customerName | customerPhone | confirmation | slot | null
  projectedPendingConfirmation: boolean;      // true → summarize and ask yes/no
  projectedCustomerName: string | null;       // name already known (for summary)
  // Accumulated booking state (from prevState + current action), server-validated
  // These are the ONLY confirmed booking fields — null means field is missing.
  projectedService: string | null;            // catalog-validated service (canonical)
  projectedDate: string | null;               // normalized date from state
  // Phone validation — if true, user sent something invalid while phone was required.
  // Phase 2 must ask for a valid phone; must NOT echo or use the invalid value.
  invalidPhoneAttempt: boolean;
}

// ─── Contradiction guard ───────────────────────────────────────────────────────

function checkContradiction(input: Phase2Input): string | null {
  if (input.toolName !== "checkAvailability" || !input.toolResult) return null;
  const av = input.toolResult as { serviceFound?: boolean; allSlotTimes?: string[] };
  const isHe = input.lang === "he" || /[א-ת]/.test(input.userMessage);
  const svc = input.serviceDisplayNameHe ?? input.normalizedService ?? "השירות";

  // False "service doesn't exist" claim
  if (av.serviceFound && /אין לנו|לא קיים|השירות לא|service doesn't exist|we don't (have|offer)/i.test(input.deterministicDraft)) {
    const slots = (av.allSlotTimes ?? []).slice(0, 3).join(", ");
    return isHe
      ? `${svc} קיים אצלנו${slots ? ". יש זמינות: " + slots + ". מה מתאים?" : "."}`
      : `${input.normalizedService ?? svc} is available${slots ? ": " + slots + ". Which works?" : "."}`;
  }

  // False "no availability" when slots exist
  if ((av.allSlotTimes ?? []).length > 0 && /^(לצערנו,\s*)?אין תורים פנויים|no available slots|no slots available/i.test(input.deterministicDraft)) {
    const slots = (av.allSlotTimes ?? []).slice(0, 3).join(", ");
    return isHe ? `יש תורים פנויים: ${slots}. מה מתאים?` : `Available: ${slots}. Which works?`;
  }

  return null;
}

// ─── Facts block ───────────────────────────────────────────────────────────────
// Builds a structured facts block for the Phase 2 LLM.
// Language-safe: Hebrew display names are separate from canonical English names.
// Phase 2 instructions tell the LLM which to use per language.

function buildFactsBlock(input: Phase2Input): string {
  const lines: string[] = [];
  const isHe = input.lang === "he" || /[א-ת]/.test(input.userMessage);

  // ── VALIDATED_BOOKING_STATE ──────────────────────────────────────────────────
  // SERVER-AUTHORITATIVE. These are the ONLY confirmed booking facts.
  // "not_confirmed" = that field is MISSING — treat as absent regardless of what
  // the customer typed or what responseGoal says.
  // This block OVERRIDES responseGoal on any conflict.
  {
    const vSvc   = input.projectedService;
    const vDate  = input.projectedDate;
    const vSlot  = input.selectedSlot;         // server-validated slot only
    const vName  = input.projectedCustomerName;
    const vPhone = input.customerPhone;         // null if phone failed normalization
    const svcDisplay = vSvc
      ? (isHe ? (input.serviceDisplayNameHe ?? vSvc) : vSvc)
      : "not_confirmed";
    const dateDisplay = vDate
      ? (isHe ? (input.dateDisplayHe ?? vDate) : vDate)
      : "not_confirmed";
    lines.push("VALIDATED_BOOKING_STATE:");
    lines.push(`  confirmed_service: ${svcDisplay}`);
    lines.push(`  confirmed_date: ${dateDisplay}`);
    lines.push(`  confirmed_slot: ${vSlot ?? "not_confirmed"}`);
    lines.push(`  confirmed_name: ${vName ?? "not_confirmed"}`);
    lines.push(`  confirmed_phone: ${vPhone ?? "not_confirmed"}`);
    lines.push(`  next_required_field: ${input.projectedNextRequired ?? "none"}`);
    lines.push(`  pending_confirmation: ${input.projectedPendingConfirmation}`);
    lines.push(`  booking_lifecycle: ${input.bookingLifecycle}`);
    lines.push(`  appointment_created: ${input.appointmentCreated}`);
    if (input.invalidPhoneAttempt) {
      lines.push(`  invalid_phone_attempt: true (customer sent something but it was not a valid phone)`);
    }
  }

  lines.push(`customer_language: ${isHe ? "he" : input.lang}`);
  lines.push(`intent: ${input.intent}`);

  // Language-safe service display
  if (isHe && input.serviceDisplayNameHe) {
    lines.push(`service_to_use_in_response: ${input.serviceDisplayNameHe}`);
    if (input.normalizedService) lines.push(`service_canonical_internal: ${input.normalizedService}`);
  } else if (input.normalizedService) {
    lines.push(`service: ${input.normalizedService}`);
  }

  // Language-safe date display
  if (isHe && input.dateDisplayHe) {
    lines.push(`date_to_use_in_response: ${input.dateDisplayHe}`);
  } else if (input.origDate) {
    lines.push(`date: ${input.origDate}`);
  }

  // Language-safe time period display
  if (isHe && input.timePeriodDisplayHe) {
    lines.push(`time_period_to_use_in_response: ${input.timePeriodDisplayHe}`);
  } else if (input.origTime) {
    lines.push(`time_period: ${input.origTime}`);
  }

  if (input.missingFields.length > 0) lines.push(`missing_from_customer: ${input.missingFields.join(", ")}`);

  // Availability facts
  if (input.toolName === "checkAvailability" && input.toolResult) {
    const av = input.toolResult as { serviceFound?: boolean; allSlotTimes?: string[]; noSlotsReason?: string };
    if (!(av.allSlotTimes?.length)) {
      lines.push("availability: no_slots");
      if (av.noSlotsReason) lines.push(`no_slots_reason: ${av.noSlotsReason}`);
    } else {
      lines.push(`availability: slots_found`);
      if (input.availabilityGoal) lines.push(`availability_goal: ${input.availabilityGoal}`);
      if (input.focusSlot)        lines.push(`focus_slot: ${input.focusSlot}`);
      if (input.requestedTimeEval && input.requestedTime) {
        const ev = input.requestedTimeEval;
        lines.push(`requested_time: ${input.requestedTime}`);
        lines.push(`requested_time_available: ${ev.requestedTimeAvailable}`);
        if (!ev.requestedTimeAvailable) {
          lines.push(`unavailable_reason: ${ev.unavailableReason}`);
          if (ev.nearestAlternatives.length)
            lines.push(`nearest_alternatives: ${ev.nearestAlternatives.join(", ")}`);
          if (ev.earliestAvailableSlot)
            lines.push(`earliest_available: ${ev.earliestAvailableSlot}`);
        } else if (ev.exactSlotMatched) {
          lines.push(`exact_slot_confirmed: ${ev.exactSlotMatched}`);
        }
      }
      if (input.allowedSlotsToMention.length) {
        lines.push(`slots_to_mention: ${input.allowedSlotsToMention.join(", ")}`);
        const remaining = input.totalAvailableSlots - input.allowedSlotsToMention.length;
        if (remaining > 0)
          lines.push(`additional_slots_not_shown: ${remaining} more (only mention if customer asks for all)`);
      }
      if (input.queryStyle === "count")
        lines.push(`customer_asked_for: count_only`);
    }
  }

  if (input.toolName === "getServices" && input.toolResult) {
    const services = input.toolResult as ServiceResult[];
    const match = input.normalizedService
      ? services.find(s => s.name.toLowerCase() === input.normalizedService!.toLowerCase())
      : null;
    if (match) {
      lines.push(`service_price: ₪${match.price}`);
      lines.push(`service_duration: ${match.durationMinutes} minutes`);
    } else {
      lines.push(`services: ${services.map(s => `${s.name} (₪${s.price})`).join(" | ")}`);
    }
  }

  if (input.toolName === "getBusinessInfo" && input.toolResult) {
    const info = input.toolResult as BusinessInfoResult;
    const open = info.workingHours.filter(h => !h.isClosed)
      .map(h => `${h.dayLabel} ${h.startTime}–${h.endTime}`).join(", ");
    lines.push(`business_hours: ${open}`);
  }

  // Booking lifecycle — truth-grounding (always included; drives "booked" language gate)
  lines.push(`booking_lifecycle: ${input.bookingLifecycle}`);
  lines.push(`appointment_created: ${input.appointmentCreated}`);

  // Booking summary — included when all fields are known (for pending_confirmation phrasing)
  if (input.bookingLifecycle === "pending_confirmation" || input.bookingLifecycle === "test_mode_confirmed") {
    if (input.selectedSlot)           lines.push(`booking_selected_slot: ${input.selectedSlot}`);
    if (input.customerPhone)          lines.push(`booking_customer_phone: ${input.customerPhone}`);
    if (input.projectedCustomerName)  lines.push(`booking_customer_name: ${input.projectedCustomerName}`);
    // service / date already in service_to_use_in_response / date_to_use_in_response
  }

  // Phone validation status (if user sent something invalid while phone was required)
  if (input.invalidPhoneAttempt) {
    lines.push(`invalid_phone_attempt: true`);
    lines.push(`phone_validation_error: format_invalid — did not match accepted Israeli phone patterns`);
    lines.push(`IMPORTANT: do NOT echo or quote the invalid number the customer sent`);
  }

  // Server-projected lifecycle directive — what the booking flow requires AFTER this turn.
  // Phase 2 MUST end the response by asking for the item indicated by next_required_field.
  if (input.projectedNextRequired) {
    lines.push(`next_required_field: ${input.projectedNextRequired}`);
  }
  if (input.projectedPendingConfirmation) {
    lines.push(`pending_confirmation: true`);
    if (input.selectedSlot)           lines.push(`summary_slot: ${input.selectedSlot}`);
    if (input.projectedCustomerName)  lines.push(`summary_name: ${input.projectedCustomerName}`);
    if (input.customerPhone)          lines.push(`summary_phone: ${input.customerPhone}`);
  }

  return lines.join("\n");
}

// ─── Post-Phase-2 truth validator ─────────────────────────────────────────────
// Hard enforcement: replaces any response that uses booking-confirmed language
// when the backend has NOT created a real appointment.
//
// This is state-based, not phrase-based. The phrase list is a safety net only.
// Primary rule: if bookingLifecycle !== "confirmed" OR !appointmentCreated → no booking language.
//
// When bookingLifecycle === "confirmed" && appointmentCreated === true, the response
// passes through unchanged — real-booking language is correct in that state.

const BOOKING_CONFIRMED_RE =
  /\bאושר\b|\bהתור\s+נקבע\b|\bנקבע\s+בהצלחה\b|\bקבעתי\s+לך\b|\bתור\s+אושר\b|\bbooked\b|\bconfirmed\b|\bscheduled\b/i;

function buildTestModeResponse(
  serviceHe: string | null,
  dateHe: string | null,
  slot: string | null,
  customerName: string | null,
  customerPhone: string | null,
  lang: "he" | "en" | "unknown",
): string {
  const isHe = lang === "he" || true; // default Hebrew for this app
  if (!isHe) {
    return "Got it, I've noted your request. This is a test session — no real appointment was created in the system yet.";
  }
  const base = "מעולה, קיבלתי את האישור. בשלב הבדיקה הזה לא נוצר תור אמיתי במערכת עדיין.";
  const hasSummary = !!(slot || customerName);
  if (!hasSummary) return base;
  const svc      = serviceHe ?? "השירות";
  const datePart = dateHe ? ` ${dateHe}` : "";
  const slotPart = slot ? ` ב-${slot}` : "";
  const namePart = customerName ? `, על שם ${customerName}` : "";
  const phonePart = customerPhone ? `, טלפון ${customerPhone}` : "";
  return `${base} פרטי הבקשה: ${svc}${datePart}${slotPart}${namePart}${phonePart}.`;
}

/**
 * Hard truth-grounding validator — called after Phase 2.
 *
 * Guarantees: the response never claims an appointment was booked/confirmed
 * unless bookingLifecycle === "confirmed" AND appointmentCreated === true.
 *
 * Returns the original draft if it is safe, or a grounded replacement if not.
 */
export function validateBookingTruth(
  draft: string,
  bookingLifecycle: string,
  appointmentCreated: boolean,
  serviceHe: string | null,
  dateHe: string | null,
  slot: string | null,
  customerName: string | null,
  customerPhone: string | null,
  lang: "he" | "en" | "unknown",
): string {
  // Real backend success → booking language is correct; pass through
  if (bookingLifecycle === "confirmed" && appointmentCreated) return draft;

  // test_mode_confirmed → always replace regardless of phrasing
  // (LLM cannot be trusted not to say "אושר" in this state)
  if (bookingLifecycle === "test_mode_confirmed") {
    return buildTestModeResponse(serviceHe, dateHe, slot, customerName, customerPhone, lang);
  }

  // Any other non-confirmed state: if forbidden language appears, replace
  if (!appointmentCreated && BOOKING_CONFIRMED_RE.test(draft)) {
    return buildTestModeResponse(serviceHe, dateHe, slot, customerName, customerPhone, lang);
  }

  return draft;
}

// ─── Customer-language sanitizer ───────────────────────────────────────────────
// Safety/quality guard — NOT the intelligence layer.
// If raw English service names or ISO dates appear in a Hebrew response,
// substitute with correct Hebrew display names.

const RAW_EN_PATTERNS: [RegExp, string][] = [
  [/\bKids\s+Haircut\b/g,          "תספורת ילדים"],
  [/\bHaircut\s*\+\s*Beard\b/g,    "תספורת וזקן"],
  [/\bBeard\b/g,                   "עיצוב זקן"],
  [/\bHaircut\b/g,                 "תספורת"],
  [/\(morning\)/gi,                "בבוקר"],
  [/\(afternoon\)/gi,              "אחר הצהריים"],
  [/\(evening\)/gi,                "בערב"],
];

const ISO_DATE_RE = /\b20\d{2}-\d{1,2}-\d{1,2}\b/g;

export function sanitizeResponseLanguage(draft: string, lang: "he" | "en" | "unknown"): string {
  const isHebrew = lang === "he" || /[א-ת]/.test(draft);
  if (!isHebrew) return draft;

  let clean = draft;
  for (const [pattern, replacement] of RAW_EN_PATTERNS) {
    clean = clean.replace(pattern, replacement);
  }
  clean = clean.replace(ISO_DATE_RE, "").replace(/\s{2,}/g, " ").trim();
  return clean;
}

// ─── Phase 2 entry point ───────────────────────────────────────────────────────

const PROCESS_RE =
  /^(אני\s*בודק|let\s+me\s+(check|look)|i('m|\s+am)\s+(checking|looking)|one\s+moment|רגע|checking\s)/i;

export async function runPhase2Phrasing(
  ai: GoogleGenAI,
  modelName: string,
  input: Phase2Input,
): Promise<string | null> {
  // Contradiction guard: catch false denials before calling LLM
  const corrected = checkContradiction(input);
  if (corrected) return sanitizeResponseLanguage(corrected, input.lang);

  const isHe = input.lang === "he" || /[א-ת]/.test(input.userMessage);
  const langRule = isHe
    ? "Respond in Hebrew ONLY. Use natural, warm, conversational Hebrew."
    : "Respond in English ONLY. Be warm and natural.";

  const factsBlock = buildFactsBlock(input);
  const recentHistory = input.history.slice(-4)
    .map(t => `${t.role === "user" ? "Customer" : "Agent"}: ${t.text}`)
    .join("\n");
  const goalLine = input.responseGoal ? `\nSPECIFIC GOAL: ${input.responseGoal}` : "";

  const systemPrompt = `You are a warm barbershop booking assistant. Write a single customer-facing response.

VALIDATED STATE AUTHORITY (overrides everything else):
The VERIFIED FACTS block starts with VALIDATED_BOOKING_STATE — these are the ONLY server-confirmed booking facts.
- confirmed_X=not_confirmed → that field is MISSING. Do NOT treat it as received, even if the customer mentioned it.
- confirmed_phone=not_confirmed → no valid phone was collected. Do NOT mention any phone from the conversation as if confirmed.
- pending_confirmation=false → the booking is NOT ready to confirm. Do NOT summarize as if it is.
- appointment_created=false → no appointment exists. Do NOT say it was booked or confirmed.
- SPECIFIC GOAL is a hint from the LLM. If it contradicts VALIDATED_BOOKING_STATE, VALIDATED_BOOKING_STATE wins.
- Raw customer message is conversation context only — not a confirmed fact.

STRICT LANGUAGE RULES:
- ${langRule}
- If customer_language=he: use service_to_use_in_response and date_to_use_in_response from VERIFIED FACTS
- NEVER output raw English service names (Beard, Haircut, Kids Haircut) in a Hebrew response
- NEVER output raw ISO dates (2026-...) in any response
- NEVER mix English and Hebrew in the same sentence
- Do NOT write a header line like "Beard 2026-06-07 (morning): ..." — start with a complete natural sentence

AVAILABILITY RULES:
- If availability_goal=earliest_available: lead with focus_slot as THE answer (e.g. "הכי מוקדם שיש ל[service] מחר [בבוקר] הוא [focus_slot]"); do NOT infer or mention any clock time that wasn't in focus_slot
- If availability_goal=latest_available: lead with focus_slot as the single latest option
- If availability_goal=later_in_period: present slots_to_mention as later options within the requested period (e.g. "מאוחר בבוקר יש זמינות ב-[slot1], [slot2] או [slot3]. מה מתאים?"); lead with the latest of those slots; do NOT show early-morning slots
- If availability_goal=nearest_to_requested_time: present slots_to_mention as the closest options
- If requested_time is set (exact_time_check): address THAT time first — available or not
- If requested_time_available=false: say the time is not available and offer nearest_alternatives
- If requested_time_available=true: confirm that exact slot
- NEVER say "תפוס" or "occupied" — the system only knows available slots, not whether others are booked; say "אין זמינות ב-[time]" or "לא ניתן לקבוע ב-[time]" instead
- Only mention slots in slots_to_mention — do not add more
- Do not dump slots as a bare comma list — wrap them in a natural sentence
- Ask at most ONE follow-up question${goalLine}

MANDATORY LIFECYCLE DIRECTIVE (server-enforced, highest priority — overrides responseGoal):
The server has computed what the booking flow requires AFTER this response.
These rules are absolute and cannot be overridden by any other instruction:
- If next_required_field=customerName: you MUST end your response by asking for the customer's name (e.g. "על איזה שם לרשום את הבקשה?")
- If next_required_field=customerPhone: you MUST end your response by asking for the customer's phone number (e.g. "מה מספר הטלפון שלך?")
- If next_required_field=confirmation OR pending_confirmation=true: you MUST summarize ALL booking details (service_to_use_in_response, date_to_use_in_response, summary_slot, summary_name, summary_phone if present) and ask for explicit yes/no confirmation
- If next_required_field=slot: you MUST ask the customer to pick a time from the offered slots
- If next_required_field is absent or null: no booking action is pending — respond naturally to the question
- ACKNOWLEDGEMENTS (מעולה/תודה/סבבה/אחלה) DURING ACTIVE BOOKING FLOW: do NOT treat as confirmation unless pending_confirmation=true; instead ask the next required question as directed above
- LOOP PREVENTION: if you would produce the same sentence as the previous agent message, instead ask the next required question directly
- If invalid_phone_attempt=true: the customer just sent an invalid phone number; acknowledge it politely, say the format was not recognized, and ask for a valid Israeli phone number (e.g. 0521234567); do NOT quote or echo the invalid number the customer sent; you MAY mention the booking details already collected (service, date, slot, name) as context

BOOKING LANGUAGE — STATE-BASED TRUTH POLICY:
The response language MUST reflect actual backend state, not the agent's intention.
- booking_lifecycle=collecting_details | slot_selected: no booking has happened; do not imply otherwise
- booking_lifecycle=pending_confirmation: all details collected — summarize (service_to_use_in_response, date_to_use_in_response, summary_slot, summary_name, summary_phone) and ask for explicit yes/no confirmation; do NOT say "booked" yet
- booking_lifecycle=test_mode_confirmed: customer confirmed, but write tools are disabled — acknowledge the request was received, say clearly no real appointment was created in this test session; do NOT say "התור נקבע" or "booked"
- booking_lifecycle=confirmed AND appointment_created=true: the backend confirmed a real appointment — you MAY and SHOULD say "התור נקבע" / "התור אושר" / "Your appointment is booked" and include the appointment details
- ANY other state (appointment_created=false, lifecycle≠confirmed): do not use booking-confirmed language

OTHER RULES:
- Do NOT say "I'm checking", "let me look", or any process phrase
- Be concise: 1–3 sentences
- Vary phrasing from previous agent message

VERIFIED FACTS:
${factsBlock}

RECENT CONVERSATION:
${recentHistory || "(first turn)"}

CUSTOMER MESSAGE: "${input.userMessage}"

Write a single plain-text response. No markdown, no JSON.`;

  try {
    const response = await ai.models.generateContent({
      model:    modelName,
      contents: [{ role: "user", parts: [{ text: "Write the customer response." }] }],
      config:   { systemInstruction: systemPrompt, temperature: 0.4, maxOutputTokens: 200 },
    });
    const text = (response.text ?? "").trim();
    if (!text || PROCESS_RE.test(text) || text.length < 3 || text.length > 600) return null;
    return sanitizeResponseLanguage(text, input.lang);
  } catch {
    return null;
  }
}
