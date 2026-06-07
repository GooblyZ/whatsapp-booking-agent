// Composes natural, language-aware customer-facing draft responses from tool
// results. Used only in the LLM pipeline — rule-based mode keeps its own drafts.
//
// Principles:
// - All logic is data-driven from tool result fields (no hardcoded message checks)
// - Never expose YYYY-MM-DD dates or canonical English names to Hebrew users
// - Never confirm, create, cancel, or reschedule appointments

import type {
  ServiceResult,
  AvailabilityResult,
  BusinessInfoResult,
  CustomerAppointmentsResult,
} from "./tools";
import type { GeminiStructuredOutput } from "./gemini-agent";
import type { NormalizedFields } from "./normalizer";
import type { ToolRunResult } from "./types";

// ─── Internal type alias ───────────────────────────────────────────────────────

type Lang = "he" | "en" | "unknown";

// ─── Time utilities ────────────────────────────────────────────────────────────

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// Convert 24h "HH:MM" → 12h "H:MM AM/PM"
function to12h(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${period}`;
}

// Hours 1–8 are treated as PM (barbershop context: "after 4" = 4 PM).
// Hours 9+ are kept as-is (10 AM, 13:00, etc.).
function afterHourTo24(h: number): number {
  return h >= 1 && h <= 8 ? h + 12 : h;
}

// Extracts the minute-threshold from an "after N" / "אחרי N" expression.
// Returns null if the expression does not match.
function extractAfterThresholdMinutes(timePref: string | null): number | null {
  if (!timePref) return null;
  const m = timePref.trim().match(/^(?:after|אחרי)\s+(\d{1,2})(?::(\d{2}))?$/i);
  if (!m) return null;
  const h24 = afterHourTo24(parseInt(m[1]));
  const mm = m[2] ? parseInt(m[2]) : 0;
  return h24 * 60 + mm;
}

// ─── formatServiceNameForLanguage ─────────────────────────────────────────────

const HE_SERVICE_LABELS: Record<string, string> = {
  "Haircut":         "תספורת",
  "Beard":           "זקן",
  "Haircut + Beard": "תספורת וזקן",
  "Kids Haircut":    "תספורת ילדים",
};

const EN_SERVICE_LABELS: Record<string, string> = {
  "Haircut":         "haircut",
  "Beard":           "beard trim",
  "Haircut + Beard": "haircut and beard",
  "Kids Haircut":    "kids haircut",
};

export function formatServiceNameForLanguage(canonical: string | null, lang: Lang): string {
  if (!canonical) return "";
  if (lang === "he") return HE_SERVICE_LABELS[canonical] ?? canonical;
  return EN_SERVICE_LABELS[canonical] ?? canonical.toLowerCase();
}

// ─── formatTimePreferenceForLanguage ──────────────────────────────────────────

// Hebrew period words → their "ב" prefixed forms used in sentences.
const HE_PERIOD_BET: Record<string, string> = {
  "ערב": "בערב",
  "בוקר": "בבוקר",
  "צהריים": "בצהריים",
  "לילה": "בלילה",
};

// English period words that become "in the X" when used standalone,
// but lose "in the" when appended after a date.
const EN_PERIOD_INTHE: Record<string, string> = {
  evening:   "in the evening",
  morning:   "in the morning",
  afternoon: "in the afternoon",
  night:     "at night",
  noon:      "at noon",
};

// Formats a raw time preference (from Gemini, in user's language) into a
// natural phrase for embedding in a sentence.
//
// Hebrew examples:
//   "ערב"      → "בערב"
//   "אחרי 4"   → "אחרי 16:00"
//   "בשעה 4"   → "בשעה 16:00"
//   "ב-16:00"  → "ב-16:00" (pass through)
//   "בערב"     → "בערב" (already prefixed, pass through)
//
// English examples:
//   "evening"  → "in the evening"  (standalone) / "evening" (after date — see formatDateTimePhrase)
//   "after 4"  → "after 4:00 PM"
//   "at 10"    → "at 10:00 AM"
export function formatTimePreferenceForLanguage(timePref: string | null, lang: Lang): string {
  if (!timePref) return "";
  const t = timePref.trim();

  if (lang === "he" || /[א-ת]/.test(t)) {
    // Already-prefixed Hebrew period words pass through
    if (/^(בערב|בבוקר|בצהריים|בלילה|אחר הצהריים)$/.test(t)) return t;
    // Bare Hebrew period words → add "ב" prefix
    if (HE_PERIOD_BET[t]) return HE_PERIOD_BET[t];
    // "אחרי N" or "אחרי N:MM" → "אחרי HH:MM"
    const afterHe = t.match(/^אחרי\s+(\d{1,2})(?::(\d{2}))?$/);
    if (afterHe) {
      const h24 = afterHourTo24(parseInt(afterHe[1]));
      const mm = afterHe[2] ?? "00";
      return `אחרי ${h24}:${mm.padStart(2, "0")}`;
    }
    // "בשעה N" → "בשעה HH:MM"
    const atHe = t.match(/^בשעה\s+(\d{1,2})(?::(\d{2}))?$/);
    if (atHe) {
      const h24 = afterHourTo24(parseInt(atHe[1]));
      const mm = atHe[2] ?? "00";
      return `בשעה ${h24}:${mm.padStart(2, "0")}`;
    }
    // "ב-HH:MM" → pass through
    return t;
  }

  // English / normalized
  if (EN_PERIOD_INTHE[t]) return EN_PERIOD_INTHE[t];
  // "after N" → "after H:MM PM/AM"
  const afterEn = t.match(/^after\s+(\d{1,2})(?::(\d{2}))?$/i);
  if (afterEn) {
    const h24 = afterHourTo24(parseInt(afterEn[1]));
    const mm = afterEn[2] ?? "00";
    return `after ${to12h(`${h24}:${mm.padStart(2, "0")}`)}`;
  }
  // "at N" → "at H:MM PM/AM"
  const atEn = t.match(/^at\s+(\d{1,2})(?::(\d{2}))?$/i);
  if (atEn) {
    const h24 = afterHourTo24(parseInt(atEn[1]));
    const mm = atEn[2] ?? "00";
    return `at ${to12h(`${h24}:${mm.padStart(2, "0")}`)}`;
  }
  return t;
}

// ─── Date phrase helpers ───────────────────────────────────────────────────────

const HE_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

// Normalises a raw Hebrew day expression into canonical "ביום X" sentence form.
// "שישי" / "יום שישי" / "ביום שישי" all → "ביום שישי"
function normalizeHebrewDayPhrase(raw: string): string {
  const stripped = raw.replace(/^(ביום\s+|יום\s+)/, "").trim();
  if (HE_DAYS.some((d) => stripped.startsWith(d))) return `ביום ${stripped}`;
  return raw;
}

// Returns the date preference as an embeddable phrase (no time component).
function formatDatePhrase(datePref: string | null, lang: Lang): string {
  if (!datePref) return "";
  const d = datePref.trim();

  // Detect Hebrew input regardless of lang param
  if (lang === "he" || /[א-ת]/.test(d)) {
    if (d === "היום") return "היום";
    if (d === "מחר") return "מחר";
    if (d === "מחרתיים") return "מחרתיים";
    return normalizeHebrewDayPhrase(d);
  }

  // English
  const EN_DATE: Record<string, string> = {
    today: "today",
    tomorrow: "tomorrow",
    "day after tomorrow": "the day after tomorrow",
    "next week": "next week",
  };
  return EN_DATE[d.toLowerCase()] ?? d; // "Friday", "next Friday", etc. pass through
}

// ─── formatDateTimePhrase ──────────────────────────────────────────────────────

// Combines date and time into a single natural phrase appropriate for the language.
//
// Hebrew: "מחר" + "ערב" → "מחר בערב"
//         "יום שישי" + "אחרי 4" → "ביום שישי אחרי 16:00"
//
// English: "tomorrow" + "evening" → "tomorrow evening"
//          "Friday" + "after 4"   → "Friday after 4:00 PM"
export function formatDateTimePhrase(
  datePref: string | null,
  timePref: string | null,
  lang: Lang,
): string {
  const datePart = formatDatePhrase(datePref, lang);
  const timeFull = formatTimePreferenceForLanguage(timePref, lang);

  if (!datePart && !timeFull) return "";
  if (!datePart) return timeFull;
  if (!timeFull) return datePart;

  if (lang === "en" || (lang !== "he" && !/[א-ת]/.test(datePart))) {
    // Strip "in the " prefix from period words when they follow a date.
    // "tomorrow in the evening" → "tomorrow evening"
    const timeCombined = timeFull.replace(/^in the /, "");
    return `${datePart} ${timeCombined}`;
  }

  // Hebrew: both parts already have correct prefixes/forms
  return `${datePart} ${timeFull}`;
}

// ─── formatSlotList ────────────────────────────────────────────────────────────

function joinHebrew(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(", ") + " ו-" + items[items.length - 1];
}

function joinEnglish(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return items.slice(0, -1).join(", ") + ", and " + items[items.length - 1];
}

// Formats a list of "HH:MM" slot strings into a natural joined phrase.
// Hebrew: 24h format joined with "ו-"
// English: 12h format joined with "and"
export function formatSlotList(slots: string[], lang: Lang, maxSlots = 5): string {
  const top = slots.slice(0, maxSlots);
  if (lang === "he" || /[א-ת]/.test(top[0] ?? "")) {
    return joinHebrew(top);
  }
  return joinEnglish(top.map(to12h));
}

// ─── explainUnavailablePreference ─────────────────────────────────────────────

// Composes a full explanation for why the requested time preference yielded no
// slots, then offers alternatives.
//
// Closing-time logic:
//   - av.workingDayEnd (from WorkingHour table or static fallback) is the
//     authoritative source. Used when the requested threshold exceeds it.
//   - Slot-list inference is NOT used — slots can be affected by bookings,
//     blocked times, or service duration, making them unreliable for hours.
//   - When workingDayEnd is unavailable, cautious wording is used instead
//     of asserting a specific closing time.
export function explainUnavailablePreference(
  av: AvailabilityResult,
  origTimePref: string | null,       // raw Gemini field (user's language)
  origDatePref: string | null,       // raw Gemini field (user's language)
  normalizedTimePref: string | null, // normalizer output (for threshold calc)
  lang: Lang,
  svcCanonical: string | null,
): string {
  const svc = formatServiceNameForLanguage(svcCanonical ?? av.serviceName, lang);
  const datePhraseOnly = formatDatePhrase(origDatePref, lang);
  const timeDisplay = formatTimePreferenceForLanguage(origTimePref ?? normalizedTimePref, lang);
  const alternatives = formatSlotList(av.allSlotTimes, lang);

  // Determine whether the requested threshold exceeds business closing time.
  // Use authoritative WorkingHour data only — never slot-list inference.
  const threshold = extractAfterThresholdMinutes(origTimePref ?? normalizedTimePref);
  const closingMinutes = av.workingDayEnd ? timeToMinutes(av.workingDayEnd) : null;
  const preferenceExceedsHours =
    threshold !== null && closingMinutes !== null && threshold >= closingMinutes;

  const hebrew = lang === "he" || /[א-ת]/.test(datePhraseOnly + (origTimePref ?? ""));

  if (hebrew) {
    const dateIntro = datePhraseOnly ? `${datePhraseOnly} ` : "";
    let closingClause = "";
    if (preferenceExceedsHours && av.workingDayEnd) {
      // Authoritative: business hours from WorkingHour table
      closingClause = `, כי העסק פתוח עד ${av.workingDayEnd}`;
    }
    // No cautious fallback in Hebrew — simply omit the clause when unknown
    return (
      `${dateIntro}אין תורים פנויים ל${svc} ${timeDisplay}${closingClause}. ` +
      `יש שעות פנויות מוקדמות יותר כמו ${alternatives}. ` +
      `תרצה אחד מהם או שנבדוק יום אחר?`
    );
  }

  const dateClause = datePhraseOnly ? ` on ${datePhraseOnly}` : "";
  let closingClause = "";
  if (preferenceExceedsHours && av.workingDayEnd) {
    // Authoritative: business hours from WorkingHour table
    closingClause = `, because the business is open until ${to12h(av.workingDayEnd)}`;
  }
  // No cautious fallback — simply omit the clause when unknown
  return (
    `No ${svc} slots available ${timeDisplay}${dateClause}${closingClause}. ` +
    `Available earlier times: ${alternatives}. ` +
    `Would any of those work, or shall we check another day?`
  );
}

// ─── Availability count draft ──────────────────────────────────────────────────

function composeCountDraft(
  av: AvailabilityResult,
  lang: Lang,
  svcCanonical: string | null,
  origDate: string | null,
): string {
  const svc = formatServiceNameForLanguage(svcCanonical, lang);
  const datePhr = formatDatePhrase(origDate, lang);
  const isHe = lang === "he" || /[א-ת]/.test(datePhr);
  // Use filtered if available, otherwise all
  const slots = (av.filteredSlotTimes?.length ?? 0) > 0 ? av.filteredSlotTimes : (av.allSlotTimes ?? []);
  const count = slots.length;

  if (count === 0) {
    const prefix = datePhr ? (isHe ? `${datePhr} — ` : `On ${datePhr} — `) : "";
    return isHe
      ? `${prefix}אין תורים פנויים ל${svc}. תרצה לבדוק יום אחר?`
      : `${prefix}no slots available for ${svc}. Would you like to check another day?`;
  }

  const listed = formatSlotList(slots, lang);
  const label = isHe
    ? count >= 4 ? "יש זמינות טובה יחסית" : count <= 2 ? "יש מעט זמינות" : `יש ${count} תורים פנויים`
    : count >= 4 ? "Good availability" : count <= 2 ? "Limited availability" : `${count} slots available`;
  const slotWord = isHe ? (count === 1 ? "תור פנוי אחד" : `${count} תורים פנויים`) : `${count} slot${count === 1 ? "" : "s"}`;

  if (isHe) {
    const dateStr = datePhr ? `${datePhr} ` : "";
    return `${dateStr}יש ${slotWord} ל${svc}: ${listed}. ${label}. מה מתאים לך?`;
  }
  return `${datePhr ? datePhr + ": " : ""}${slotWord} for ${svc}: ${listed}. ${label}. Which works for you?`;
}

// ─── Availability draft ────────────────────────────────────────────────────────

function composeAvailabilityDraft(
  av: AvailabilityResult,
  lang: Lang,
  normalizedService: string | null,
  origDate: string | null,
  origTime: string | null,
  isCountQuery = false,
): string {
  const svcCanonical = av.serviceFound ? av.serviceName : (normalizedService ?? av.serviceName);

  // ── Count query: route to dedicated count draft ───────────────────────────────
  if (isCountQuery) {
    return composeCountDraft(av, lang, svcCanonical, origDate);
  }

  const svc = formatServiceNameForLanguage(svcCanonical, lang);

  // ── No slots at all ──────────────────────────────────────────────────────────
  if (av.noSlotsReason || av.allSlotTimes.length === 0) {
    const datePhr = formatDatePhrase(origDate, lang);
    if (lang === "he" || /[א-ת]/.test(datePhr)) {
      return `לצערנו, אין תורים פנויים ל${svc}${datePhr ? " " + datePhr : ""}. תרצה לבדוק יום אחר?`;
    }
    return `Sorry, there are no available slots for ${svc}${datePhr ? " on " + datePhr : ""}. Would you like to check another day?`;
  }

  // ── Filtered slots available ─────────────────────────────────────────────────
  if (av.filteredSlotTimes.length > 0) {
    const slotList = formatSlotList(av.filteredSlotTimes, lang);
    const dtPhrase = formatDateTimePhrase(origDate, origTime, lang);
    if (lang === "he" || /[א-ת]/.test(dtPhrase)) {
      return `יש תורים פנויים ל${svc}${dtPhrase ? " " + dtPhrase : ""} ב-${slotList}. מה מתאים לך?`;
    }
    return `Available ${svc} times${dtPhrase ? " " + dtPhrase : ""}: ${slotList}. Which works best for you?`;
  }

  // ── No filtered slots, but alternatives exist ────────────────────────────────
  return explainUnavailablePreference(av, origTime, origDate, av.filterApplied, lang, svcCanonical);
}

// ─── Services draft ────────────────────────────────────────────────────────────

function composeServicesDraft(
  services: ServiceResult[],
  intent: string,
  normalizedService: string | null,
  lang: Lang,
): string {
  const hebrew = lang === "he";

  if (services.length === 0) {
    return hebrew
      ? "מצטערים, אין לנו שירותים פעילים כרגע."
      : "Sorry, we have no active services at the moment.";
  }

  // Single service query (price check or booking ask)
  if (normalizedService && (intent === "ASK_PRICES" || intent === "BOOK_APPOINTMENT" || intent === "ASK_SERVICES")) {
    const target = normalizedService.toLowerCase().replace(/[+&]/g, "and").replace(/\s+/g, " ");
    const match = services.find((s) => {
      const n = s.name.toLowerCase().replace(/[+&]/g, "and").replace(/\s+/g, " ");
      return n === target || n.includes(target) || target.includes(n);
    });
    if (match) {
      const price = Number(match.price) % 1 === 0
        ? `₪${Math.round(Number(match.price))}`
        : `₪${match.price}`;
      const svc = formatServiceNameForLanguage(match.name, lang);
      return hebrew
        ? `${svc} עולה ${price} ולוקח בערך ${match.durationMinutes} דקות.`
        : `A ${svc} costs ${price} and takes about ${match.durationMinutes} minutes.`;
    }
  }

  // Full list
  const lines = services.map((s) => {
    const price = Number(s.price) % 1 === 0
      ? `₪${Math.round(Number(s.price))}`
      : `₪${s.price}`;
    const svc = formatServiceNameForLanguage(s.name, lang);
    return hebrew
      ? `${svc} — ${price} (${s.durationMinutes} דקות)`
      : `${svc} — ${price} (${s.durationMinutes} min)`;
  });

  return hebrew
    ? `אנחנו מציעים את השירותים הבאים:\n${lines.join("\n")}\n\nאיזה שירות תרצה?`
    : `We offer the following services:\n${lines.join("\n")}\n\nWhich would you like to book?`;
}

// ─── Business info draft ───────────────────────────────────────────────────────

const EN_TO_HE_DAY: Record<string, string> = {
  Sunday: "ראשון", Monday: "שני", Tuesday: "שלישי", Wednesday: "רביעי",
  Thursday: "חמישי", Friday: "שישי", Saturday: "שבת",
};

function composeBusinessInfoDraft(info: BusinessInfoResult, lang: Lang): string {
  const hebrew = lang === "he";
  const open = info.workingHours.filter((h) => !h.isClosed);
  const closed = info.workingHours.filter((h) => h.isClosed);

  if (hebrew) {
    const lines = open.map((h) => `יום ${EN_TO_HE_DAY[h.dayLabel] ?? h.dayLabel}: ${h.startTime}–${h.endTime}`);
    if (closed.length) lines.push(`${closed.map((h) => `יום ${EN_TO_HE_DAY[h.dayLabel] ?? h.dayLabel}`).join(", ")}: סגור`);
    return `שעות הפעילות שלנו:\n${lines.join("\n")}\n\nנשמח לראותך!`;
  }

  const lines = open.map((h) => `${h.dayLabel}: ${h.startTime}–${h.endTime}`);
  if (closed.length) lines.push(`${closed.map((h) => h.dayLabel).join(", ")}: Closed`);
  return `Our business hours:\n${lines.join("\n")}\n\nWe look forward to seeing you!`;
}

// ─── Customer appointments draft ───────────────────────────────────────────────

function composeCustomerAppointmentsDraft(
  res: CustomerAppointmentsResult,
  intent: string,
  lang: Lang,
): string {
  const hebrew = lang === "he";

  if (!res.customerFound) {
    return hebrew
      ? "לא מצאנו תורים עבור המספר הזה. האם אתה בטוח שהמספר נכון?"
      : "No booking history found for this phone number. Are you sure it's correct?";
  }
  if (res.appointments.length === 0) {
    return hebrew
      ? `${res.customerName}, אין לך תורים פעילים כרגע.`
      : `${res.customerName}, you have no upcoming appointments.`;
  }

  const action = intent === "CANCEL_APPOINTMENT"
    ? (hebrew ? "לבטל" : "cancel")
    : (hebrew ? "להזיז" : "reschedule");

  if (res.appointments.length === 1) {
    const a = res.appointments[0];
    const svc = formatServiceNameForLanguage(a.service, lang);
    return hebrew
      ? `מצאנו תור ל${svc} ב-${a.dateLabel} בשעה ${a.timeLabel}. האם תרצה ${action} את התור?`
      : `Found your ${svc} appointment on ${a.dateLabel} at ${a.timeLabel}. Would you like to ${action} it?`;
  }

  const list = res.appointments
    .map((a, i) => {
      const svc = formatServiceNameForLanguage(a.service, lang);
      return `${i + 1}. ${svc} — ${a.dateLabel} ${hebrew ? "בשעה" : "at"} ${a.timeLabel}`;
    })
    .join("\n");

  return hebrew
    ? `מצאנו ${res.appointments.length} תורים:\n${list}\n\nאיזה מהם תרצה ${action}?`
    : `Found ${res.appointments.length} upcoming appointments:\n${list}\n\nWhich one would you like to ${action}?`;
}

// ─── Main entry point ──────────────────────────────────────────────────────────

export function composeLlmResponse(
  toolRun: ToolRunResult | null,
  geminiRaw: GeminiStructuredOutput,
  norm: NormalizedFields,
  intent: string,
): string | null {
  if (!toolRun || toolRun.status !== "executed" || toolRun.result === null) {
    return null;
  }

  const lang = geminiRaw.language;
  const origDate = geminiRaw.datePreference;  // user's language (e.g. "מחר", "tomorrow")
  const origTime = geminiRaw.timePreference;  // user's language (e.g. "ערב", "evening")

  try {
    switch (toolRun.actualToolName) {
      case "checkAvailability":
        return composeAvailabilityDraft(
          toolRun.result as AvailabilityResult,
          lang,
          norm.service,
          origDate,
          origTime,
          (geminiRaw as { queryStyle?: string }).queryStyle === "count",
        );

      case "getServices":
        return composeServicesDraft(
          toolRun.result as ServiceResult[],
          intent,
          norm.service,
          lang,
        );

      case "getBusinessInfo":
        return composeBusinessInfoDraft(toolRun.result as BusinessInfoResult, lang);

      case "getCustomerAppointments":
        return composeCustomerAppointmentsDraft(
          toolRun.result as CustomerAppointmentsResult,
          intent,
          lang,
        );

      default:
        return null;
    }
  } catch {
    return null;
  }
}
