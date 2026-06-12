// Database types matching the Supabase schema.
// Keep in sync with supabase/schema.sql.

export type AppointmentStatus =
  | "pending"
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show";

export type AppointmentSource = "whatsapp" | "dashboard" | "manual" | "system" | "platform";

export type MessageDirection = "inbound" | "outbound";

export type MessageChannel = "whatsapp";

export interface Business {
  id: string;
  name: string;
  slug: string;
  phone: string | null;
  timezone: string;
  created_at: string;
  updated_at: string;
}

export interface BusinessSettings {
  id: string;
  business_id: string;
  // Operational
  booking_enabled: boolean;
  confirmation_required: boolean;
  default_slot_duration_minutes: number;
  // Business identity (shown in settings page)
  address: string | null;
  city: string | null;
  // WhatsApp integration health (migration 006 — optional until applied)
  whatsapp_status?: "healthy" | "degraded" | "auth_failed";
  last_whatsapp_error?: string | null;
  last_whatsapp_error_at?: string | null;
  whatsapp_consecutive_failures?: number;
  // DB columns that exist but are NO LONGER surfaced in the UI.
  // These remain null after migration 002. Content lives in knowledge_base_items instead.
  /** @deprecated Use KB category "parking" */
  parking_instructions: string | null;
  /** @deprecated Use KB category "contact" / "parking" */
  entrance_instructions: string | null;
  /** @deprecated Use KB category "policy" */
  cancellation_policy_text: string | null;
  /** @deprecated Use ai_settings.language */
  language: string;
  created_at: string;
  updated_at: string;
}

export interface StaffMember {
  id: string;
  business_id: string;
  name: string;
  phone: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface BusinessHour {
  id: string;
  business_id: string;
  day_of_week: number; // 0 = Sunday … 6 = Saturday
  opens_at: string | null; // "HH:MM"
  closes_at: string | null; // "HH:MM"
  is_closed: boolean;
  created_at: string;
  updated_at: string;
}

export interface StaffWorkingHour {
  id: string;
  business_id: string;
  staff_member_id: string;
  day_of_week: number; // 0 = Sunday … 6 = Saturday
  opens_at: string | null; // "HH:MM"
  closes_at: string | null; // "HH:MM"
  is_closed: boolean;
  created_at: string;
  updated_at: string;
}

export interface ServiceCategory {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Service {
  id: string;
  business_id: string;
  category_id: string | null; // optional — references service_categories(id)
  name: string;
  description: string | null;
  duration_minutes: number;
  price: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Customer {
  id: string;
  business_id: string;
  phone: string;
  name: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Appointment {
  id: string;
  business_id: string;
  customer_id: string;
  service_id: string | null;
  staff_member_id: string | null; // nullable — not all businesses assign a specific staff member
  start_time: string;
  end_time: string;
  status: AppointmentStatus;
  source: AppointmentSource;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  business_id: string;
  customer_id: string | null;
  direction: MessageDirection;
  channel: MessageChannel;
  from_phone: string | null;
  to_phone: string | null;
  body: string | null;
  raw_payload: Record<string, unknown> | null;
  meta_message_id: string | null;
  created_at: string;
}

export interface ConversationState {
  id: string;
  business_id: string;
  customer_id: string;
  state: string;
  context: Record<string, unknown>;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export type KnowledgeBaseItemCategory =
  | "about"     // "About the business" — primary Gemini context
  | "faq"
  | "pricing"
  | "parking"
  | "policy"
  | "contact"
  | "custom";

export interface KnowledgeBaseItem {
  id: string;
  business_id: string;
  category: KnowledgeBaseItemCategory;
  title: string;
  content: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type AISettingsTone = "friendly" | "professional" | "luxury" | "casual";
export type AISettingsResponseLength = "short" | "medium" | "long";
export type AISettingsEmojiUsage = "none" | "low" | "medium";

export interface AISettings {
  id: string;
  business_id: string;
  assistant_name: string;
  tone: AISettingsTone;
  response_length: AISettingsResponseLength;
  emoji_usage: AISettingsEmojiUsage;
  language: string;
  custom_instructions: string | null;
  // AI control toggles — all default true. Disabling never affects bookings.
  ai_enabled: boolean;
  faq_enabled: boolean;
  intent_detection_enabled: boolean;
  created_at: string;
  updated_at: string;
}

// ── Booking platform event layer (migration 007) ────────────────────────────

export type PlatformEventStatus = "pending" | "processed" | "skipped";

export interface PlatformEvent {
  id: string;
  business_id: string;
  customer_id: string | null;
  appointment_id: string | null;
  type:
    | "appointment_booked"
    | "appointment_cancelled"
    | "appointment_rescheduled"
    | "reminder_due"
    | "waitlist_opportunity"
    | "abandoned_booking"
    | "customer_inactive";
  payload: Record<string, unknown>;
  status: PlatformEventStatus;
  created_at: string;
  processed_at: string | null;
}

export type WaitlistStatus = "active" | "notified" | "converted" | "expired" | "cancelled";

export interface WaitlistEntry {
  id: string;
  business_id: string;
  customer_id: string;
  service_id: string | null;
  date_from: string | null;  // DATE, business-local
  date_to: string | null;
  time_from: string | null;  // "HH:MM"
  time_to: string | null;
  status: WaitlistStatus;
  notified_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A single row in ai_events — non-sensitive Gemini activity log. */
export interface AIEvent {
  id: string;
  business_id: string;
  customer_id: string | null;
  called: boolean;
  intent: string | null;
  confidence: number | null;
  success: boolean;
  response_type: string | null;
  created_at: string;
}

export interface BusinessAIContext {
  business: Business;
  businessSettings: BusinessSettings | null;
  aiSettings: AISettings | null;
  services: Service[];
  knowledgeBaseItems: KnowledgeBaseItem[];
  /** Weekly schedule — 0–7 rows (0 = Sunday … 6 = Saturday). Empty = hours not configured. */
  businessHours: BusinessHour[];
}
