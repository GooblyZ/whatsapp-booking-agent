// lib/ai/persona-enhance.ts
// Server-side only.
//
// "✨ Enhance" — an OWNER-INITIATED, settings-time helper that rewrites a rough
// personality description into a clearer, richer one. The owner reviews and edits
// the result before saving, so this never silently becomes the behavior authority:
// the description in the textbox is always the source of truth.
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
  "You help a small-business owner describe their WhatsApp receptionist's PERSONALITY.",
  "Rewrite the owner's rough description into a clear, vivid, natural one that an AI can act on.",
  "",
  "Rules:",
  "- Write in Hebrew, 2–4 short sentences, in the owner's voice describing the receptionist.",
  "- Describe ONLY character, voice, attitude and how it treats customers.",
  "- Do NOT mention message length, emojis, language, opening hours, prices, services, or any business facts.",
  "- Do NOT add prohibitions or rules (those live elsewhere).",
  "- Keep the owner's original intent; enrich and clarify it, don't replace it.",
  "- Gender-neutral toward the customer (e.g. \"מתאים לך\"), unless the owner specified otherwise.",
  "",
  'Output STRICT JSON only: {"description": "<the improved description>"}',
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
