# CURRENT_STATE — receptionist-core (as of 2026-06-12, post-pivot)

Lint ✅ · Build ✅ · Simulation suite green (scenarios 1–19, 21, 22 — there is no #20;
last full run 2026-06-12, includes the new platform-mode scenario 22).

## PRODUCT TRANSITION (owner decision 2026-06-12 — see TRANSITION_PLAN.md)
Scheduling moves OUT of the AI conversation into the **booking platform**. Built and
validated this session (live behavior unchanged until the owner flips the flag):
- **`/book/[slug]`** — public mobile-first RTL booking wizard (service → day → visual
  slot grid → details → deterministic booking + WhatsApp confirmation with manage link).
  Past times today are filtered (+15-min lead) — the old bug #3 never reaches this path.
- **`/appointment/[id]`** — self-service view / cancel / reschedule (uuid link).
- **`lib/booking/platform.ts`** — deterministic platform service layer (shares
  getAvailableSlots / isIntervalFree / collision handling with the chat path).
- **`BOOKING_MODE` flag** — `conversational` (default, exact pre-pivot behavior) |
  `platform` (AI detects BOOK/CANCEL/RESCHEDULE intent → system attaches links;
  `lib/ai/platform-turn.ts`; persona drops all scheduling machinery).
  > **`conversational` is LEGACY/DEPRECATED (Risk G).** All the reliability guards
  > (low-signal/quiet mode, evidence gate, emoji handling, link-wording fences) live in
  > platform mode only. `flow.ts` now emits a once-per-process `console.warn` when running
  > conversational so no business is silently deployed on the unprotected path — set
  > `BOOKING_MODE=platform` for production.
- **Event layer** — migration `007_platform_events_waitlist.sql` (events + waitlist
  tables + source='platform'; NOT yet applied), fail-open emitter (`lib/events/emit.ts`),
  jobs-runner skeleton (`POST /api/jobs/process`, JOBS_SECRET-gated).
- **`lib/booking/outbound.ts`** — single outbound chokepoint shared by chat + platform.

Founder checkpoints before flipping: set `PUBLIC_BASE_URL`, apply migrations 006+007,
manual phone walkthrough of both pages. Phases 4–6 (waitlist e2e, reminders,
conversational-machinery removal) are scoped in TRANSITION_PLAN.md.

### Phase 4+ progress (2026-06-13)
- **Receptionist quality (both modes)**: per-turn CUSTOMER block (new/returning, name,
  visit history — `renderCustomerState`); persona uses it (greet regulars by name);
  sharper FAQ (answer-first), honest escalation, one-question ambiguity handling.
- **Booking UX polish**: trust chips, structured detail card (confirm + success),
  `aria-live` slot states, RTL/a11y, service-card affordances.
- **AI Settings = "Define your receptionist"** (SIMPLIFIED 2026-06-13, latest):
  the form is now five plain sections (Capabilities / Identity / Personality /
  Writing style / Hard rules). `tone` presets and `business_type` were RETIRED from
  the UI + persona (the AI learns the business from facts/services/KB; both columns
  kept dormant as read-only back-compat — persona still reads `tone` as a silent
  fallback for configs that only set one). Personality is ONE natural-language field
  (`custom_instructions`) + an optional **✨ enhance** button (`lib/ai/persona-enhance.ts`,
  `enhancePersonaAction`) that rewrites the description via one fail-soft, settings-time
  Gemini call — NOT on the customer-turn path (`brain.ts` is still the only per-turn
  call site). Added **`assistant_gender`** (Identity) for Hebrew self-reference
  ("אני שמחה" vs "אני שמח"); default neutral; does not change customer-directed phrasing.
  Predefined starter templates were REMOVED (user-owned named profiles are the next
  pass). `updateAISettings` is now precise-strangler-safe (drops only the offending
  unknown column on a missing-column error). Migrations 008 + 009 applied; **migration
  010 (`assistant_gender`) is NEW and not yet applied** — until then the strangler
  drops the column on save and reads default to neutral (no behavior gap).
- **Waitlist vertical slice**: join on fully-booked days; freed-slot matcher
  (`lib/booking/waitlist.ts`); cancel/reschedule (platform + dashboard) emit freed
  slots; `lib/events/process.ts` notifies the earliest waitlist match (FIFO, cap 1).
- **Reminders**: `enqueueDueReminders` (24h window, idempotent) + reminder processor;
  driven by `POST /api/jobs/process` (JOBS_SECRET-gated; 503 until set).
- **Audit**: confirmed all appointment writes are deterministic (`flow.ts` +
  `platform.ts`); `lib/ai/` never mutates appointments.
- Sim scenarios: 24 (receptionist quality), 25 (rewritten → "Define your receptionist":
  one description, gender self-reference, format precedence, legacy back-compat),
  26 (waitlist windows). Lint+build+full suite green.
- New founder checkpoints: **apply migration 010** (`assistant_gender`) to enable the
  gender field (the code is fail-soft until then); set JOBS_SECRET + schedule the runner.

## What currently works (validated live and/or in sims)
- End-to-end WhatsApp booking in Hebrew: greeting → any-order field collection →
  real availability check → deterministic "כן" confirmation → DB INSERT → receipt.
- Typo-tolerant parsing: "5 וןצי"/"חמש וחצי"/"וחןצי" → 17:30; "יופ חמישי" → Thursday;
  "ט6ב אז יון ראשון הבא" → Sunday; negated weekdays ("לא שלישי, אמרתי חמישי").
- Corrections & changes: day/time/service reopening, rejected slots never re-offered,
  un-reject on explicit mention, time retained through day changes.
- FAQ during booking with context retention; FAQ → booking switch carrying the service.
- Availability truth: closed/outside/taken/available verdicts enforced on the reply
  (verdict alignment), off-grid times accepted on free intervals, same-turn
  confirmation when the last field arrives via Gemini.
- Honesty fences: booked-claim fence, false-closed-claim correction, date echo,
  confirmation CTA, next-step backstop, confusion/duplicate recovery.
- Gemini 503 resilience: in-call retry, 2-strike 60s cooldown, fully deterministic
  degraded turns (booking continues with zero AI calls), notice-once UX, auto-recovery.
- Meta auth failure degraded mode: inbound saved, AI skipped, per-inbound auth probe,
  dashboard alert (alert persistence needs migration 006).
- Owner settings: tone/length/emoji/custom instructions visibly steer replies; emoji=none
  enforced on EVERY outbound (model, guard, and deterministic strings alike).
- Cost instrumentation: `[gemini-usage]`, `[gemini-prompt]`, engine token logs
  (~$0.0003/turn on flash-lite).
- Dashboard: appointments management, services/hours/settings/KB editing, AI debug panel,
  activity feed, health overview.

## What partially works
- **WhatsApp health dashboard banner** — code complete, but persistence columns come from
  migration 006 which is NOT applied to the live DB yet.
- **Multi-service requests** — the model promises combinations; only one service is
  actually bookable per appointment (known bug #5).
- **Service recommendation flow** ("מה אתה מציע?") — works, names real services after the
  persona fix, but quality is prompt-level (model variance).
- **Burst handling** — aggregate + supersede-at-send implemented and unit-sound, lightly
  exercised in production.
- **Degraded-mode FAQ** — during a 503 cooldown, FAQs get the "leave me details" notice
  instead of a real answer (facts exist; deterministic FAQ answering not built).

## What is broken (known, reproduced — status as of 2026-06-12 post-pivot session)
See PROJECT_CONTEXT.md "Known bugs" for the full list with fix ideas. Headlines:
1. ~~No "today is…" anchor in the prompt~~ **FIXED** — persona now carries a per-turn
   "TODAY/TOMORROW is…" anchor (both modes; sim scenario 23).
2. Past times today offered/bookable — **fixed on the PLATFORM path** (+15-min lead);
   still present in conversational-mode slot prompts (`getAvailableSlots` itself).
3. Past DD/MM silently books NEXT YEAR (no year in echo) — open (conversational only).
4. ~~`falseClosedClaim` misses "היום/מחר"~~ **FIXED** — relative day refs via
   `dayRefsFor` + `AvailabilityInfo.todayISO` (sim scenario 23).
5. Junk live data (services "בדיקה"/"שד", parking="שד") — open; clean via dashboard.

## What needs validation
- A full clean live WhatsApp run on the CURRENT code (the last live sessions ran older
  builds; **the dev server must be restarted** to pick up everything since).
- Meta access token validity (it expired once on 2026-06-09; degraded mode handles it,
  but bookings stop until refreshed).
- Migration 006 application + the dashboard banner appearing on a real auth failure.
- Off-grid booking INSERT path under concurrency (pre-insert interval check is new).
- Cooldown behavior on a real multi-minute 503 storm (sim-validated only).

## Highest priority next tasks
1. Add the **today/tomorrow date anchor** to the persona (1 line, fixes a whole class of
   weekday hallucinations).
2. **Past-time filter** for today in `getAvailableSlots` + `isIntervalFree`.
3. Apply **migration 006** in Supabase SQL editor; **clean junk business data** via
   dashboard (services בדיקה/שד, parking_instructions).
4. Extend `falseClosedClaim` to היום/מחר; extend the booked-claim regex
   (סגרנו/הזמנתי/רשמתי אותך) — with care not to match the fence's own output.
5. Restart dev server; run one full live WhatsApp regression of the original incident
   conversations.

## Medium priority
- DD/MM year-rollover guard (ask or echo the year when >60 days out).
- Time-format gaps: "17.30", "ב 5", "בשעה 16"; treat "אחרי/לפני X" as a preference window.
- Exclusion-date vocabulary ("אי אפשר", "חוץ מ", prefer the day after "רק").
- Multi-service honesty (persona line) or real multi-service booking.
- Webhook POST signature validation (X-Hub-Signature-256).
- Add `tsx` as a real devDependency so sims run on fresh clones.

## Low priority
- Cancel/reschedule execution (the conversational layer already refuses honestly).
- Multi-day availability scan.
- Outbound retry queue; durable (DB-backed) Gemini cooldown state.
- `ai_events` model/token columns for cost attribution.
- Split `booking-session.ts` (631 lines) / trim `flow.ts` (513) per the 500-line rule.
- Rename the GitHub repo (still `whatsapp-booking-agent`); delete `master` once the owner
  confirms `main` is good.
