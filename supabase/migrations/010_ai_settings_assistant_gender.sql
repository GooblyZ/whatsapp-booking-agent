-- ============================================================
-- Migration 010 — Assistant gender (Identity)
--
-- Part of the "Define your receptionist" simplification (2026-06-13). Adds the
-- assistant's own grammatical gender for Hebrew SELF-reference ("אני שמחה" vs
-- "אני שמח"). This is the assistant's identity only — it does NOT change the
-- gender-neutral phrasing toward the customer (that stays mirrored-from-customer).
--
-- NOTE: the same simplification also RETIRES `tone` and `business_type` from the
-- dashboard UI and the persona. Those columns are intentionally KEPT here (not
-- dropped): the persona reads `tone` as a silent back-compat fallback for older
-- configs that only ever set a tone, and dropping data is avoided. They can be
-- dropped in a future migration once no config relies on them.
--
-- Apply manually in the Supabase SQL editor. Idempotent — safe to re-run.
-- Until applied the code FAILS SOFT: updateAISettings drops the unknown column and
-- retries; reads default to 'neutral' (the pre-existing behavior).
-- ============================================================

ALTER TABLE ai_settings
  ADD COLUMN IF NOT EXISTS assistant_gender TEXT NOT NULL DEFAULT 'neutral'
    CHECK (assistant_gender IN ('neutral', 'female', 'male'));
