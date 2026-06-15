// lib/ai/gender.ts
// Server-side only. PURE text helpers — no DB, no Gemini.
//
// Deterministic assistant SELF-REFERENCE gender enforcement. Hebrew is gendered,
// so a prompt instruction ("speak about yourself in masculine Hebrew") loses at
// temperature 0.7 — especially when the owner's personality text and the
// assistant's NAME imply the opposite gender (live case: name "מנילה" + a
// feminine personality description, with assistant_gender=male → the model
// drifted "אני שמח" → "אני יודעת" → "אני מבינה" within one conversation).
//
// This makes the OWNER'S assistant_gender the FINAL authority: applied at the
// outbound chokepoint, it rewrites the assistant's own gendered forms to the
// configured gender regardless of what the model produced or what history/persona
// pulled toward. It NEVER touches references to the CUSTOMER (those stay
// neutral/mirrored) — every rule is anchored to first-person ("אני …") or to
// unambiguous assistant nouns.

import type { AISettingsGender } from "@/types/database";

// Hebrew Unicode block, used as a "Hebrew word boundary" (JS \b doesn't work on
// Hebrew letters). Explicit codepoints — never literal glyphs.
const H = `${String.fromCharCode(0x0590)}-${String.fromCharCode(0x05ff)}`;
const NB = `(?<![${H}])`; // no Hebrew letter before
const NA = `(?![${H}])`;  // no Hebrew letter after
// Words that may sit between "אני" and the participle ("אני כבר לא יודעת").
const ADV = "(?:לא|כבר|עדיין|באמת|ממש|מאוד|כל כך|לגמרי|פשוט|כאן|תכף|אכן|בהחלט|אישית)";
const GAP = `(?:\\s+${ADV}){0,2}`;
// First-person "אני", allowing the common attached prefixes ש/ו/כ ("שאני", "ואני",
// "כשאני") — e.g. the boundary line "נראה שאני לא מצליחה…".
const ANI = "[שוכ]{0,2}אני";

// [masculine, feminine] first-person assistant participles. Same-on-both forms are
// intentionally excluded (nothing to correct).
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["שמח", "שמחה"], ["יודע", "יודעת"], ["מבין", "מבינה"], ["יכול", "יכולה"],
  ["מתנצל", "מתנצלת"], ["מצטער", "מצטערת"], ["בטוח", "בטוחה"], ["חושב", "חושבת"],
  ["ממליץ", "ממליצה"], ["מציע", "מציעה"], ["מעדיף", "מעדיפה"], ["מסכים", "מסכימה"],
  ["זוכר", "זוכרת"], ["מדבר", "מדברת"], ["כותב", "כותבת"], ["שולח", "שולחת"],
  ["מקבל", "מקבלת"], ["מתכוון", "מתכוונת"], ["צריך", "צריכה"], ["מצליח", "מצליחה"],
];

interface Rule { re: RegExp; to: string }

/** Builds the wrong→right rewrite rules for a target gender. */
function rulesFor(target: "male" | "female"): Rule[] {
  const rules: Rule[] = [];
  for (const [m, f] of PAIRS) {
    if (m === f) continue;
    const wrong = target === "male" ? f : m;
    const right = target === "male" ? m : f;
    // 1) First-person, the dominant drift form: "[ש/ו/כ]אני [adv] <wrong>".
    rules.push({ re: new RegExp(`${NB}(${ANI}${GAP}\\s+)${wrong}${NA}`, "g"), to: `$1${right}` });
    // 2) Opener helper phrase without "אני": "<wrong> לעזור/לסייע…".
    rules.push({ re: new RegExp(`${NB}${wrong}(\\s+(?:לעזור|לסייע|לשרת|לעמוד\\s+לרשות))`, "g"), to: `${right}$1` });
  }
  // 3) Assistant nouns/adjectives (always about the assistant).
  const m = target === "male";
  // העוזרת ↔ העוזר (keep optional ה)
  rules.push({ re: new RegExp(`${NB}(ה?)${m ? "עוזרת" : "עוזר"}${NA}`, "g"), to: `$1${m ? "עוזר" : "עוזרת"}` });
  // וירטואלית ↔ וירטואלי (keep optional ה)
  rules.push({ re: new RegExp(`${NB}(ה?)${m ? "וירטואלית" : "וירטואלי"}${NA}`, "g"), to: `$1${m ? "וירטואלי" : "וירטואלית"}` });
  return rules;
}

const RULES_MALE = rulesFor("male");
const RULES_FEMALE = rulesFor("female");

/**
 * Rewrites the assistant's own gendered forms to the configured gender. No-op for
 * "neutral"/undefined (preserves the pre-existing behavior). Customer-directed
 * phrasing is never touched (rules are first-person / assistant-noun anchored).
 */
export function enforceAssistantGender(text: string, gender: AISettingsGender | undefined): string {
  if (!text || (gender !== "male" && gender !== "female")) return text;
  const rules = gender === "male" ? RULES_MALE : RULES_FEMALE;
  let out = text;
  for (const r of rules) out = out.replace(r.re, r.to);
  return out;
}

/**
 * Counts assistant self-reference forms still in the WRONG gender — used by the
 * validation suite to assert zero drift after enforcement.
 */
export function countWrongGenderForms(text: string, gender: AISettingsGender | undefined): number {
  if (!text || (gender !== "male" && gender !== "female")) return 0;
  let count = 0;
  for (const [mForm, fForm] of PAIRS) {
    if (mForm === fForm) continue;
    const wrong = gender === "male" ? fForm : mForm;
    const afterAni = new RegExp(`${NB}${ANI}${GAP}\\s+${wrong}${NA}`, "g");
    const opener = new RegExp(`${NB}${wrong}\\s+(?:לעזור|לסייע|לשרת)`, "g");
    count += (text.match(afterAni)?.length ?? 0) + (text.match(opener)?.length ?? 0);
  }
  const wrongNoun = gender === "male" ? "עוזרת" : "עוזר";
  count += (text.match(new RegExp(`${NB}ה?${wrongNoun}${NA}`, "g"))?.length ?? 0);
  return count;
}
