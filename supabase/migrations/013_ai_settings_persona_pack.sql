-- Migration 013: predefined persona packs (Rev.3 persona slice).
--
-- Adds an EXPLICIT persona selector to ai_settings, replacing the fragile "detect the preset by
-- exact-matching custom_instructions" approach for the two new FIRST-CLASS rich packs. The lightweight
-- 5-preset chooser is retired from the UI; a business now picks Warm & Casual, Professional & Elegant,
-- or Custom.
--
--   persona_pack        — the behavioral selector.
--                         'warm_casual' | 'professional_elegant' → the structured pack in
--                           lib/ai/persona-packs.ts is authoritative for voice/style/emoji.
--                         'custom' (DEFAULT) → today's path is unchanged: custom_instructions +
--                           explicit emoji/length/gender drive the voice.
--   custom_base_pack_id — UI/AUDIT metadata ONLY: which rich pack a Custom persona was seeded from via
--                         "Start from a pack". NEVER a behavioral authority. NULL for from-scratch
--                         Custom and for rich-pack selections.
--
-- BEHAVIOR-PRESERVING: existing rows backfill to 'custom' (NOT NULL DEFAULT), so no live tenant changes
-- voice until the owner explicitly picks a rich pack. Rollback = ignore the column (runtime treats a
-- missing/`custom` value exactly as today).
--
-- Additive + idempotent. Apply MANUALLY in the Supabase SQL editor (no migration runner in this repo);
-- keep supabase/schema.sql in sync.

ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS persona_pack TEXT NOT NULL DEFAULT 'custom'
    CHECK (persona_pack IN ('warm_casual', 'professional_elegant', 'custom'));

ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS custom_base_pack_id TEXT
    CHECK (custom_base_pack_id IN ('warm_casual', 'professional_elegant'));
