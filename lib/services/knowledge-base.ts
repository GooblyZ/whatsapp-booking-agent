import { supabaseServer } from "@/lib/supabase/server";
import type { KnowledgeBaseItem, KnowledgeBaseItemCategory } from "@/types/database";

export async function getKnowledgeBaseItems(
  businessId: string
): Promise<KnowledgeBaseItem[]> {
  const db = supabaseServer();
  const { data, error } = await db
    .from("knowledge_base_items")
    .select("*")
    .eq("business_id", businessId)
    .order("category")
    .order("title");
  if (error) throw new Error(error.message);
  return (data ?? []) as KnowledgeBaseItem[];
}

export interface CreateKnowledgeBaseItemInput {
  category: KnowledgeBaseItemCategory;
  title: string;
  content: string;
}

export async function createKnowledgeBaseItem(
  businessId: string,
  data: CreateKnowledgeBaseItemInput
): Promise<void> {
  const db = supabaseServer();
  const { error } = await db.from("knowledge_base_items").insert({
    business_id: businessId,
    category: data.category,
    title: data.title,
    content: data.content,
  });
  if (error) throw new Error(error.message);
}

export interface UpdateKnowledgeBaseItemInput {
  category?: KnowledgeBaseItemCategory;
  title?: string;
  content?: string;
  active?: boolean;
}

export async function updateKnowledgeBaseItem(
  businessId: string,
  itemId: string,
  data: UpdateKnowledgeBaseItemInput
): Promise<void> {
  const db = supabaseServer();
  const { error } = await db
    .from("knowledge_base_items")
    .update(data as Record<string, unknown>)
    .eq("id", itemId)
    .eq("business_id", businessId);
  if (error) throw new Error(error.message);
}

export async function deleteKnowledgeBaseItem(
  businessId: string,
  itemId: string
): Promise<void> {
  const db = supabaseServer();
  const { error } = await db
    .from("knowledge_base_items")
    .delete()
    .eq("id", itemId)
    .eq("business_id", businessId);
  if (error) throw new Error(error.message);
}
