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
  // וירטואלית ↔ וירטואלי (keep optional definite-ה AND an optional connective/spelling vav, so the
  // double-vav spelling "הווירטואלי" — used in the menu copy "העוזר הווירטואלי" — is also gendered;
  // otherwise the female fence left a mixed "העוזרת הווירטואלי").
  rules.push({ re: new RegExp(`${NB}(ה?ו?)${m ? "וירטואלית" : "וירטואלי"}${NA}`, "g"), to: `$1${m ? "וירטואלי" : "וירטואלית"}` });
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

// ── NEUTRAL voice (Phase 1A) ─────────────────────────────────────────────────────
// Hebrew has no genderless first-person present participle, so "be neutral" fails at the model
// level (report §8). Strategy = AVOIDANCE: rewrite a POSITIVE first-person gendered participle
// to an impersonal/plural-future equivalent that carries no gender. NEGATED forms ("אני לא יכול")
// are deliberately NOT matched — replacing the verb there would invert the meaning — so they are
// left to the prompt (a rare, safe leftover). Customer-directed phrasing is never touched.
const NEUTRAL_REPLACE: Record<string, string> = {
  "יכול": "אפשר", "יכולה": "אפשר",
  "שמח": "נשמח", "שמחה": "נשמח",
  "ממליץ": "מומלץ", "ממליצה": "מומלץ",
  "מציע": "מוצע", "מציעה": "מוצע",
  "יודע": "ידוע לי", "יודעת": "ידוע לי",
  "מבין": "מובן", "מבינה": "מובן",
  "בטוח": "בוודאי", "בטוחה": "בוודאי",
  "מצטער": "סליחה", "מצטערת": "סליחה",
  "מתנצל": "סליחה", "מתנצלת": "סליחה",
  "מסכים": "מקובל", "מסכימה": "מקובל",
};
// Positive-only adverbs (NO negation) between "אני" and the participle, so a negated form never matches.
const POS_ADV = "(?:כבר|עדיין|באמת|ממש|מאוד|כל כך|לגמרי|פשוט|כאן|תכף|אכן|בהחלט|אישית)";
const POS_GAP = `(?:\\s+${POS_ADV}){0,2}`;
const NEUTRAL_RULES: Rule[] = Object.entries(NEUTRAL_REPLACE).map(([form, to]) => ({
  re: new RegExp(`${NB}${ANI}${POS_GAP}\\s+${form}${NA}`, "g"),
  to, // replaces the «אני [adv] <form>» span; the tail (e.g. " לעזור") is preserved
}));

// ── NEUTRAL identity / person references ─────────────────────────────────────────
// The verb rules above only de-gender first-person PARTICIPLES ("אני שמח/יכול"). Manual testing
// showed the model ALSO genders its own IDENTITY — "אני העוזרת הווירטואלית של X", "אפשר להתייחס
// אליי כאל מישהי מהצוות", or, answering "בן או בת?", "אני בת". In NEUTRAL mode the assistant must
// not present ITSELF as a man or a woman, so its OWN self-reference is rewritten to non-personal,
// SERVICE-style wording ("זה הצ׳אט של X"). Every pattern is anchored to the assistant's SELF-
// reference (first-person "אני" or the virtual-assistant noun) and Hebrew-boundary protected, so
// customer references and unrelated lookalikes are never touched: "אחות"/"אחיות" (nurse), the
// honorific "גברת"/plural "גברים", "בן/בת זוג", and ages ("בן 30") all survive.
//
// SCOPE — this fence governs the assistant's SELF-gender ONLY. Customer-ADDRESS slang the owner may
// intentionally configure as persona style ("אחי", "גבר", "אחותי") is NOT a self-gender violation and
// is deliberately left untouched (so business/service text like "תספורת גבר", "שירות לגברים" also
// survives). Whether it's appropriate to address an unknown customer that way is a separate
// customer-address-policy concern (future AI Settings work), not this fence.
const NEUTRAL_IDENTITY = "זה הצ׳אט"; // non-personal, service-style: "this is the chat of <business>"
// SELF-IDENTITY CLASS (first-person). The model introduces itself with several gendered ROLE nouns,
// optionally followed by an identity QUALIFIER — a whole family, not one sentence:
//   "אני העוזרת הווירטואלית של X", "אני עוזרת הקבלה של X", "אני נציג השירות של X",
//   "אני המזכירה הדיגיטלית של X", "אני העוזר האישי של X".
const ROLE = "(?:עוזר(?:ת)?|נציג(?:ה|ת)?|מזכיר(?:ה|ת)?)"; // assistant / representative / secretary (incl. construct forms)
// An identity qualifier bound to the role: an adjective (optional definite-ה + the double-vav spelling
// of "הווירטואלי") OR a construct noun ("הקבלה"/"השירות"). The leading \s+ is part of each branch.
const ROLE_QUAL =
  "(?:\\s+ה?ו?(?:וירטואלי(?:ת)?|דיגיטלי(?:ת)?|אישי(?:ת)?|אוטומטי(?:ת)?)|\\s+ה?(?:קבלה|שירות))";
// A bounded ALLOWLIST of GENERIC business/establishment nouns — how a business refers to ITSELF, never
// industry/service vocab (so it stays business-agnostic). Rule 1b ONLY rewrites "אני <role> ה<entity>"
// against this fixed list, which makes it grammar-safe by construction: a verb + adverb/quantifier
// ("אני עוזר המון/הכי/הבוקר/הרבה יותר") can never match it, so no broken "זה הצ׳אט של המון" is possible.
// Extend this list to teach the fence a new business form — never widen it to an open-ended ה-word.
const ENTITY = "(?:עסק|סטודיו|מרפאה|מכון|מרכז|קליניקה|חברה|צוות|משרד|שירות|קבלה)";
const NEUTRAL_IDENTITY_RULES: Rule[] = [
  // 1) First-person self-IDENTITY as a CLASS → "זה הצ׳אט …" (the "של X" tail is preserved). Fires ONLY
  //    when "אני <role>" is unmistakably the identity NOUN: the role is DEFINITE ("אני ה<role> …"), OR
  //    carries an identity qualifier ("אני עוזרת הקבלה"), OR is followed by "של <business>". This
  //    deliberately never touches the VERB readings "אני עוזר/ת לך" (help) or "אני מזכיר/ה לך" (remind)
  //    — they have no ה, no qualifier and no "של", so none of the three branches match.
  { re: new RegExp(`${NB}${ANI}\\s+(?:ה${ROLE}${ROLE_QUAL}?|${ROLE}(?:${ROLE_QUAL}|(?=\\s+של)))${NA}`, "g"), to: NEUTRAL_IDENTITY },
  // 1b) SMIKHUT construct identity: "אני <role> ה<generic-business-noun>" → "זה הצ׳אט של <noun>" (the
  //    noun is PRESERVED, so it stays clean Hebrew): "אני עוזרת הסטודיו" → "זה הצ׳אט של הסטודיו",
  //    "אני נציגת הקליניקה" → "זה הצ׳אט של הקליניקה", "אני מזכירת המרכז" → "זה הצ׳אט של המרכז". CONSERVATIVE:
  //    only the fixed ENTITY allowlist matches, so verb+adverb phrases ("אני עוזר המון/הכי/הבוקר") are never
  //    rewritten. The word boundary (NA) keeps "העסק" from firing inside "העסקה" (a deal). The assistant
  //    verbs take ל ("עוזר/מזכיר ל…", handled by NEUTRAL_ACTION_RULES), so this never collides with them.
  { re: new RegExp(`${NB}${ANI}\\s+${ROLE}\\s+(ה${ENTITY})${NA}`, "g"), to: `${NEUTRAL_IDENTITY} של $1` },
  // 2) First-person gender DECLARATION (answer to "בן או בת?"): "אני בן/בת" → service wording. Guarded
  //    so "אני בן/בת זוג" and ages ("אני בן 30") are NEVER caught. ONLY the first-person self-statement
  //    is rewritten — "בן"/"בת" anywhere else (including customer-address) is left untouched.
  { re: new RegExp(`${NB}${ANI}\\s+(?:בן|בת)${NA}(?!\\s+זוג)(?!\\s*\\d)`, "g"), to: NEUTRAL_IDENTITY },
  // 3) Bare virtual-assistant noun (no "אני") — e.g. leaked/standalone identity copy → "הצ׳אט".
  { re: new RegExp(`${NB}ה?עוזר(?:ת)?\\s+ה?ו?וירטואלי(?:ת)?${NA}`, "g"), to: "הצ׳אט" },
  // 4) Degraded-state self-noun "העוזר/ת החכם/ה …" → neutral "הצ׳אט החכם …".
  { re: new RegExp(`${NB}ה?עוזר(?:ת)?\\s+החכ(?:ם|מה)${NA}`, "g"), to: "הצ׳אט החכם" },
  // 5) Self-as-"someone": "כ[אל] מישהו/מישהי …" → "כחלק …" (a genderless "as part of the team").
  { re: new RegExp(`${NB}כ(?:אל\\s+)?מישה[יו]${NA}`, "g"), to: "כחלק" },
];

// First-person gendered ACTION verbs that take a ל-OBJECT — "אני עוזר/ת לך" (help), "אני מזכיר/ה לך"
// (remind) — rewritten to neutral, impersonal action wording ("אפשר לעזור לך" / "אפשר להזכיר לך").
// GRAMMATICALITY GUARD: rewrite ONLY when the object is unmistakably a ל-PREPOSITION phrase that keeps
// "אפשר לעזור ל…" clean — a closed-class dative pronoun ("לך"/"לכם"/"לו"/"להם"…) OR a double-ל word
// (ל-prep + a ל-initial word: "ללקוח"/"ללקוחות"/"ללא"). A bare ל-INITIAL noun used as object
// ("אני עוזרת לקוחות") is single-ל and is deliberately NOT matched — rewriting it would yield the broken
// "אפשר לעזור לקוחות"; such ambiguous noun-role phrases are left unchanged. The ל-object lookahead also
// separates the VERB ("עוזר לך") from the identity NOUN ("עוזרת הקבלה"/"עוזר של X") and from third-party
// mentions. Narrow by design — only these two action verbs, first-person, before a clean ל-object.
const LAMED_DATIVE = "ל(?:הם|הן|כם|כן|נו|ך|ו|ה|י)"; // ל + pronoun suffix (to me/you/him/her/us/them)
const LAMED_OBJ = `(?:${LAMED_DATIVE}(?![${H}])|לל)`; // a whole-word dative pronoun OR a double-ל word
const NEUTRAL_ACTION_RULES: Rule[] = [
  { re: new RegExp(`${NB}${ANI}\\s+עוזר(?:ת)?(?=\\s+${LAMED_OBJ})`, "g"), to: "אפשר לעזור" },
  { re: new RegExp(`${NB}${ANI}\\s+מזכיר(?:ה)?(?=\\s+${LAMED_OBJ})`, "g"), to: "אפשר להזכיר" },
];

/** Rewrites POSITIVE first-person gendered self-references (participles + the help/remind action verbs)
 *  AND gendered identity/person phrasing to impersonal, service-style forms (neutral voice). Anchored to
 *  the assistant's own self-reference; customer-address slang is NOT touched. No-op when there's nothing
 *  to rewrite (good replies untouched). */
export function enforceNeutralVoice(text: string): string {
  if (!text) return text;
  let out = text;
  for (const r of NEUTRAL_RULES) out = out.replace(r.re, r.to);           // first-person participle verbs (שמח/יכול…)
  for (const r of NEUTRAL_ACTION_RULES) out = out.replace(r.re, r.to);    // first-person action verbs (עוזר/מזכיר ל…)
  for (const r of NEUTRAL_IDENTITY_RULES) out = out.replace(r.re, r.to);  // identity / person nouns
  return out.replace(/ {2,}/g, " ").trim();
}

/** Counts ANY first-person gendered participle ("אני …") — the neutral-mode scorer (target 0). */
export function countGenderedFirstPerson(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (const [m, f] of PAIRS) {
    if (m === f) continue;
    for (const form of [m, f]) {
      count += text.match(new RegExp(`${NB}${ANI}${GAP}\\s+${form}${NA}`, "g"))?.length ?? 0;
    }
  }
  return count;
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
