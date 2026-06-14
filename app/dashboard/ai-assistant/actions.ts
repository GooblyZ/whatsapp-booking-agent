"use server";

import { getDefaultBusinessId } from "@/lib/config";
import { updateAISettings } from "@/lib/services/ai-settings";
import { enhancePersonaDescription } from "@/lib/ai/persona-enhance";
import type {
  AISettingsResponseLength,
  AISettingsEmojiUsage,
  AISettingsGender,
} from "@/types/database";
import { redirect } from "next/navigation";

const ALLOWED_LANGUAGES = ["he", "en", "ar", "ru", "es", "fr"] as const;
type AllowedLanguage = typeof ALLOWED_LANGUAGES[number];

function safeLanguage(raw: unknown): AllowedLanguage {
  return ALLOWED_LANGUAGES.includes(raw as AllowedLanguage)
    ? (raw as AllowedLanguage)
    : "he";
}

const GENDERS = ["neutral", "female", "male"] as const;
function safeGender(raw: unknown): AISettingsGender {
  return GENDERS.includes(raw as AISettingsGender) ? (raw as AISettingsGender) : "neutral";
}

function cleanText(raw: unknown, max: number): string | null {
  const s = (raw as string | null)?.trim();
  return s && s.length ? s.slice(0, max) : null;
}

export async function saveAISettingsAction(formData: FormData) {
  const businessId = getDefaultBusinessId();

  const { fullyPersisted } = await updateAISettings(businessId, {
    // IDENTITY
    assistant_name:      (formData.get("assistant_name") as string)?.trim() || "עוזר",
    assistant_gender:    safeGender(formData.get("assistant_gender")),
    // WRITING STYLE (format)
    response_length:     (formData.get("response_length") as AISettingsResponseLength)   || "medium",
    emoji_usage:         (formData.get("emoji_usage")     as AISettingsEmojiUsage)       || "low",
    language:            safeLanguage(formData.get("language")),
    // PERSONALITY — the single natural-language voice authority.
    custom_instructions: cleanText(formData.get("custom_instructions"), 2000),
    // HARD RULES
    things_to_avoid:     cleanText(formData.get("things_to_avoid"), 1000),
    // Unchecked checkboxes are absent from FormData → treated as false.
    ai_enabled:               formData.get("ai_enabled") === "on",
    faq_enabled:              formData.get("faq_enabled") === "on",
    intent_detection_enabled: formData.get("intent_detection_enabled") === "on",
  });

  // Surface when a column couldn't persist (a pending migration, e.g. 010 gender).
  redirect(`/dashboard/ai-assistant?saved=1${fullyPersisted ? "" : "&persona=deferred"}`);
}

export type EnhanceState =
  | { status: "idle" }
  | { status: "done"; text: string }
  | { status: "error"; message: string };

/**
 * ✨ Enhance — rewrites the personality description (owner-initiated, settings-time).
 * Called directly from the client form; returns the improved text for the owner to
 * review/edit. Fail-soft: on any issue the UI keeps the original text.
 */
export async function enhancePersonaAction(current: string): Promise<EnhanceState> {
  const res = await enhancePersonaDescription(current ?? "");
  if (res.ok) return { status: "done", text: res.text };
  const message =
    res.reason === "empty"
      ? "כתוב/י תיאור קצר קודם, ואז אפשר לשפר אותו."
      : res.reason === "not_configured"
        ? "שירות ה-AI לא מוגדר כרגע — התיאור נשמר כפי שהוא."
        : "השיפור לא זמין כרגע — נסה/י שוב מאוחר יותר. התיאור שלך נשמר כפי שהוא.";
  return { status: "error", message };
}
