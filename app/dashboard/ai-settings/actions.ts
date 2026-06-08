"use server";

import { getDefaultBusinessId } from "@/lib/config";
import { updateAISettings } from "@/lib/services/ai-settings";
import type {
  AISettingsTone,
  AISettingsResponseLength,
  AISettingsEmojiUsage,
} from "@/types/database";
import { revalidatePath } from "next/cache";

export async function saveAISettingsAction(formData: FormData) {
  const businessId = getDefaultBusinessId();

  await updateAISettings(businessId, {
    assistant_name:
      (formData.get("assistant_name") as string) || "Assistant",
    tone: (formData.get("tone") as AISettingsTone) || "friendly",
    response_length:
      (formData.get("response_length") as AISettingsResponseLength) || "medium",
    emoji_usage:
      (formData.get("emoji_usage") as AISettingsEmojiUsage) || "low",
    language: (formData.get("language") as string) || "en",
    custom_instructions:
      (formData.get("custom_instructions") as string) || null,
  });

  revalidatePath("/dashboard/ai-settings");
}
