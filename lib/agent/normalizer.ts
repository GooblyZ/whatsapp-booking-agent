// Normalizes Hebrew/natural-language Gemini output fields into values the
// existing tool-runner and slot-filter infrastructure already understands.

// ─── Service normalization ─────────────────────────────────────────────────────

// Ordered: compound entries MUST come before their component words.
const SERVICE_MAP: [RegExp, string][] = [
  [/תספורת\s*(ו|[+&])\s*זקן/i,           "Haircut + Beard"],
  [/haircut\s*(and|[+&])\s*beard/i,      "Haircut + Beard"],
  [/haircut\s*\+\s*beard/i,              "Haircut + Beard"],
  [/תספורת\s*\+\s*זקן/i,                 "Haircut + Beard"],
  [/עיצוב\s*זקן/i,                       "Beard"],
  [/beard\s*trim/i,                      "Beard"],
  [/^זקן$/i,                             "Beard"],
  [/^beard$/i,                           "Beard"],
  [/תספורת\s*לילדים/i,                   "Kids Haircut"],
  [/kids?\s*haircut/i,                   "Kids Haircut"],
  [/^תספורת$/i,                          "Haircut"],
  [/^haircut$/i,                         "Haircut"],
];

export function normalizeService(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  for (const [pattern, canonical] of SERVICE_MAP) {
    if (pattern.test(trimmed)) return canonical;
  }
  // Return the original value — resolveServiceByName in tools.ts has its own
  // fuzzy fallback and will handle unknown values gracefully.
  return trimmed;
}

// ─── Date normalization ────────────────────────────────────────────────────────

// Maps Hebrew/mixed date expressions to the English labels that
// resolveDatePreference() in tool-runner.ts already handles.
const DATE_MAP: [RegExp, string][] = [
  [/^מחרתיים$|^מחרת יום מחר$/,       "day after tomorrow"],
  [/^מחר$/,                            "tomorrow"],
  [/^היום$/,                           "today"],
  [/^שבוע הבא$/,                       "next week"],
  // Days with ביום / יום prefix
  [/^(ביום\s+|יום\s+)?ראשון$/,        "Sunday"],
  [/^(ביום\s+|יום\s+)?שני$/,          "Monday"],
  [/^(ביום\s+|יום\s+)?שלישי$/,        "Tuesday"],
  [/^(ביום\s+|יום\s+)?רביעי$/,        "Wednesday"],
  [/^(ביום\s+|יום\s+)?חמישי$/,        "Thursday"],
  [/^(ביום\s+|יום\s+)?שישי$/,         "Friday"],
  [/^(ביום\s+|יום\s+)?שבת$/,          "Saturday"],
  // "שישי הבא" / "יום שישי הבא"
  [/^(ביום\s+|יום\s+)?ראשון\s+הבא$/,  "next Sunday"],
  [/^(ביום\s+|יום\s+)?שני\s+הבא$/,    "next Monday"],
  [/^(ביום\s+|יום\s+)?שלישי\s+הבא$/,  "next Tuesday"],
  [/^(ביום\s+|יום\s+)?רביעי\s+הבא$/,  "next Wednesday"],
  [/^(ביום\s+|יום\s+)?חמישי\s+הבא$/,  "next Thursday"],
  [/^(ביום\s+|יום\s+)?שישי\s+הבא$/,   "next Friday"],
  [/^(ביום\s+|יום\s+)?שבת\s+הבא$/,    "next Saturday"],
];

export function normalizeDatePreference(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  for (const [pattern, english] of DATE_MAP) {
    if (pattern.test(trimmed)) return english;
  }
  // Already English — pass through unchanged.
  return trimmed;
}

// ─── Time normalization ────────────────────────────────────────────────────────

// Maps Hebrew/mixed time expressions to English labels that
// filterSlotsByPreference() in tools.ts already handles.
export function normalizeTimePreference(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim();

  // "אחרי N" / "אחרי N:00" → "after N"
  const afterHe = t.match(/^אחרי\s+(\d{1,2}(?::\d{2})?)$/);
  if (afterHe) return `after ${afterHe[1]}`;

  // "בשעה N" → "at N"
  const atHe = t.match(/^בשעה\s+(\d{1,2}(?::\d{2})?)$/);
  if (atHe) return `at ${atHe[1]}`;

  // "ב-N:00" → "at N:00"
  const atDash = t.match(/^ב-(\d{1,2}:\d{2})$/);
  if (atDash) return `at ${atDash[1]}`;

  // Named periods
  if (/^(ערב|בערב)$/.test(t)) return "evening";
  if (/^(בוקר|בבוקר)$/.test(t)) return "morning";
  if (/^(צהריים|בצהריים)$/.test(t)) return "afternoon";
  if (/^(לילה|בלילה)$/.test(t)) return "night";

  // Already English — pass through.
  return t;
}

// ─── Convenience bundle ────────────────────────────────────────────────────────

export interface NormalizedFields {
  service: string | null;
  datePreference: string | null;
  timePreference: string | null;
}

export function normalizeGeminiFields(
  service: string | null,
  datePreference: string | null,
  timePreference: string | null,
): NormalizedFields {
  return {
    service: normalizeService(service),
    datePreference: normalizeDatePreference(datePreference),
    timePreference: normalizeTimePreference(timePreference),
  };
}
