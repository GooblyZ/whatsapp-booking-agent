"use server";

import { getDefaultBusinessId } from "@/lib/config";
import { updateAISettings } from "@/lib/services/ai-settings";
import type {
  AISettingsTone,
  AISettingsResponseLength,
  AISettingsEmojiUsage,
} from "@/types/database";
import { redirect } from "next/navigation";

const ALLOWED_LANGUAGES = ["he", "en", "ar", "ru", "es", "fr"] as const;
type AllowedLanguage = typeof ALLOWED_LANGUAGES[number];

function safeLanguage(raw: unknown): AllowedLanguage {
  return ALLOWED_LANGUAGES.includes(raw as AllowedLanguage)
    ? (raw as AllowedLanguage)
    : "he";
}

function cleanText(raw: unknown, max: number): string | null {
  const s = (raw as string | null)?.trim();
  return s && s.length ? s.slice(0, max) : null;
}

export async function saveAISettingsAction(formData: FormData) {
  const businessId = getDefaultBusinessId();

  const { extendedPersisted } = await updateAISettings(businessId, {
    assistant_name:      (formData.get("assistant_name") as string)?.trim() || "עוזר",
    tone:                (formData.get("tone")            as AISettingsTone)             || "friendly",
    response_length:     (formData.get("response_length") as AISettingsResponseLength)   || "medium",
    emoji_usage:         (formData.get("emoji_usage")     as AISettingsEmojiUsage)       || "low",
    language:            safeLanguage(formData.get("language")),
    custom_instructions: cleanText(formData.get("custom_instructions"), 2000),
    // Persona depth (migration 008) — saved when the columns exist, else deferred.
    business_type:       cleanText(formData.get("business_type"), 120),
    persona_voice:       cleanText(formData.get("persona_voice"), 1000),
    things_to_avoid:     cleanText(formData.get("things_to_avoid"), 1000),
    // Unchecked checkboxes are absent from FormData → treated as false.
    ai_enabled:               formData.get("ai_enabled") === "on",
    faq_enabled:              formData.get("faq_enabled") === "on",
    intent_detection_enabled: formData.get("intent_detection_enabled") === "on",
  });

  // Surface when the advanced persona fields couldn't persist (migration 008 pending).
  redirect(`/dashboard/ai-assistant?saved=1${extendedPersisted ? "" : "&persona=deferred"}`);
}
