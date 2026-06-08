"use server";

import { getDefaultBusinessId } from "@/lib/config";
import {
  createKnowledgeBaseItem,
  updateKnowledgeBaseItem,
  deleteKnowledgeBaseItem,
} from "@/lib/services/knowledge-base";
import type { KnowledgeBaseItemCategory } from "@/types/database";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

const VALID_CATEGORIES: KnowledgeBaseItemCategory[] = [
  "about", "faq", "pricing", "parking", "policy", "contact", "custom",
];

function validate(formData: FormData): string | null {
  const title   = (formData.get("title")   as string)?.trim() ?? "";
  const content = (formData.get("content") as string)?.trim() ?? "";
  if (title.length   < 3)  return "kb_title_short";
  if (content.length < 10) return "kb_content_short";
  return null;
}

function safeCategory(raw: unknown): KnowledgeBaseItemCategory {
  return VALID_CATEGORIES.includes(raw as KnowledgeBaseItemCategory)
    ? (raw as KnowledgeBaseItemCategory)
    : "faq";
}

export async function createKBItemAction(formData: FormData) {
  const err = validate(formData);
  if (err) redirect(`/dashboard/knowledge-base?error=${err}`);

  const businessId = getDefaultBusinessId();
  await createKnowledgeBaseItem(businessId, {
    category: safeCategory(formData.get("category")),
    title:    (formData.get("title")   as string).trim(),
    content:  (formData.get("content") as string).trim(),
  });
  redirect("/dashboard/knowledge-base?saved=1");
}

export async function updateKBItemAction(formData: FormData) {
  const err = validate(formData);
  if (err) redirect(`/dashboard/knowledge-base?error=${err}`);

  const businessId = getDefaultBusinessId();
  const id         = formData.get("id") as string;
  await updateKnowledgeBaseItem(businessId, id, {
    category: safeCategory(formData.get("category")),
    title:    (formData.get("title")   as string).trim(),
    content:  (formData.get("content") as string).trim(),
  });
  redirect("/dashboard/knowledge-base?saved=1");
}

export async function toggleKBItemActiveAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  const id         = formData.get("id") as string;
  const active     = formData.get("active") === "true";
  await updateKnowledgeBaseItem(businessId, id, { active });
  revalidatePath("/dashboard/knowledge-base");
}

export async function deleteKBItemAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  const id         = formData.get("id") as string;
  await deleteKnowledgeBaseItem(businessId, id);
  revalidatePath("/dashboard/knowledge-base");
}
