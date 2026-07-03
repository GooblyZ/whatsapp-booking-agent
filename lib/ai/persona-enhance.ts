// lib/ai/persona-enhance.ts
// Server-side only.
//
// "✨ Enhance" — an OWNER-INITIATED, settings-time helper that NORMALIZES a rough
// personality description into clean STYLE-INSTRUCTION language (the same register as
// the shipped presets: "הסגנון צריך להיות…"), preserving the owner's meaning and any
// wording they explicitly asked for. It is a normalizer, not a biographer: never a
// third-person character sketch ("היא תמיד נעימה…"), never invented traits. The owner
// reviews and edits the result before saving, so this never silently becomes the
// behavior authority: the description in the textbox is always the source of truth.
//
// This is NOT part of the customer messaging path — `lib/ai/brain.ts` remains the
// only per-turn Gemini call site. This runs only when the owner clicks the button
// in the dashboard. Fail-soft: on any error the caller keeps the original text.
//
// Uses the same single model + JSON-forced client as the rest of the app (no model
// or generation-config changes). Scope is deliberately narrow — VOICE only: never
// formatting (length/emoji), never hard rules, never business facts.

import { geminiGenerateJSON, isGeminiConfigured } from "./gemini";

const MAX_INPUT = 1500;
const MAX_OUTPUT = 600;

export type EnhanceResult =
  | { ok: true; text: string }
  | { ok: false; reason: "empty" | "not_configured" | "unavailable" };

const INSTRUCTION = [
  "You NORMALIZE a small-business owner's rough description of their WhatsApp assistant's PERSONALITY",
  "into clean STYLE-INSTRUCTION language an AI can follow. You are a normalizer, not a writer:",
  "preserve the owner's meaning and requested wording — only make it clearer, tighter, and prompt-ready.",
  "",
  "OUTPUT REGISTER — write like a style guide, never a biography. Use instruction forms such as:",
  '"הסגנון צריך להיות…", "התשובות צריכות להרגיש…", "הטון…", "להשתמש ב…", "להימנע מ…", "כדאי לשמור על…".',
  "",
  "Rules:",
  "- Hebrew, 2–4 short sentences, style-instruction phrasing ONLY.",
  '- NEVER a third-person character sketch ("היא תמיד…", "הוא תמיד…") and NEVER first-person ("אני…") —',
  "  the assistant's gender is a SEPARATE setting; describe the STYLE, not a person.",
  '- NEVER slash-gender forms ("חם/ה", "תרצה/י").',
  "- PRESERVE the owner's intent and any specific words/phrases they asked the assistant to use —",
  "  keep those verbatim. Do NOT invent traits, moods, or habits the owner didn't request.",
  "- Describe ONLY character, voice, attitude and how replies should feel to customers.",
  "- Do NOT mention message length, emojis, language, opening hours, prices, services, or any business facts.",
  '- Do NOT add prohibitions the owner didn\'t ask for; a style avoidance the OWNER requested may stay, phrased as "להימנע מ…".',
  "",
  'Output STRICT JSON only: {"description": "<the normalized style instructions>"}',
].join("\n");

/**
 * Rewrites a personality description. Never throws. Returns the improved text on
 * success, or a typed reason the caller can surface (then keep the original).
 */
export async function enhancePersonaDescription(raw: string): Promise<EnhanceResult> {
  const input = (raw ?? "").trim();
  if (!input) return { ok: false, reason: "empty" };
  if (!isGeminiConfigured()) return { ok: false, reason: "not_configured" };

  const res = await geminiGenerateJSON(INSTRUCTION, input.slice(0, MAX_INPUT));
  if (!res.ok) return { ok: false, reason: "unavailable" };

  const description = parseDescription(res.text);
  if (!description) return { ok: false, reason: "unavailable" };

  return { ok: true, text: description.slice(0, MAX_OUTPUT) };
}

function parseDescription(text: string): string | null {
  // The client forces application/json, but stay tolerant of stray fences.
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const obj = JSON.parse(cleaned) as { description?: unknown };
    const d = typeof obj.description === "string" ? obj.description.trim() : "";
    return d.length > 0 ? d : null;
  } catch {
    return null;
  }
}
