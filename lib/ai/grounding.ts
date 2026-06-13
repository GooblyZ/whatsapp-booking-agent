// lib/ai/grounding.ts
// Server-side only.
//
// Strict grounding verification. Gemini owns the wording, but it must not quote a
// price / time / phone that isn't backed by the source of truth.
//
// Time rules (fixes the "17:00 rejected though inside business hours" bug):
//   A time token in the reply is GROUNDED when ANY of:
//     1. it lies INSIDE an open business-hours range (e.g. 17:00 in 09:00-18:00),
//     2. it is an exact allowed time (hours bound / system-provided open slot),
//     3. the CUSTOMER mentioned it in their own message (echo allowance — needed
//        for honest negatives like "ב-19:00 כבר סגור").
//   Availability truth (free vs taken) is handled UPSTREAM: the system feeds the
//   evaluated category (closed/outside/taken/available) to Gemini as facts before
//   the reply is written. Grounding here is the last-resort fence, not the router.
//
// Scope (honest): verifies currency amounts, clock times, and phone numbers — the
// concrete values customers act on. Free-text policy prose is governed by the
// prompt's "facts-only" mandate, not by regex.

import type { FactIndex } from "./facts";

export interface GroundingResult {
  ok: boolean;
  violations: string[];
  kinds: ("price" | "time" | "phone")[]; // categories present, for fact-aware fallback
}

// Currency amounts: "₪80", "80 ₪", "80 שח", "80 ש\"ח", "80 שקל/שקלים".
const PRICE_RE = /(?:₪\s*(\d{1,6}))|(?:(\d{1,6})\s*(?:₪|ש"?ח|שקלים?|shekels?|nis))/gi;
// Clock times: "09:00", "9:30".
const TIME_RE = /\b(\d{1,2}):(\d{2})\b/g;
// Long digit runs that look like a phone number (>= 9 digits, allowing separators).
const PHONE_RE = /(?:\+?\d[\d\-\s().]{8,}\d)/g;

// ── Hebrew time parsing ────────────────────────────────────────────────────────
//
// Natural Hebrew time forms ("חמש וחצי", "5 וחצי", "רבע לחמש", "בשבע בערב") plus
// common typos ("וןצי" for "וחצי"). Live incident: "5:30 PM" was stated FOUR times
// ("5 וןצי", "חמש וחצי", "5 וחצי") before any layer captured it.
//
// Daypart inference (booking context): bare hours 1-7 default to AFTERNOON
// (matching the persona's own convention "בחמש" → 17:00); 8-11 default to morning;
// explicit "בבוקר" / "בערב" / "אחר הצהריים" override.

// Spelled-out hours (feminine forms). Compounds FIRST so "אחת" never eats "אחת עשרה".
const SPELLED_HOURS: [string, number][] = [
  ["אחת עשרה", 11], ["שתים עשרה", 12], ["שתיים עשרה", 12],
  ["שמונה", 8], ["שתיים", 2], ["שתים", 2], ["שלוש", 3], ["ארבע", 4],
  ["חמש", 5], ["שבע", 7], ["תשע", 9], ["עשר", 10], ["שש", 6], ["אחת", 1],
];
const SPELLED_ALT = SPELLED_HOURS.map(([w]) => w).join("|");
// "וחצי" + common typo variants: ח→ן substitution ("וןצי") AND an extra inserted
// letter ("וחןצי" — live occurrence); "ורבע" for quarter past.
const FRACTION = "ו[חן]{1,2}צי|ורבע";

const MORNING_RE = /בבוקר|לפנות בוקר/;
const EVENING_RE = /בערב|אחר\s?ה?צהריים|אחרי\s?ה?צהריים|אחה"?צ|לפנות ערב|בלילה/;

function spelledToHour(word: string): number | null {
  const hit = SPELLED_HOURS.find(([w]) => w === word.trim());
  return hit ? hit[1] : null;
}

function fractionToMinutes(frac: string | undefined): string {
  if (!frac) return "00";
  return /רבע/.test(frac) ? "15" : "30";
}

/** Booking-context daypart inference for an ambiguous 1-12 hour. */
function inferDaypart(h: number, text: string): number {
  if (h >= 13) return h;                 // already 24h
  if (MORNING_RE.test(text)) return h;   // explicit morning ("12 בבוקר" ≈ noon colloquially)
  if (EVENING_RE.test(text)) return h === 12 ? 12 : h + 12;
  if (h >= 1 && h <= 7) return h + 12;   // "חמש"/"5:30" in a booking → afternoon
  return h;                              // 8-12 default to morning / noon
}

function fmt(h: number, mm: string): string | null {
  if (h < 0 || h > 23) return null;
  return `${String(h).padStart(2, "0")}:${mm}`;
}

/**
 * Extracts ONE concrete clock time from a customer message → "HH:MM" or null,
 * with booking-context daypart inference. Precedence: explicit HH:MM > digit
 * + fraction ("5 וחצי") > "רבע ל..." > spelled hour > bare "ב5".
 */
export function extractExplicitTime(text: string): string | null {
  const t = (text ?? "").trim();
  if (t.length === 0) return null;

  // 1. Explicit HH:MM (daypart-inferred when ambiguous: "5:30" → 17:30).
  const colon = t.match(/(?:^|[^\d])(\d{1,2}):(\d{2})(?!\d)/);
  if (colon) {
    const h = parseInt(colon[1], 10), mm = parseInt(colon[2], 10);
    if (h <= 23 && mm <= 59) return fmt(inferDaypart(h, t), colon[2]);
  }

  // 2. Digit + fraction: "5 וחצי", "ב5 וחצי", "5 וןצי", "8 ורבע".
  const digitFrac = t.match(new RegExp(`(?:^|[\\s,.!?])ב?-?(\\d{1,2})\\s*(${FRACTION})`));
  if (digitFrac) {
    const h = parseInt(digitFrac[1], 10);
    if (h <= 23) return fmt(inferDaypart(h, t), fractionToMinutes(digitFrac[2]));
  }

  // 2b. Digit + adjacent daypart word: "5 בערב", "10 בבוקר".
  const digitMod = t.match(/(?:^|[\s,.!?])(\d{1,2})\s+(בערב|בבוקר|בצהריים|אחה"?צ|אחר\s?הצהריים|אחרי\s?הצהריים|בלילה)/);
  if (digitMod) {
    const h = parseInt(digitMod[1], 10);
    if (h <= 23) return fmt(inferDaypart(h, t), "00");
  }

  // 3. "רבע ל-5" / "רבע לחמש" → quarter TO the (daypart-inferred) hour.
  const quarterTo = t.match(new RegExp(`רבע ל-?(?:(\\d{1,2})|(${SPELLED_ALT}))`));
  if (quarterTo) {
    const h = quarterTo[1] ? parseInt(quarterTo[1], 10) : spelledToHour(quarterTo[2] ?? "");
    if (h !== null && h >= 0 && h <= 23) {
      const target = inferDaypart(h, t);
      return fmt(target === 0 ? 23 : target - 1, "45");
    }
  }

  // 4. Spelled hour: "חמש וחצי", "בחמש", "בשעה שבע", "שבע בערב". A bare spelled
  //    hour needs an anchor — "ב"/"בשעה" prefix, a fraction, an ADJACENT daypart
  //    word, or being the whole message ("חמש"). "(?!\s*דקות)" keeps durations
  //    ("בחמש דקות") out.
  const spelled = t.match(new RegExp(
    `(?:^|[\\s,.!?])(בשעה\\s+)?(ב)?(${SPELLED_ALT})(?:\\s*(${FRACTION}))?` +
    `(\\s+(?:בערב|בבוקר|בצהריים|אחה"?צ|אחר\\s?הצהריים|אחרי\\s?הצהריים|בלילה))?(?=$|[\\s,.!?])(?!\\s*דקות)`
  ));
  if (spelled) {
    const [, bishaa, bePrefix, word, frac, adjacentMod] = spelled;
    const h = spelledToHour(word);
    const wholeMessage = t.replace(/[!?.…]+$/g, "").trim() === `${bePrefix ?? ""}${word}${frac ? ` ${frac}` : ""}`.trim()
      || t.replace(/[!?.…]+$/g, "").trim() === word;
    if (h !== null && (bishaa || bePrefix || frac || adjacentMod || wholeMessage)) {
      return fmt(inferDaypart(h, t), fractionToMinutes(frac));
    }
  }

  // 5. Bare "ב9" / "ב-19" (daypart-inferred: "ב5" → 17:00).
  const bare = t.match(/(?:^|[\s,.!?])ב-?(\d{1,2})(?![\d:/])/);
  if (bare) {
    const h = parseInt(bare[1], 10);
    if (h <= 23) return fmt(inferDaypart(h, t), "00");
  }

  return null;
}

/**
 * Extracts normalized "HH:MM" tokens from arbitrary text (for the echo allowance).
 * Deliberately WIDE: ambiguous hours contribute BOTH the AM and PM reading, so an
 * honest reply that normalizes the customer's "ב7"/"שבע וחצי" to 19:00/19:30 is
 * never flagged as ungrounded. (Allowance only — never used to assert facts.)
 */
export function extractTimeTokens(text: string): Set<string> {
  const out = new Set<string>();
  const add = (h: number, mm: string) => {
    if (h < 0 || h > 23) return;
    out.add(`${String(h).padStart(2, "0")}:${mm}`);
    if (h >= 1 && h <= 11) out.add(`${String(h + 12).padStart(2, "0")}:${mm}`);
  };
  for (const m of (text ?? "").matchAll(TIME_RE)) {
    const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (h <= 23 && mm <= 59) add(h, m[2]);
  }
  // Bare "ב9" / "ב-19" forms also count as customer-mentioned times.
  for (const m of (text ?? "").matchAll(/(?:^|[\s,.!?])ב-?(\d{1,2})(?![\d:/])/g)) {
    const h = parseInt(m[1], 10);
    if (h <= 23) add(h, "00");
  }
  // Natural-Hebrew forms ("חמש וחצי", "5 וןצי", "רבע לשבע") via the rich parser —
  // it returns the inferred reading; add() widens with the counterpart.
  const rich = extractExplicitTime(text ?? "");
  if (rich) {
    const [h, mm] = rich.split(":");
    const hn = parseInt(h, 10);
    add(hn > 12 ? hn - 12 : hn, mm);
    add(hn, mm);
  }
  return out;
}

/** Digit runs (>= 9 digits) that look like phone numbers, in any text. */
export function extractPhoneDigits(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of (text ?? "").matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 9) out.add(digits);
  }
  return out;
}

/**
 * Returns ok=false (with reasons) if the reply quotes any unverifiable price,
 * time, or phone number. In strict mode the caller discards the reply on failure.
 *
 * `allowedTimes` — extra exact times provided as facts this turn (open slots,
 * nearest alternatives). `echoTimes` — times the customer mentioned themselves.
 * `allowedPhones` — phone numbers that are legitimately quotable even though they
 * aren't the business phone: the CUSTOMER's own number (it identifies them, it is
 * not a "contact us" claim) and any phone the customer typed themselves. The fence
 * still catches an INVENTED/wrong business number — its real job.
 */
export function verifyGrounding(
  reply: string,
  index: FactIndex,
  allowedTimes: Set<string> = new Set(),
  echoTimes: Set<string> = new Set(),
  allowedPhones: Set<string> = new Set()
): GroundingResult {
  const violations: string[] = [];
  const kinds = new Set<"price" | "time" | "phone">();
  const text = reply ?? "";

  // 1. Prices — every currency amount must be a real service price.
  for (const m of text.matchAll(PRICE_RE)) {
    const raw = m[1] ?? m[2];
    if (raw == null) continue;
    const amount = parseInt(raw, 10);
    if (!Number.isFinite(amount)) continue;
    if (!index.prices.has(amount)) {
      violations.push(`price ₪${amount} not in source of truth`);
      kinds.add("price");
    }
  }

  // 2. Times — inside an open range, exactly allowed, or customer-echoed.
  for (const m of text.matchAll(TIME_RE)) {
    const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (h > 23 || mm > 59) continue; // not a real time token
    const t = `${String(h).padStart(2, "0")}:${m[2]}`;
    const minutes = h * 60 + mm;
    const inRange = index.timeRanges.some((r) => minutes >= r.start && minutes <= r.end);
    if (inRange || index.times.has(t) || allowedTimes.has(t) || echoTimes.has(t)) continue;
    violations.push(`time ${t} outside business hours and not system-provided`);
    kinds.add("time");
  }

  // 3. Phone — a phone-like run must match the business phone OR an explicitly
  //    allowed number (the customer's own phone identifies them; it is not a
  //    "contact us" claim). An invented/other business number still fails — that
  //    is the fence's real purpose.
  if (index.phoneDigits) {
    const matchesEither = (a: string, b: string) => a === b || a.endsWith(b) || b.endsWith(a);
    for (const m of text.matchAll(PHONE_RE)) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length < 9) continue;
      if (matchesEither(digits, index.phoneDigits)) continue;
      if ([...allowedPhones].some((p) => p.length >= 9 && matchesEither(digits, p))) continue;
      violations.push(`phone ${digits} does not match business phone`);
      kinds.add("phone");
    }
  }

  return { ok: violations.length === 0, violations, kinds: [...kinds] };
}
