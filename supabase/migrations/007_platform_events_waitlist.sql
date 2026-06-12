-- ============================================================
-- Migration 007 — booking platform, events, waitlist
-- (TRANSITION_PLAN.md phases 1–4)
--
-- Apply manually in the Supabase SQL editor. Idempotent.
-- Until applied the code FAILS SOFT:
--   - platform bookings fall back to source='system'
--   - event emission is skipped with a log line
-- ============================================================

-- 1. Appointments created by the booking platform get their own source.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_source_check;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_source_check
  CHECK (source IN ('whatsapp', 'dashboard', 'manual', 'system', 'platform'));

-- 2. events — the system DETECTS, the AI COMMUNICATES.
--    payload holds safe metadata only (no message text, no full phone numbers).
CREATE TABLE IF NOT EXISTS events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id    UUID REFERENCES customers(id) ON DELETE SET NULL,
  appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,

  type TEXT NOT NULL CHECK (type IN (
    'appointment_booked', 'appointment_cancelled', 'appointment_rescheduled',
    'reminder_due', 'waitlist_opportunity', 'abandoned_booking', 'customer_inactive'
  )),

  payload      JSONB NOT NULL DEFAULT '{}',

  -- pending → processed (communicated / acted on) | skipped (no action needed)
  status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processed', 'skipped')),

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_events_business_id      ON events(business_id);
CREATE INDEX IF NOT EXISTS idx_events_pending          ON events(business_id, status, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_events_appointment_id   ON events(appointment_id)
  WHERE appointment_id IS NOT NULL;

-- 3. waitlist_entries — customers waiting for availability in a window.
--    Window fields are nullable: "whenever something frees up" is a valid entry.
CREATE TABLE IF NOT EXISTS waitlist_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  service_id  UUID REFERENCES services(id) ON DELETE SET NULL,

  date_from   DATE,            -- earliest acceptable date (business-local)
  date_to     DATE,            -- latest acceptable date
  time_from   TEXT,            -- "HH:MM" lower bound, business-local
  time_to     TEXT,            -- "HH:MM" upper bound

  -- active → notified (opportunity sent) → converted (booked) | expired | cancelled
  status      TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'notified', 'converted', 'expired', 'cancelled')),

  notified_at TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_waitlist_business_id ON waitlist_entries(business_id);
CREATE INDEX IF NOT EXISTS idx_waitlist_active      ON waitlist_entries(business_id, status)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS trg_updated_at ON waitlist_entries;
CREATE TRIGGER trg_updated_at
  BEFORE UPDATE ON waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
