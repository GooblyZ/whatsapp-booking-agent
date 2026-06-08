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

export async function createKBItemAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  await createKnowledgeBaseItem(businessId, {
    category:
      (formData.get("category") as KnowledgeBaseItemCategory) ?? "faq",
    title: formData.get("title") as string,
    content: formData.get("content") as string,
  });
  redirect("/dashboard/knowledge-base");
}

export async function updateKBItemAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  const id = formData.get("id") as string;
  await updateKnowledgeBaseItem(businessId, id, {
    category: formData.get("category") as KnowledgeBaseItemCategory,
    title: formData.get("title") as string,
    content: formData.get("content") as string,
  });
  redirect("/dashboard/knowledge-base");
}

export async function toggleKBItemActiveAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  const id = formData.get("id") as string;
  const active = formData.get("active") === "true";
  await updateKnowledgeBaseItem(businessId, id, { active });
  revalidatePath("/dashboard/knowledge-base");
}

export async function deleteKBItemAction(formData: FormData) {
  const businessId = getDefaultBusinessId();
  const id = formData.get("id") as string;
  await deleteKnowledgeBaseItem(businessId, id);
  revalidatePath("/dashboard/knowledge-base");
}
