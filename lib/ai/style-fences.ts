// lib/ai/style-fences.ts
// Server-side only. PURE deterministic presentation fences — no DB, no Gemini.
//
// AI Settings Phase 1A: make owner PRESENTATION settings actually hold on EVERY outbound
// (Gemini-authored, canned/platform, reminders) by enforcing them deterministically at the
// outbound chokepoint — the report's lesson that "owner control becomes real exactly when it
// is fenced" (temp 0.7 ignores prompt-only style hints). Conservative by construction: links/
// URLs and required platform text are never broken, and an enforcement that would mangle the
// message falls back to keeping the safe original. These fences govern PRESENTATION only — never
// routing, booking/manage, grounding, reliability, or deterministic-mode behavior.

import type { AISettingsResponseLength } from "@/types/database";

// One emoji GRAPHEME: a base pictographic char plus any variation-selector / skin-tone / ZWJ
// continuation, matched as a single unit so a cap counts "🙂"/"👍🏽"/"👨‍👩‍👧" each as one.
const EMOJI_UNIT = /\p{Extended_Pictographic}(?:️|[\u{1F3FB}-\u{1F3FF}]|‍\p{Extended_Pictographic})*/gu;

/** Keeps at most `max` emojis; removes the rest. max<=0 strips all (== stripEmojis). */
export function enforceEmojiCap(text: string, max: number): string {
  if (!text) return text;
  let kept = 0;
  return text
    .replace(EMOJI_UNIT, (m) => { kept += 1; return kept <= max ? m : ""; })
    .replace(/ {2,}/g, " ")
    .trim();
}

// Conservative caps. Generous char budgets so a normal reply is untouched; trimming only ever
// happens at sentence boundaries and never when a URL is present.
const LENGTH_CAPS: Record<AISettingsResponseLength, { sentences: number; chars: number }> = {
  short: { sentences: 2, chars: 220 },
  medium: { sentences: 4, chars: 420 },
  long: { sentences: 8, chars: 900 },
};
const URL_RE = /https?:\/\//;

/**
 * Conservative length cap. NO-OP when: the text carries a URL/link (CTAs are sacred), or it's
 * already within the char budget. Otherwise keeps whole leading sentences up to the sentence +
 * char caps — never cuts mid-sentence, never mid-word, never a URL. If trimming would leave too
 * little, keeps the safe original. Governs plain explanatory text only.
 */
export function enforceLength(text: string, length: AISettingsResponseLength): string {
  if (!text) return text;
  if (URL_RE.test(text)) return text;                  // link/CTA present → never trim
  const cap = LENGTH_CAPS[length] ?? LENGTH_CAPS.medium;
  if (text.length <= cap.chars) return text;           // within budget → untouched
  const sentences = text.split(/(?<=[.!?…])\s+/);
  let out = "";
  let n = 0;
  for (const s of sentences) {
    if (n >= cap.sentences) break;
    if (out.length > 0 && (out.length + 1 + s.length) > cap.chars) break;
    out = out ? `${out} ${s}` : s;
    n += 1;
  }
  out = out.trim();
  return out.length >= 8 ? out : text;                 // too little left → keep safe original
}

const SAFE_FALLBACK = "אני כאן 🙂 אפשר לשאול אותי על העסק או לקבוע תור.";
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes owner-forbidden phrases (exact / near-exact substring, case-insensitive). NARROW by
 * design — no semantics. NEVER touches text that carries a URL/link (a booking/manage CTA or
 * platform-required line must survive an owner "avoid" rule). Tidies leftover punctuation; if the
 * removal mangles the message (empty / too short), returns a SAFE generic line instead. The owner's
 * avoid list can shape wording but can never strip required links or safety content.
 */
export function enforceForbiddenPhrases(text: string, phrases: string[]): string {
  if (!text || !phrases?.length) return text;
  if (URL_RE.test(text)) return text;                  // protect links / platform-required text
  let out = text;
  for (const raw of phrases) {
    const p = (raw ?? "").trim();
    if (p.length < 2) continue;
    out = out.replace(new RegExp(escapeRegExp(p), "gi"), "");
  }
  if (out === text) return text;                        // nothing matched → untouched
  out = out
    .replace(/ {2,}/g, " ")
    .replace(/\s+([,.!?…])/g, "$1")
    .replace(/^[\s,–-]+/, "")
    .trim();
  return out.replace(/\s/g, "").length >= 3 ? out : SAFE_FALLBACK; // mangled → safe fallback
}
