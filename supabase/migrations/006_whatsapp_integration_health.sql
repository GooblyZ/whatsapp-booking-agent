-- Migration 006: WhatsApp integration health on business_settings.
-- Run this in the Supabase SQL Editor.
--
-- Persists per-business WhatsApp delivery health so the dashboard can surface
-- "authentication failed — reconnect Meta token" to the owner. The runtime
-- works without these columns (memory-only mode); this migration adds the
-- dashboard visibility.
--
-- whatsapp_status: healthy | degraded | auth_failed
--
-- Idempotent — safe to re-run.

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS whatsapp_status TEXT NOT NULL DEFAULT 'healthy'
    CHECK (whatsapp_status IN ('healthy', 'degraded', 'auth_failed'));

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS last_whatsapp_error TEXT;

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS last_whatsapp_error_at TIMESTAMPTZ;

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS whatsapp_consecutive_failures INTEGER NOT NULL DEFAULT 0;
