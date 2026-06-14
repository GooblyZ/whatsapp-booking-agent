-- ============================================================
-- Migration 008 — AI Settings persona depth
--
-- Makes "AI Settings" a real product area: each business can shape its
-- receptionist beyond the 4 tone presets. All columns are NULLABLE and additive.
--
-- Apply manually in the Supabase SQL editor. Idempotent.
-- Until applied the code FAILS SOFT: the dashboard still saves the core settings,
-- and the persona simply omits the advanced fields (updateAISettings retries
-- core-only on a missing-column error; reads default to undefined).
--
-- NOTE (2026-06-13 redesign): `persona_voice` is SUPERSEDED — personality is now a
-- single field (custom_instructions). Migration 009 merges any persona_voice text
-- into custom_instructions and drops the column. Do not add new writes here.
-- ============================================================

-- The kind of business — frames the whole receptionist persona
-- (e.g. "מספרה", "מרפאת שיניים", "סטודיו לפילאטיס").
ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS business_type TEXT;

-- Free-text personality description, richer than the tone preset
-- (e.g. "חמים, זוכר לקוחות קבועים, אוהב לדבר על טיולים"). Owner's words.
-- SUPERSEDED by custom_instructions — see migration 009.
ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS persona_voice TEXT;

-- Explicit guardrails the receptionist must always respect
-- (e.g. "אף פעם אל תבטיח תור באותו היום; אל תדון במחירי מתחרים").
ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS things_to_avoid TEXT;
