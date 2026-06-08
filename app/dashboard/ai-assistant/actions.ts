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

export async function saveAISettingsAction(formData: FormData) {
  const businessId    = getDefaultBusinessId();
  const customInstr   = (formData.get("custom_instructions") as string)?.trim();

  await updateAISettings(businessId, {
    assistant_name:      (formData.get("assistant_name") as string)?.trim() || "עוזר",
    tone:                (formData.get("tone")            as AISettingsTone)             || "friendly",
    response_length:     (formData.get("response_length") as AISettingsResponseLength)   || "medium",
    emoji_usage:         (formData.get("emoji_usage")     as AISettingsEmojiUsage)       || "low",
    language:            safeLanguage(formData.get("language")),
    custom_instructions: customInstr?.length ? customInstr : null,
  });

  redirect("/dashboard/ai-assistant?saved=1");
}
