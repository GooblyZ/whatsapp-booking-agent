// lib/ai/events.ts
// Server-side only.
//
// Safe, non-sensitive logging of Gemini activity (PART 1 — monitoring).
// Stores ONLY metadata: business/customer UUIDs, whether Gemini was called,
// the detected intent, confidence, success, and the response type.
//
// NEVER stores: API key, full prompt, full business context, the customer's
// message text, phone numbers, or any other sensitive customer data.
//
// All functions are fail-safe: logging never throws, and reads degrade to
// empty/zero if the ai_events table is missing (migration not yet run).

import { supabaseServer } from "@/lib/supabase/server";
import type { AIEvent } from "@/types/database";

/** The canonical set of response types we record (kept in sync with the brain). */
export type AIEventResponseType =
  // Phase 1 receptionist-brain outcomes
  | "conversation"      // natural smalltalk / general reply
  | "faq_answer"        // grounded informational answer
  | "booking_intent"    // booking discussed, not yet confirmed
  | "booking_handoff"   // confirmed → handed to deterministic booking flow
  | "cancel_reschedule" // asked to cancel/reschedule (not supported yet)
  | "irrelevant"        // off-topic, steered back
  | "unknown"           // unclear
  | "noise"             // junk / empty / repeated chars (pre-Gemini)
  | "abuse"             // abusive input (pre-Gemini)
  | "grounding_failed"  // Gemini reply failed strict grounding → safe fallback
  | "ai_disabled"       // AI master switch off
  | "not_configured"    // no Gemini API key
  | "error"             // Gemini/API failure
  | "degraded"          // served deterministically during Gemini overload cooldown
  // Legacy (kept for historical rows / deterministic booking flow)
  | "booking_confirm"
  | "booking_clarify"
  | "booking_disabled"
  | "greeting";

export interface LogAIEventInput {
  businessId: string;
  customerId: string | null;
  called: boolean;
  intent: string | null;
  confidence: number | null;
  success: boolean;
  responseType: AIEventResponseType;
}

/**
 * Records one AI decision. Fire-and-forget: never throws, never blocks the
 * WhatsApp reply. If the table is missing it logs a hint and moves on.
 */
export async function logAIEvent(input: LogAIEventInput): Promise<void> {
  try {
    const db = supabaseServer();
    const { error } = await db.from("ai_events").insert({
      business_id: input.businessId,
      customer_id: input.customerId,
      called: input.called,
      intent: input.intent,
      confidence: input.confidence,
      success: input.success,
      response_type: input.responseType,
    });
    if (error) {
      console.error(
        "[ai-events] insert failed (did you run supabase/migrations/004_ai_events.sql?):",
        error.message
      );
    }
  } catch (err) {
    console.error("[ai-events] unexpected logging error:", err instanceof Error ? err.message : String(err));
  }
}

/** Most recent AI events for a business (newest first). Returns [] on any error. */
export async function getRecentAIEvents(businessId: string, limit = 30): Promise<AIEvent[]> {
  try {
    const db = supabaseServer();
    const { data, error } = await db
      .from("ai_events")
      .select("id, business_id, customer_id, called, intent, confidence, success, response_type, created_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      console.error("[ai-events] read failed:", error.message);
      return [];
    }
    return (data ?? []) as AIEvent[];
  } catch (err) {
    console.error("[ai-events] unexpected read error:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Approximate count of AI events since an ISO timestamp.
 * Defaults to counting only events where Gemini was actually called
 * (i.e. billable usage). Returns 0 on any error.
 */
export async function countAIEventsSince(
  businessId: string,
  sinceISO: string,
  onlyCalled = true
): Promise<number> {
  try {
    const db = supabaseServer();
    let query = db
      .from("ai_events")
      .select("*", { count: "exact", head: true })
      .eq("business_id", businessId)
      .gte("created_at", sinceISO);
    if (onlyCalled) query = query.eq("called", true);

    const { count, error } = await query;
    if (error) {
      console.error("[ai-events] count failed:", error.message);
      return 0;
    }
    return count ?? 0;
  } catch (err) {
    console.error("[ai-events] unexpected count error:", err instanceof Error ? err.message : String(err));
    return 0;
  }
}
