import type { ConversationState } from "./conversation-state";

export type FollowUpResolution =
  | { type: "slot_selection"; slot: string }
  | { type: "name_fill"; name: string }
  | { type: "confirm" }
  | { type: "deny" }
  | { type: "change_date" };

// ─── Hebrew hour words (1–18, covers typical barbershop hours) ─────────────────

const HE_HOUR_MAP: Record<string, number> = {
  "אחת": 1, "שתיים": 2, "שתים": 2, "שלוש": 3, "ארבע": 4,
  "חמש": 5, "שש": 6, "שבע": 7, "שמונה": 8, "תשע": 9,
  "עשר": 10, "אחת עשרה": 11, "שתים עשרה": 12,
  "שלוש עשרה": 13, "ארבע עשרה": 14, "חמש עשרה": 15,
  "שש עשרה": 16, "שבע עשרה": 17, "שמונה עשרה": 18,
};

// Normalises any time expression to "HH:mm", or null if no time is recognised.
//
// Handles:
//   "9:30"           → "09:30"     (bare H:MM)
//   "09:30"          → "09:30"     (already zero-padded)
//   "9.30"           → "09:30"     (dot separator)
//   "אני רוצה 9:30"  → "09:30"     (time embedded in Hebrew sentence)
//   "9 וחצי"         → "09:30"     (digit + half-hour)
//   "תשע וחצי"       → "09:30"     (Hebrew word + half-hour)
//   "תשע שלושים"     → "09:30"     (Hebrew word + thirty)
//   "9"              → "09:00"     (bare hour — caller checks against offeredSlots)
export function normalizeTimeCandidate(input: string): string | null {
  const t = input.trim();

  // H:MM or HH:MM embedded anywhere in input ("אני רוצה 9:30" → "09:30")
  const colonMatch = t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (colonMatch) {
    const h = parseInt(colonMatch[1], 10), m = parseInt(colonMatch[2], 10);
    if (h <= 23 && m <= 59) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  // H.MM dot separator (9.30 → 09:30)
  const dotMatch = t.match(/\b(\d{1,2})\.(\d{2})\b/);
  if (dotMatch) {
    const h = parseInt(dotMatch[1], 10), m = parseInt(dotMatch[2], 10);
    if (h <= 23 && m <= 59) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  // Digit + וחצי ("9 וחצי" → "09:30")
  const digitHalf = t.match(/\b(\d{1,2})\s+וחצי\b/);
  if (digitHalf) {
    const h = parseInt(digitHalf[1], 10);
    if (h <= 23) return `${String(h).padStart(2, "0")}:30`;
  }

  // Hebrew word + וחצי or שלושים ("תשע וחצי" / "תשע שלושים" → "09:30")
  for (const [word, h] of Object.entries(HE_HOUR_MAP)) {
    if (new RegExp(`${word}\\s+וחצי`).test(t)) return `${String(h).padStart(2, "0")}:30`;
    if (new RegExp(`${word}\\s+שלושים`).test(t)) return `${String(h).padStart(2, "0")}:30`;
  }

  // Bare digit — only when input contains nothing else ("9" → "09:00")
  if (/^\d{1,2}$/.test(t)) {
    const h = parseInt(t, 10);
    if (h <= 23) return `${String(h).padStart(2, "0")}:00`;
  }

  return null;
}

// ─── Main follow-up resolver ───────────────────────────────────────────────────

// Detects whether the user's message is a follow-up to the current conversation
// state (slot pick, name, confirm/deny) rather than a new independent request.
// Returns null when it's a new message Gemini should handle.
export function resolveFollowUpMessage(
  input: string,
  state: ConversationState,
): FollowUpResolution | null {
  const t = input.trim();

  // Slot selection — only when slots were offered and none is selected yet.
  // Uses normalizeTimeCandidate so "אני רוצה 9:30" matches offered slot "09:30".
  if (state.offeredSlots.length > 0 && !state.selectedSlot) {
    const normalizedCandidate = normalizeTimeCandidate(t);
    if (normalizedCandidate) {
      const slot = state.offeredSlots.find((s) => s === normalizedCandidate);
      if (slot) return { type: "slot_selection", slot };
      // Bare hour matched a slot (e.g., "9" → "09:00") — only if exact slot exists
      // (slot not found → fall through to ordinals; Gemini handles if neither matches)
    }
    const ordinalIdx = resolveOrdinal(t);
    if (ordinalIdx !== null && ordinalIdx < state.offeredSlots.length) {
      return { type: "slot_selection", slot: state.offeredSlots[ordinalIdx] };
    }
  }

  // Confirmation / denial — only when explicitly pending
  if (state.pendingConfirmation) {
    if (/^(כן|yes|אישור|confirm|בסדר|ok|אוקי|sure|yep)$/i.test(t)) return { type: "confirm" };
    if (/^(לא|no|ביטול|cancel|nope)$/i.test(t)) return { type: "deny" };
  }

  // Change-date expressions
  if (/תבדוק?\s*יום\s*אחר|check\s*an?other\s*day|different\s*day|יום\s*אחר/i.test(t)) {
    return { type: "change_date" };
  }

  // Name fill — only when we're explicitly waiting for the customer name
  if (state.nextRequiredField === "customerName" && isLikelyName(t)) {
    return { type: "name_fill", name: t };
  }

  return null;
}

// ─── Ordinal resolver ──────────────────────────────────────────────────────────

// Optional prefix: "האופציה " or "השעה " before ordinal word
const ORD_PRE = "(?:האופציה\\s+|השעה\\s+)?";

function resolveOrdinal(t: string): number | null {
  // English
  if (/^(the\s+)?first(\s+one)?$/i.test(t)) return 0;
  if (/^(the\s+)?second(\s+one)?$/i.test(t)) return 1;
  if (/^(the\s+)?third(\s+one)?$/i.test(t)) return 2;
  if (/^(the\s+)?fourth(\s+one)?$/i.test(t)) return 3;
  if (/^(the\s+)?fifth(\s+one)?$/i.test(t)) return 4;
  // Hebrew — masculine + feminine + "האופציה" prefix
  if (new RegExp(`^${ORD_PRE}הראשונ[הת]?$`).test(t)) return 0;
  if (new RegExp(`^${ORD_PRE}השנ(?:י|ייה|יה)?$`).test(t)) return 1;
  if (new RegExp(`^${ORD_PRE}השליש[יה]ת?$`).test(t)) return 2;
  if (new RegExp(`^${ORD_PRE}הרביע[יה]ת?$`).test(t)) return 3;
  if (new RegExp(`^${ORD_PRE}החמיש[יה]ת?$`).test(t)) return 4;
  return null;
}

// ─── Name heuristic ────────────────────────────────────────────────────────────

// A bare short word/phrase with no digits or special chars is likely a name.
function isLikelyName(t: string): boolean {
  if (t.length < 2 || t.length > 50) return false;
  if (/\d/.test(t)) return false;
  if (/[!?@#$%^&*()\[\]{}|\\/<>~`+=:;]/.test(t)) return false;
  if (t.split(/\s+/).length > 3) return false;
  return true;
}
