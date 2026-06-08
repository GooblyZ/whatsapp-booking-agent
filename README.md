# receptionist-core

WhatsApp-first digital receptionist SaaS — foundation layer.

Designed for appointment-based service businesses: hairdressers, barbers, physiotherapists,
therapists, Pilates instructors, consultants, private teachers, and more.

---

## What is implemented

- Next.js App Router project (TypeScript)
- Supabase client setup (server-side + browser-side, service role key never reaches the browser)
- Multi-tenant PostgreSQL schema (13 tables, all scoped to `business_id`)
- Meta WhatsApp Cloud API webhook (`GET` verification + `POST` message receiver)
- `sendWhatsAppMessage()` helper (server-side only)
- Health check endpoint (`/api/health`)
- Environment variable template (`.env.example`)
- **Dashboard foundation** — 5 CRUD pages backed by real Supabase queries:
  - `/dashboard` — live stats (customers, appointments, services, messages)
  - `/dashboard/business-settings` — name, phone, timezone, language, booking config, cancellation policy
  - `/dashboard/services` — list, create, edit, activate/deactivate (optional categories)
  - `/dashboard/staff` — list, create, edit, activate/deactivate (always optional — one-person businesses work fine)
  - `/dashboard/knowledge-base` — list, create, edit, activate/deactivate, delete
  - `/dashboard/ai-settings` — assistant name, tone, response length, emoji usage, language, custom instructions
- **Service layer** (`lib/services/`) — clean reusable async functions for all CRUD operations
- **AI context builder** (`lib/ai/context.ts`) — `getBusinessAIContext()` aggregates all data Gemini will need

## What is intentionally NOT implemented yet

- Authentication (Supabase Auth — next phase)
- AI / Gemini / LLM integration (context builder is ready; integration is next)
- Booking flow logic
- Availability calculation
- Rescheduling
- Reminders
- Waitlist
- Payments
- Email / SMS
- Per-business webhook routing (currently uses `DEFAULT_BUSINESS_ID`)

---

## Folder structure

```
receptionist-core/
├── app/
│   ├── api/
│   │   ├── health/route.ts                  # GET /api/health → { ok: true }
│   │   └── webhook/route.ts                 # GET + POST /api/webhook (Meta WhatsApp)
│   ├── dashboard/
│   │   ├── layout.tsx                       # Dashboard nav layout
│   │   ├── page.tsx                         # /dashboard — live stats
│   │   ├── business-settings/
│   │   │   ├── page.tsx                     # /dashboard/business-settings
│   │   │   └── actions.ts                   # Server Actions: save settings
│   │   ├── services/
│   │   │   ├── page.tsx                     # /dashboard/services — CRUD
│   │   │   └── actions.ts                   # Server Actions: create, update, toggle
│   │   ├── staff/
│   │   │   ├── page.tsx                     # /dashboard/staff — CRUD
│   │   │   └── actions.ts                   # Server Actions: create, update, toggle
│   │   ├── knowledge-base/
│   │   │   ├── page.tsx                     # /dashboard/knowledge-base — CRUD + delete
│   │   │   └── actions.ts                   # Server Actions: create, update, toggle, delete
│   │   └── ai-settings/
│   │       ├── page.tsx                     # /dashboard/ai-settings — form
│   │       └── actions.ts                   # Server Actions: save
│   ├── layout.tsx
│   └── page.tsx
├── lib/
│   ├── supabase/
│   │   ├── server.ts                        # Server-side Supabase client (service role)
│   │   ├── client.ts                        # Browser-side Supabase client (anon key)
│   │   └── types.ts                         # Database type wrapper (replace with generated types)
│   ├── whatsapp/
│   │   └── send-message.ts                  # sendWhatsAppMessage() helper
│   ├── services/
│   │   ├── business.ts                      # getBusinessWithSettings, updateBusinessSettings
│   │   ├── catalog.ts                       # getServices, createService, updateService
│   │   ├── staff.ts                         # getStaffMembers, createStaffMember, updateStaffMember
│   │   ├── knowledge-base.ts                # getKnowledgeBaseItems, create, update, delete
│   │   └── ai-settings.ts                   # getAISettings, updateAISettings
│   ├── ai/
│   │   └── context.ts                       # getBusinessAIContext() — AI data aggregator
│   └── config.ts                            # getDefaultBusinessId() helper
├── types/
│   └── database.ts                          # TypeScript types for all DB entities
├── supabase/
│   └── schema.sql                           # Full PostgreSQL schema — run in Supabase SQL Editor
├── .env.example                             # Environment variable template
└── README.md
```

---

## Environment variables

Copy `.env.example` to `.env.local` and fill in all values.

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (safe for browser) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key — enforces RLS (safe for browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key — bypasses RLS. **Server only. Never expose.** |
| `META_VERIFY_TOKEN` | Secret string you choose — entered in Meta developer console |
| `META_ACCESS_TOKEN` | Meta permanent access token |
| `META_PHONE_NUMBER_ID` | Meta WhatsApp phone number ID |
| `DEFAULT_BUSINESS_ID` | UUID of the business row in Supabase for this webhook instance |
| `DASHBOARD_ACCESS_PASSWORD` | Password for the `/dashboard` management UI. **Required in production.** If not set, the dashboard is accessible without authentication and both `/login` and the dashboard nav show a yellow warning banner. |
| `META_VERIFY_TOKEN` | A secret string you choose and enter in the Meta webhook console to verify ownership. |
| `META_ACCESS_TOKEN` | Meta permanent system user access token (or temporary test token). |
| `META_PHONE_NUMBER_ID` | WhatsApp Business phone number ID from the Meta developer console. |
| `META_API_VERSION` | Meta Graph API version (default: `v20.0`). Optional. |

---

## Local setup

```bash
# 1. Install dependencies
npm install

# 2. Create .env.local from the template
cp .env.example .env.local
# Edit .env.local with real values

# 3. Run the dev server
npm run dev
```

---

## Supabase setup

1. Create a new project at [supabase.com](https://supabase.com).
2. Go to **Project Settings → API** and copy:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`
3. Go to **SQL Editor → New query**, paste the contents of `supabase/schema.sql`, and run it.
4. Insert your first business row:
   ```sql
   INSERT INTO businesses (name, slug, timezone)
   VALUES ('My Business', 'my-business', 'Asia/Jerusalem')
   RETURNING id;
   ```
5. Copy the returned `id` into `DEFAULT_BUSINESS_ID` in your `.env.local`.
6. (Optional) Run `npx supabase gen types typescript --project-id <your-project-id> > lib/supabase/types.ts`
   to replace the placeholder types with fully generated ones.

---

## Meta webhook setup

1. Go to [developers.facebook.com](https://developers.facebook.com) → your app → WhatsApp → Configuration.
2. Set **Callback URL** to: `https://your-domain.com/api/webhook`
3. Set **Verify token** to the value you chose for `META_VERIFY_TOKEN`.
4. Subscribe to the **messages** field under Webhooks.
5. Test by sending a WhatsApp message to your connected phone number.

For local development, use [ngrok](https://ngrok.com) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) to expose `localhost:3000` to the internet.

```bash
# Example with ngrok
npx ngrok http 3000
# Use the https URL as your webhook callback URL in Meta
```

---

## Vercel deployment

1. Push the project to a GitHub repository.
2. Import the repo into [vercel.com](https://vercel.com).
3. Add all environment variables from `.env.example` in the Vercel project settings.
4. Deploy. Vercel will build and serve the Next.js app.
5. Update the Meta webhook callback URL to your Vercel domain.

---

## Dashboard foundation (pass 3)

Changes added in this phase:

### New database tables

**`knowledge_base_items`** — Structured knowledge entries the AI receptionist uses to answer questions.
- Categories: `faq`, `pricing`, `parking`, `policy`, `contact`, `custom`
- Each entry has a `title` (the question), `content` (the answer), and an `active` flag
- Purpose: business owners populate this once; the AI queries it per conversation

**`ai_settings`** — Controls the AI receptionist's communication style per business.
- One row per business (`UNIQUE (business_id)`)
- Fields: `assistant_name`, `tone`, `response_length`, `emoji_usage`, `language`, `custom_instructions`
- All fields have sensible defaults — works out of the box before any configuration

### Dashboard pages

| Route | Purpose |
|---|---|
| `/dashboard` | Live counts: customers, appointments, services, messages |
| `/dashboard/business-settings` | Edit business name, phone, timezone, language, booking config |
| `/dashboard/services` | CRUD for services. Categories optional — one service works fine |
| `/dashboard/staff` | CRUD for staff members. Always optional — one-person businesses work without this |
| `/dashboard/knowledge-base` | CRUD for knowledge base entries with activate/deactivate and delete |
| `/dashboard/ai-settings` | Configure AI receptionist personality and communication style |

All pages are `force-dynamic` (server-rendered on demand, never statically prerendered).
All mutations use Next.js Server Actions with `revalidatePath` / `redirect` after commit.

### Service layer (`lib/services/`)

All functions take `businessId` as the first parameter — they are reusable when authentication is added.

```typescript
// Business
getBusinessWithSettings(businessId)
updateBusinessSettings(businessId, data)

// Services catalog
getServices(businessId)
getServiceCategories(businessId)
createService(businessId, data)
updateService(businessId, serviceId, data)

// Staff
getStaffMembers(businessId)
createStaffMember(businessId, data)
updateStaffMember(businessId, staffId, data)

// Knowledge base
getKnowledgeBaseItems(businessId)
createKnowledgeBaseItem(businessId, data)
updateKnowledgeBaseItem(businessId, itemId, data)
deleteKnowledgeBaseItem(businessId, itemId)

// AI settings
getAISettings(businessId)
updateAISettings(businessId, data)
```

### AI context builder (`lib/ai/context.ts`)

`getBusinessAIContext(businessId)` aggregates all data needed for an AI conversation:

```typescript
{
  business,           // name, timezone, phone
  businessSettings,   // booking config, cancellation policy
  aiSettings,         // tone, response length, language, custom instructions
  services,           // what the business offers (name, price, duration)
  knowledgeBaseItems  // FAQs, policies, parking, pricing text
}
```

**No AI calls are made.** This is preparation only. When Gemini is integrated, pass this context as the system prompt. The AI can then answer questions about services, pricing, policies, and parking without hallucinating.

### Future Gemini integration plan

1. Enable Gemini in `app/api/webhook/route.ts` — after storing the inbound message, call `getBusinessAIContext(businessId)` and pass it to Gemini with the customer's message.
2. Gemini composes a reply using the context (services, knowledge base, AI settings for tone/language).
3. Pass the reply to `sendWhatsAppMessage()` to deliver it.
4. If the customer wants to book, transition the `conversation_states` row to a booking flow state.

No other files need to change for basic AI Q&A. The context builder is the integration point.

---

## Foundation hardening (pass 2)

Changes applied on top of the initial foundation:

- **`appointments.staff_member_id`** — nullable FK to `staff_members`. Allows optional staff assignment per appointment without requiring it for simple businesses.
- **`staff_working_hours` table** — per-staff weekly schedule, prepared for future availability logic. Falls back to `business_hours` when no row exists.
- **`service_categories` table** — optional grouping for services (e.g. "Hair", "Nails", "Consultations"). Unique per `(business_id, name)`.
- **`services.category_id`** — nullable FK to `service_categories`. No categories required.
- **`appointments.source` CHECK updated** — values changed from `website/admin` to `dashboard/manual/system` to better reflect SaaS reality.
- **`updated_at` triggers** — extended to cover the two new tables.

---

## Architecture notes

- **Multi-tenant from day one**: every table carries `business_id`. A single database serves all businesses with row-level isolation.
- **Service role key is server-only**: `lib/supabase/server.ts` is imported only in API routes and Server Actions. The browser receives only the anon key.
- **Webhook returns 200 immediately**: message processing runs asynchronously. Meta never receives a timeout or error response that would trigger retries.
- **Raw payload stored**: every inbound message stores `raw_payload` (JSONB). This enables replaying events and debugging without losing data.
- **`DEFAULT_BUSINESS_ID`**: a temporary env variable for single-tenant development. When per-business WhatsApp numbers are supported, the webhook will resolve `business_id` from the `META_PHONE_NUMBER_ID` in the payload.

---

## WhatsApp Cloud API — setup guide

### What this provides

`app/api/webhook/whatsapp/route.ts` — the canonical WhatsApp webhook endpoint.

Flow: WhatsApp user → Meta Cloud API → `POST /api/webhook/whatsapp` → `lib/message-handler.ts` → Supabase + fallback Hebrew reply.

The fallback reply (sent until AI is integrated):
```
ההודעה התקבלה בהצלחה.
מערכת העוזר החכם עדיין בשלבי פיתוח.
```

### What is NOT implemented yet

- AI / Gemini reasoning
- Booking logic (appointment creation)
- Real conversation flow (intent detection, slot selection)
- Multi-business webhook routing

---

### Step 1 — Values you need from Meta

Log in to [developers.facebook.com](https://developers.facebook.com) → your app → WhatsApp → API Setup.

| Meta value | Where to find it | Env var |
|---|---|---|
| **Phone Number ID** | WhatsApp → API Setup → Phone Number | `META_PHONE_NUMBER_ID` |
| **Access Token** | Temporary: on the API Setup page. Permanent: create a System User in Business Settings. | `META_ACCESS_TOKEN` |
| **Verify Token** | You choose any string | `META_VERIFY_TOKEN` |

---

### Step 2 — Add env vars

Add to `.env.local`:

```env
META_VERIFY_TOKEN=your-secret-verify-string
META_ACCESS_TOKEN=your-meta-access-token
META_PHONE_NUMBER_ID=your-phone-number-id
META_API_VERSION=v20.0
```

---

### Step 3 — Expose localhost for local development

Meta requires a publicly reachable HTTPS URL. Use ngrok or Cloudflare Tunnel:

```bash
# ngrok
npx ngrok http 3000
# Cloudflare Tunnel
npx cloudflared tunnel --url http://localhost:3000
```

Copy the generated HTTPS URL — you need it in Meta.

---

### Step 4 — Register the webhook in Meta

1. Go to **Meta developer console → your app → WhatsApp → Configuration**.
2. Click **Edit** next to Webhook.
3. Set **Callback URL** to:
   ```
   https://<your-ngrok-or-domain>/api/webhook/whatsapp
   ```
4. Set **Verify token** to the value you chose for `META_VERIFY_TOKEN`.
5. Click **Verify and Save** — Meta sends a GET request; your server responds with the challenge.
6. Under **Webhook fields**, subscribe to **`messages`**.

---

### Step 5 — Send a test message

Send a WhatsApp message from the test number (set up in Meta API Setup) to the phone number linked to your `META_PHONE_NUMBER_ID`.

Or use curl to simulate the webhook POST locally:

```bash
curl -X POST http://localhost:3000/api/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -d '{
    "object": "whatsapp_business_account",
    "entry": [{
      "changes": [{
        "field": "messages",
        "value": {
          "messages": [{
            "id": "wamid.test001",
            "from": "972501234567",
            "timestamp": "1700000000",
            "type": "text",
            "text": { "body": "שלום" }
          }]
        }
      }]
    }]
  }'
```

Expected: `OK` (200). Check Supabase → `messages` table for the saved row.

---

### Step 6 — Verify in Supabase

After sending a message, confirm in Supabase → `messages`:

| Column | Expected value |
|---|---|
| `direction` | `inbound` |
| `channel` | `whatsapp` |
| `from_phone` | sender's phone |
| `body` | message text |
| `meta_message_id` | WhatsApp `wamid` |
| `wa_timestamp` | UTC datetime from Meta payload |

---

## WhatsApp booking flow — manual test guide

Use this to verify the end-to-end booking flow before connecting a real WhatsApp number.
You can simulate the webhook by sending POST requests with `curl` or Postman, or use ngrok to test with an actual phone.

### Prerequisites

1. Dev server running (`npm run dev`)
2. `DEFAULT_BUSINESS_ID` set to an existing business in `.env.local`
3. Seed data applied — run `supabase/seed.sql` in the Supabase SQL Editor
4. If testing via real WhatsApp: ngrok tunnel active, Meta webhook configured

### Simulating a message (curl)

Replace `<WAMID>` with any unique string (e.g. `wamid.test.001`).
Replace `<PHONE>` with any phone number string (e.g. `972501234567`).

```bash
curl -X POST http://localhost:3000/api/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "object": "whatsapp_business_account",
    "entry": [{
      "changes": [{
        "field": "messages",
        "value": {
          "messages": [{
            "id": "<WAMID>",
            "from": "<PHONE>",
            "type": "text",
            "text": { "body": "תור" }
          }]
        }
      }]
    }]
  }'
```

Change `"body"` to simulate different steps. Each curl call = one WhatsApp message.

---

### Scenario 1 — Happy path (full booking)

| Step | Send | Expected response |
|------|------|-------------------|
| 1 | `תור` | Service list with numbered options |
| 2 | `1` | Asks for date |
| 3 | `מחר` | Lists available time slots |
| 4 | `1` | Shows booking summary, asks *כן* / *לא* |
| 5 | `כן` | Confirms appointment, resets to idle |

Verify in Supabase → `appointments` table: one new row with correct `start_time` (UTC), `status = confirmed`, `source = whatsapp`.

---

### Scenario 2 — Cancel mid-flow

| Step | Send | Expected response |
|------|------|-------------------|
| 1 | `תור` | Service list |
| 2 | `1` | Asks for date |
| 3 | `ביטול` | Cancellation confirmed, returns to idle |

Verify: no appointment row created; `conversation_states.state = idle`.

---

### Scenario 3 — Invalid service number

| Step | Send | Expected response |
|------|------|-------------------|
| 1 | `תור` | Service list (e.g. 3 services) |
| 2 | `99` | Re-shows service list with correction prompt |
| 3 | `שלום` | Re-shows service list again (not a number) |
| 4 | `2` | Proceeds to date selection |

---

### Scenario 4 — Unrecognisable date

| Step | Send | Expected response |
|------|------|-------------------|
| 1 | `תור` | Service list |
| 2 | `1` | Asks for date |
| 3 | `ביום שלישי` | Error — Hebrew parsing not supported for day-names; asks for DD/MM |
| 4 | `15/8` | Lists slots for 15 August |

---

### Scenario 5 — No available slots

| Step | Send | Expected response |
|------|------|-------------------|
| 1 | `תור` | Service list |
| 2 | `1` | Asks for date |
| 3 | Send a date that is a Saturday (e.g. the next Saturday as `DD/MM`) | "אין שעות פנויות" — asks for another date |
| 4 | Send next Sunday | Lists slots |

---

### Scenario 6 — Restart during active flow

| Step | Send | Expected response |
|------|------|-------------------|
| 1 | `תור` | Service list |
| 2 | `1` | Asks for date |
| 3 | `קביעת תור` | Flow restarts — service list shown again |

---

### Scenario 7 — Decline at confirmation

| Step | Send | Expected response |
|------|------|-------------------|
| 1–4 | (happy path through to confirmation) | Booking summary |
| 5 | `לא` | Cancellation confirmed, idle |

Verify: no appointment row.

---

### Timezone verification

After a successful booking (Scenario 1), open `appointments` in Supabase and check `start_time`:

- Business timezone: `Asia/Jerusalem` (UTC+2 winter / UTC+3 summer)
- If you booked 10:00 slot → `start_time` should be `07:00 UTC` (winter) or `08:00 UTC` (summer, DST ends October)

---

### Dashboard smoke test

After running any booking scenario, visit these routes and confirm they load without errors:

| Route | Check |
|-------|-------|
| `http://localhost:3000/dashboard` | Stats increment after booking |
| `http://localhost:3000/dashboard/business-settings` | Form loads with saved data |
| `http://localhost:3000/dashboard/services` | Seeded services appear |
| `http://localhost:3000/dashboard/staff` | Seeded staff member appears |
| `http://localhost:3000/dashboard/ai-assistant` | Both sections load |
| `http://localhost:3000/dashboard/knowledge-base` | Redirects to ai-assistant |
| `http://localhost:3000/dashboard/ai-settings` | Redirects to ai-assistant |

---

## שלב חובה: הרצת מיגרציות ב-Supabase

לפני שמתחילים לבדוק תהליך הזמנת תורים, יש להריץ את קובץ המיגרציות הבא במסד הנתונים.

### מה המיגרציה עושה

הקובץ `supabase/migrations/phase_4_whatsapp_and_booking_hardening.sql` מוסיף:

1. **unique constraint** בטבלת `conversation_states` — למנוע שורות כפולות לאותו לקוח
2. **שני אינדקסים** בטבלת `appointments` — מניעת קביעת שתי פגישות לאותה שעה
3. **עמודת `send_status`** בטבלת `messages` — עוקבת אחר הצלחת שליחת WhatsApp
4. **עמודת `wa_timestamp`** בטבלת `messages` — שומרת את חותמת הזמן מ-Meta
5. **עמודת `external_message_id`** בטבלת `messages` — מזהה הודעה חיצוני (wamid)

כל הפקודות **idempotent** — בטוח להריץ פעמים רבות.

### איך מריצים

1. פתחו את [supabase.com](https://supabase.com) ובחרו את הפרויקט שלכם
2. לחצו על **SQL Editor** בסרגל הצד השמאלי
3. לחצו על **New query**
4. פתחו את הקובץ `supabase/migrations/phase_4_whatsapp_and_booking_hardening.sql` והעתיקו את כל תוכנו
5. הדביקו בחלון ה-SQL Editor
6. לחצו **Run**
7. בדקו שהפלט מציג: `Success. No rows returned`

### וידוא שהמיגרציה פעלה

לאחר ריצה מוצלחת, הריצו שאילתת בדיקה:

```sql
SELECT column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'messages'
   AND column_name  IN ('send_status', 'wa_timestamp', 'external_message_id');
```

צפוי לראות 3 שורות. אם חסרות שורות — המיגרציה לא פעלה; חיזרו על השלבים.

### בדיקה דרך Health Endpoint

ניתן גם לבדוק ישירות דרך הנקודת הקצה:

```bash
curl http://localhost:3000/api/health/db
```

תגובה תקינה (לאחר ריצת המיגרציה):

```json
{
  "ok": true,
  "checks": {
    "messages_send_status": true,
    "messages_wa_timestamp": true,
    "messages_external_message_id": true,
    "conversation_states_unique": true
  }
}
```

אם `ok: false` — בדקו אילו שדות מחזירים `false` והריצו את המיגרציה.

### תסמין שגיאה אם המיגרציה חסרה

אם תשלחו הודעת WhatsApp לפני הרצת המיגרציה, תראו בלוגים:

```
[message-handler] failed to save inbound message: Could not find the 'wa_timestamp' column of 'messages' in the schema cache
— if the error mentions a missing column (send_status, wa_timestamp, external_message_id),
run: supabase/migrations/phase_4_whatsapp_and_booking_hardening.sql
```

הפתרון: הריצו את המיגרציה כמתואר למעלה.
