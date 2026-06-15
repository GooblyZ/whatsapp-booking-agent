# Bootstrap prompt for a new Claude Code session rooted at this project

Copy-paste everything below the line as the FIRST message of the new session.

---

You are picking up **receptionist-core** — a Gemini-powered WhatsApp AI receptionist
for Israeli small businesses (Hebrew conversations, real availability, deterministic
booking). This is a continuation of mature, working development — NOT a new project.

**Onboard first, in this order (all in the repo root):**
1. `SESSION_HANDOFF.md` — 2-minute summary: status, risks, next actions.
2. `CLAUDE.md` — binding rules (read the "Architectural rules" and "Things NOT to
   change" sections carefully; they encode the owner's explicit decisions).
3. `CURRENT_STATE.md` — what works, what's broken, prioritized backlog.
4. `PROJECT_CONTEXT.md` — full architecture + the 9 known bugs with fix ideas.
5. `REPOSITORY_MAP.md` — file layout and reading order for the code.

**Non-negotiables (summary — full versions in CLAUDE.md):**
- **Business-agnostic product.** This serves ALL appointment-based businesses (salons,
  studios, clinics, physios, coaches…), not hair salons. RB Hair Studio is only the test
  tenant. Classify business OPERATIONS, not TYPES; never hardcode salon-specific
  assumptions — each business teaches the system through its own data (see the "Product
  principle" section in CLAUDE.md).
- Gemini understands and speaks; the SYSTEM validates and executes. The AI never writes
  to the DB and never claims a booking happened without the deterministic INSERT.
- Single model (`gemini-2.5-flash-lite`), one call per turn. No routing, no model
  changes, no cost optimization, no weakening of the owner-personality system.
- Booking-critical behavior stays deterministic; new AI failure modes get deterministic
  guards plus a regression scenario in `scripts/simulate-conversations.ts`.
- Definition of done: `npm run lint` + `npm run build` + full sim suite green
  (`npm i -D --no-save tsx` once, then
  `node --env-file=.env.local --import tsx scripts/simulate-conversations.ts`).
- Never log secrets/prompts/PII. Supabase from tooling: read-only.

**Current status:** all work is committed and pushed (`main` on
github.com/GooblyZ/whatsapp-booking-agent). Build/lint/sims green. The live system runs
as a local dev server + ngrok; the dev server may be running STALE code — restart it
before any live testing. The Meta access token expires periodically — verify via
`/api/health/whatsapp` before debugging "broken" sends.

**Where to start (owner-approved priority order, details in CURRENT_STATE.md):**
1. Add a "today is <weekday, date>" anchor to the persona prompt (fixes a verified class
   of weekday hallucinations) + extend the false-closed-claim guard to היום/מחר.
2. Filter past times for same-day availability (`getAvailableSlots` / `isIntervalFree`).
3. Remind the owner to: apply `supabase/migrations/006_whatsapp_integration_health.sql`
   in the Supabase SQL editor, and clean junk business data (services "בדיקה"/"שד",
   parking_instructions) in the dashboard.
4. Then continue down the known-bugs list in PROJECT_CONTEXT.md (each fix gets a sim
   scenario; run the full suite after).

Before coding anything, confirm you've read the five docs and state your plan for item 1.
