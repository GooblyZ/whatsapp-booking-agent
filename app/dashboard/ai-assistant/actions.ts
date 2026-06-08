"use server";

import { getDefaultBusinessId } from "@/lib/config";
import { updateAISettings } from "@/lib/services/ai-settings";
import {
  createKnowledgeBaseItem,
  updateKnowledgeBaseItem,
  deleteKnowledgeBaseItem,
} from "@/lib/services/knowledge-base";
import type {
  AISettingsTone,
  AISettingsResponseLength,
  AISettingsEmojiUsage,
  KnowledgeBaseItemCategory,
} from "@/types/database";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function saveAISettingsAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  const customInstr = (formData.get("custom_instructions") as string)?.trim();
  await updateAISettings(businessId, {
    assistant_name:    (formData.get("assistant_name") as string)?.trim() || "עוזר",
    tone:              (formData.get("tone") as AISettingsTone)             || "friendly",
    response_length:   (formData.get("response_length") as AISettingsResponseLength) || "medium",
    emoji_usage:       (formData.get("emoji_usage") as AISettingsEmojiUsage) || "low",
    language:          (formData.get("language") as string)?.trim()        || "he",
    custom_instructions: customInstr?.length ? customInstr : null,
  });
  redirect("/dashboard/ai-assistant?saved=1");
}

export async function createKBItemAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  await createKnowledgeBaseItem(businessId, {
    category: (formData.get("category") as KnowledgeBaseItemCategory) ?? "faq",
    title:    (formData.get("title") as string)?.trim() ?? "",
    content:  (formData.get("content") as string)?.trim() ?? "",
  });
  redirect("/dashboard/ai-assistant?saved=1");
}

export async function updateKBItemAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  const id         = formData.get("id") as string;
  await updateKnowledgeBaseItem(businessId, id, {
    category: formData.get("category") as KnowledgeBaseItemCategory,
    title:    (formData.get("title") as string)?.trim() ?? "",
    content:  (formData.get("content") as string)?.trim() ?? "",
  });
  redirect("/dashboard/ai-assistant?saved=1");
}

export async function toggleKBItemActiveAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  const id         = formData.get("id") as string;
  const active     = formData.get("active") === "true";
  await updateKnowledgeBaseItem(businessId, id, { active });
  revalidatePath("/dashboard/ai-assistant");
}

export async function deleteKBItemAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  const id         = formData.get("id") as string;
  await deleteKnowledgeBaseItem(businessId, id);
  revalidatePath("/dashboard/ai-assistant");
}
