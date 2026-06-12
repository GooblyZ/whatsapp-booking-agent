# CURRENT_STATE — receptionist-core (as of 2026-06-12)

Git: `main` @ `7df3fbc` (= code of `f5ff9ce` "Add Gemini-powered AI receptionist…").
Lint ✅ · Build ✅ · Simulation suite: 20/20 scenarios green (numbered 1–19 and 21 — there
is no #20; last full run 2026-06-11).

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

## What is broken (known, reproduced, NOT yet fixed — owner asked for review first)
See PROJECT_CONTEXT.md "Known bugs" for the full list with fix ideas. Headlines:
1. No "today is…" anchor in the prompt → model misstates today/tomorrow weekday facts.
2. Past times today are offered/bookable (no now-filter in slot computation).
3. Past DD/MM silently books NEXT YEAR (no year in echo).
4. `falseClosedClaim` misses "היום/מחר" phrasing.
5. Junk live data (services "בדיקה"/"שד", parking="שד") actively causes hallucinations.

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
