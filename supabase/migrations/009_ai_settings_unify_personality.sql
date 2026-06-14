-- ============================================================
-- Migration 009 — Unify personality into a single field
--
-- The AI Settings redesign (2026-06-13) collapses the two free-text personality
-- controls into ONE voice authority. Previously both `persona_voice` (migration
-- 008) and `custom_instructions` shaped the persona, with an invisible precedence
-- order — the root cause of unpredictable, conflicting behavior. Personality is
-- now exactly one field: `custom_instructions`.
--
-- This migration is DATA-PRESERVING: any text in persona_voice is merged into
-- custom_instructions before the column is dropped (the live business kept its
-- personality in persona_voice). When both fields held text, they are joined so
-- nothing is lost.
--
-- Apply manually in the Supabase SQL editor. Idempotent and self-guarding:
-- once persona_voice is gone the whole block is a no-op, so it is safe to re-run
-- and safe on fresh databases that never had the column.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_settings' AND column_name = 'persona_voice'
  ) THEN
    -- Merge persona_voice into custom_instructions without clobbering existing text.
    UPDATE ai_settings
       SET custom_instructions = CASE
             WHEN custom_instructions IS NULL OR btrim(custom_instructions) = ''
               THEN persona_voice
             ELSE custom_instructions || E'\n' || persona_voice
           END
     WHERE persona_voice IS NOT NULL AND btrim(persona_voice) <> '';

    ALTER TABLE ai_settings DROP COLUMN persona_voice;
  END IF;
END $$;
