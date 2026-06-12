# PROJECT_CONTEXT — receptionist-core

> Full background for anyone (human or AI) picking up this project cold.
> Companion docs: `CURRENT_STATE.md` (what works), `REPOSITORY_MAP.md` (where things are),
> `CLAUDE.md` (rules), `SESSION_HANDOFF.md` (TL;DR).
>
> ⚠ **PRODUCT PIVOT (2026-06-12)**: this document describes the conversational-
> scheduling architecture, which is now the LEGACY path (`BOOKING_MODE=conversational`,
> still the live default). The target architecture — AI as conversation/intent layer,
> web booking platform as the scheduling owner, event-driven automation — is specified
> in **`TRANSITION_PLAN.md`**, which supersedes this document where they conflict.

## Product vision
A WhatsApp-first **AI receptionist SaaS** for Israeli small businesses (hair salons,
barbershops, clinics, studios). A customer texts the business's WhatsApp number in natural,
messy Hebrew; the AI receptionist answers questions, collects booking details
conversationally, checks **real** availability, and books appointments — feeling like a
reliable human receptionist, not a menu bot. The business owner manages everything
(services, hours, AI personality, knowledge base, appointments) from a web dashboard.

Guiding principle, stated by the product owner and enforced throughout the code:

> **"Gemini understands. Gemini speaks. The system validates and executes."**

The AI never writes to the database, never creates/cancels/changes appointments, and never
gets to claim something happened unless the deterministic system actually did it.

## Target customers
Hebrew-speaking SMB service businesses taking appointments over WhatsApp. One business per
deployment right now (`DEFAULT_BUSINESS_ID` routes all webhook traffic); the schema is
multi-tenant-shaped (every table keyed by `business_id`) but tenant routing/auth is not
built yet.

## Main user flows
1. **Customer books via WhatsApp**: greeting/smalltalk → service/day/time gathered in ANY
   order (typos tolerated) → system checks real availability → deterministic confirmation
   step (literal "כן") → DB INSERT → success message.
2. **Customer asks FAQs** (prices, hours, parking, address) mid-conversation — answered
   from grounded business facts, booking context retained.
3. **Customer corrects/changes details** ("לא אמרתי שלישי, אמרתי חמישי", "בעצם שעה אחרת")
   — fields reopen, rejected times never re-offered.
4. **Owner manages business** via `/dashboard`: appointments, services, hours, AI
   personality (tone/length/emoji/custom instructions), knowledge base, activity feed,
   AI debug panel.

## Current architecture (one inbound message, end to end)
```
Meta webhook POST /api/webhook/whatsapp
  → lib/message-handler.ts   dedup (wamid) → upsert customer → save inbound →
                             Meta-auth degraded gate → burst aggregation
  → lib/booking/flow.ts      AI-first router: explicit cancel / literal yes-no in
                             booking_confirm → deterministic; everything else → engine
  → lib/ai/idle-handler.ts   THE CONVERSATION ENGINE (one turn):
      1. load business context + AI settings (fresh每 turn)
      2. booking session load + deterministic pre-processing
         (change requests, offer rejection)
      3. memory (gap-bounded history) + upcoming appointments + send-failure check
      4. deterministic Hebrew probe (service/day/time) → REAL availability
      5. ONE Gemini call (lib/ai/brain.ts) → { reply, understanding }
         (or degraded mode: zero AI calls during 503 cooldown)
      6. merge understanding into session (+ probe rescue, confirm-state protection,
         credible-changeRequest gate, history time-recovery)
      6c. post-merge availability re-check (same-turn confirmation)
      7. loop/correction bookkeeping (stuck counter)
      8. guards: confusion recovery, redundant-question, stuck>=3, duplicate;
         verdict alignment; date echo; next-step backstop; emoji enforcement
      9. persist session/state; arm booking_confirm when ready+available
      10. booked-claim fence; CTA backstop; ai_events logging
  → flow.ts sends the reply (supersede check for bursts; settings chokepoint;
    send-health recording) and saves the outbound message
```

## Tech stack
- **Next.js 16.2.7** (App Router, Turbopack) — NOTE: breaking changes vs older Next;
  read `node_modules/next/dist/docs/` before framework-level work (see `AGENTS.md`).
- **React 19**, TypeScript 5, ESLint 9.
- **Supabase** (Postgres) via `@supabase/supabase-js` — service-role client server-side
  only (`lib/supabase/server.ts`); no ORM, no migration framework (SQL files applied
  manually in the Supabase SQL editor).
- **Meta WhatsApp Cloud API** (graph.facebook.com) for messaging.
- **Google Gemini** REST API (`gemini-2.5-flash-lite`) — direct fetch, no SDK.
- Dev tooling: `tsx` (installed ad-hoc via `npm i -D --no-save tsx`) for the scripts.

## AI architecture
- **Single model, single call per turn.** `lib/ai/gemini.ts` — `GEMINI_MODEL` env override,
  default `gemini-2.5-flash-lite`; `maxOutputTokens: 4096`; `thinkingConfig.thinkingBudget: 0`
  on 2.5-flash models (thinking tokens otherwise eat the output budget → truncated JSON);
  JSON response mime; 12s timeout; one in-call retry on 503; process-global overload
  cooldown (2 strikes → 60s degraded mode); per-request token/cost logging.
- **The brain** (`lib/ai/brain.ts`): pure — builds the persona instruction, calls Gemini
  with native multi-turn history, parses/validates the JSON, runs strict grounding
  (prices/times/phones must be backed by facts), maps failures to safe fallbacks.
  Returns `{ reply, understanding }`; understanding includes intent, appointmentIntent
  (BOOK/RESCHEDULE/CANCEL/MODIFY/LIST), extracted fields, changeRequest, correction flags.
- **The persona** (`lib/ai/persona.ts`): persona-dominant prompt; owner AI settings are
  the authoritative style layer (tone profiles + exemplars + hard length/emoji
  constraints + custom instructions with top priority); working-memory booking block;
  availability block; facts block; honesty rules (facts-only, never invent motives,
  history never outranks facts).
- **BookingSession** (`lib/ai/booking-session.ts`): the primary abstraction — a
  continuously evolving draft (service/day/time/goal/lifecycle/rejectedSlots/
  lastOfferedSlots/lastVerdict/stuckTurns), persisted in `conversation_states.context`.
  Deterministic Hebrew parsing lives here + `lib/ai/grounding.ts` (rich time parser:
  typos, spelled-out hours, fractions, daypart inference; negation-aware weekday dates).
- **Deterministic reliability layer** (`lib/ai/reply-polish.ts` + engine guards): verdict
  alignment (reply can never contradict availability), booked-claim fence ("התור נקבע"
  only after a real INSERT), date echo, confirmation CTA, next-step backstop, confusion/
  duplicate recovery, false-closed-claim correction, armed-confirmation protection.
- **Degraded modes**: Gemini 503 cooldown → fully deterministic turns (probe + recap +
  honest verdicts + booking continuation); Meta auth failure → inbound saved, AI skipped,
  auto-recovery probe per inbound (`lib/integration-health.ts`).
- **Memory** (`lib/ai/conversation.ts`): last 8 exchanges from the `messages` table,
  24h age cap, 6h conversation-gap boundary, fallback lines filtered from AI-facing turns.

## Booking architecture
- Slot grid: `lib/booking/availability.ts#getAvailableSlots` — grid stepped by service
  duration inside business hours, minus overlapping pending/confirmed appointments.
- Off-grid requested times verified by `isIntervalFree` (interval overlap check) — an
  empty day accepts 15:30 even on a 45-min grid.
- Requested-time evaluation: 4 categories — `closed_day / outside_hours / taken /
  available` (`lib/ai/availability-facts.ts`), fed to Gemini BEFORE it writes.
- Confirmation: ONLY the deterministic path books. Engine arms `booking_confirm` state
  when service+day+time set AND verdict=available; the router catches a literal yes
  (`parseYesNo` — "כן אבל..." is NOT a yes) → `handleConfirmation` → pre-insert
  `isIntervalFree` re-check → INSERT (unique-constraint collision → live alternatives).
- Legacy numbered-menu flow still exists in `flow.ts` as a technical fallback only
  (AI hard-down + customer typed "תור").

## WhatsApp integration architecture
- `app/api/webhook/whatsapp/route.ts`: GET = Meta verify (`META_VERIFY_TOKEN`);
  POST = inbound messages + status callbacks; routes by `DEFAULT_BUSINESS_ID`.
- `lib/whatsapp.ts`: send text via Cloud API; failure classification
  (auth/api/network/config); `checkWhatsAppAuth` probe (cheap GET on phone-number id).
- `lib/integration-health.ts`: per-business health (healthy/degraded/auth_failed),
  in-memory + best-effort persistence to `business_settings` (needs migration 006);
  dashboard banner on auth failure.
- Outbound messages saved with `send_status`; a recent failed send (≤45 min) makes the
  next reply open with a brief "הייתה לי תקלה" acknowledgement.

## Gemini integration architecture
See "AI architecture". Key facts: API key only ever lives in the request URL and is
redacted from every log; prompts and customer PII are never logged (char-size component
breakdown + token usage only); cost ≈ $0.0003–0.0004/turn at current prompt size
(~2.4–3.1K input tokens, ~160 output).

## Database structure overview (Supabase)
`supabase/schema.sql` is the canonical mirror; migrations in `supabase/migrations/`.
- `businesses` — tenant root (name, slug, phone, timezone).
- `business_settings` — booking flags, address/parking, (post-006: whatsapp_status,
  last_whatsapp_error, consecutive failures).
- `business_hours` — per weekday opens/closes/is_closed.
- `services` — name, duration_minutes, price, active.
- `staff` — basic staff records (not yet used by booking logic).
- `knowledge_base_items` — owner FAQ content by category.
- `ai_settings` — assistant_name, tone, response_length, emoji_usage, language,
  custom_instructions, ai_enabled/faq_enabled/intent_detection_enabled toggles.
- `customers` — per (business, phone).
- `messages` — full inbound/outbound log; wamid dedup; send_status; wa_timestamp.
  Doubles as the AI conversation memory source.
- `conversation_states` — per (business, customer): state machine
  (idle/booking_confirm/legacy menu states), `context.booking_session`, 24h TTL.
- `appointments` — start/end UTC, status (pending/confirmed/cancelled/completed),
  source; unique start_time per business guards exact-slot races.
- `ai_events` — safe AI telemetry (called, intent, success, response_type) — NO prompts,
  NO message text, NO PII.

## Dashboard structure (`app/dashboard/*`)
Password-gated (`DASHBOARD_ACCESS_PASSWORD` via `app/login` + `proxy.ts` middleware).
Pages: overview/health (page.tsx), appointments (+status actions), services,
business-hours, business-settings, knowledge-base, ai-settings, ai-assistant,
ai-debug (single-turn brain tester with extraction/grounding visibility), activity feed,
staff. Server actions per page (`actions.ts`).

## Key design decisions (and why)
1. **Conversation > intent classification.** One Gemini call returns reply + structured
   understanding; no separate classifier, no menu prison. (Menus made it feel like a bot.)
2. **AI never executes.** Every state change and the INSERT are deterministic; the AI's
   output is treated as untrusted input to be validated.
3. **Determinism wraps the model.** Every live incident became a deterministic guard:
   verdict alignment, booked-claim fence, rejected-slot tracking, confirm-state
   protection, etc. The model provides warmth; the system provides truth.
4. **Owner settings are the style authority** — history is explicitly subordinated to
   them (prevents style drift / template parroting from old messages).
5. **Single cheap model** (flash-lite) + rich prompt + guards, instead of model routing.
   An extractor/reply two-call split was designed and explicitly DEFERRED by the owner.
6. **Availability ≠ business hours.** The model is force-fed the system-computed verdict
   before writing; it may never infer slots from opening hours.
7. **Zero added latency for message bursts**: aggregate-on-arrival + supersede-at-send
   instead of debounce timers.
8. **Fail-open logging**: telemetry (ai_events, health persistence) never blocks replies.

## Important constraints (owner-mandated, do not violate)
- Do NOT change the Gemini model or add multi-model routing.
- Do NOT optimize cost at the expense of quality (explicitly stated several times).
- Do NOT weaken the custom personality system (custom_instructions are top style priority).
- Booking-critical decisions stay deterministic.
- Prefer contained fixes over refactors; keep files under ~500 lines (extract cohesive
  modules when they grow — `reply-polish.ts` exists for exactly this reason).
- Never log secrets, full prompts, or customer PII (phone numbers masked to last 4).

## Security considerations
- `SUPABASE_SERVICE_ROLE_KEY` is server-only; never import `lib/supabase/server.ts`
  client-side.
- Gemini API key never logged (redaction in `lib/ai/gemini.ts`).
- Dashboard behind a single shared password (no per-user auth yet) — fine for MVP,
  inadequate for multi-tenant production.
- Webhook GET verification via `META_VERIFY_TOKEN`; **no signature validation of POST
  payloads yet** (Meta `X-Hub-Signature-256` not checked) — known gap.
- Customer messages are stored in full in `messages` (needed for memory); ai_events
  deliberately stores none of it.
- Prompt injection tested manually: the persona + grounding held (no invented discounts),
  but there is no dedicated injection defense layer.

## Current strengths
- Genuinely conversational Hebrew booking with typo tolerance, any-order field
  collection, corrections, and rejected-slot memory.
- Strong deterministic truth layer: availability verdicts, booked-claim fence,
  date echo, confirmation CTA — the embarrassing lies observed live are now structurally
  impossible or auto-corrected.
- Resilience: Gemini 503 degraded mode (bookings still work with ZERO AI calls),
  Meta-auth degraded mode with auto-recovery.
- 20-scenario simulation suite replaying real incidents end to end.
- Full observability: per-request token/cost logs, prompt composition logs, ai_events.

## Current weaknesses
- Single-call architecture ceiling: flash-lite writes the reply AND the extraction JSON;
  vague turns get occasional flat/invented framing (prose-level, not fact-level).
- Prose-fact hallucination is not deterministically checkable (e.g. invented a parking
  description when the configured fact was junk).
- The model has NO "today is X" anchor in the prompt (top known gap — see bugs).
- No cancel/reschedule execution; customers are referred to the business.
- Single-day availability only ("when's the soonest?" unanswerable with facts).
- No outbound retry queue; in-memory cooldown state is per-process.

## Known bugs (verified in manual QA, 2026-06-11 — none fixed yet, by request)
1. **No today-anchor in the persona** → model said "today closed, tomorrow Thursday" when
   today WAS an open Thursday. Fix idea: inject `Today is <weekday> <date>` per turn.
2. `falseClosedClaim` guard misses "היום/מחר" phrasing (only matches weekday names).
3. **No past-time filter for today** in `getAvailableSlots`/`isIntervalFree` — afternoon
   "תור להיום" can offer (and book) morning times that already passed.
4. `parseHebrewDate` rolls past DD/MM a full year forward silently; date echo shows no year.
5. Multi-service requests are overpromised ("בטח שאפשר לשלב") but only one service books.
6. Exclusion dates: "אי אפשר שלישי, רק רביעי" resolves to Tuesday (negation vocab is
   only "לא"; first-listed weekday wins).
7. Time formats missed deterministically: "17.30" (dot), "ב 5" (space), "בשעה 16";
   "אחרי 16:00" captured as exactly 16:00 (preposition dropped).
8. Booked-claim fence regex misses "סגרנו!", "הזמנתי לך תור", "רשמתי אותך ל...".
9. Junk live data: services "בדיקה"/"שד" (price null), parking_instructions="שד" —
   triggers hallucinated facts. Clean via dashboard.

## Technical debt
- Migration `006_whatsapp_integration_health.sql` exists in repo but is NOT applied to
  the live database (health persistence + dashboard banner silently degrade until then).
- `flow.ts` (513 lines) and `idle-handler.ts` (~506) slightly exceed the 500-line rule;
  `booking-session.ts` (631) is the next split candidate.
- `ai_events` has no model/token columns — historical cost attribution impossible.
- `tsx` is not a devDependency (installed ad-hoc) — sims fail on a fresh clone until
  `npm i -D --no-save tsx`.
- Legacy menu flow code in `flow.ts` is mostly dead weight (fallback only).
- GitHub repo is still named `whatsapp-booking-agent` (the predecessor project);
  `main` is the mainline, `master` + `backup/main-prototype-20260612` are backups.

## Future roadmap (owner-aligned, in rough priority)
1. Fix the known-bugs list above (today-anchor first — one line, biggest effect).
2. Apply migration 006; clean junk business data.
3. Cancel/reschedule execution (lifecycle scaffolding already exists and is gated).
4. Multi-day availability scan ("מתי הכי קרוב?").
5. Extractor/reply two-call split (designed P0, owner-deferred — revisit when quality
   ceiling matters more than simplicity).
6. Webhook signature validation; real auth/multi-tenancy; outbound retry queue.
7. Meta token lifecycle management (the live token expired once already and silently
   broke everything until degraded mode caught it).
