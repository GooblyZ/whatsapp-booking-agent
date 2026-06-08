-- ============================================================
-- receptionist-core — Demo / Seed Data
-- ============================================================
-- Run this in the Supabase SQL Editor AFTER schema.sql.
-- Requires at least one row in the businesses table.
-- Safe to run multiple times (idempotent).
-- ============================================================

DO $$
DECLARE
  biz_id UUID := '574dd51c-b4a9-4637-8510-dd02b578b15d';
BEGIN
  -- Verify the business exists
  IF NOT EXISTS (SELECT 1 FROM businesses WHERE id = biz_id) THEN
    RAISE EXCEPTION 'Business % not found. Check DEFAULT_BUSINESS_ID in .env.local.', biz_id;
  END IF;

  -- Set business timezone if still at default UTC
  UPDATE businesses
  SET timezone = 'Asia/Jerusalem'
  WHERE id = biz_id AND timezone = 'UTC';

  -- ── Business hours ──────────────────────────────────────────
  -- Sun-Thu 09:00-18:00, Fri 09:00-14:00, Sat closed
  INSERT INTO business_hours (business_id, day_of_week, opens_at, closes_at, is_closed)
  VALUES
    (biz_id, 0, '09:00', '18:00', false),  -- Sunday
    (biz_id, 1, '09:00', '18:00', false),  -- Monday
    (biz_id, 2, '09:00', '18:00', false),  -- Tuesday
    (biz_id, 3, '09:00', '18:00', false),  -- Wednesday
    (biz_id, 4, '09:00', '18:00', false),  -- Thursday
    (biz_id, 5, '09:00', '14:00', false),  -- Friday
    (biz_id, 6, NULL,    NULL,    true)     -- Saturday (closed)
  ON CONFLICT (business_id, day_of_week) DO NOTHING;

  -- ── Services ────────────────────────────────────────────────
  INSERT INTO services (business_id, name, description, duration_minutes, price, active)
  SELECT biz_id, 'תספורת', 'תספורת לגברים ונשים', 30, 80, true
  WHERE NOT EXISTS (SELECT 1 FROM services WHERE business_id = biz_id AND name = 'תספורת');

  INSERT INTO services (business_id, name, description, duration_minutes, price, active)
  SELECT biz_id, 'צביעת שיער', 'צביעה מלאה', 90, 250, true
  WHERE NOT EXISTS (SELECT 1 FROM services WHERE business_id = biz_id AND name = 'צביעת שיער');

  INSERT INTO services (business_id, name, description, duration_minutes, price, active)
  SELECT biz_id, 'פן ועיצוב', 'פן ועיצוב שיער', 45, 120, true
  WHERE NOT EXISTS (SELECT 1 FROM services WHERE business_id = biz_id AND name = 'פן ועיצוב');

  -- ── Staff member ────────────────────────────────────────────
  INSERT INTO staff_members (business_id, name, active)
  SELECT biz_id, 'מנהל הסלון', true
  WHERE NOT EXISTS (SELECT 1 FROM staff_members WHERE business_id = biz_id);

END $$;
