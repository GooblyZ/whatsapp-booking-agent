-- 012: Durable outbound traceability (closes the outbound-safety audit loop).
--
-- Every customer-visible WhatsApp send already goes through ONE chokepoint
-- (lib/booking/outbound.ts) and is LOGGED with a src=…/reason=… tag. This makes that
-- trace DURABLE in the messages row so it is auditable from the database, not only from
-- logs — e.g. matching a WhatsApp STATUS callback's wamid back to the row that sent it.
--
-- No behavior change: the columns are NULLABLE with no backfill, and the code falls back
-- to the legacy insert if these columns are not yet present (so persistence keeps working
-- even before this migration is applied). Apply in the Supabase SQL editor, then restart.
--
-- NOTE: the outbound WhatsApp wamid is stored in the EXISTING messages.meta_message_id
-- column (its documented purpose: "Meta's wamid — used for deduplication and status
-- updates"). Inbound dedup is unaffected — inbound and outbound wamids never collide.
--
-- `source` intentionally has NO CHECK constraint: the enum lives in the TS type
-- (OutboundSource); keeping the column free-text means adding a future source value in
-- code can never be rejected by a stale DB constraint.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS source      TEXT,  -- ai_turn | deterministic | booking_platform | job_reminder | job_waitlist | recovery | dashboard | unknown
  ADD COLUMN IF NOT EXISTS reason      TEXT,  -- specific trigger (book_confirm, cancel_confirm, reminder_due, link_booking, brain branch, …)
  ADD COLUMN IF NOT EXISTS trigger_ref TEXT;  -- optional correlation id (e.g. appointment id for a booking-platform confirmation)

-- Analytics/audit lookups by source (partial — only labeled rows).
CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source) WHERE source IS NOT NULL;
