# REPOSITORY_MAP — receptionist-core

Repository root: this folder (`receptionist-core/` — has its own `.git`).
Remote: https://github.com/GooblyZ/whatsapp-booking-agent (default branch `main`).

## Directory tree (important parts)
```
receptionist-core/
├─ app/                         Next.js App Router
│  ├─ api/
│  │  ├─ webhook/whatsapp/route.ts   ★ Meta webhook (GET verify, POST inbound/status)
│  │  ├─ webhook/route.ts            generic webhook stub
│  │  └─ health/…                    /api/health, /db, /whatsapp probes
│  ├─ dashboard/                ★ owner dashboard (password-gated)
│  │  ├─ page.tsx               overview + integration health + AI usage
│  │  ├─ appointments/          list + status actions
│  │  ├─ services/  business-hours/  business-settings/  knowledge-base/  staff/
│  │  ├─ ai-settings/           tone/length/emoji/custom instructions + AI toggles
│  │  ├─ ai-debug/              single-turn brain tester (extraction + grounding view)
│  │  ├─ ai-assistant/          assistant config page
│  │  └─ activity/              message/event feed
│  ├─ login/                    dashboard password login
│  └─ layout.tsx, page.tsx      root layout/landing
├─ lib/
│  ├─ ai/                       ★★ THE AI RECEPTIONIST
│  │  ├─ idle-handler.ts        ★ conversation ENGINE — one turn, end to end
│  │  ├─ brain.ts               ★ pure Gemini turn: prompt → call → parse → ground
│  │  ├─ booking-session.ts     ★ BookingSession state + Hebrew probe + merge logic
│  │  ├─ reply-polish.ts        ★ deterministic reply guards (verdict alignment,
│  │  │                           booked-claim fence, date echo, CTA, duplicates)
│  │  ├─ gemini.ts              API client, 503 retry + cooldown, token/cost logging
│  │  ├─ persona.ts             system-instruction builder (owner settings authority)
│  │  ├─ grounding.ts           fact verification + rich Hebrew TIME parser
│  │  ├─ availability-facts.ts  4-way availability verdicts + prompt rendering
│  │  ├─ conversation.ts        memory from messages table (gap-bounded) + helpers
│  │  ├─ facts.ts               business facts/index for grounding
│  │  ├─ context.ts             getBusinessAIContext (settings/services/KB/hours)
│  │  └─ events.ts              ai_events safe telemetry
│  ├─ booking/
│  │  ├─ flow.ts                ★ router: deterministic vs engine; confirmation INSERT
│  │  ├─ availability.ts        slot grid, isIntervalFree, Hebrew date parse, TZ utils
│  │  └─ helpers.ts             conversation_states/messages DB helpers
│  ├─ message-handler.ts        ★ inbound pipeline: dedup, save, degraded gate, bursts
│  ├─ whatsapp.ts               Cloud API send + failure classification + auth probe
│  ├─ integration-health.ts     WhatsApp health state machine (per business)
│  ├─ services/                 dashboard CRUD services (ai-settings, catalog, hours…)
│  ├─ supabase/server.ts        ★ service-role client (SERVER ONLY)
│  └─ config.ts                 DEFAULT_BUSINESS_ID
├─ scripts/                     dev validation (run: node --env-file=.env.local --import tsx …)
│  ├─ simulate-conversations.ts ★ 20-scenario regression suite (live Gemini)
│  ├─ audit-token-usage.ts      token/cost audit (countTokens + live replay + DB volume)
│  ├─ diagnose-gemini-json.ts   model/config probe matrix (malformed-JSON forensics)
│  └─ simulate-whatsapp-health.ts  17 health-logic checks
├─ supabase/
│  ├─ schema.sql                ★ canonical schema mirror
│  ├─ migrations/               002,003,004,005,phase_4 applied; ⚠ 006 NOT yet applied
│  └─ seed.sql
├─ types/database.ts            TS types for all tables + BusinessAIContext
├─ proxy.ts                     Next middleware: /dashboard auth gate
├─ PROJECT_CONTEXT.md  CURRENT_STATE.md  SESSION_HANDOFF.md  CLAUDE.md  AGENTS.md
└─ README.md                    setup + env var documentation
```

## Entry points
- **Inbound customer message**: `app/api/webhook/whatsapp/route.ts` →
  `lib/message-handler.ts` → `lib/booking/flow.ts` → `lib/ai/idle-handler.ts`.
- **Dashboard**: `proxy.ts` (auth) → `app/dashboard/*` (server components + actions).
- **Health**: `app/api/health/*`.
- **Dev validation**: `scripts/simulate-conversations.ts`.

## API routes
| Route | Purpose |
|---|---|
| `GET/POST /api/webhook/whatsapp` | Meta verify / inbound messages + statuses |
| `POST /api/webhook` | generic stub |
| `GET /api/health` | liveness |
| `GET /api/health/db` | Supabase connectivity |
| `GET /api/health/whatsapp` | Meta credentials probe |

## Database-related files
`supabase/schema.sql` (truth), `supabase/migrations/*.sql` (applied manually in Supabase
SQL editor — no framework), `types/database.ts`, `lib/supabase/server.ts` (+ client.ts
anon for any client-side needs), `lib/booking/helpers.ts`, `lib/services/*`.

## AI-related files
Everything under `lib/ai/` (see tree). Read order for onboarding:
`idle-handler.ts` → `brain.ts` → `booking-session.ts` → `reply-polish.ts` →
`availability-facts.ts` → `persona.ts` → `gemini.ts`.

## Booking-related files
`lib/booking/flow.ts` (router + the ONLY appointment INSERT),
`lib/booking/availability.ts` (slots/intervals/dates), `lib/ai/availability-facts.ts`
(verdicts), `lib/ai/booking-session.ts` (draft state).

## Env vars (names only — values live in `.env.local`, NEVER committed)
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_API_VERSION`, `META_VERIFY_TOKEN`,
`DEFAULT_BUSINESS_ID`, `DASHBOARD_ACCESS_PASSWORD`,
`GEMINI_API_KEY`, `GEMINI_MODEL` (default gemini-2.5-flash-lite),
`GEMINI_COOLDOWN_SECONDS`, `GEMINI_SIMULATE_OVERLOAD` (test hook),
`AI_MEMORY_TURNS`, `AI_MEMORY_MAX_AGE_HOURS`, `AI_MAX_TURN_CHARS`, `AI_MEMORY_GAP_HOURS`.
