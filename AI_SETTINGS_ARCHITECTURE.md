# AI Settings Architecture — Prompt-first Design (T2)

> **Status: DESIGN ONLY (2026-06-16). No code, migrations, or runtime behavior changed by this
> document.** This is the T2 / Workstream-B deliverable (`ai/prompt-settings`) called for by
> `ARCHITECTURE_ASSESSMENT.md` §5 and §7 (M1). It defines *which* AI settings should exist, derived
> from the ideal Gemini prompt — not from the current screen. Implementation (PRs, migrations, UI
> regroup) happens only after the open product decisions in §9 are answered and the owner approves.
>
> Evidence base (read at authoring time): `lib/ai/persona.ts` (`buildReceptionistInstruction`),
> `lib/ai/brain.ts` (`runReceptionistTurn`, `FALLBACK`), `lib/ai/platform-turn.ts`, `lib/ai/facts.ts`
> (`Capabilities`), `types/database.ts` (`AISettings`), `lib/services/ai-settings.ts`,
> `app/dashboard/ai-assistant/{page,actions,PersonaFields}.tsx`, `lib/ai/persona-enhance.ts`,
> `supabase/schema.sql` (`ai_settings`), `lib/config.ts` (`getBookingMode`).

---

## 1. Prompt-first principle

The settings must be the **owner-editable projection of the prompt**, not the other way around. The
prompt is the source of truth; the settings screen is one rendering of the owner-tunable parts of it.

Method used to build this design:
1. Decompose the runtime prompt into components.
2. Tag each component with an **owner**: *owner-editable* vs *engine-owned (invisible)*.
3. Only then ask, per owner-editable component, "would a business owner realistically tune this, and
   does it meaningfully change behavior?"

**A setting earns its place only if it satisfies at least one of:**
- Meaningfully changes the **customer experience**.
- Meaningfully changes the **assistant personality**.
- Meaningfully changes **business behavior**.
- Would realistically be adjusted by **business owners**.

If a setting exists only because of implementation history, it must not be exposed.

**Correctness lens applied throughout — the platform pivot.** The product targets
`BOOKING_MODE=platform`; `conversational` is explicitly legacy / Risk-G (`CURRENT_STATE.md`,
`TRANSITION_PLAN.md`). Therefore a setting that only does something in conversational mode is, for the
product's future, **dead** — and two of today's three capability toggles fail exactly this test (§3).

**Precedence spine (the load-bearing invariant the settings model must preserve).** The prompt encodes
a strict, non-overlapping order so two owner controls can never silently fight:

```
character (WHO YOU ARE)  <  format (HOW YOU WRITE)  <  hard rules (never-cross)
```

This is the single best decision in `persona.ts`. Every settings grouping below mirrors it.

---

## 2. Current prompt architecture

`buildReceptionistInstruction()` emits ~10K chars/turn, re-read from the DB every turn (no caching),
in this order:

| # | Block | Source of truth | Owner |
|---|---|---|---|
| 1 | **Identity** — `"{name}" — receptionist of "{business}"`, texting on WhatsApp | `assistant_name` + business | mixed |
| 2 | "You are a person, not a system running a flow" | hardcoded | engine |
| 3 | **Date anchor** — today/tomorrow weekday (per-turn) | system | engine |
| 4 | **WHO YOU ARE** — `custom_instructions ‖ persona_voice ‖ tone-map` + **gender line** + "personality is behavior, not vocabulary" | settings | **owner (primary)** |
| 5 | **HOW YOU WRITE** — language / length / emoji + "character ≠ length" | settings | owner |
| 6 | **HARD RULES** — `things_to_avoid` (only when set) | settings | owner |
| 7 | **WORKING MEMORY** — customer + existing-appointments block | system | engine |
| 8 | Stuck-turn warning (≥2 turns no progress) | system | engine |
| 9 | **HOW YOU CONVERSE** — react-first, tiny-message handling, "name 2–3 real services", corrections, recap, neutral gender | hardcoded | engine |
| 10 | **FACTS & HONESTY** — answer only from facts, answer-first, ambiguity→one question, availability rules | hardcoded | engine |
| 11 | **APPOINTMENTS** — platform vs conversational branch | hardcoded (mode) | engine |
| 12 | FAQ gate — "do not answer info questions" (only when `faq_enabled=false`) | setting | owner |
| 13 | **BUSINESS FACTS** | business data (services/KB/hours) | owner-elsewhere |
| 14 | **AVAILABILITY** (conversational only) | system | engine |
| 15 | History (native turns, or embedded transcript) | system | engine |
| 16 | `replyGuidance` system note | system | engine |
| 17 | **OUTPUT JSON contract** | system | engine |
| 18 | **ACTIONABILITY rule** ("decide `requestsBusinessAction` FIRST") | system | engine |

### 2.1 Strong sections (engine-owned, keep)
- **Precedence spine** (4 → 5 → 6) — why a single free-text personality field works without chaos.
- **Single voice authority** — `custom_instructions` is the *only* personality input; the old
  tone-vs-voice conflict is gone by construction.
- **Date anchor, ACTIONABILITY gate, FACTS & HONESTY, working memory, platform fences** — these encode
  the core law ("the model understands; the system validates and executes"). Correctness, not preference.
- **Gender self-reference line** — correctly modeled as the assistant's own grammar, separate from how
  it addresses the customer.

### 2.2 Weak sections
1. **`language` is asserted but not honored downstream.** The prompt says "Language: en," but every
   deterministic customer-facing string — the booking CTA (`BOOK_LINE`/`MANAGE_LINE`/`MY_APPTS_LINE`),
   `LOW_SIGNAL_*`, `COMPLAINT_ACK`, `META_FALLBACK`, degraded-mode text, `FALLBACK.aiDisabled` — is
   **hardcoded Hebrew**. So `language≠he` yields a half-broken bilingual experience. For a
   business-agnostic product meant to serve non-Hebrew tenants, this is the biggest coherence gap.
   *(System fix, not a setting — see §6 and §8.)*
2. **Imperative density / redundancy.** Gender-neutral phrasing is instructed three times (gender line,
   "default to neutral," honesty block). The file's own header warns "instruction overload produces
   compliance-shaped, robotic prose." Engine tuning, not a settings concern.
3. **Dead fallback chain inside the live builder** — `LEGACY_TONE_PROFILE` + `persona_voice ‖ tone`
   carried in `persona.ts`. Latent debt the settings cleanup should retire.
4. **Empty-personality default** is a fixed "warm, helpful, professional" — fine, but a brand-new tenant
   has a generic voice until they write one (onboarding concern).

### 2.3 What should NEVER be configurable (engine correctness)
Actionability gate · output JSON contract · honesty/grounding rules · working-memory block · date
anchor · platform fences (link mechanics, scheduling-question defusing) · low-signal / quiet-mode · the
"person, not a flow" identity frame · HOW-YOU-CONVERSE mechanics. Exposing any of these invites an owner
to break the core law.

---

## 3. Existing settings assessment

Every column on `ai_settings` today, with a verdict.

| Setting | Verdict | Reasoning | Behavior impact |
|---|---|---|---|
| `custom_instructions` | **Keep (the star)** | Sole voice authority; the primary lever. Deserves the most UI room + ✨ enhance. | High |
| `assistant_name` | **Keep** | Identity; appears in prompt + self-intro. | Medium |
| `assistant_gender` | **Keep** | Real correctness lever for gendered languages (Hebrew self-reference). | Medium (Hebrew) |
| `response_length` | **Keep** | Format; distinct prompt deltas (`lengthHint`). | High |
| `emoji_usage` | **Keep** | Format; also enforced deterministically at the outbound chokepoint. | High |
| `language` | **Keep, but fix** | Meaningful, but only half-wired (§2.2 #1). Keep the setting; pair with the system localization fix + a new fixed/mirror mode. | High once fixed |
| `things_to_avoid` | **Keep (advanced)** | Hard-rule layer; overrides everything. Real boundary control. | High when set |
| `tone` | **Remove** | Already retired from UI/persona; lives only as a silent fallback. Finish the removal (backfill first). | None (dead) |
| `business_type` | **Remove** | Retired 2026-06-13; violates "classify operations, not business types." | None (dead) |
| `persona_voice` | **Remove** | Merged into `custom_instructions` (migration 009); read-only fallback only. | None (dead) |
| `intent_detection_enabled` | **Remove** | **Dead in platform mode.** It only feeds `caps.canStartBooking`, which the persona consults **only in the conversational branch**; platform link attachment is driven entirely by `routing.ts` + `hasBookingSignal`. Changes nothing in the target architecture. | **None in platform** |
| `faq_enabled` | **Remove (or demote to advanced)** | Marginal. "Answer booking intent but refuse all questions" is a rare want and makes the product worse. Only effect is one prompt line. | Low |
| `ai_enabled` | **Replace** → single "Assistant active" master switch **+ fix its fallback** | The concept (pause the AI) is legitimate, but its "off" text — `"כדי לקבוע תור כתוב 'תור'"` — is conversational-only and **broken in platform mode**: it names a keyword that triggers no flow, and because the decision returns `ok:false`, **no booking link attaches either** → a dead end. | High (currently a latent bug) |

**Headline findings (concrete, verifiable):**
- **`intent_detection_enabled` is vestigial** in the platform target — pure implementation residue.
- **`ai_enabled` "off" is a broken UX in platform mode** — the toggle's semantics were never updated
  for the pivot.
- The three capability toggles are the clearest example of *settings that exist because of
  implementation history, not owner value.* Collapse three → one.

---

## 4. Final proposed settings model

Four owner-facing groups mirroring the precedence spine, plus one slim status control. ~8 meaningful
fields, vs today's 8 live + 3 dead + 2 marginal.

**A · Identity — "Who your receptionist is"**
- `assistant_name`
- `assistant_gender` *(shown only for gendered languages; neutral default)*

**B · Personality — "How it should act"** *(primary surface; largest field)*
- `personality` (= `custom_instructions`) + ✨ enhance

**C · Writing style — "How it writes"**
- `response_length` · `emoji_usage` · `language` · **`language_mode`** *(new: fixed | mirror)*

**D · Boundaries — "What it must / mustn't do"**
- `things_to_avoid` (hard rules; advanced)
- **`fallback_behavior`** *(new: refer-to-phone | take-a-message | human-follow-up)* + optional
  `escalation_contact`

**E · Status — one master switch**
- `assistant_active` *(replaces `ai_enabled`; "off" = pause AI, route to booking link / configured
  fallback — never the broken keyword text)*

| Field | Category | Type | Prompt component | Owner-editable |
|---|---|---|---|---|
| `assistant_name` | Identity | text | Identity | ✅ |
| `assistant_gender` | Identity | enum | gender line | ✅ |
| `personality` (`custom_instructions`) | Personality | textarea + ✨ | WHO YOU ARE | ✅ (primary) |
| `response_length` | Style | enum | HOW YOU WRITE | ✅ |
| `emoji_usage` | Style | enum | HOW YOU WRITE + chokepoint | ✅ |
| `language` | Style | enum | HOW YOU WRITE + (system strings) | ✅ |
| `language_mode` *(new)* | Style | enum | HOW YOU WRITE | ✅ |
| `things_to_avoid` | Boundaries | textarea | HARD RULES | ✅ (advanced) |
| `fallback_behavior` *(new)* | Boundaries | enum + text | FACTS & HONESTY escalation | ✅ |
| `assistant_active` *(replaces `ai_enabled`)* | Status | bool | gates the call | ✅ |

Everything else (working memory, actionability, honesty, fences, output contract, CTA mechanics, quiet
mode) stays **engine-owned and invisible**.

---

## 5. Removed / deprecated settings

| Setting | Action | Pre-req before removal |
|---|---|---|
| `tone` | Drop column; remove `LEGACY_TONE_PROFILE` + fallback chain from `persona.ts` | **Backfill** any tenant whose personality is empty but `tone` is set → `custom_instructions` |
| `persona_voice` | Drop column; remove fallback | **Backfill** empty-personality tenants relying on `persona_voice` |
| `business_type` | Drop column | None (already unused in persona) |
| `intent_detection_enabled` | Drop column | Confirm nothing else reads `caps.canStartBooking` in platform path (currently only the conversational branch + debug page do) |
| `faq_enabled` | Drop or demote to advanced | Decide in §9; if removed, the FAQ gate line goes away (assistant always answers from facts) |
| `ai_enabled` | **Replace**, not drop → `assistant_active` | Fix the "off" behavior (T1 owns the string — §8) |

> ⚠ **Data-safety ordering:** the persona currently reads `tone` and `persona_voice` as **silent
> fallbacks**. Dropping them without the backfill would silently change a live tenant's voice. Backfill
> first (read-only inspection of live data before assuming the test tenant is clean), then drop.

---

## 6. Missing settings

Ranked by how clearly they pass the §1 bar.

1. **Fallback / escalation behavior** *(business behavior — strong).* "When you can't help:
   (a) refer to phone, (b) take a message for the team, (c) say a human will follow up." Optional
   escalation contact/label. Today hardcoded as "point them to the business (its phone)."
2. **Language mode: fixed vs mirror customer** *(customer experience — strong).* Realistic for
   multilingual clienteles (Hebrew / Arabic / Russian). Distinct, tunable, meaningful.
3. **Welcome / first-message** *(experience — medium, optional).* Many owners want a specific opener.
   Could live in persona; a dedicated optional field is a natural lever.
4. **After-hours / closed message** *(business behavior — medium, optional).* Overlaps
   `business_settings` / hours — decide ownership before adding to avoid duplicating business config.

**Not a setting — a required SYSTEM fix (flagged loudly):** **localize the deterministic CTA + canned
strings by `language`.** Without it, `language` is a half-promise and the product cannot serve a
non-Hebrew tenant. This is engine work in `platform-turn.ts` / `brain.ts FALLBACK` — see §8.

**Explicitly NOT worth adding:** temperature / model / token knobs (engine; owner prioritizes quality
over cost), a "tone preset" (just retired — do not reintroduce), per-intent prompt overrides (breaks the
single-call law), a free-text CTA label (owners would break it — localize by system instead).

---

## 7. Migration plan

The migration runner is **manual** (Supabase SQL editor); keep `supabase/schema.sql` in sync with every
migration. Each behavior change gets a sim scenario (the suite already has #25 for settings precedence —
extend it). Defaults must preserve current behavior exactly.

**Phase 1 — Backfill, then drop dead columns.**
1. Backfill: for any tenant with empty `custom_instructions` but a set `tone` / `persona_voice`, write
   the equivalent into `custom_instructions`. Inspect live data read-only first.
2. Migration: drop `tone`, `business_type`, `persona_voice`. Remove `LEGACY_TONE_PROFILE` + the fallback
   chain from `persona.ts`. Sync `schema.sql`.

**Phase 2 — Collapse the toggles.**
3. Remove `intent_detection_enabled` (dead) and `faq_enabled` (decision §9). Rename/repurpose
   `ai_enabled` → `assistant_active`, and **fix the platform "off" path** so it routes to the booking
   link / configured fallback instead of the conversational keyword text. *(The string lives in
   `brain.ts FALLBACK` — T1's footprint; see §8.)*

**Phase 3 — Add the two justified new settings.**
4. Migration: add `language_mode` (default `fixed` = today's behavior) and `fallback_behavior`
   (+ optional contact). Wire into `persona.ts` (new lines in HOW YOU WRITE / FACTS & HONESTY). Defaults
   preserve current behavior.

**Phase 4 — UI regroup (the T2 → T3 handoff).**
5. Re-section `PersonaFields.tsx` into Identity / Personality / Writing style / Boundaries / Status. T2
   defines *which* fields exist; **T3 restyles** that screen afterward — do not restyle twice.

**Cross-cutting discipline.** Serialize migrations — this track's column drops must not ship
concurrently with T5's tenant schema (per `ARCHITECTURE_ASSESSMENT.md` §8). Land small, reviewable
increments; integrate to `main` frequently.

### Suggested PR breakdown (within `ai/prompt-settings`)
- **PR-1** *(do first; low risk; no owner input needed)* — Phase 1 + Phase 2 + Phase 4 UI regroup.
  Self-contained; unblocks T3.
- **PR-2** *(needs the §9 product decisions answered)* — Phase 3, the two new settings.
- **Hand-off item (NOT in this branch)** — the string-localization + `assistant_active`-off fallback;
  belongs to T1 (§8).

---

## 8. T1 / T2 ownership boundary

T2 (`ai/prompt-settings`) and T1 (`reliability/consolidation`) may run in parallel **only with explicit
file ownership** (`ARCHITECTURE_ASSESSMENT.md` §8). The settings work touches one surface that is firmly
in T1's footprint, so the boundary is drawn here:

| Concern | Owner | Files |
|---|---|---|
| Which settings exist; `AISettings` shape; persona **prompt text** for settings; settings UI contract | **T2** | `persona.ts` (prompt strings), `types/database.ts` (`AISettings`), `lib/services/ai-settings.ts`, `PersonaFields.tsx`, settings migrations |
| Turn pipeline, classifiers, low-signal/quiet machinery, **deterministic canned strings**, `FALLBACK.*` | **T1** | `platform-turn.ts`, `routing.ts`, `brain.ts` (incl. `FALLBACK`), `conversation.ts`, `message-handler.ts`, `flow.ts` |

**Two items that T2 *decides* but T1 *implements*:**
1. **Localize CTA + canned strings by `language`** — the strings live in `platform-turn.ts` and
   `brain.ts FALLBACK` (T1's files). T2 owns the *requirement* ("these must follow the `language`
   setting"); T1 owns the change. Doing it in T2 would collide with T1 on the load-bearing turn
   pipeline.
2. **`assistant_active` "off" behavior** — the broken `FALLBACK.aiDisabled` string and its routing live
   in `brain.ts` / the turn path (T1). T2 owns the *semantics decision* (the master switch exists; "off"
   routes to the link / fallback, not a conversational keyword); T1 owns the string + routing fix.

Sim test file `scripts/simulate-conversations.ts` is shared — partition by scenario-number range while
both tracks are active (per §8 of the assessment).

---

## 9. Open product decisions

These block PR-2; PR-1 can proceed without them.

1. **`fallback_behavior` options.** Which fallback modes do we offer, and is the default
   "refer to phone"? Candidates: refer-to-phone · take-a-message · human-will-follow-up · (combination).
   Does it reuse the business phone, or take a separate `escalation_contact`? *(Owner product input.)*
2. **`faq_enabled` — remove entirely, or keep as an advanced toggle?** Recommended: remove (fold into
   `assistant_active`). Keeping it means retaining one prompt line + one column for a rarely-wanted
   behavior. *(Owner decision; low stakes.)*
3. **`language_mode` default.** `fixed` (current behavior, safe) vs `mirror` (often what a multilingual
   clientele wants). Recommended default `fixed` to preserve current behavior; owner can opt into mirror.
4. **Welcome message + after-hours message — in scope for T2 or deferred?** Both are plausible owner
   levers but overlap other surfaces (persona / `business_settings`). Recommended: **defer** out of the
   first settings pass to keep PR-1/PR-2 contained; revisit during productization (T3).
5. **`assistant_active` "off" semantics.** Confirm the desired behavior when an owner pauses the AI in
   platform mode: silent (no reply) vs always-send-booking-link vs the configured `fallback_behavior`.
   Recommended: route to `fallback_behavior`. *(Owner decision; couples to #1 and to T1 per §8.)*

---

*End of T2 design document. Implementation begins only after §9 is resolved and the owner approves.*
