-- Migration 004: ai_events — safe internal logging of Gemini activity.
-- Run this in the Supabase SQL Editor.
--
-- Stores ONLY non-sensitive metadata about each AI decision:
--   business_id, customer_id (existing safe UUID), whether Gemini was called,
--   detected intent, confidence, success/failure, and the response type.
--
-- Intentionally NOT stored: API key, full prompt, full business context,
-- the customer's message text, or any other sensitive customer data.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS ai_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id   UUID REFERENCES customers(id) ON DELETE SET NULL,

  called        BOOLEAN NOT NULL DEFAULT FALSE,   -- was the Gemini API actually called?
  intent        TEXT,                             -- detected intent, or NULL when not classified
  confidence    NUMERIC(4, 3),                    -- 0.000–1.000, or NULL
  success       BOOLEAN NOT NULL DEFAULT TRUE,    -- did the decision resolve without error?
  response_type TEXT,                             -- faq_answer | booking_confirm | irrelevant | ...

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_events_business_id      ON ai_events(business_id);
CREATE INDEX IF NOT EXISTS idx_ai_events_business_created ON ai_events(business_id, created_at);

-- Grant access to the PostgREST service role (mirrors schema.sql global grant).
GRANT ALL ON ai_events TO service_role;
