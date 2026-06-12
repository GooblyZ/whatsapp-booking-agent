import { supabaseServer } from "@/lib/supabase/server";
import type {
  AISettings,
  AISettingsTone,
  AISettingsResponseLength,
  AISettingsEmojiUsage,
} from "@/types/database";

export async function getAISettings(businessId: string): Promise<AISettings | null> {
  const db = supabaseServer();
  const { data } = await db
    .from("ai_settings")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();
  return data as AISettings | null;
}

export interface UpdateAISettingsInput {
  assistant_name?: string;
  tone?: AISettingsTone;
  response_length?: AISettingsResponseLength;
  emoji_usage?: AISettingsEmojiUsage;
  language?: string;
  custom_instructions?: string | null;
  // AI control toggles — disabling never affects the booking flow.
  ai_enabled?: boolean;
  faq_enabled?: boolean;
  intent_detection_enabled?: boolean;
}

export async function updateAISettings(
  businessId: string,
  data: UpdateAISettingsInput
): Promise<void> {
  const db = supabaseServer();
  const { error } = await db
    .from("ai_settings")
    .upsert(
      { business_id: businessId, ...data },
      { onConflict: "business_id" }
    );
  if (error) throw new Error(error.message);
}
