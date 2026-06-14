import { supabaseServer } from "@/lib/supabase/server";
import type {
  AISettings,
  AISettingsResponseLength,
  AISettingsEmojiUsage,
  AISettingsGender,
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
  // IDENTITY
  assistant_name?: string;
  assistant_gender?: AISettingsGender;
  // WRITING STYLE (format)
  response_length?: AISettingsResponseLength;
  emoji_usage?: AISettingsEmojiUsage;
  language?: string;
  // PERSONALITY — the single natural-language voice authority.
  custom_instructions?: string | null;
  // HARD RULES
  things_to_avoid?: string | null;
  // AI control toggles — disabling never affects the booking flow.
  ai_enabled?: boolean;
  faq_enabled?: boolean;
  intent_detection_enabled?: boolean;
  // NOTE: `tone` and `business_type` are intentionally NOT writable — they are
  // retired from the UI/persona (read-only back-compat columns only).
}

/** Recognizes a Postgres/PostgREST "unknown column" rejection (migration not applied). */
function isMissingColumnError(error: { code?: string; message?: string }): boolean {
  if (error.code === "PGRST204" || error.code === "42703") return true;
  const msg = error.message ?? "";
  return /column/i.test(msg) && /(schema cache|does not exist)/i.test(msg);
}

/** Extracts the offending column name from a missing-column error, when present. */
function missingColumnName(error: { message?: string }): string | null {
  const msg = error.message ?? "";
  // PostgREST: Could not find the 'assistant_gender' column of 'ai_settings' …
  const a = msg.match(/find the '([^']+)' column/i);
  if (a) return a[1];
  // Postgres 42703: column "assistant_gender" of relation "ai_settings" does not exist
  const b = msg.match(/column "([^"]+)"/i);
  if (b) return b[1];
  return null;
}

/**
 * Upserts AI settings. Strangler-safe across partially-migrated databases: it sends
 * the full payload, and on an "unknown column" rejection it drops ONLY the offending
 * column and retries (so e.g. a not-yet-applied `assistant_gender` never blocks a
 * `things_to_avoid` that does have a column). Returns whether everything persisted.
 */
export async function updateAISettings(
  businessId: string,
  data: UpdateAISettingsInput
): Promise<{ fullyPersisted: boolean; droppedColumns: string[] }> {
  const db = supabaseServer();
  const payload: Record<string, unknown> = { business_id: businessId, ...data };
  const dropped: string[] = [];

  // At most a few rounds — one per missing column. Bounded to avoid any loop.
  for (let attempt = 0; attempt < 6; attempt++) {
    const { error } = await db.from("ai_settings").upsert(payload, { onConflict: "business_id" });
    if (!error) return { fullyPersisted: dropped.length === 0, droppedColumns: dropped };

    if (!isMissingColumnError(error)) throw new Error(error.message);

    const col = missingColumnName(error);
    if (col && col !== "business_id" && col in payload) {
      delete payload[col];
      dropped.push(col);
      console.warn(`[ai-settings] column '${col}' not present — saved without it (apply the pending migration)`);
      continue;
    }
    // Missing-column error we couldn't pin to a name: nothing safe left to strip.
    throw new Error(error.message);
  }
  throw new Error("[ai-settings] upsert still failing after dropping unknown columns");
}
