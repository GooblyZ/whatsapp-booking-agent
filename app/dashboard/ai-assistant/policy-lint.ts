// app/dashboard/ai-assistant/policy-lint.ts
// PURE, UI-ONLY advisory heuristic (Phase A0). Detects text in the STYLE fields
// (personality / "things to avoid") that reads like a business RULE or FACT rather
// than wording/tone guidance — so the dashboard can gently nudge the owner to put it
// in the Knowledge Base instead.
//
// Strictly advisory: it NEVER blocks saving, NEVER edits the owner's text, and is NOT
// imported by the runtime or the Gemini prompt compiler. No React — safe to unit-test.
//
// AI Settings are presentation/style only; business facts (prices, services, hours) and
// policy (who is accepted, appointment/cancellation rules) belong in the Knowledge Base /
// Business Rules and must not live in a free-text style field.

// Terms that signal business policy/facts rather than style. Singular roots are matched as
// substrings so e.g. "מחיר" also catches "מחירים". "לקוחות"/"שירותים" are kept in their
// plural form on purpose, so a normal style mention of a single customer ("הלקוח") does NOT trip.
export const POLICY_LINT_TERMS = [
  "מחיר", "מחירים", "כסף", "הנחה", "תור", "תורים", "לקוחות",
  "לא לקבל", "לא לקבוע", "לא להציע", "ביטול", "שירות", "שירותים",
] as const;

/** Returns the policy-like terms found in the text (empty = looks like clean style guidance). */
export function flagsBusinessPolicy(text: string | null | undefined): string[] {
  const t = (text ?? "").trim();
  if (t.length === 0) return [];
  return POLICY_LINT_TERMS.filter((term) => t.includes(term));
}
