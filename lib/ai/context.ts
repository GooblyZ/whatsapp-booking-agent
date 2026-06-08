import { supabaseServer } from "@/lib/supabase/server";
import type { Business, BusinessSettings, BusinessAIContext } from "@/types/database";
import { getAISettings } from "@/lib/services/ai-settings";
import { getServices } from "@/lib/services/catalog";
import { getKnowledgeBaseItems } from "@/lib/services/knowledge-base";
import { getBusinessHours } from "@/lib/services/business-hours";

// Returns all data the AI receptionist needs to handle a conversation.
// No AI calls are made here — this is data preparation only.
// Wire this into Gemini (or any LLM) in a future phase.
export async function getBusinessAIContext(
  businessId: string
): Promise<BusinessAIContext> {
  const db = supabaseServer();

  const [
    { data: businessData },
    { data: settingsData },
    aiSettings,
    services,
    knowledgeBaseItems,
    businessHours,
  ] = await Promise.all([
    db.from("businesses").select("*").eq("id", businessId).single(),
    db.from("business_settings").select("*").eq("business_id", businessId).maybeSingle(),
    getAISettings(businessId),
    getServices(businessId),
    getKnowledgeBaseItems(businessId),
    getBusinessHours(businessId),
  ]);

  if (!businessData) {
    throw new Error(`Business not found: ${businessId}`);
  }

  return {
    business: businessData as Business,
    businessSettings: settingsData as BusinessSettings | null,
    aiSettings,
    services,
    knowledgeBaseItems,
    businessHours,
  };
}
