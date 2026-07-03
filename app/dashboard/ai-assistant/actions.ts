"use server";

import { getDefaultBusinessId } from "@/lib/config";
import { updateAISettings, type UpdateAISettingsInput } from "@/lib/services/ai-settings";
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

  // AI Settings v1: PRESENT-FIELDS-ONLY partial payload. When the assistant is OFF the style
  // controls are rendered `disabled`, and disabled fields are ABSENT from FormData — so a field
  // is written only when it was actually submitted. A save-while-off therefore persists ONLY the
  // master switch and can never wipe the owner's style columns (updateAISettings' upsert touches
  // only the keys it receives). ai_enabled is the ONE field always written: the switch is always
  // enabled, and an unchecked checkbox is legitimately absent → false.
  const data: UpdateAISettingsInput = { ai_enabled: formData.get("ai_enabled") === "on" };
  // IDENTITY
  if (formData.has("assistant_name"))   data.assistant_name   = (formData.get("assistant_name") as string)?.trim() || "עוזר";
  if (formData.has("assistant_gender")) data.assistant_gender = safeGender(formData.get("assistant_gender"));
  // WRITING STYLE (format)
  if (formData.has("response_length")) data.response_length = (formData.get("response_length") as AISettingsResponseLength) || "medium";
  if (formData.has("emoji_usage"))     data.emoji_usage     = (formData.get("emoji_usage")     as AISettingsEmojiUsage)     || "low";
  if (formData.has("language"))        data.language        = safeLanguage(formData.get("language"));
  // PERSONALITY — the single natural-language voice authority.
  if (formData.has("custom_instructions")) data.custom_instructions = cleanText(formData.get("custom_instructions"), 2000);
  // HARD RULES
  if (formData.has("things_to_avoid")) data.things_to_avoid = cleanText(formData.get("things_to_avoid"), 1000);
  // faq_enabled / intent_detection_enabled are NO LONGER owner-facing (core behavior whenever the
  // assistant is on) and are deliberately NOT written — existing DB values are preserved verbatim
  // (Option A in the AI Settings v1 plan; backend reads in brain.ts/facts.ts are unchanged).

  // Presentation-only save feedback: a genuine persistence failure should surface a graceful
  // Hebrew banner, not an unhandled 500. redirect() throws NEXT_REDIRECT internally, so it MUST
  // stay OUTSIDE the try — otherwise the success redirect would be swallowed by the catch.
  let fullyPersisted = true;
  let saveFailed = false;
  try {
    ({ fullyPersisted } = await updateAISettings(businessId, data));
  } catch {
    saveFailed = true;
  }

  if (saveFailed) {
    redirect("/dashboard/ai-assistant?error=ai_settings_save_failed");
  }

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
