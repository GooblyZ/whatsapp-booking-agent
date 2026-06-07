import type {
  AgentIntent,
  AgentConfidence,
  AgentAnalysisResult,
  MissingField,
  SuggestedTool,
} from "./types";

// ─── Intent patterns (English + Hebrew) ───────────────────────────────────────
// Priority: most specific intents first. Each group checked in order.

const RESCHEDULE_RE = [
  /\b(reschedule|rescheduling|move my appointment|change my appointment|postpone|push (my appointment|it) to|shift (it|my appointment))\b/i,
  /להזיז\s*(את\s*)?התור|לשנות\s*(את\s*)?התור|לדחות\s*(את\s*)?התור|אפשר\s*לשנות/,
];

const CANCEL_RE = [
  /\b(cancel|cancellation|cancel (my|the) appointment|i('d| would) like to cancel|i want to cancel)\b/i,
  /\bdon'?t (want|need) (it|the appointment|my appointment)\b/i,
  /לבטל\s*(את\s*)?התור|רוצה\s*לבטל|לבטל\s*תור/,
];

const HUMAN_RE = [
  /\b(speak to|talk to|connect me (with|to)|get me) (a |an |a real )?(human|person|agent|staff|manager|someone|representative)\b/i,
  /\breal (person|agent|human)\b/i,
  /לדבר\s*עם\s*(אדם|נציג|מישהו)|נציג\s*אנושי/,
];

const PRICES_RE = [
  /\bhow much (is|does|for|cost|are)\b/i,
  /\b(price|pricing|cost|fee|rate)\b/i,
  /כמה\s*(עולה|זה|זה\s*עולה|המחיר)|מה\s*(המחיר|העלות)\s*(של|ל)/,
];

const HOURS_RE = [
  /\b(hours|opening hours|business hours|when (do|are) you (open|close)|what time (do you|are you) (open|close)|are you open)\b/i,
  /שעות\s*(הפעילות|פתיחה|עבודה)|מתי\s*(אתם\s*)?(פתוחים|פותחים|סוגרים)/,
];

const SERVICES_RE = [
  /\bwhat (services|do you (offer|have|provide))\b/i,
  /\b(services (available|you offer|you have)|your services|list of services|services menu)\b/i,
  /\bwhat can (you do|i get|i book)\b/i,
  /איזה\s*שירותים|מה\s*אתם\s*מציעים|אילו\s*שירותים|מה\s*יש\s*לכם/,
];

const AVAILABILITY_RE = [
  /\b(available|availability|when can i (come|book|get in)|any (slots|openings|spots|times)|free (slots|time|times))\b/i,
  /\bhow many (slots|appointments|times?|openings?)\b/i,
  /\b(slots|appointments|times?)\s*(available|open|free|left)\b/i,
  // Hebrew: "כמה תורים", "יש זמינות", "יש תורים", "מה פנוי", "יש הרבה", "מה זמין"
  /כמה\s*(תורים|מקומות|פנויים?)|יש\s*(תורים?|זמינות|מקום)\b|מה\s*(פנוי|זמין)\b|יש\s*הרבה/,
  /יש\s*(תור|מקום|זמן)\s*(ל|ב|מחר|היום)/,
];

const BOOK_EXPLICIT_RE = [
  /\b(book|booking|reserve|schedule|make (a|an) appointment|i('d| would) like (to book|an appointment|a slot))\b/i,
  /\b(want (a|to) (book|schedule|make)|i want (a|an) (haircut|beard|shave|trim|color|treatment))\b/i,
  /\bcan i (get|have|book|schedule)\b/i,
  /אני\s*רוצה\s*(לקבוע|תספורת|תור)|אפשר\s*לקבוע|רוצה\s*(לקבוע|תור)\b/,
];

// ─── Service dictionary ────────────────────────────────────────────────────────
// Compound services MUST appear before single-service entries.

const SERVICES: { name: string; re: RegExp }[] = [
  {
    name: "Haircut + Beard",
    re: /\b(haircut\s*(and|\+|&|with)\s*beard|beard\s*(and|\+|&|with)\s*haircut|cut\s*(and|\+|&)\s*beard)\b|תספורת\s*(ו|&|\+|-)\s*זקן|זקן\s*(ו|&|\+|-)\s*תספורת/i,
  },
  { name: "Haircut", re: /\b(haircut|hair cut|strizka|hair trim)\b|תספורת/i },
  { name: "Beard", re: /\b(beard|beard trim|beard trimming|beard shaping)\b|זקן/i },
  { name: "Shave", re: /\b(shave|shaving|wet shave)\b|גילוח/i },
  { name: "Hair color", re: /\b(colo(u)?r(ing)?|dye|highlights)\b|צביעה|צבע\s*שיער/i },
  { name: "Hair treatment", re: /\b(treatment|keratin|conditioning|straighten)\b|טיפול\s*שיער/i },
];

// ─── Date patterns ─────────────────────────────────────────────────────────────

const DATES: { label: string; re: RegExp }[] = [
  // Specific multi-word — check before bare day names
  { label: "in three days", re: /\bin three days\b|בעוד\s*שלושה\s*ימים/i },
  { label: "day after tomorrow", re: /\bday after tomorrow\b|מחרתיים|בעוד\s*יומיים|עוד\s*יומיים/i },
  { label: "tomorrow", re: /\btomorrow\b|מחר/i },
  { label: "today", re: /\btoday\b|היום/i },
  { label: "next Monday", re: /\bnext monday\b/i },
  { label: "next Tuesday", re: /\bnext tuesday\b/i },
  { label: "next Wednesday", re: /\bnext wednesday\b/i },
  { label: "next Thursday", re: /\bnext thursday\b/i },
  { label: "next Friday", re: /\bnext friday\b/i },
  { label: "next Saturday", re: /\bnext saturday\b/i },
  { label: "next Sunday", re: /\bnext sunday\b/i },
  { label: "next week", re: /\bnext week\b|שבוע\s*הבא/i },
  { label: "this week", re: /\bthis week\b/i },
  { label: "Sunday", re: /\bsunday\b|יום\s*ראשון/i },
  { label: "Monday", re: /\bmonday\b|יום\s*שני/i },
  { label: "Tuesday", re: /\btuesday\b|יום\s*שלישי/i },
  { label: "Wednesday", re: /\bwednesday\b|יום\s*רביעי/i },
  { label: "Thursday", re: /\bthursday\b|יום\s*חמישי/i },
  { label: "Friday", re: /\bfriday\b|יום\s*שישי/i },
  { label: "Saturday", re: /\bsaturday\b|שבת/i },
];

// ─── Entity extractors ─────────────────────────────────────────────────────────

function extractDate(text: string): string | null {
  for (const { label, re } of DATES) {
    if (re.test(text)) return label;
  }
  return null;
}

function extractTime(text: string): { label: string; exact: boolean } | null {
  // Exact: "at 4", "at 3pm", "at 15:00", "בשעה 4", "ב-16:00"
  const atEn = text.match(/\bat\s+(\d{1,2}(?::\d{2})?)\s*(am|pm)?\b/i);
  if (atEn) return { label: `at ${atEn[1]}${atEn[2] ? atEn[2].toUpperCase() : ""}`, exact: true };

  const atHe = text.match(/(?:בשעה|ב-)\s*(\d{1,2}(?::\d{2})?)/);
  if (atHe) return { label: `at ${atHe[1]}`, exact: true };

  // Exact: "3pm", "10am" (standalone, no "after" prefix)
  const ampm = text.match(/(?<!\bafter\s)\b(\d{1,2}(?::\d{2})?)\s*(am|pm)\b/i);
  if (ampm) return { label: `${ampm[1]}${ampm[2].toUpperCase()}`, exact: true };

  // Exact: bare HH:MM clock like "16:00", "09:30" (not "after 16:00")
  const clock = text.match(/(?<!\bafter\s)(?<![אחרי\s])\b(\d{2}:\d{2})\b/);
  if (clock) return { label: clock[1], exact: true };

  // Preference: "after 4", "after 16:00" — not an exact slot, just a boundary
  const afterEn = text.match(/\bafter\s+(\d{1,2}(?::\d{2})?)\s*(am|pm)?\b/i);
  if (afterEn) return { label: `after ${afterEn[1]}${afterEn[2] ? afterEn[2].toUpperCase() : ""}`, exact: false };

  // Preference: "אחרי 4" — time boundary, not exact
  const afterHe = text.match(/אחרי\s+(\d{1,2}(?::\d{2})?)/);
  if (afterHe) return { label: `after ${afterHe[1]}`, exact: false };

  // Named periods (English + Hebrew) — all preferences
  if (/\bmorning\b|בבוקר/i.test(text)) return { label: "morning", exact: false };
  if (/\bnoon\b|בצהריים/i.test(text)) return { label: "noon", exact: false };
  if (/אחר\s*הצהריים|\bafternoon\b/i.test(text)) return { label: "afternoon", exact: false };
  if (/\bevening\b|בערב/i.test(text)) return { label: "evening", exact: false };
  if (/\bnight\b|בלילה/i.test(text)) return { label: "night", exact: false };

  return null;
}

function extractService(text: string): string | null {
  for (const svc of SERVICES) {
    if (svc.re.test(text)) return svc.name;
  }
  return null;
}

function extractName(text: string): string | null {
  const match = text.match(/\bmy name is ([A-Za-z]{2,})\b/i);
  return match ? match[1] : null;
}

// ─── Intent detection ──────────────────────────────────────────────────────────

function detectIntent(text: string): { intent: AgentIntent; confidence: AgentConfidence } {
  if (RESCHEDULE_RE.some((r) => r.test(text))) return { intent: "RESCHEDULE_APPOINTMENT", confidence: "HIGH" };
  if (CANCEL_RE.some((r) => r.test(text))) return { intent: "CANCEL_APPOINTMENT", confidence: "HIGH" };
  if (HUMAN_RE.some((r) => r.test(text))) return { intent: "HUMAN_HANDOFF", confidence: "HIGH" };
  if (PRICES_RE.some((r) => r.test(text))) return { intent: "ASK_PRICES", confidence: "HIGH" };
  if (HOURS_RE.some((r) => r.test(text))) return { intent: "ASK_BUSINESS_HOURS", confidence: "HIGH" };
  if (SERVICES_RE.some((r) => r.test(text))) return { intent: "ASK_SERVICES", confidence: "HIGH" };
  if (AVAILABILITY_RE.some((r) => r.test(text))) return { intent: "ASK_AVAILABILITY", confidence: "HIGH" };
  if (BOOK_EXPLICIT_RE.some((r) => r.test(text))) return { intent: "BOOK_APPOINTMENT", confidence: "HIGH" };

  // Weak signals: service mentioned with date/time context but no explicit booking verb
  const hasService = SERVICES.some((s) => s.re.test(text));
  const hasDate = extractDate(text) !== null;
  const hasTime = extractTime(text) !== null;

  if (hasService && hasDate && hasTime) return { intent: "BOOK_APPOINTMENT", confidence: "MEDIUM" };
  if (hasService && (hasDate || hasTime)) return { intent: "BOOK_APPOINTMENT", confidence: "LOW" };

  return { intent: "UNKNOWN", confidence: "LOW" };
}

// ─── Missing fields ────────────────────────────────────────────────────────────

function computeMissingFields(
  intent: AgentIntent,
  service: string | null,
  date: string | null,
  time: string | null,
  customerName: string | null,
  hasPhone: boolean
): MissingField[] {
  if (intent !== "BOOK_APPOINTMENT") return [];
  const missing: MissingField[] = [];
  if (!service) missing.push("service");
  if (!date) missing.push("date");
  if (!time) missing.push("time");
  if (!customerName) missing.push("customerName");
  if (!hasPhone) missing.push("customerPhone");
  return missing;
}

// ─── Tool suggestion ───────────────────────────────────────────────────────────
// createAppointment is never suggested from a single text message —
// availability must always be checked first.

function suggestTool(
  intent: AgentIntent,
  missing: MissingField[]
): { tool: SuggestedTool; reason: string } {
  switch (intent) {
    case "BOOK_APPOINTMENT":
      if (missing.includes("service"))
        return { tool: "getServices", reason: "Service unknown — present available options to customer first" };
      // Even with all preferences present, availability must be checked before creating a booking
      return { tool: "checkAvailability", reason: "Check available slots for the service and time preference before confirming" };
    case "CANCEL_APPOINTMENT":
      return { tool: "cancelAppointment", reason: "Locate appointment by phone/date before cancelling" };
    case "RESCHEDULE_APPOINTMENT":
      return { tool: "rescheduleAppointment", reason: "Find existing booking, then check availability for the new slot" };
    case "ASK_SERVICES":
      return { tool: "getServices", reason: "Return the full list of services with descriptions" };
    case "ASK_PRICES":
      return { tool: "getServices", reason: "Service records include price information" };
    case "ASK_AVAILABILITY":
      return { tool: "checkAvailability", reason: "Query available slots for the service/date mentioned" };
    case "ASK_BUSINESS_HOURS":
      return { tool: "getBusinessInfo", reason: "Return working hours from business configuration" };
    case "HUMAN_HANDOFF":
      return { tool: "handoffToHuman", reason: "Customer explicitly requested a human agent" };
    default:
      return { tool: "handoffToHuman", reason: "Intent unclear — escalate rather than guess" };
  }
}

// ─── Draft response ────────────────────────────────────────────────────────────

function buildDraft(
  intent: AgentIntent,
  service: string | null,
  date: string | null,
  time: string | null,
  missing: MissingField[]
): string {
  switch (intent) {
    case "BOOK_APPOINTMENT": {
      if (missing.includes("service"))
        return "Hi! I'd be happy to help you book an appointment. Which service would you like — haircut, beard trim, shave, or something else?";
      const svc = service!;
      const ctx = [date, time].filter(Boolean).join(", ");
      if (missing.includes("date") && missing.includes("time"))
        return `Sure! When would you like to come in for your ${svc}? Any date and time preference?`;
      if (missing.includes("date"))
        return `Got it — ${svc} at ${time}. Which day works best for you? And what's your name?`;
      if (missing.includes("time"))
        return `Got it — ${svc} on ${date}. What time works best? And what's your name?`;
      if (missing.includes("customerName"))
        return `Sure, I can help with that. I'll check available ${svc} times for ${ctx}. What's your name?`;
      return `Let me check available slots for a ${svc}${ctx ? ` — ${ctx}` : ""}. One moment…`;
    }
    case "CANCEL_APPOINTMENT":
      return "I can help with that. Can you share the date and time of the appointment you'd like to cancel?";
    case "RESCHEDULE_APPOINTMENT":
      return "No problem! Which appointment would you like to move, and what new date and time works for you?";
    case "ASK_SERVICES":
      return "We offer a range of grooming services. Let me pull up the full list for you!";
    case "ASK_PRICES":
      return service
        ? `I'll look up the price for ${service} right now.`
        : "Happy to help with pricing. Which service are you asking about?";
    case "ASK_AVAILABILITY":
      return service
        ? `Let me check available slots for ${service}${date ? ` on ${date}` : ""}.`
        : "I can check availability for you. Which service are you interested in, and do you have a preferred date?";
    case "ASK_BUSINESS_HOURS":
      return "We're open Sunday–Thursday 09:00–18:00 and Friday 09:00–14:00. We're closed on Saturdays.";
    case "HUMAN_HANDOFF":
      return "Of course! Let me connect you with one of our team members who can assist you directly.";
    default:
      return "I'm the booking assistant for this barbershop. I can help you schedule appointments, check availability, or answer questions about our services. How can I help?";
  }
}

// ─── Safety notes ──────────────────────────────────────────────────────────────

function buildNotes(intent: AgentIntent, text: string): string | null {
  if (intent === "UNKNOWN")
    return "Message appears unrelated to booking. Redirect politely without engaging with the off-topic content.";
  if (intent === "CANCEL_APPOINTMENT" || intent === "RESCHEDULE_APPOINTMENT")
    return "Verify customer identity and appointment details before executing any modification.";
  if (text.length > 400)
    return "Message is unusually long — consider manual review before processing.";
  return null;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function analyzeMessage(text: string, phone?: string): AgentAnalysisResult {
  const trimmed = text.trim();
  const { intent, confidence } = detectIntent(trimmed);
  const service = extractService(trimmed);
  const date = extractDate(trimmed);
  const timeResult = extractTime(trimmed);
  const customerName = extractName(trimmed);
  const hasPhone = Boolean(phone?.trim());
  const missingFields = computeMissingFields(intent, service, date, timeResult?.label ?? null, customerName, hasPhone);
  const suggestedToolCall = suggestTool(intent, missingFields);
  const draftResponse = buildDraft(intent, service, date, timeResult?.label ?? null, missingFields);
  const notes = buildNotes(intent, trimmed);

  return {
    intent,
    confidence,
    extractedService: service,
    extractedDate: date,
    extractedTime: timeResult?.label ?? null,
    extractedCustomerName: customerName,
    hasExactTime: timeResult?.exact ?? false,
    needsAvailabilityCheck: intent === "BOOK_APPOINTMENT" || intent === "ASK_AVAILABILITY",
    missingFields,
    suggestedToolCall,
    draftResponse,
    notes,
  };
}
