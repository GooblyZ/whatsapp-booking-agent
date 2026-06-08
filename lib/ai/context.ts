import { supabaseServer } from "@/lib/supabase/server";
import type { Business, BusinessSettings, BusinessAIContext } from "@/types/database";
import { getAISettings } from "@/lib/services/ai-settings";
import { getServices } from "@/lib/services/catalog";
import { getKnowledgeBaseItems } from "@/lib/services/knowledge-base";
import { getBusinessHours } from "@/lib/services/business-hours";

// Returns all data the AI receptionist needs to handle a conversation.
// No AI calls are made here — this is data preparation only.
// Wire this into Gemini in the next phase.
//
// Single sources of truth:
//   business identity    → businesses table (name, phone) + business_settings (address, city)
//   business hours       → business_hours table
//   services             → services table
//   what the AI knows    → knowledge_base_items (parking, policy, FAQ, about, etc.)
//   AI behaviour         → ai_settings (tone, language, name, etc.)
//
// Deprecated fields intentionally excluded from context:
//   business_settings.parking_instructions  → use KB category "parking" instead
//   business_settings.entrance_instructions → use KB category "contact" / "parking"
//   business_settings.cancellation_policy_text → use KB category "policy"
//   business_settings.language              → use ai_settings.language only
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
    // Select only the fields Gemini should use — deprecated columns excluded
    db
      .from("business_settings")
      .select("id, business_id, booking_enabled, default_slot_duration_minutes, address, city, created_at, updated_at")
      .eq("business_id", businessId)
      .maybeSingle(),
    getAISettings(businessId),
    getServices(businessId),
    getKnowledgeBaseItems(businessId),
    getBusinessHours(businessId),
  ]);

  if (!businessData) {
    throw new Error(`Business not found: ${businessId}`);
  }

  return {
    business:          businessData as Business,
    businessSettings:  settingsData as BusinessSettings | null,
    aiSettings,
    services,
    knowledgeBaseItems,
    businessHours,
  };
}
