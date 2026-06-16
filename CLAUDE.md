@AGENTS.md

# receptionist-core — Claude Code Onboarding Guide

WhatsApp-first AI receptionist SaaS (Hebrew) for SMB appointment booking.
**Read first:** `SESSION_HANDOFF.md` (2-min summary) → `CURRENT_STATE.md` (what works /
what's next) → `PROJECT_CONTEXT.md` (full background) → `REPOSITORY_MAP.md` (where).

## Repository Policy (mandatory)
`main` is the canonical branch and source of truth for this repository.

Unless the user explicitly approves otherwise:
- All development work happens on `main`.
- All commits and pushes target `main`.
- Do not create, switch to, or work on another branch without approval.
- Before any **checkout, switch, reset, rebase, merge, cherry-pick, force-push, branch
  deletion, or history-altering operation**:
  1. Explain why it is needed.
  2. List affected branches.
  3. Obtain explicit user approval.

Backup and archival branches are read-only unless the user explicitly requests recovery work.

Protected archival branches:
- `backup/main-20260616`
- `backup/infra-eval-harness-20260616`

If there is uncertainty, stop and ask.

## Project goals
A customer texts the business on WhatsApp in messy natural Hebrew; the bot answers,
helps, and gets appointments booked reliably. Core law:

> **Gemini understands. Gemini speaks. The system validates and executes.**

The AI must NEVER write to the DB, never create/cancel/change appointments, and never
claim a booking happened unless the deterministic write ran.

> **PRODUCT PIVOT (2026-06-12, owner decision — see `TRANSITION_PLAN.md`):**
> scheduling is moving OUT of the AI conversation into the web **booking platform**
> (`/book/[slug]`, `/appointment/[id]`, `lib/booking/platform.ts`). Target: the AI does
> conversation, FAQ, personalization and intent DETECTION; the platform owns booking /
> cancellation / rescheduling / waitlists deterministically; the system detects events
> (`events` table, migration 007) and the AI communicates them. The transition is
> governed by `BOOKING_MODE` (`conversational` = legacy default, `platform` = new path).
> The conversational machinery stays intact until the owner flips the flag and
> approves its removal.

## Product principle — business-agnostic (do not violate)
This is an **appointment-based-business platform**, NOT a hair-salon product. The live
test tenant (**RB Hair Studio**) is one example tenant, never the product definition.
The product must serve any appointment-based business: hair/nail salons, beauticians,
yoga & Pilates studios, physiotherapists, massage therapists, clinics, consultants,
coaches — and businesses that don't exist yet.

> **Classify business OPERATIONS, not business TYPES.**
> Reason about *what the customer is asking the system to do*, never about the industry.
> "אני רוצה פן", "אני רוצה שיעור פילאטיס", "אני רוצה טיפול פנים" are all the same
> operation — *the customer wants a service* → **BOOK**. The booking, cancel, reschedule,
> list, and FAQ operations are identical across every industry; only the data differs.

How this binds every layer (apply it forward — to AI behavior, intent classification,
booking flows, CRM, reminders, dashboard, appointment management, future automations):
- **Each business teaches the system what it is** through its own data — `services`,
  `business_settings`, `knowledge_base_items`, `ai_settings` (the persona description).
  The AI/persona learns the business from these facts, never from hardcoded industry
  vocabulary. (This is exactly why `business_type` and the `tone` presets were retired
  on 2026-06-13 — the AI infers the business from facts/services/KB.)
- **No hardcoded industry assumptions in logic.** Intent gates, parsers, guards, prompts,
  schema, and UI must work for a Pilates class and a physiotherapy session as well as a
  haircut. A business's configured service names are the source of truth for "what they
  offer" — any built-in service keyword list is only a generic fallback and must stay
  industry-neutral (see `hasBookingSignal` in `lib/ai/platform-turn.ts`).
- **Examples are examples, not the model.** Hebrew like "תספורת"/"פן" may appear in
  comments, seed data, dashboard placeholders, and sim scenarios as *illustrations* of
  the test tenant — never as a built-in expectation. Prefer industry-neutral examples in
  any text the system sends (persona prompts, customer-facing strings, link labels).
- **New features stay vertical-neutral.** Before adding anything that names a salon
  service or assumes a salon workflow, ask: would this still be correct for a yoga studio
  or a clinic? If not, generalize it or move the specificity into per-business data.

## Architectural rules (do not violate)
1. **One Gemini call per customer turn** (`lib/ai/brain.ts` is the only runtime call
   site). No multi-model routing, no classifier calls, no fallback models.
2. **Model is `gemini-2.5-flash-lite`** via `GEMINI_MODEL` env — do not change without
   the owner's explicit request. Keep `thinkingBudget: 0` + `maxOutputTokens: 4096`
   (removing them re-breaks JSON on thinking models).
3. **Booking-critical actions stay deterministic**: every appointment write
   (`flow.ts handleConfirmation` in conversational mode, `lib/booking/platform.ts` in
   platform mode), availability verdicts, link attachment (the model never writes URLs),
   and every guard in `lib/ai/reply-polish.ts`. New AI failure modes get deterministic
   fences, not prompts.
4. **Owner AI settings are the style authority** (tone/length/emoji/custom instructions)
   — never weaken `custom_instructions` priority; history never outranks settings/facts.
5. **Don't optimize cost** unless asked — the owner explicitly prioritizes quality.
6. Prefer **contained fixes** over refactors; keep files under ~500 lines by extracting
   cohesive modules (`reply-polish.ts` is the pattern to follow).
7. Every live bug fix gets a **simulation scenario** in
   `scripts/simulate-conversations.ts` (scenarios replay real incidents; numbering runs
   1–19, 21, 22 — there is no #20; #22 covers platform mode).

## Things NOT to change without owner review
- The Gemini model / generation config (rule 2).
- The deterministic confirmation flow and the appointment INSERT path.
- The grounding fence (`lib/ai/grounding.ts` verifyGrounding) and verdict alignment.
- The persona's hard structure (working memory block, availability block, output schema).
- `supabase/schema.sql` semantics (migrations are applied MANUALLY in the Supabase SQL
  editor — there is no migration runner; keep schema.sql in sync with new migrations).
- `.gitignore` entries for `.env*` and `dev.log`.

## Coding standards
- TypeScript strict; no `any` escape hatches in lib code.
- Never throw across the messaging path — every external call returns typed results;
  telemetry is fail-open (logging must never block a reply).
- **Logging hygiene**: never log secrets/API keys, full prompts, message bodies, or
  phone numbers (mask to last 4). Token counts, char sizes, intents = fine.
- Hebrew customer-facing strings: gender-neutral phrasing ("כתוב/כתבי", "נוח לך"),
  no emojis hardcoded into strings that bypass the settings chokepoint (ALL outbound
  WhatsApp goes through `lib/booking/outbound.ts sendOutbound()` — chat router and
  booking platform alike — which enforces emoji_usage=none).
- Comments explain constraints the code can't show, in the file's existing voice.

## Common commands
```powershell
npm run dev                      # dev server — the owner usually runs: npm run dev *>> dev.log
npm run build                    # production build + typecheck (must pass before done)
npm run lint                     # eslint (must be clean)

# Validation suite (live Gemini calls, ~$0.02/run; needs tsx once per node_modules):
npm i -D --no-save tsx
node --env-file=.env.local --import tsx scripts/simulate-conversations.ts

# Token/cost audit, Gemini JSON forensics, WhatsApp health checks:
node --env-file=.env.local --import tsx scripts/audit-token-usage.ts
node --env-file=.env.local --import tsx scripts/diagnose-gemini-json.ts
node --env-file=.env.local --import tsx scripts/simulate-whatsapp-health.ts
```
Definition of done for any change: `lint` clean + `build` green + full sim suite green
(+ a new scenario if you fixed a behavior bug).

## Deployment / runtime notes
- Runs as a local dev server + ngrok for the Meta webhook (no cloud deploy yet).
- After code changes the owner must RESTART the dev server (it has repeatedly run stale
  code during live tests — check before debugging "old" behavior!).
- `META_ACCESS_TOKEN` is a temporary token that EXPIRES (it died once mid-test);
  degraded mode catches it, `/api/health/whatsapp` verifies it.
- Migration `006_whatsapp_integration_health.sql` is committed but NOT applied to the
  live DB — apply in Supabase SQL editor to enable health persistence + dashboard banner.
- Supabase access from tooling/agents: **read-only** for debugging/QA; never write to
  the live DB from an agent — schema changes only via reviewed migration files.

## Known pitfalls
- **Next.js 16 has breaking changes** — read `node_modules/next/dist/docs/` before
  framework-specific work (see `AGENTS.md`).
- PowerShell 5.1 quirks: no `&&`; Hebrew literals get corrupted through pipes (write
  temp .ts files instead of inline `node -e`); stray redirects have created junk files
  in the repo root before — check `git status` before committing.
- `.env*` files are read-protected for agents; scripts use `node --env-file=.env.local`.
- The sim suite hits the real Gemini API and the real Supabase DB (read-only) — both
  keys must be valid.
- `git` history: `main` is the mainline; `master` (identical code) and
  `backup/main-prototype-20260612` (old predecessor project) are backups pending owner
  deletion. The GitHub repo name (`whatsapp-booking-agent`) predates this codebase.
- Temperature is 0.7 — single sim-check failures can be model variance; rerun before
  digging (this happened twice; both times the rerun passed).
- Test-data hygiene: junk rows in live `services` / `business_settings` cause
  hallucinations (see CURRENT_STATE known bugs).
