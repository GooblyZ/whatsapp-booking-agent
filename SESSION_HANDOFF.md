# SESSION_HANDOFF — receptionist-core (updated 2026-06-12, post-pivot)

## What this project is
A Gemini-powered **WhatsApp AI receptionist** for Israeli SMBs — **now transitioning**
(owner decision 2026-06-12, see `TRANSITION_PLAN.md`) from conversational scheduling to
a **booking platform** architecture: the AI converses, answers FAQs and detects intent;
the web platform (`/book/[slug]`, `/appointment/[id]`) owns booking/cancel/reschedule
deterministically. *"Gemini understands. Gemini speaks. The system validates and
executes."* Next.js 16 + Supabase + Meta WhatsApp Cloud API + gemini-2.5-flash-lite
(single model, single call per turn).

## Current status
- Phase 1–3 of the transition are BUILT and validated: booking page, self-service
  page, `BOOKING_MODE` flag + AI intent routing, event/waitlist schema (migration 007,
  NOT yet applied), fail-open event emitter, jobs-runner skeleton.
- Lint ✅ Build ✅ — full sim suite green incl. new **scenario 22 (platform mode)**.
- **Live behavior is UNCHANGED**: `BOOKING_MODE` defaults to `conversational`.
  Flipping to `platform` is a founder action (requires `PUBLIC_BASE_URL`).
- Battle-tested conversational stack remains intact as the fallback.

## Biggest risks / founder checkpoints
1. **Flip `BOOKING_MODE=platform`** only after setting `PUBLIC_BASE_URL` (ngrok URL)
   and a manual walk through `/book/[slug]` on a phone.
2. Migrations **006 + 007 not applied** to the live DB (apply in Supabase SQL editor).
3. **Stale dev server** — restart before any live testing.
4. **Meta access token expires** silently (degraded mode catches it).
5. Old known bugs (today-anchor, junk live data) still open in conversational mode —
   they disappear in platform mode but matter until the flip.

## Most important files
`TRANSITION_PLAN.md` (architecture decision record) ·
`lib/booking/platform.ts` (deterministic booking service) ·
`app/book/[slug]/` + `app/appointment/[id]/` (customer UI) ·
`lib/ai/platform-turn.ts` (platform-mode AI turn + link routing) ·
`lib/booking/outbound.ts` (single outbound chokepoint) ·
`lib/ai/idle-handler.ts` + `lib/booking/flow.ts` (legacy conversational path) ·
`scripts/simulate-conversations.ts` (regression suite).

## Next recommended actions (in order)
1. Owner: set `PUBLIC_BASE_URL`, walk through `/book/[slug]` + `/appointment/[id]`
   manually (phone, RTL, slot flow), apply migrations 006+007.
2. Flip `BOOKING_MODE=platform` on the dev server → live WhatsApp test: booking intent
   → link → book on page → WhatsApp confirmation arrives.
3. Waitlist end-to-end (join UI + cancellation watcher + AI outreach) — phase 4.
4. Reminders via the events runner (`/api/jobs/process`) — phase 5.
5. After platform mode is live-proven: remove conversational machinery + rewrite the
   sim suite around platform flows (phase 6, owner-approved).

**Rules of engagement** live in `CLAUDE.md` (no model change, no routing, no cost
optimization, deterministic booking-critical paths, sims after every fix).
