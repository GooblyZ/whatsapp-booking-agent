-- ============================================================
-- receptionist-core — Supabase Database Schema
-- ============================================================
-- Run this in the Supabase SQL Editor (project > SQL Editor > New query).
-- All tables use:
--   - UUID primary keys (gen_random_uuid())
--   - timestamptz for timestamps
--   - business_id on every tenant-scoped table
-- ============================================================

-- Enable the pgcrypto extension if needed (Supabase usually has it).
-- CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- businesses
-- The top-level tenant entity. Every other table is scoped to
-- a business_id.
-- ============================================================

CREATE TABLE IF NOT EXISTS businesses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  phone       TEXT,
  timezone    TEXT NOT NULL DEFAULT 'UTC',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- business_settings
-- One row per business. Controls booking behaviour and AI tone.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_settings (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  language                      TEXT NOT NULL DEFAULT 'en',   -- e.g. 'en', 'he', 'ar'

  booking_enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  confirmation_required         BOOLEAN NOT NULL DEFAULT TRUE, -- customer must confirm before creating

  default_slot_duration_minutes INTEGER NOT NULL DEFAULT 30,

  cancellation_policy_text      TEXT,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT business_settings_business_id_unique UNIQUE (business_id)
);

-- ============================================================
-- staff_members
-- People who take appointments at the business.
-- ============================================================

CREATE TABLE IF NOT EXISTS staff_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  name        TEXT NOT NULL,
  phone       TEXT,

  active      BOOLEAN NOT NULL DEFAULT TRUE,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- business_hours
-- General weekly schedule for the business as a whole.
-- day_of_week: 0 = Sunday, 1 = Monday … 6 = Saturday
-- opens_at / closes_at stored as "HH:MM" strings in the
-- business's local timezone (see businesses.timezone).
-- ============================================================

CREATE TABLE IF NOT EXISTS business_hours (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),

  opens_at    TEXT,           -- "HH:MM", null when is_closed = true
  closes_at   TEXT,           -- "HH:MM", null when is_closed = true

  is_closed   BOOLEAN NOT NULL DEFAULT FALSE,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT business_hours_unique_day UNIQUE (business_id, day_of_week)
);

-- ============================================================
-- staff_working_hours
-- Optional per-staff weekly schedule.
-- Falls back to business_hours when no row exists for a staff member.
-- Not used by availability logic yet — prepared for future use.
-- ============================================================

CREATE TABLE IF NOT EXISTS staff_working_hours (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  staff_member_id UUID NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,

  day_of_week     SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),

  opens_at        TEXT,           -- "HH:MM", null when is_closed = true
  closes_at       TEXT,           -- "HH:MM", null when is_closed = true

  is_closed       BOOLEAN NOT NULL DEFAULT FALSE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT staff_working_hours_unique_day UNIQUE (business_id, staff_member_id, day_of_week)
);

-- ============================================================
-- service_categories
-- Optional grouping for services. Nullable on services.
-- e.g. "Hair", "Nails", "Massage", "Consultations"
-- ============================================================

CREATE TABLE IF NOT EXISTS service_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  name        TEXT NOT NULL,
  description TEXT,

  active      BOOLEAN NOT NULL DEFAULT TRUE,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT service_categories_unique_name_per_business UNIQUE (business_id, name)
);

-- ============================================================
-- services
-- What the business offers (haircut, physiotherapy session, etc.)
-- ============================================================

CREATE TABLE IF NOT EXISTS services (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  category_id      UUID REFERENCES service_categories(id) ON DELETE SET NULL,  -- optional grouping

  name             TEXT NOT NULL,
  description      TEXT,

  duration_minutes INTEGER NOT NULL DEFAULT 30,
  price            NUMERIC(10, 2),          -- nullable: some businesses don't show prices

  active           BOOLEAN NOT NULL DEFAULT TRUE,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- customers
-- Unique per (business_id, phone). A person can exist as a
-- customer at many businesses independently.
-- ============================================================

CREATE TABLE IF NOT EXISTS customers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  phone       TEXT NOT NULL,
  name        TEXT,
  notes       TEXT,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT customers_unique_phone_per_business UNIQUE (business_id, phone)
);

-- ============================================================
-- appointments
-- ============================================================

CREATE TABLE IF NOT EXISTS appointments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  service_id      UUID REFERENCES services(id) ON DELETE SET NULL,
  staff_member_id UUID REFERENCES staff_members(id) ON DELETE SET NULL,  -- nullable: not all businesses assign staff

  start_time  TIMESTAMPTZ NOT NULL,
  end_time    TIMESTAMPTZ NOT NULL,

  -- pending | confirmed | cancelled | completed | no_show
  status      TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),

  -- whatsapp | dashboard | manual | system | platform (booking platform — migration 007)
  source      TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (source IN ('whatsapp', 'dashboard', 'manual', 'system', 'platform')),

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- messages
-- All inbound and outbound WhatsApp messages.
-- customer_id is nullable: set once the customer is identified.
-- ============================================================

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,

  -- inbound | outbound
  direction       TEXT NOT NULL
    CHECK (direction IN ('inbound', 'outbound')),

  -- whatsapp (extensible for future channels)
  channel         TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (channel IN ('whatsapp')),

  from_phone      TEXT,
  to_phone        TEXT,

  body            TEXT,

  raw_payload     JSONB,          -- full webhook payload or Meta API response

  meta_message_id TEXT,           -- Meta's wamid — used for deduplication and status updates

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- conversation_states
-- Persists the booking flow state per (business, customer).
-- One active row per customer per business at a time.
-- context stores whatever the active flow needs (intent, slots, etc.)
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_states (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- e.g. 'idle' | 'collecting_service' | 'collecting_date' | 'pending_confirmation'
  state       TEXT NOT NULL DEFAULT 'idle',

  context     JSONB NOT NULL DEFAULT '{}',

  expires_at  TIMESTAMPTZ,       -- null = never expires; set for time-limited flows

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT conversation_states_unique_per_customer UNIQUE (business_id, customer_id)
);

-- ============================================================
-- Indexes
-- ============================================================

-- business_id on every tenant table (fast tenant queries)
CREATE INDEX IF NOT EXISTS idx_business_settings_business_id    ON business_settings(business_id);
CREATE INDEX IF NOT EXISTS idx_staff_members_business_id         ON staff_members(business_id);
CREATE INDEX IF NOT EXISTS idx_business_hours_business_id        ON business_hours(business_id);
CREATE INDEX IF NOT EXISTS idx_staff_working_hours_business_id   ON staff_working_hours(business_id);
CREATE INDEX IF NOT EXISTS idx_staff_working_hours_staff_id      ON staff_working_hours(staff_member_id);
CREATE INDEX IF NOT EXISTS idx_service_categories_business_id    ON service_categories(business_id);
CREATE INDEX IF NOT EXISTS idx_services_business_id              ON services(business_id);
CREATE INDEX IF NOT EXISTS idx_services_category_id              ON services(category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_business_id             ON customers(business_id);
CREATE INDEX IF NOT EXISTS idx_appointments_business_id          ON appointments(business_id);
CREATE INDEX IF NOT EXISTS idx_appointments_staff_member_id      ON appointments(staff_member_id) WHERE staff_member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_business_id              ON messages(business_id);
CREATE INDEX IF NOT EXISTS idx_conversation_states_business_id   ON conversation_states(business_id);

-- Customer phone lookup
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

-- Appointment time range queries (overlap detection, calendar views)
CREATE INDEX IF NOT EXISTS idx_appointments_start_time ON appointments(business_id, start_time);
CREATE INDEX IF NOT EXISTS idx_appointments_end_time   ON appointments(business_id, end_time);

-- Message deduplication by Meta message ID
CREATE INDEX IF NOT EXISTS idx_messages_meta_message_id ON messages(meta_message_id)
  WHERE meta_message_id IS NOT NULL;

-- Conversation lookup by customer
CREATE INDEX IF NOT EXISTS idx_conversation_states_customer_id ON conversation_states(customer_id);

-- ============================================================
-- updated_at trigger function
-- Automatically refreshes updated_at on any UPDATE.
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply the trigger to all tables that have updated_at
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'businesses',
      'business_settings',
      'staff_members',
      'business_hours',
      'staff_working_hours',
      'service_categories',
      'services',
      'customers',
      'appointments',
      'conversation_states'
    ])
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_updated_at ON %I;
       CREATE TRIGGER trg_updated_at
         BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION update_updated_at();',
      t, t
    );
  END LOOP;
END;
$$;

-- ============================================================
-- Grants — allow PostgREST roles to access all public tables.
-- Run once after creating tables. Safe to re-run.
-- ============================================================

GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ============================================================
-- knowledge_base_items
-- Structured knowledge entries the AI receptionist uses to
-- answer common questions (FAQs, pricing, policies, etc.).
-- ============================================================

CREATE TABLE IF NOT EXISTS knowledge_base_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- about | faq | pricing | parking | policy | contact | custom
  category    TEXT NOT NULL DEFAULT 'faq'
    CHECK (category IN ('about', 'faq', 'pricing', 'parking', 'policy', 'contact', 'custom')),

  title       TEXT NOT NULL,
  content     TEXT NOT NULL,

  active      BOOLEAN NOT NULL DEFAULT TRUE,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- ai_settings
-- Controls how the AI receptionist presents itself.
-- One row per business (enforced by UNIQUE constraint).
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_settings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  assistant_name      TEXT NOT NULL DEFAULT 'Assistant',

  -- friendly | professional | luxury | casual
  tone                TEXT NOT NULL DEFAULT 'friendly'
    CHECK (tone IN ('friendly', 'professional', 'luxury', 'casual')),

  -- short | medium | long
  response_length     TEXT NOT NULL DEFAULT 'medium'
    CHECK (response_length IN ('short', 'medium', 'long')),

  -- none | low | medium
  emoji_usage         TEXT NOT NULL DEFAULT 'low'
    CHECK (emoji_usage IN ('none', 'low', 'medium')),

  language            TEXT NOT NULL DEFAULT 'en',

  custom_instructions TEXT,

  -- Persona depth (migration 008) — each business shapes its own receptionist.
  business_type       TEXT,   -- "מספרה", "מרפאת שיניים", … frames the persona
  persona_voice       TEXT,   -- richer free-text personality beyond the tone preset
  things_to_avoid     TEXT,   -- explicit guardrails the receptionist must respect

  -- AI control toggles (see migration 005). Disabling AI never affects bookings.
  ai_enabled               BOOLEAN NOT NULL DEFAULT TRUE,  -- master switch for the Gemini layer
  faq_enabled              BOOLEAN NOT NULL DEFAULT TRUE,  -- answer FAQ questions
  intent_detection_enabled BOOLEAN NOT NULL DEFAULT TRUE,  -- act on detected booking intent

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ai_settings_business_id_unique UNIQUE (business_id)
);

-- ============================================================
-- ai_events
-- Safe, non-sensitive log of Gemini activity (monitoring & cost visibility).
-- Stores metadata only — never the API key, prompt, context, or message text.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id   UUID REFERENCES customers(id) ON DELETE SET NULL,

  called        BOOLEAN NOT NULL DEFAULT FALSE,   -- was the Gemini API actually called?
  intent        TEXT,                             -- detected intent, or NULL
  confidence    NUMERIC(4, 3),                    -- 0.000–1.000, or NULL
  success       BOOLEAN NOT NULL DEFAULT TRUE,    -- decision resolved without error?
  response_type TEXT,                             -- faq_answer | booking_confirm | irrelevant | ...

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Indexes for new tables
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_knowledge_base_items_business_id ON knowledge_base_items(business_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_base_items_category    ON knowledge_base_items(business_id, category);
CREATE INDEX IF NOT EXISTS idx_knowledge_base_items_active      ON knowledge_base_items(business_id, active);
CREATE INDEX IF NOT EXISTS idx_ai_settings_business_id          ON ai_settings(business_id);
CREATE INDEX IF NOT EXISTS idx_ai_events_business_id            ON ai_events(business_id);
CREATE INDEX IF NOT EXISTS idx_ai_events_business_created       ON ai_events(business_id, created_at);

-- ============================================================
-- updated_at triggers for new tables
-- ============================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'knowledge_base_items',
      'ai_settings'
    ])
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_updated_at ON %I;
       CREATE TRIGGER trg_updated_at
         BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION update_updated_at();',
      t, t
    );
  END LOOP;
END;
$$;

-- ============================================================
-- Safe migrations
-- Run these AFTER the initial schema is in place.
-- All statements are idempotent — safe to re-run.
-- ============================================================

-- 1. conversation_states uniqueness
--    The UNIQUE constraint is declared in CREATE TABLE above.
--    This block adds it retroactively on deployments that were
--    created before the constraint existed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversation_states_unique_per_customer'
      AND conrelid = 'conversation_states'::regclass
  ) THEN
    ALTER TABLE conversation_states
      ADD CONSTRAINT conversation_states_unique_per_customer
      UNIQUE (business_id, customer_id);
  END IF;
END $$;

-- 2. Appointment slot-collision prevention
--    Two unique partial indexes cover both cases:
--    (a) business with no staff assignment (staff_member_id IS NULL)
--    (b) business with staff assignment (staff_member_id IS NOT NULL)
--    Only active appointments (pending / confirmed) are considered.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_no_double_book_no_staff
  ON appointments (business_id, start_time)
  WHERE status IN ('pending', 'confirmed')
    AND staff_member_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_no_double_book_with_staff
  ON appointments (business_id, staff_member_id, start_time)
  WHERE status IN ('pending', 'confirmed')
    AND staff_member_id IS NOT NULL;

-- 3. Outbound message send status
--    Tracks whether the WhatsApp API call succeeded.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS send_status TEXT DEFAULT 'pending'
    CHECK (send_status IN ('pending', 'sent', 'failed'));

-- 4. WhatsApp message timestamp
--    Stores the original timestamp from the Meta payload (Unix epoch converted to UTC).
--    Distinct from created_at (which records when the server received the webhook).
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS wa_timestamp TIMESTAMPTZ;

-- 5. Booking platform events + waitlist (migration 007)
--    The system DETECTS events; the AI COMMUNICATES them (TRANSITION_PLAN.md).
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
  status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processed', 'skipped')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_events_business_id    ON events(business_id);
CREATE INDEX IF NOT EXISTS idx_events_pending        ON events(business_id, status, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_events_appointment_id ON events(appointment_id)
  WHERE appointment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS waitlist_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  service_id  UUID REFERENCES services(id) ON DELETE SET NULL,
  date_from   DATE,
  date_to     DATE,
  time_from   TEXT,
  time_to     TEXT,
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

-- 6. WhatsApp integration health (migration 006)
--    Per-business delivery health; auth_failed suspends AI replies until the
--    Meta token is reconnected (dashboard surfaces the alert).
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS whatsapp_status TEXT NOT NULL DEFAULT 'healthy'
    CHECK (whatsapp_status IN ('healthy', 'degraded', 'auth_failed'));
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS last_whatsapp_error TEXT;
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS last_whatsapp_error_at TIMESTAMPTZ;
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS whatsapp_consecutive_failures INTEGER NOT NULL DEFAULT 0;
