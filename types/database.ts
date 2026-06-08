// Database types matching the Supabase schema.
// Keep in sync with supabase/schema.sql.

export type AppointmentStatus =
  | "pending"
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show";

export type AppointmentSource = "whatsapp" | "dashboard" | "manual" | "system";

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
  language: string;
  booking_enabled: boolean;
  confirmation_required: boolean;
  default_slot_duration_minutes: number;
  cancellation_policy_text: string | null;
  // Location fields (migration 002)
  address: string | null;
  city: string | null;
  parking_instructions: string | null;
  entrance_instructions: string | null;
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
  created_at: string;
  updated_at: string;
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
