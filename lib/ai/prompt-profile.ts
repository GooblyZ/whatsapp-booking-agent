// lib/ai/prompt-profile.ts
// Server-side only. PURE — no DB, no Gemini, no network.
//
// AI Settings Phase 1A (gemini-prompt-influence report, Model D "Hybrid"):
// a single NORMALIZED owner-settings profile, built once from ai_settings, that the
// outbound enforcement fences and observability consume. It separates OWNER-CONFIGURABLE
// PRESENTATION (name, gender/voice, length, emoji, avoid phrases, style text, language)
// from PLATFORM-FIXED behavior (booking/manage routing, grounding, reliability, deterministic
// mode, provider policy) — which lives in code and is NOT represented here. Owner settings are
// an additive presentation layer; they must never become a system-behavior layer.
//
// The profile carries a deterministic, PRIVACY-SAFE hash of the normalized owner values (no
// phone, no message body, no full prompt) so any reply can be attributed to a settings version.

import { createHash } from "crypto";
import type { AISettings, AISettingsGender, AISettingsResponseLength, AISettingsEmojiUsage } from "@/types/database";

export interface PromptProfile {
  assistantName: string;
  assistantGender: AISettingsGender;           // "male" | "female" | "neutral"
  responseLength: AISettingsResponseLength;    // "short" | "medium" | "long"
  emojiUsage: AISettingsEmojiUsage;            // "none" | "low" | "medium"
  /** Max emojis allowed in an outbound message (none=0, low=1, medium=2). */
  emojiCap: number;
  customInstructions: string | null;           // style input only — never a hard behavior override
  thingsToAvoid: string[];                      // normalized owner "avoid" phrases (forbidden-phrase fence)
  language: string;                             // "he" default (single market)
  settingsVersion: string | null;              // = ai_settings.updated_at (no new column)
  promptProfileHash: string;                    // stable hash of the normalized OWNER values
}

// Product defaults — match the persona builder's defaults so the profile and the prompt agree.
const DEFAULT_NAME = "עוזר";
const DEFAULT_GENDER: AISettingsGender = "neutral";
const DEFAULT_LENGTH: AISettingsResponseLength = "medium";
const DEFAULT_EMOJI: AISettingsEmojiUsage = "low";
const DEFAULT_LANGUAGE = "he";

const GENDERS: AISettingsGender[] = ["male", "female", "neutral"];
const LENGTHS: AISettingsResponseLength[] = ["short", "medium", "long"];
const EMOJIS: AISettingsEmojiUsage[] = ["none", "low", "medium"];

/** Max emojis per outbound message for an emoji-usage level. */
export function emojiCapFor(usage: AISettingsEmojiUsage): number {
  return usage === "none" ? 0 : usage === "medium" ? 2 : 1; // none=0, medium=2, low(default)=1
}

/** Splits the free-text "things to avoid" field into trimmed candidate phrases (lines / ; / |).
 *  Commas are NOT split on — Hebrew avoid phrases often contain commas. */
export function parseThingsToAvoid(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n;|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/** Builds the normalized owner profile from ai_settings (a missing row / partial select → safe
 *  product defaults). Accepts a Partial row so the chokepoint can select only the columns it needs. */
export function buildPromptProfile(ai: Partial<AISettings> | null | undefined, businessId?: string): PromptProfile {
  const assistantName = ai?.assistant_name?.trim() || DEFAULT_NAME;
  const assistantGender = GENDERS.includes(ai?.assistant_gender as AISettingsGender)
    ? (ai!.assistant_gender as AISettingsGender) : DEFAULT_GENDER;
  const responseLength = LENGTHS.includes(ai?.response_length as AISettingsResponseLength)
    ? (ai!.response_length as AISettingsResponseLength) : DEFAULT_LENGTH;
  const emojiUsage = EMOJIS.includes(ai?.emoji_usage as AISettingsEmojiUsage)
    ? (ai!.emoji_usage as AISettingsEmojiUsage) : DEFAULT_EMOJI;
  const customInstructions = ai?.custom_instructions?.trim() || null;
  const thingsToAvoid = parseThingsToAvoid(ai?.things_to_avoid);
  const language = ai?.language?.trim() || DEFAULT_LANGUAGE;
  const settingsVersion = (typeof ai?.updated_at === "string" && ai.updated_at) || null;

  const profile: Omit<PromptProfile, "promptProfileHash"> = {
    assistantName, assistantGender, responseLength, emojiUsage,
    emojiCap: emojiCapFor(emojiUsage),
    customInstructions, thingsToAvoid, language, settingsVersion,
  };
  return { ...profile, promptProfileHash: hashProfile(profile, businessId) };
}

/**
 * Deterministic, privacy-safe hash of the normalized OWNER settings. Canonical key order so the
 * hash is stable across runs; includes businessId for per-tenant uniqueness in logs. Hashes ONLY
 * owner-setting values — NEVER a phone number, a customer message, or the full prompt. Runtime /
 * customer input does not enter the hash, so it stays stable across turns until the owner edits.
 */
export function hashProfile(p: Omit<PromptProfile, "promptProfileHash">, businessId?: string): string {
  const canonical = JSON.stringify([
    businessId ?? "",
    p.assistantName,
    p.assistantGender,
    p.responseLength,
    p.emojiUsage,
    p.customInstructions ?? "",
    p.thingsToAvoid,        // already normalized array (order preserved from owner input)
    p.language,
  ]);
  return createHash("sha1").update(canonical).digest("hex").slice(0, 12);
}
