# SESSION_HANDOFF — receptionist-core (written 2026-06-12)

## What this project is
A Gemini-powered **WhatsApp AI receptionist** for Israeli SMBs: natural-Hebrew
conversation (typos and all), grounded FAQ answers, any-order booking collection,
real availability checks, and a **deterministic** confirmation + DB insert. The AI never
executes anything — *"Gemini understands. Gemini speaks. The system validates and
executes."* Next.js 16 + Supabase + Meta WhatsApp Cloud API + gemini-2.5-flash-lite
(single model, single call per turn).

## Current status
- `main` @ `7df3fbc` on github.com/GooblyZ/whatsapp-booking-agent — all work committed.
- Lint ✅ Build ✅ — **20/20 simulation scenarios green** (suite replays real incidents).
- Battle-tested through ~6 live WhatsApp incident rounds; each failure became a
  deterministic guard + a regression scenario.
- 9 verified-but-unfixed bugs from the last manual QA round are documented (with fix
  ideas) in `PROJECT_CONTEXT.md` → "Known bugs"; the owner asked for review-only, so
  they await a green light.

## Biggest risks
1. **The model has no "today is…" anchor** → weekday/date hallucinations (top bug, 1-line fix).
2. **Past times today are bookable** (no now-filter in slot math).
3. **Stale dev server** — live tests have repeatedly run old code; restart before testing.
4. **Meta access token expires** silently (degraded mode catches it; bookings still stop).
5. Migration **006 not applied** to live DB; **junk live data** ("שד" services/parking)
   actively triggers hallucinations.

## Most important files
`lib/ai/idle-handler.ts` (engine) · `lib/ai/brain.ts` (Gemini turn) ·
`lib/ai/booking-session.ts` (state+Hebrew parsing) · `lib/ai/reply-polish.ts` (truth
guards) · `lib/booking/flow.ts` (router + the only INSERT) ·
`scripts/simulate-conversations.ts` (regression suite).

## Next recommended actions (in order)
1. Persona today-anchor line + falseClosedClaim היום/מחר extension.
2. Past-time filter for today (`getAvailableSlots` / `isIntervalFree`).
3. Apply migration 006; clean junk business data in the dashboard.
4. Restart dev server → full live WhatsApp regression of the incident conversations.
5. Then work down `CURRENT_STATE.md` → medium priority.

**Rules of engagement** live in `CLAUDE.md` (no model change, no routing, no cost
optimization, deterministic booking-critical paths, sims after every fix).
