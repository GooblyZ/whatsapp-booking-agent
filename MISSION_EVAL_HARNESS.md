# Mission — Phase 0: Reliability Eval Harness (WS D / T4)

> **For a fresh, dedicated Claude conversation on branch `infra/eval-harness`.** This is Phase 0 of the
> roadmap in `ARCHITECTURE_ASSESSMENT.md` (Section 7) and track **T4** in its execution plan (Section 8).
> Read `ARCHITECTURE_ASSESSMENT.md` (esp. §4a the three-axis model, §8 execution structure) and
> `CLAUDE.md` / `AGENTS.md` first. **Do not start until the plan here is approved.**

## Why this exists (read first)
Today, AI-behavior changes are validated by hand on live WhatsApp, and the sim suite mixes pure checks
with temp-0.7 live-Gemini checks that flicker. Before we consolidate the reliability layer (WS A) or
touch prompts/settings (WS B), we need a **small, fast, mostly-deterministic safety net** that captures
the *current* decision behavior as a golden baseline — so refactors are provably behavior-neutral
without live-testing roulette. **This must stay small and practical — a safety net, not a test platform.**

## Objective
A deterministic, zero-cost **golden eval** over the reliability/routing/aggregation **decision logic**
(the already-pure functions), plus a **separate, small, tolerant live-Gemini** check for model
understanding. The golden layer is the refactor safety net; the live layer catches prompt/settings
regressions.

## Scope
- **In:** a golden snapshot eval of the pure decision functions; a thin scripted multi-turn
  decision-sequence check; a small live-Gemini understanding/property check; a golden fixtures file; an
  `npm run eval` entry; a one-screen pass/fail + diff report.
- **Out:** see Non-Goals. Keep total size to ~a few hundred lines across 1–2 scripts + 1 fixtures file.

## Files likely involved
- **NEW:** `scripts/eval/reliability-eval.ts` (deterministic golden runner), `scripts/eval/golden.json`
  (or inline fixtures), optionally `scripts/eval/live-understanding.ts` (the tolerant live layer).
  Optional `package.json` script: `"eval": "node --import tsx scripts/eval/reliability-eval.ts"`.
- **IMPORT only (no behavior change):**
  - `lib/ai/routing.ts` — `resolveRoute`, `modelOperation`, `messageOperation`, `linkKindForRoute`
  - `lib/ai/platform-turn.ts` — `preGeminiAction`, `lowSignalKind`, `countsTowardQuiet`,
    `lowSignalActionFor`, `quietModePlan`, `greetingResetPlan`, `applyBookingEvidenceGate`,
    `hasBookingSignal`, `isEmojiOnly`, `looksLikeNoise`, `looksLikeGreetingOrMeta`,
    `persistPlatformState`, `readLowSignalCount`, `readGreetingCount`
  - `lib/message-handler.ts` — `aggregateBurst`; `lib/booking/flow.ts` — `hasNewerInbound`;
    `lib/config.ts` — `getAggregationDebounceMs`; `lib/ai/brain.ts` — `isKnownFallbackText`,
    `classifyInput`, and `runReceptionistTurn` (live layer only)
- **Allowed minimal lib touch:** adding an `export` to a pure function that isn't exported yet. That is
  the ONLY permitted change to `lib/**`. No logic changes.

## What the eval should test
**Deterministic golden layer (the core — no Gemini, no DB writes):** for a table of inputs, snapshot
the decisions and compare on every run:
- **Routing integrity:** `resolveRoute(understanding, message)` + `linkKindForRoute` over the routing
  matrix (BOOK/LIST/RESCHEDULE/CANCEL/NONE; model self-contradiction `intent=booking`+`appt=LIST`;
  message-verb override; FAQ/smalltalk → NONE; existing-appt independence).
- **Low-signal / quiet-mode:** `lowSignalKind`, `countsTowardQuiet`, `lowSignalActionFor`,
  `quietModePlan`, `greetingResetPlan`, `preGeminiAction` over scripted (prevCounts, message, kind)
  inputs — including the escalation tiers and the de-spam plan.
- **Evidence gate & booking signal:** `applyBookingEvidenceGate`, `hasBookingSignal`, `messageOperation`.
- **Turn-kind detectors:** `isEmojiOnly`, `looksLikeNoise`, `looksLikeGreetingOrMeta` over the labeled
  message sets.
- **Aggregation:** `aggregateBurst` (mock-db) join behavior; `hasNewerInbound` serialization (3-fragment
  burst → exactly one proceeds); `getAggregationDebounceMs` config (default/0/cap).
- **History hygiene:** `isKnownFallbackText` matches all canned low-signal/quiet lines, not real answers.
- **Decision-sequence (composition):** a thin scripted runner that calls the real pure functions in the
  documented `runPlatformTurn` order over multi-turn scripts (greeting spam, gibberish→recover,
  emoji spam, booking burst), asserting final `{route, linkKind, suppressReply, counters}` and
  Gemini-call count. *(Marked TEMPORARY: once WS A extracts a pure `TurnPipeline`, point this at the
  real pipeline and delete the thin runner — avoid permanent duplication.)*

**Live-Gemini layer (separate command, small, tolerant):** ~10–15 real Hebrew messages →
`runReceptionistTurn` → assert coarse properties only: correct `intent`/`appointmentIntent`/
`requestsBusinessAction` on clear cases; platform-mode reply has no slot list and claims no completed
booking; an FAQ is answered from facts. **Allowed to flake — label "rerun once on variance"** (consistent
with the documented temp-0.7 behavior).

## Deterministic/mock-based vs live-Gemini
- **Deterministic/mock (must be 0 network, 0 DB writes, <~2s):** everything in the golden layer. Use the
  existing chainable-mock-db pattern (see `simulate-conversations.ts` scenarios 41 & 43) for
  `aggregateBurst`/`hasNewerInbound`/`persistPlatformState`. Construct `Understanding` objects inline
  (cast pattern already used in scenarios 30/35/42).
- **Live-Gemini (separate, tolerant):** only the understanding/property layer. Never gate a refactor on
  it.

## Golden fixtures
- A versioned `golden.json` (or inline `as const` table): `input → expected decision`, generated ONCE
  from the current implementation and committed as the baseline.
- A documented **`--update-golden`** path to regenerate intentionally (the diff is the review artifact).
- Golden applies ONLY to the deterministic layer. The live layer uses property assertions, never golden.

## How it protects future refactors
- **WS A (reliability consolidation):** the golden decision + decision-sequence layer proves the new
  `TurnPipeline`/`classifyTurnSignal` produce identical decisions for every fixture → behavior-neutral,
  no live testing. This is the gate that lets A proceed in parallel.
- **WS B (prompt/settings):** the live understanding layer catches classification regressions from
  prompt edits; the pure layer confirms settings changes don't alter decision logic.
- **Routing / low-signal / aggregation:** any change that shifts a decision shows up as a golden diff.

## Outputs / reports
- A one-screen summary: deterministic `N/N golden cases match` (expected 0 diffs); live
  `M checks, K passed (rerun-tolerant)`.
- On golden mismatch: a readable per-case **diff** (`input → expected vs actual`) so a regression is
  obvious at a glance.
- A single line of live-call count (cost transparency). No dashboards, no HTML, no coverage reports.

## Validation requirements (definition of done for this mission)
- `npm run lint` clean, `npm run build` green.
- Deterministic eval runs with **no network and no DB writes**, fast, and **passes with 0 golden diffs**
  against current `main`.
- Live eval runs behind its own command and is not required for the deterministic pass (CI-safe without
  Gemini keys).
- Existing `simulate-conversations.ts` still passes unchanged (this mission does not modify it).
- Golden baseline committed; `--update-golden` documented in the script header.

## Explicit non-goals
- **Not** a general testing framework/platform, new test runner, CI build-out, coverage tooling, or
  LLM-as-judge.
- **Not** a rewrite or absorption of `simulate-conversations.ts` (leave it as-is; do not entangle).
- **Not** exhaustive model-quality evaluation or a large prompt dataset.
- **Not** UI/dashboard, booking-platform e2e, or multi-tenancy testing.
- **Not** any runtime behavior change — the harness only OBSERVES (the sole allowed `lib/**` edit is
  adding a missing `export`).
- **Not** chasing determinism for the live layer — isolate and tolerate temp-0.7 variance.

## Standing constraints
TypeScript strict, no `any` in lib. Keep it small. Do not commit or push until the owner approves.
Restart note is irrelevant (no runtime change). Branch: `infra/eval-harness`.
