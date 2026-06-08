-- Migration 002: Add location fields to business_settings
-- Run this against your Supabase project via the SQL editor or supabase db push.

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS address               TEXT,
  ADD COLUMN IF NOT EXISTS city                  TEXT,
  ADD COLUMN IF NOT EXISTS parking_instructions  TEXT,
  ADD COLUMN IF NOT EXISTS entrance_instructions TEXT;

COMMENT ON COLUMN business_settings.address               IS 'Street address — shown by the AI assistant when customers ask about location.';
COMMENT ON COLUMN business_settings.city                  IS 'City — shown by the AI assistant when customers ask about location.';
COMMENT ON COLUMN business_settings.parking_instructions  IS 'Free-text parking guidance shown by the AI assistant.';
COMMENT ON COLUMN business_settings.entrance_instructions IS 'Free-text entrance/arrival guidance shown by the AI assistant.';
