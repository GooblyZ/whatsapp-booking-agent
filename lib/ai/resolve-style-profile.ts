// lib/ai/resolve-style-profile.ts
// Server-safe, PURE — no DB, no Gemini, no network. NOT imported by the runtime or the live prompt yet
// (Phase B1 foundation only).
//
// This is the FUTURE single source of truth for presentation STYLE. It compiles the owner's AI Settings
// (the detected preset + the explicit emoji/length/language controls + free-text style notes) into ONE
// structured, non-contradictory ResolvedStyleProfile. In this phase it is foundation only: persona.ts and
// the live profileHash (lib/ai/prompt-profile.ts) are UNTOUCHED. Phase B2 will emit one compact prompt
// block from this and switch the hash over, behind an eval + a deliberate §47 shell-hash update.
//
// STYLE-ONLY: this resolver describes only HOW the assistant speaks. It never encodes routing, booking,
// facts, prices, appointment/cancellation rules, or any platform behavior — those live in code and the
// Knowledge Base and always win over style.

import { createHash } from "crypto";
import type { AISettings, AISettingsEmojiUsage, AISettingsResponseLength } from "@/types/database";
import { PERSONA_PRESETS } from "./persona-presets";
import { emojiCapFor } from "./prompt-profile";

export type StylePreset = "warm" | "professional" | "casual" | "premium" | "concise" | "custom" | "default";
export type RegisterLevel = "refined" | "formal" | "plain" | "casual";

/** 1–5 style dimensions (1 = low, 5 = high). */
export interface StyleVector {
  formality: number;
  warmth: number;
  energy: number;
  brevity: number;
}

export type StyleWarningKind = "emoji_override" | "length_override" | "policy_in_style_notes";
export interface StyleWarning {
  kind: StyleWarningKind;
  detail: string;
}

export interface ResolvedStyleProfile {
  /** Detected from custom_instructions (an exact shipped-preset match), or "custom"/"default". */
  preset: StylePreset;
  /** formality/warmth/energy come from the preset; brevity is resolved from the explicit length control. */
  vector: StyleVector;
  emojiUsage: AISettingsEmojiUsage;        // the explicit persisted value
  emojiCap: number;                        // 0|1|2 resolved from emojiUsage
  responseLength: AISettingsResponseLength; // the explicit persisted value
  register: RegisterLevel;
  addressing: "neutral";                   // toward the customer (assistant self-gender is a separate concern)
  language: string;
  styleNotes: string | null;               // free-text STYLE guidance (custom_instructions when NOT a known preset)
  /** True when the explicit control differs from the detected preset's default (a deliberate override). */
  overrides: { emoji: boolean; length: boolean };
  /** Non-blocking advisory/conflict metadata. Never rewrites or drops the owner's text. */
  warnings: StyleWarning[];
  /** Stable hash of the RESOLVED style (semantic fields only). NOT the live runtime profileHash. */
  resolvedHash: string;
}

export interface PresetStyleDefault {
  formality: number;
  warmth: number;
  energy: number;
  emoji: AISettingsEmojiUsage;
  length: AISettingsResponseLength;
  register: RegisterLevel;
}

// Structured vectors for the shipped presets (keys = persona-presets.ts ids). These are the DEFAULTS a
// preset implies; the explicit emoji/length controls can still override them (recorded in `overrides`).
// Vertical-neutral and STYLE-ONLY — they describe tone, never business behavior.
export const PRESET_STYLE_DEFAULTS: Record<Exclude<StylePreset, "custom" | "default">, PresetStyleDefault> = {
  warm:         { formality: 3, warmth: 5, energy: 3, emoji: "low",  length: "medium", register: "plain"   }, // חמים ומזמין
  professional: { formality: 4, warmth: 3, energy: 2, emoji: "none", length: "medium", register: "formal"  }, // מקצועי ורגוע
  casual:       { formality: 2, warmth: 4, energy: 4, emoji: "low",  length: "medium", register: "casual"  }, // צעיר וקליל
  premium:      { formality: 5, warmth: 3, energy: 2, emoji: "none", length: "medium", register: "refined" }, // יוקרתי ומוקפד
  concise:      { formality: 3, warmth: 3, energy: 2, emoji: "none", length: "short",  register: "plain"   }, // ענייני וקצר
};
const NEUTRAL_DEFAULT: PresetStyleDefault = { formality: 3, warmth: 3, energy: 3, emoji: "low", length: "medium", register: "plain" };

const VALID_EMOJI: AISettingsEmojiUsage[] = ["none", "low", "medium"];
const VALID_LENGTH: AISettingsResponseLength[] = ["short", "medium", "long"];

/** short→5, medium→3, long→1 (higher = more brief). */
function brevityForLength(len: AISettingsResponseLength): number {
  return len === "short" ? 5 : len === "long" ? 1 : 3;
}

/** Detect which shipped preset (if any) currently seeds custom_instructions — exact trimmed match. A known
 *  preset is represented by its structured vector; an edited/own description becomes "custom"; empty → "default". */
function detectPreset(customInstructions: string | null): StylePreset {
  const t = (customInstructions ?? "").trim();
  if (t.length === 0) return "default";
  const hit = PERSONA_PRESETS.find((p) => p.text.trim() === t);
  if (hit && hit.id in PRESET_STYLE_DEFAULTS) return hit.id as StylePreset;
  return "custom";
}

export interface ResolveStyleOptions {
  /** OPTIONAL policy detector (the Phase A0 lint can be injected). Keeps this resolver DECOUPLED from the
   *  dashboard module: when provided and styleNotes reads like business policy, a non-blocking advisory
   *  warning is recorded. It NEVER rewrites, drops, or blocks the owner's text. */
  detectPolicy?: (text: string) => string[];
}

/**
 * Compiles AI Settings into ONE resolved style profile. PURE + fail-open: missing/invalid settings fall
 * back to safe neutral defaults. Does NOT touch the runtime prompt or the live profileHash (Phase B1).
 */
export function resolveStyleProfile(
  ai: Partial<AISettings> | null | undefined,
  opts: ResolveStyleOptions = {}
): ResolvedStyleProfile {
  const customInstructions = ai?.custom_instructions?.trim() || null;
  const preset = detectPreset(customInstructions);
  const def = preset === "custom" || preset === "default" ? NEUTRAL_DEFAULT : PRESET_STYLE_DEFAULTS[preset];

  const emojiUsage = VALID_EMOJI.includes(ai?.emoji_usage as AISettingsEmojiUsage)
    ? (ai!.emoji_usage as AISettingsEmojiUsage)
    : def.emoji;
  const responseLength = VALID_LENGTH.includes(ai?.response_length as AISettingsResponseLength)
    ? (ai!.response_length as AISettingsResponseLength)
    : def.length;
  const language = ai?.language?.trim() || "he";

  // styleNotes = the owner's free-text voice ONLY when it isn't a known preset (a known preset is already
  // represented structurally by its vector, so its seed text is not double-counted as notes).
  const styleNotes = preset === "custom" ? customInstructions : null;

  const overrides = {
    emoji: emojiUsage !== def.emoji,
    length: responseLength !== def.length,
  };

  const warnings: StyleWarning[] = [];
  if (overrides.emoji) warnings.push({ kind: "emoji_override", detail: `emoji '${emojiUsage}' overrides preset default '${def.emoji}'` });
  if (overrides.length) warnings.push({ kind: "length_override", detail: `length '${responseLength}' overrides preset default '${def.length}'` });
  if (styleNotes && opts.detectPolicy) {
    const hits = opts.detectPolicy(styleNotes);
    if (hits.length > 0) warnings.push({ kind: "policy_in_style_notes", detail: `style notes contain business-policy terms (belongs in Knowledge Base): ${hits.join(", ")}` });
  }

  const vector: StyleVector = {
    formality: def.formality,
    warmth: def.warmth,
    energy: def.energy,
    brevity: brevityForLength(responseLength),
  };

  const profile: Omit<ResolvedStyleProfile, "resolvedHash"> = {
    preset,
    vector,
    emojiUsage,
    emojiCap: emojiCapFor(emojiUsage),
    responseLength,
    register: def.register,
    addressing: "neutral",
    language,
    styleNotes,
    overrides,
    warnings,
  };
  return { ...profile, resolvedHash: hashResolvedStyle(profile) };
}

/**
 * Stable, privacy-safe hash of the RESOLVED style — SEMANTIC style fields only. `warnings` are derived
 * advisory metadata and are excluded, so two profiles that differ only in derived warnings still hash the
 * same. NOTE: unlike the live `promptProfileHash`, this excludes identity fields like assistant_name — a
 * name change is NOT a style change, so it must not move the style hash. Phase B1 demonstration only; this
 * is NOT yet the runtime hash. No phone, no message, no full prompt ever enters the hash.
 */
export function hashResolvedStyle(p: Omit<ResolvedStyleProfile, "resolvedHash">): string {
  const canonical = JSON.stringify([
    p.preset,
    p.vector.formality, p.vector.warmth, p.vector.energy, p.vector.brevity,
    p.emojiCap, p.responseLength, p.register, p.addressing, p.language,
    p.styleNotes ?? "",
    p.overrides.emoji, p.overrides.length,
  ]);
  return createHash("sha1").update(canonical).digest("hex").slice(0, 12);
}
