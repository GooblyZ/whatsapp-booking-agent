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
  // Persona depth (migration 008) — may not exist in the DB yet.
  business_type?: string | null;
  persona_voice?: string | null;
  things_to_avoid?: string | null;
  // AI control toggles — disabling never affects the booking flow.
  ai_enabled?: boolean;
  faq_enabled?: boolean;
  intent_detection_enabled?: boolean;
}

/** Columns that have existed since before the persona-depth migration. */
const CORE_KEYS = [
  "assistant_name", "tone", "response_length", "emoji_usage", "language",
  "custom_instructions", "ai_enabled", "faq_enabled", "intent_detection_enabled",
] as const;

/** Columns added by migration 008 — absent until the owner applies it. */
const EXTENDED_KEYS = ["business_type", "persona_voice", "things_to_avoid"] as const;

/** True when the DB rejected an unknown column (migration 008 not applied yet). */
function isMissingColumnError(error: { code?: string; message?: string }): boolean {
  if (error.code === "PGRST204" || error.code === "42703") return true;
  const msg = error.message ?? "";
  return /column/i.test(msg) && /(schema cache|does not exist)/i.test(msg);
}

/**
 * Upserts AI settings. Strangler-safe: attempts the full payload, and if the DB
 * rejects an unknown persona-depth column (migration 008 not yet applied),
 * retries with only the core columns so the dashboard never breaks. Returns
 * whether the extended persona fields were actually persisted.
 */
export async function updateAISettings(
  businessId: string,
  data: UpdateAISettingsInput
): Promise<{ extendedPersisted: boolean }> {
  const db = supabaseServer();
  const sentExtended = EXTENDED_KEYS.some((k) => k in data);

  const { error } = await db
    .from("ai_settings")
    .upsert({ business_id: businessId, ...data }, { onConflict: "business_id" });

  if (!error) return { extendedPersisted: sentExtended };

  if (sentExtended && isMissingColumnError(error)) {
    const core: Record<string, unknown> = { business_id: businessId };
    for (const k of CORE_KEYS) if (k in data) core[k] = (data as Record<string, unknown>)[k];
    const { error: retryError } = await db
      .from("ai_settings")
      .upsert(core, { onConflict: "business_id" });
    if (retryError) throw new Error(retryError.message);
    console.warn("[ai-settings] persona-depth columns not present — saved core settings only (apply migration 008)");
    return { extendedPersisted: false };
  }

  throw new Error(error.message);
}
