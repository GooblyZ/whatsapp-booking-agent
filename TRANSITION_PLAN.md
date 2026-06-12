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
| 1 | Booking platform MVP: /book/[slug] (mobile-first RTL wizard), /appointment/[id] self-service | this transition |
| 2 | BOOKING_MODE flag + AI intent-routing (platform persona, link appending), WhatsApp booking confirmations | this transition |
| 3 | Event architecture: migration 007 (events, waitlist, source='platform'), fail-open emitter, /api/jobs/process runner skeleton | this transition |
| 4 | Waitlist end-to-end (join via page, watcher on cancellation, AI outreach) | next |
| 5 | Reminders (WhatsApp first; SMS/email via channel abstraction in events payload), calendar files (.ics generation → Google/Apple/Outlook) | next |
| 6 | Conversational-machinery removal + sim-suite rewrite around platform flows | after platform mode is live-proven |
| 7 | AI settings deepening (per-business behavior packs, richer KB tooling) | continuous |

## Founder checkpoints (decisions only the owner can make)

1. **Flip `BOOKING_MODE=platform`** — requires: `PUBLIC_BASE_URL` set to the public
   (ngrok or deployed) URL so links resolve; a quick manual run through /book/[slug].
2. **Apply migration `007_platform_events_waitlist.sql`** in the Supabase SQL editor
   (manual, like all migrations). Until applied: bookings still work — the code
   fails soft (source falls back, events are skipped with a log line).
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
