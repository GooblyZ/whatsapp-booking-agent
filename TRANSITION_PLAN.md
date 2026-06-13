# TRANSITION_PLAN — Platform-Driven Booking (pivot of 2026-06-12)

> Founder decision: scheduling moves OUT of the AI conversation into a visual booking
> platform. The AI focuses on conversation, FAQ, personalization, and intent detection;
> it ROUTES customers into deterministic flows instead of running them in chat.
> This document is the architecture decision record for the transition.
> It supersedes the conversational-booking portions of CLAUDE.md where they conflict.

## Target architecture

```
WhatsApp customer
   │
   ▼
webhook → message-handler → flow.ts router
   │
   ▼
AI layer (ONE Gemini call, unchanged principle)
   • natural conversation, FAQ from business facts, personalization (ai_settings)
   • detects intent: BOOK / CANCEL / RESCHEDULE
   • platform mode: replies naturally + system appends a BOOKING LINK (deterministic,
     never model-written)
   │
   ▼
Booking platform (web, mobile-first, RTL Hebrew)
   • /book/[slug]            service → day → visual slot grid → details → confirm
   • /appointment/[id]       self-service view / cancel / reschedule (uuid = token)
   • shares the SAME deterministic engine: getAvailableSlots, isIntervalFree,
     pre-insert re-check, unique-index collision handling
   │
   ▼
Event layer (migration 007)
   • events table: booked / cancelled / rescheduled / reminder_due / waitlist_opportunity / abandoned_booking
   • emitters are fail-open (never block a booking or a reply)
   • the SYSTEM decides; the AI COMMUNICATES (WhatsApp messages through the
     settings chokepoint)
   • waitlist table + watcher: cancellation frees a slot → matching waitlist entries
     get a booking-opportunity message with a link
```

## Strangler-fig strategy (why nothing breaks)

`BOOKING_MODE` (env, later per-business column):
- `conversational` — DEFAULT. The live system behaves exactly as today. All 20 sim
  scenarios stay green. Zero behavioral change until the founder flips the flag.
- `platform` — AI stops collecting booking details; intent → link routing; persona
  drops the scheduling machinery; booking happens on /book/[slug].

The conversational machinery (booking-session merge, verdict alignment, confirmation
arming, legacy menus) is NOT deleted in this phase. It is decommissioned by the flag
and removed in a later cleanup phase once the platform path is live-proven.

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Booking platform MVP: /book/[slug] (mobile-first RTL wizard), /appointment/[id] self-service | ✅ done |
| 2 | BOOKING_MODE flag + AI intent-routing (platform persona, link appending), WhatsApp booking confirmations | ✅ done |
| 3 | Event architecture: migration 007 (events, waitlist, source='platform'), fail-open emitter, /api/jobs/process runner | ✅ done |
| 4a | Receptionist quality: customer-state awareness (new/returning/name), sharper FAQ/escalation/ambiguity in the persona | ✅ done (cycle 1) |
| 4b | Booking platform UX polish: trust chips, structured detail card, aria-live states, RTL/a11y | ✅ done (cycle 2) |
| 4c | AI Settings product area: migration 008 (business_type/persona_voice/things_to_avoid), strangler-safe writes, dashboard | ✅ done (cycle 3) |
| 4d | Waitlist vertical slice (join on full days, freed-slot matcher, FIFO notify) + reminder processor in the job runner | ✅ done (cycle 4) |
| 5 | SMS/email reminder channels (channel abstraction in events payload), calendar files (.ics → Google/Apple/Outlook) | next |
| 5b | Abandonment + inactivity re-engagement (needs start-tracking / inactivity scan — cadence + privacy is a founder decision) | foundation only |
| 6 | Conversational-machinery removal + sim-suite rewrite around platform flows | after platform mode is live-proven |
| 7 | AI settings deepening (per-business behavior packs, richer KB tooling) | continuous |

## Founder checkpoints (decisions only the owner can make)

1. **Flip `BOOKING_MODE=platform`** — requires: `PUBLIC_BASE_URL` set to the public
   (ngrok or deployed) URL so links resolve; a quick manual run through /book/[slug].
2. **Apply migration `007_platform_events_waitlist.sql`** in the Supabase SQL editor
   (manual, like all migrations). Until applied: bookings still work — the code
   fails soft (source falls back, events/waitlist are skipped with a log line).
2b. **Apply migration `008_ai_settings_persona_depth.sql`** to enable the advanced
   AI-settings fields (business_type / persona_voice / things_to_avoid). Until then
   the dashboard saves core settings and shows a notice; the persona omits them.
2c. **Set `JOBS_SECRET`** and schedule `POST /api/jobs/process` (cron / Task Scheduler /
   Vercel cron, e.g. every 15 min) to drive reminders + waitlist notifications.
   Without it the runner returns 503 and nothing is sent.
3. **Phone verification policy** for public bookings (MVP ships without OTP; appointment
   links are unguessable uuids; consider WhatsApp-code verification before real launch).
4. **Deleting the conversational machinery** (phase 6) once satisfied with platform mode.

## What carries over unchanged

- One Gemini call per turn; model/config untouched.
- Owner AI settings as style authority; grounding fence; degraded modes; burst handling.
- The deterministic availability/INSERT core — now shared by chat (legacy) and web.
- Logging hygiene (no PII/prompt logging), fail-open telemetry.

## New invariants

- The AI never writes URLs from the model — links are appended by the system.
- The platform pages never call the AI — they are fully deterministic.
- Platform availability filters past times for today (fixes known bug #2 on the new path).
- Events are observations, not commands: emit failure must never fail the action.
