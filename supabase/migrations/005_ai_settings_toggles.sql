-- Migration 005: AI control toggles on ai_settings.
-- Run this in the Supabase SQL Editor.
--
-- Lets a business owner temporarily disable AI (or specific AI features)
-- WITHOUT affecting the deterministic booking flow. All default to TRUE so
-- existing behaviour is unchanged after migration.
--
-- Idempotent — safe to re-run.

ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS faq_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS intent_detection_enabled BOOLEAN NOT NULL DEFAULT TRUE;
