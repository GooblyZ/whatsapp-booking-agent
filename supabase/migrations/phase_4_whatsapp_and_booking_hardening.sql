-- ============================================================
-- Phase 4 — WhatsApp infrastructure & booking hardening
-- ============================================================
-- Run this in: Supabase dashboard → SQL Editor → New query
-- All statements are idempotent — safe to run multiple times.
-- Running this on a fresh schema is also safe.
-- ============================================================

-- ── 1. conversation_states — unique constraint ────────────────
-- Ensures at most one active conversation state per customer per business.
-- The constraint is declared in schema.sql; this block adds it retroactively
-- on deployments that were created before the constraint existed.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname    = 'conversation_states_unique_per_customer'
      AND conrelid   = 'public.conversation_states'::regclass
  ) THEN
    ALTER TABLE public.conversation_states
      ADD CONSTRAINT conversation_states_unique_per_customer
      UNIQUE (business_id, customer_id);
    RAISE NOTICE 'Added constraint conversation_states_unique_per_customer';
  ELSE
    RAISE NOTICE 'Constraint conversation_states_unique_per_customer already exists — skipped';
  END IF;
END $$;


-- ── 2. appointments — slot collision prevention ───────────────
-- Two partial unique indexes prevent two active appointments at the same
-- start_time for the same business resource.

-- Case A: no staff member assigned (staff_member_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_no_double_book_no_staff
  ON public.appointments (business_id, start_time)
  WHERE status IN ('pending', 'confirmed')
    AND staff_member_id IS NULL;

-- Case B: staff member is assigned
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_no_double_book_with_staff
  ON public.appointments (business_id, staff_member_id, start_time)
  WHERE status IN ('pending', 'confirmed')
    AND staff_member_id IS NOT NULL;


-- ── 3. messages.send_status ───────────────────────────────────
-- Tracks whether the outbound WhatsApp API call succeeded.
-- Values: 'pending' | 'sent' | 'failed'

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS send_status TEXT
    DEFAULT 'pending'
    CHECK (send_status IN ('pending', 'sent', 'failed'));


-- ── 4. messages.wa_timestamp ──────────────────────────────────
-- Stores the original timestamp from the Meta webhook payload
-- (Unix epoch, converted to UTC).
-- Distinct from created_at (when the server received the webhook).

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS wa_timestamp TIMESTAMPTZ;


-- ── 5. messages.external_message_id ──────────────────────────
-- Stores the external provider's message ID (e.g. WhatsApp wamid).
-- meta_message_id stores the same value for WhatsApp; this column
-- is the canonical name used for cross-channel extensibility.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS external_message_id TEXT;


-- ── Verification queries (optional, run to confirm) ──────────
-- SELECT column_name, data_type
--   FROM information_schema.columns
--  WHERE table_schema = 'public'
--    AND table_name   = 'messages'
--    AND column_name  IN ('send_status', 'wa_timestamp', 'external_message_id');
--
-- SELECT constraint_name
--   FROM information_schema.table_constraints
--  WHERE table_schema   = 'public'
--    AND table_name     = 'conversation_states'
--    AND constraint_type = 'UNIQUE';

-- ============================================================
-- End of phase_4_whatsapp_and_booking_hardening.sql
-- ============================================================
