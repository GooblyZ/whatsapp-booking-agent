-- ============================================================
-- Migration 011 — enable Row Level Security on all public tables
--
-- Apply MANUALLY in the Supabase SQL editor (no migration runner).
-- Idempotent: ENABLE ROW LEVEL SECURITY on an already-enabled table is a no-op.
--
-- WHY THIS IS SAFE / WHY THERE ARE NO POLICIES
-- --------------------------------------------
-- The application reaches Postgres ONLY through the service_role key
-- (lib/supabase/server.ts -> supabaseServer()). service_role has the BYPASSRLS
-- attribute, so RLS policies never apply to it: every server flow keeps working
-- unchanged — public booking, appointment create / reschedule / cancel, the
-- waitlist, the dashboard, and the WhatsApp pipeline all run server-side as
-- service_role.
--
-- The anon key (NEXT_PUBLIC_SUPABASE_ANON_KEY) is shipped in the browser bundle
-- but is NEVER used to query the DB — lib/supabase/client.ts (supabaseClient())
-- has zero importers in the codebase. Today, with RLS disabled, that public key
-- can still read/write every row (all customers, phone numbers, appointments,
-- messages) directly via PostgREST.
--
-- Enabling RLS with NO permissive policies flips anon/authenticated to
-- deny-by-default while service_role keeps full access. That is the MINIMUM and
-- STRICTEST safe configuration for this architecture. Adding anon SELECT/INSERT
-- policies would REGRESS security (it would re-open the public key) and is
-- intentionally omitted. Per-appointment access for /appointment/[id] remains
-- gated in application code by the unguessable UUID token, unchanged by this.
--
-- ai_events (migration 004) and events + waitlist_entries (migration 007) already
-- have RLS enabled, so they are not repeated here.
-- ============================================================

ALTER TABLE public.businesses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_settings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_hours       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_working_hours  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_categories   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_states  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_base_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_settings          ENABLE ROW LEVEL SECURITY;

-- Verify (optional): every public table should report rowsecurity = true.
--   SELECT relname, relrowsecurity FROM pg_class
--   WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY relname;
