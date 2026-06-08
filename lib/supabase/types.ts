// Supabase-generated database type wrapper.
// Replace the `Json` and `Database` types here with the output of:
//   npx supabase gen types typescript --project-id <your-project-id>
// once you have connected a real Supabase project.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// Placeholder — replace with the full generated type from `supabase gen types`.
// The generic <Database> on createClient enforces type safety throughout the app.
export type Database = {
  public: {
    Tables: {
      businesses: { Row: Record<string, unknown>; Insert: Record<string, unknown>; Update: Record<string, unknown> };
      business_settings: { Row: Record<string, unknown>; Insert: Record<string, unknown>; Update: Record<string, unknown> };
      staff_members: { Row: Record<string, unknown>; Insert: Record<string, unknown>; Update: Record<string, unknown> };
      business_hours: { Row: Record<string, unknown>; Insert: Record<string, unknown>; Update: Record<string, unknown> };
      services: { Row: Record<string, unknown>; Insert: Record<string, unknown>; Update: Record<string, unknown> };
      customers: { Row: Record<string, unknown>; Insert: Record<string, unknown>; Update: Record<string, unknown> };
      appointments: { Row: Record<string, unknown>; Insert: Record<string, unknown>; Update: Record<string, unknown> };
      messages: { Row: Record<string, unknown>; Insert: Record<string, unknown>; Update: Record<string, unknown> };
      conversation_states: { Row: Record<string, unknown>; Insert: Record<string, unknown>; Update: Record<string, unknown> };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
};
