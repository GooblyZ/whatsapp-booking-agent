-- Migration 003: Add "about" to knowledge_base_items category CHECK constraint
-- Run this in the Supabase SQL Editor.
--
-- The original constraint only allows:
--   faq | pricing | parking | policy | contact | custom
--
-- This migration replaces it to also allow:
--   about
--
-- Safe: no existing rows use 'about'. All existing items remain valid.
-- Idempotent: wrapped in a DO block so re-running is harmless.

DO $$
BEGIN
  -- Drop the old constraint if it exists
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_base_items_category_check'
      AND conrelid = 'knowledge_base_items'::regclass
  ) THEN
    ALTER TABLE knowledge_base_items
      DROP CONSTRAINT knowledge_base_items_category_check;
  END IF;

  -- Add the new constraint with 'about' included
  -- Use IF NOT EXISTS pattern via another existence check
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_base_items_category_check'
      AND conrelid = 'knowledge_base_items'::regclass
  ) THEN
    ALTER TABLE knowledge_base_items
      ADD CONSTRAINT knowledge_base_items_category_check
      CHECK (category IN ('about', 'faq', 'pricing', 'parking', 'policy', 'contact', 'custom'));
  END IF;
END $$;
