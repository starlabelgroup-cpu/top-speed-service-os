# Top Speed Service OS API — Vercel deployment runbook

This deploys the real API (accounts + bookings on PostgreSQL/Supabase) as its
own Vercel project from this repo.

## 1. Import the project (Ramone — Pepper's Vercel access is team-blocked)

1. Vercel → **Add New → Project** → import **starlabelgroup-cpu/top-speed-service-os**
2. **Root Directory: `apps/api`** ← the one setting that matters
3. Leave framework/build settings alone — `apps/api/vercel.json` supplies the
   build command (`prisma generate && prisma migrate deploy && node prisma/seed.mjs`)
   and rewrites all paths to the serverless entry (`api/index.js`).
4. Add the environment variables below (Production), then **Deploy**.

## 2. Environment variables (Production)

| Name | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Supabase **direct** connection URI (Project Settings → Database → Connection string → URI; host `db.<ref>.supabase.co`, port **5432**) | Direct (not the :6543 pooler) because the build runs migrations. Swapping to the pooler later is a one-value change. |
| `JWT_SECRET` | A long random phrase you invent (32+ characters) | Signs login tokens. Never reuse it anywhere else. Changing it signs everyone out. |
| `ALLOW_DEMO_AUTH` | `false` | Demo auth must be off in production. |
| `CORS_ORIGIN` | `https://web-chi-olive-19dblh9azm.vercel.app` | Comma-separated list allowed — add the commercial platform origin when it deploys. |
| `ALLOW_STAFF_REGISTRATION` | No longer read by the code (bootstrap bypass removed 2026-11-09) | See step 3. |
| `OPENAI_API_KEY` | Key from platform.openai.com → API keys | Powers Speedy (chat + photo diagnosis). Also connected to Pepper via the secure connector for verification. `OPENAI_MODEL` is optional (defaults to gpt-4o-mini; gpt-4o is the stronger vision option). |

## 3. First staff accounts (bootstrap, once) — DONE 2026-11-09

The bootstrap is complete: the first COMPANY_OWNER account exists
(service@topspeedappliance.net) and the `ALLOW_STAFF_REGISTRATION` code
bypass has been **removed** from `src/routes/auth.js`. From now on, staff
accounts can only be created by a signed-in PLATFORM_ADMIN / COMPANY_OWNER
via `POST /api/v1/auth/register` with a staff `"role"` (e.g. `"DISPATCHER"`
for Service Setters) while authenticated as the admin. Never re-add an
unauthenticated staff-registration path.

Customers self-register freely at any time (CUSTOMER role only).

## 4. Verify the deploy

- `GET https://<api-project>.vercel.app/api/v1/health` →
  `"mode": "database"`, `"database": "connected"`,
  `"persistence": { "accounts": "database", "bookings": "database", ... }`
- Register a test customer, log in, create a booking, restart-proof by
  checking it appears in the Book OS setter queue.

Troubleshooting:

- Health `"database": "connection-failed"` → DATABASE_URL is wrong (project
  ref, password, or it points at a different project). The string is only
  ever in Vercel/Supabase settings — Pepper never sees it.
- Every route 404s → Root Directory is not `apps/api`.
- Build fails at `prisma migrate deploy` → DATABASE_URL missing at build
  time, or not the direct :5432 string.

## Notification providers (Resend email + Twilio SMS)

The notification outbox sends for real once these Production env vars exist:

| Name | Value | Notes |
| --- | --- | --- |
| `RESEND_API_KEY` | Key from resend.com → API Keys | Also connected to Pepper via the secure connector for verification. |
| `EMAIL_FROM` | `Top Speed Appliance <service@updates.topspeedapplianceservice.com>` | Verified in Resend on 2026-11-08 (sending + receiving enabled). `topspeedappliance.net` is added in Resend but its verification is **failed** until its SPF/DKIM DNS records are fixed — switch EMAIL_FROM to the .net address only after it shows verified. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | From the Twilio console | SMS sends from the Twilio number. US A2P 10DLC registration for the number may be required for reliable delivery. |
| `CRON_SECRET` | Any long random string (optional) | Enables the automatic drain below. |

Delivery triggers: staff call `POST /api/v1/notifications/send`, or schedule
Vercel Cron to `GET /api/v1/notifications/cron-drain` (Vercel sends
`CRON_SECRET` automatically when the env var exists; cron frequency depends
on the Vercel plan). Health reports each provider as configured or not.
Entries whose provider is unconfigured stay queued — never lost.

## How it runs

Vercel serverless: `api/index.js` wraps the Express app. Each cold-started
instance hydrates its working store from the database before serving;
mutations write through to PostgreSQL inside the routes, so the database is
always the source of truth. Referral and notification queues are still
in-memory in this phase (health reports them honestly) — they move to the
database in a later phase.
