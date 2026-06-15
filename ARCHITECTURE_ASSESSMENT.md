# Product Architecture & Parallel Workstreams — Strategic Assessment

> Strategic assessment & roadmap (2026-06-16). Direction only — no implementation has been done from
> this document. Each milestone (M1–M5) gets its own implementation plan before any code.

## Context
The conversation engine is now materially stable (routing integrity, JSON recovery, quiet mode,
emoji/greeting loops, aggregation, duplicate-Gemini suppression — all landed and committed at
`344af55`). Continuing to fix one bug at a time risks **local optimization**: polishing reliability
while the things that actually make this *sellable* (owner-facing product quality, a coherent
settings model, multi-tenancy) stay immature. Goal: name the parallel workstreams, rank them, and
set architectural direction.

Evidence base: `lib/ai/platform-turn.ts`, `routing.ts`, `brain.ts`, `persona.ts`,
`conversation.ts`, `message-handler.ts`, `flow.ts`; `types/database.ts` (AISettings); the dashboard
(`app/dashboard/layout.tsx`, `page.tsx`, `ai-assistant/page.tsx`, `PersonaFields.tsx`) and the
customer booking (`app/book/[slug]/page.tsx` + `booking.module.css`).

---

## 1. Recommended Parallel Workstreams
These touch **different layers**, so they parallelize cleanly with little merge conflict:

- **A — Reliability Architecture Consolidation** (runtime turn pipeline). Convert the implicit guard
  sequence into a named, ordered pipeline + one unified turn-classifier + explicit turn-state.
- **B — Prompt-first Settings Architecture** (prompt + DB settings + settings UI). Define the prompt
  contract first; derive/prune settings from it.
- **C — Productization & Design** (owner dashboard, terminology, onboarding) — and the SaaS unlock:
  **multi-tenancy + per-business auth**.
- **D — Observability & Eval harness** (cross-cutting enabler). A deterministic-where-possible eval
  + structured turn events, so A/B/C can change behavior without relying on live WhatsApp testing.

A, B, C are the three named workstreams; D is the connective tissue that makes the other three safe
and fast (today, regressions surface only in live testing — see the temp-0.7 sim flakiness and
repeated "stale dev server" incidents).

---

## 2. Workstream Priority

| WS | Priority | Why |
|---|---|---|
| **C (productization + multi-tenancy)** | **High** | This is the gap between "AI project" and "SaaS product." The owner dashboard reads as a dev tool (env-var/migration instructions in the UI, exposed "Gemini calls", a debug page in the nav), and the app is **single-tenant** (`getDefaultBusinessId()` from env) — you cannot onboard a second business without code/env changes. This is the literal ceiling on selling it. |
| **B (prompt-first settings)** | **High** | Settings are the owner's primary lever and currently mix meaningful controls with cosmetic/confusing ones. Doing B *before* C's settings UX avoids redesigning the settings screen twice. Relatively contained. |
| **A (reliability consolidation)** | **Medium-High** | The engine *works*, so this is not an emergency — but the guard logic is approaching the complexity ceiling (one ~450-line `runPlatformTurn` with ~12 ordered stages). Consolidate now, while the behavior is fresh and well-tested, before it ossifies. Not urgent enough to block C/B. |
| **D (observability/eval)** | **Medium** | High leverage but supporting. Stand up a thin version early (it de-risks A and B); invest more as A proceeds. |

Net: **run C and B in parallel now**, start A's consolidation in parallel at lower intensity, and
seed D immediately as the safety net.

---

## 3. Risks Of Continuing Bug-Only
- **Patchwork ossification:** each new failure mode becomes another stage inserted into the
  load-bearing, implicitly-ordered `runPlatformTurn` sequence. The order is correctness-critical but
  enforced only by comments — fragile, high cognitive load, hard to onboard anyone new.
- **Local optimization:** reliability gets to 99% while the *sales* blockers (owner trust, onboarding,
  multi-tenancy) stay at 40%. The product feels unfinished where buyers actually look.
- **Settings drift:** more toggles bolted on without a prompt model → an incoherent settings screen.
- **No eval safety net:** behavior changes are validated by hand on live WhatsApp; temp-0.7 variance
  already makes the sim flaky and "stale server ran old code" has bitten repeatedly.
- **Single-tenant ceiling:** the longer multi-tenancy is deferred, the more code assumes one business.

---

## 4. AI Reliability Architecture Assessment

**Strengths**
- **One strong governing law** — "the model understands; the system validates and executes" — applied
  consistently: deterministic fences around a probabilistic core.
- **Single Gemini call site** (`runReceptionistTurn`) and a **single outbound chokepoint**
  (`outbound.ts`, gender + emoji) — two clean invariants.
- **`routing.ts` is now a proper single source of truth** — the recommended pattern; proves the
  codebase *can* consolidate.
- **Pure, testable units** + a 43-scenario regression suite; fail-open telemetry.

**Weaknesses / patchwork risks**
- **`runPlatformTurn` is a god-function** (~450 lines, ~12 sequential stages: emoji → pre-Gemini guard
  → degraded → supersede-gate → Gemini → booking-claim scrub → dedup → URL strip → evidence gate →
  routing/link → low-signal → greeting → link-wording fence → persist → log). The **stage order is
  implicit** and correctness-critical.
- **Overlapping "how meaningful is this turn?" classifiers**, each added for one bug:
  `classifyInput`, `looksLikeNoise`, `isEmojiOnly`, `looksLikeGreetingOrMeta`, `lowSignalKind`,
  `isLowValueAck`, `suppressLinkFor`, `claimsOperation`. They answer the same question with separate
  heuristics → duplicated intent, drift risk.
- **Two parallel counters** (`consecutiveLowSignalTurns`, `consecutiveGreetingTurns`) with distinct
  increment/reset rules and subtle cross-interactions; state lives as ad-hoc fields in
  `conversation_states.context` with no schema.
- **Coupling that must co-evolve:** the canned-reply constants and `isKnownFallbackText`'s regex
  (history filtering) must stay in sync by hand.
- **Two whole behavior paths** (platform vs legacy conversational); conversational is unprotected
  (Risk G) yet still shipped — dead weight + latent risk.
- **Observability is log-string-based**, not structured events — hard to analyze at scale.

**Hidden complexity / maintainability**
- The next guard must be inserted at exactly the right point in the sequence. There is no explicit
  "turn state" object; stages mutate `replyText`/`linkAttached`/`suppressReply` in place.

**Direction (consolidation, NOT redesign — behavior-preserving):**
1. Extract a named, ordered **TurnPipeline** of stages (each a pure `(state) → state` step) so the
   order is structural, not comment-enforced. Follow the `routing.ts` extraction pattern.
2. Unify the low-value classifiers into **one `classifyTurnSignal()`** returning a typed signal
   (productive / greeting / meta / gibberish / emoji / complaint / unclear).
3. Make **turn-state explicit** (a typed object) and **formalize the conversation-state schema**
   (the counters). Retire the legacy conversational path once platform-only is confirmed.

### 4a. Target Behavioral Model — the Three-Axis Model

> **Status: this is the TARGET model, not the current one. Do NOT rewrite the existing system now.**
> The current quiet-mode / greeting-loop / low-signal machinery is **working and covered by the
> regression suite** (scenarios 32–43). This section exists to give future reliability work a single
> coherent model to converge toward — so consolidation is deliberate, not another reactive patch.

**The core diagnosis.** The reliability layer is one coherent behavioral model expressed as patchwork.
A single scalar (`consecutiveLowSignalTurns`) is standing in for three *independent* questions, and
every later patch (`countsTowardQuiet`, the second `consecutiveGreetingTurns` counter, the emoji
branch, the evidence gate) is an attempt to recover a lost dimension from that scalar. The clearest
tell: we added a **second counter** to cover the first counter's blind spot — a sign the scalar is the
wrong primitive, not that it needed another companion.

**A healthy conversation needs three ORTHOGONAL axes, not one counter:**

1. **Turn meaning** (stateless — what is *this* message?): substantive · social (greeting / ack /
   farewell / smalltalk) · meta (about the bot) · corrective/complaint · empty/uninterpretable · hostile.
2. **Trajectory** (stateful — where is the *conversation* going?): opening · progressing ·
   resolved/idle · **stalled** (a goal exists but isn't converging) · dormant (no goal, drifting).
3. **Good-faith / channel health** (stateful — *is this a real customer worth a model call?*):
   healthy · degraded (noise/testing) · flooding · hostile.

**Why the categories resist a single classifier — they live on different axes:** productive/greetings/
acknowledgements = Axis 1; **confusion = Axis 2** (one "I don't get it" is meta on A1, but *repeated*
non-convergence is a trajectory property); spam/abuse = Axis 3; **testing = Axis 3 + 2** (a real human
poking the bot, with no goal).

**The behavioral bug the missing model hides:** because Axis 2 (trajectory) and Axis 3 (health) are
fused into one counter, a **genuinely confused customer and a bored key-masher follow the identical
escalation ladder** (clarify → cold boundary → quiet). That is backwards — confusion (stalled +
*healthy*) should make the assistant *more* helpful (concrete examples, then the business phone/human),
while noise (degraded) deserves cheap sparse handling, and abuse (hostile) deserves a fixed boundary
with no "let me help more." One ladder cannot serve responses that should be opposite.

**States that should exist** (two small explicit state machines + one per-turn classification —
replacing the counters): **Phase** `OPENING → ACTIVE(goal) → RESOLVED/IDLE`, with `STALLED` and
`DORMANT` off-ramps (actions derive from phase, not from "count == 3"); **Health**
`HEALTHY → DEGRADED → FLOODING → HOSTILE` (this — not trajectory — gates model spend); **Turn-kind**
(the single Axis-1 classifier). Today's `quiet mode` is really `STALLED` (escalate to a human) and
`DEGRADED/DORMANT` (go sparse) wearing one coat; splitting them is most of the fix.

**Counters that are symptoms of the missing model:** `consecutiveLowSignalTurns` (a scalar faking the
Phase + Health machines), `consecutiveGreetingTurns` (the blind-spot patch — "repeated social-only,
no goal" is simply the `DORMANT` phase), and the `lowSignalActionFor` threshold ladder (magic numbers
substituting for a phase × health action table).

**Guards that would collapse under the correct model:** `classifyInput`, `looksLikeNoise`,
`isEmojiOnly`, `looksLikeGreetingOrMeta`, `lowSignalKind`, `isLowValueAck`, and the meta half of
`suppressLinkFor` → **one Axis-1 classifier** (seven implementations of one concept);
`quietModePlan` + `greetingResetPlan` + the `lowSignalActionFor` tiers + `preGeminiAction` branching →
**one action table** keyed on (phase, health, turn-kind); `applyBookingEvidenceGate` → a thin
corroboration check. **Precedent: `routing.ts` already did exactly this consolidation for the routing
axis** — the reliability axes simply haven't had their `routing.ts` moment yet.

**How this should guide future work:**
- Treat the three axes as the **target**; let them **absorb** existing guards *incrementally*, gated by
  the eval harness (WS D) so behavior is provably preserved. **Consolidation, not rewrite.**
- **Avoid adding new counters or classifiers.** New reliability behavior should be expressed as a
  *value* within an existing axis, not a new scalar or a new bespoke detector.
- Defining the model is cheap; *proving* it fits real traffic needs observed, axis-classified
  conversations (coupled to WS D) — so the model and observability advance together.

> ⚠ **WARNING — the patchwork tripwire.** If the next reliability fix requires adding *another counter*
> or *another classifier*, **stop.** That is the signal to pause and ask whether the behavior belongs
> in the three-axis model (a value on Axis 1, or a transition in the Phase/Health machines) instead of
> a new bespoke guard. Adding a third counter or a ninth classifier means the consolidation is overdue
> — handle it via the model, or consciously accept the debt and record why.

---

## 5. AI Settings / Prompt Architecture Assessment

**Current prompt anatomy** (`persona.ts buildReceptionistInstruction`, ~10K chars/turn): Identity →
"you're a person, not a flow" → per-turn date anchor → **WHO YOU ARE** (personality = `custom_instructions`
‖ `persona_voice` ‖ legacy `tone`) + gender line → **HOW YOU WRITE** (language/length/emoji) → **HARD
RULES** (`things_to_avoid`) → **WORKING MEMORY** (booking block) → convers/honesty/appointments rules
(platform vs conversational) → **BUSINESS FACTS** → availability → history → output JSON contract →
actionability rule. This is already a thoughtful, layered prompt with clear precedence.

**Prompt-first ideal architecture** — eight components, each with an explicit owner & visibility:

| Component | Source of truth | Owner-editable? | Maps to setting |
|---|---|---|---|
| **Identity** (name, business name, gender) | settings + business | Editable | name, assistant_gender |
| **Character / Voice** (one natural-language description) | settings | **Editable (primary lever)** | custom_instructions (+ ✨ enhance) |
| **Format** (language, length, emoji) | settings | Editable | language, response_length, emoji_usage |
| **Hard Rules** (never-cross) | settings | Editable (advanced) | things_to_avoid |
| **Business Knowledge** (facts/services/hours/KB) | business data | Editable elsewhere | services / KB / hours pages |
| **Working Memory** (customer + appts) | system | Hidden | — |
| **Operating Mode** (platform fences, actionability, honesty, output contract) | system | **Hidden (engine-owned)** | none — must NOT be a setting |
| **Per-turn anchors** (date, availability, supersede) | system | Hidden | — |

**Settings verdict (derive from the prompt, not vice-versa):**
- **Keep (meaningfully affect behavior):** `custom_instructions` (the star), `assistant_name`,
  `assistant_gender`, `response_length`, `emoji_usage`, `language`, `things_to_avoid`.
- **Cut / formally remove:** `tone`, `persona_voice`, `business_type` (already deprecated/read-only —
  finish the removal with a migration once no config relies on them).
- **Re-evaluate the capability toggles** (`ai_enabled`, `faq_enabled`, `intent_detection_enabled`):
  decide which are real product switches vs vestigial — each should map to a concrete prompt/behavior
  delta or be removed.
- **Never expose** Operating Mode, the output contract, or the actionability rule as settings — they
  are engine correctness, not preferences.
- Settings UI should mirror the prompt layers (Identity / Voice / Format / Hard Rules), which
  `PersonaFields.tsx` already roughly does — tighten the mapping and drop anything with no prompt effect.

---

## 6. Product & Design Assessment

**The core finding — an asymmetry:** the **customer-facing booking** (`/book/[slug]`) is
production-grade (CSS modules, monogram, trust chips, RTL, clean typography). The **owner-facing
dashboard** — the surface a buyer evaluates before paying — still reads as a developer admin panel.

**What makes the dashboard feel like "an AI project," not a SaaS product:**
- **No design system:** raw inline `style={{}}` objects everywhere, `system-ui` font, ad-hoc colors —
  versus the booking page's cohesive CSS module. Inconsistent, unbranded.
- **Developer instructions shown to the owner:** set `DASHBOARD_ACCESS_PASSWORD` in `.env.local`,
  configure `META_PHONE_NUMBER_ID`/`META_ACCESS_TOKEN`, "restart the server", run migration
  `010_..._assistant_gender.sql`. A real SaaS owner never sees env vars or migration filenames.
- **Vendor/AI leakage:** the dashboard shows "≈ N קריאות Gemini היום/החודש" and a **"בדיקת AI"
  (AI debug)** tool in the main nav. Exposes the implementation (Gemini) and a dev tool to the buyer.
- **Terminology inconsistency:** nav brand "מזכירה חכמה" (smart secretary), settings title "הגדרת
  הקבלן/ית" ("the contractor" — an odd/incorrect term for a receptionist), product principle says
  "receptionist." Pick one persona noun and use it everywhere.
- **No real onboarding:** there's a setup *checklist* on the home page, but first-run = "go set env
  vars / fill business settings." No guided, self-serve wizard.
- **Single-tenant:** the dashboard is hardwired to one business via `getDefaultBusinessId()`. There's
  no per-business login, signup, or tenant isolation in the UI — the structural SaaS blocker.

**What this costs:** buyer trust. The people who must trust the product to pay (business owners) see
the roughest, most technical surface. Functionality is largely there; *perception* is not.

---

## 7. Recommended Next Milestones

- **M1 — Prompt-first settings redefinition (WS B).** Write down the prompt contract (the 8 components
  above), prune dead settings (`tone`/`persona_voice`/`business_type` removal migration), decide the
  capability toggles, and align `PersonaFields.tsx` to the kept set. *Contained; unblocks M3.*
- **M2 — Dashboard productization pass (WS C, part 1).** A real design system/token set, remove ALL
  developer-facing instructions (move env/migration concerns to ops docs, not the UI), hide vendor
  names and the debug tool behind a dev-only flag, one consistent persona term, and a guided
  onboarding wizard. *Biggest perception ROI.*
- **M3 — Reliability consolidation (WS A).** Named TurnPipeline + unified `classifyTurnSignal()` +
  explicit turn-state + conversation-state schema; retire the legacy conversational path on sign-off.
  Behavior-preserving; gated by the eval harness.
- **M4 — Observability & eval harness (WS D).** Structured per-turn events + a deterministic-where-
  possible eval (mock-Gemini fixtures for the pipeline; live calls only for true model-quality checks)
  so M1–M3 ship without live-testing roulette. *Start a thin version immediately.*
- **M5 — Multi-tenancy + per-business auth (WS C, part 2 — the SaaS unlock).** Tenant model, signup,
  per-business isolation, billing hook. Larger; sequence after M2's UI foundation. This is the gate to
  actually selling to more than the one test tenant.

**Parallelization:** M1 + M2 run in parallel now (different layers). M4 seeds alongside. M3 starts at
low intensity in parallel and intensifies once M4 exists. M5 follows M2.

---

## 8. Execution Structure — how to run this (organization IS architecture)

Project organization is treated as part of the architecture: the same conflict/coupling analysis used
for code applies to *how the work is scheduled across branches and Claude conversations*. The binding
constraints are **context-window limits** (one conversation can hold one workstream's mental model
sharply; two degrade it), **merge-conflict risk** (driven by file footprint overlap), **task
interference** (mixing concerns in one session produces correlated mistakes), and **a single human
reviewer** (true parallelism is capped by review bandwidth, not by how many sessions can be spawned).

**Rule: one workstream = one branch = one dedicated Claude conversation.** Do not multiplex workstreams
in a single conversation — it thrashes context and makes compaction drop the wrong half. Use a **git
worktree per active branch** so parallel tracks don't fight over the working dir / dev server.

### Track map

| Track | Branch | Dedicated conversation | File footprint | Parallel-safe with | Must isolate from |
|---|---|---|---|---|---|
| **T1 Reliability consolidation** (WS A/M3) | `reliability/consolidation` | yes | `lib/ai/platform-turn,routing,brain,conversation`, `message-handler`, `flow`; sim pipeline scenarios | T3, T4 | T5 |
| **T2 Prompt-first settings** (WS B/M1) | `ai/prompt-settings` | yes | `persona.ts`, `types/database` (AISettings), `services/ai-settings`, `PersonaFields` *contract*, settings migration; sim settings scenarios | T3 (ordered), T1 (with file ownership) | T5 |
| **T3 Dashboard productization** (WS C1/M2) | `product/dashboard` | yes | `app/dashboard/**` UI, design tokens, terminology — *excluding* the AI-settings screen restyle until T2 lands | T1, T2 | T5 |
| **T4 Eval & observability** (WS D/M4) | `infra/eval-harness` | yes (or fold into T1) | NEW eval/fixtures (low conflict); structured-events instrumentation hooks into T1's pipeline | everything (new files) | — (events piece couples to T1) |
| **T5 Multi-tenancy** (WS C2/M5) | `platform/multi-tenancy` | yes | `config.ts`, `proxy.ts`/auth, schema/RLS, **every `getDefaultBusinessId()` call site** | *(none — isolate)* | T1, T2, T3 |

### What can run in parallel vs what must be isolated
- ✅ **Safe parallel:** **T1 ∥ T3** (runtime lib vs dashboard UI — disjoint). **T4 ∥ anything** (new
  files). T3 is the universal safe partner.
- ⚠ **Ordered handoff (not concurrent on the shared surface):** **T2 → T3** on the AI-settings screen —
  T2 defines *which* settings exist (prompt-first), then T3 restyles that screen. **T1 ∥ T2** is allowed
  only with **file ownership**: T1 owns the pipeline functions, T2 owns `persona.ts` prompt text +
  AISettings; split `simulate-conversations.ts` by scenario-number range so the shared test file doesn't
  collide.
- ✋ **Must isolate (never concurrent with core edits):** **T5 multi-tenancy.** It changes the
  data-access foundation app-wide; running it alongside T1/T2/T3 guarantees conflicts on `config.ts`
  and every business-scoped query. Sequence it after the UI/settings foundation is stable, on its own.

### Recommended phasing (for a single reviewer: 2 active tracks + 1 background)
- **Phase 0 (prep, small, do first):** T4 minimal eval harness + **capture current behavior as golden
  fixtures**. This is the highest-leverage sequencing decision — it lets T1 refactor *provably*
  behavior-neutral instead of via live-WhatsApp roulette.
- **Phase 1 (parallel):** **T2 + T3** (the two "High" priorities, mostly disjoint) with **T1** starting
  once Phase 0 exists. If review bandwidth caps you at two, run the disjoint pair **{T1 + T3}** or
  **{T2 + T3}** and queue the third.
- **Phase 2:** finish T1 (gated by T4); T3 restyles the settings screen after T2 merges.
- **Phase 3 (isolated, sequential):** T5 multi-tenancy, alone.

### Workflow changes that raise velocity without raising risk
1. **Conversation-per-branch, worktree-per-branch** — keeps each context sharp and each PR reviewable.
2. **Short-lived branches, integrate to `main` frequently** — the longer T1/T5 live, the worse the
   conflict on `platform-turn.ts` / `config.ts`. Land small, reviewable increments.
3. **Explicit file ownership while tracks overlap** — declare, per active track, which shared files it
   owns (pipeline vs prompt vs settings UI); partition `simulate-conversations.ts` by scenario range.
4. **Eval harness before the refactor** — freeze the behavioral contract as golden outputs before T1.
5. **Serialize migrations** — the migration runner is manual (Supabase SQL editor); T2's
   drop-deprecated-columns and T5's tenant schema must be applied one at a time, in order, with
   `schema.sql` kept in sync. Never let two tracks ship migrations concurrently.
6. **Sub-agents vs separate conversations — use the right tool:** *within* one track's conversation,
   sub-agents can parallelize read-only exploration; *across* tracks, use separate top-level
   conversations + branches, **not** background sub-agents (they share the parent's context budget and
   are for within-task fan-out, not multi-day independent streams).

**Bottom line:** run **2 parallel tracks (3 if the third is T4 or a disjoint pair), each its own
branch and its own conversation**; keep **T5 strictly isolated and sequenced last**; and **land the
eval harness first** so the reliability consolidation can proceed safely in parallel with the
product/settings work.
