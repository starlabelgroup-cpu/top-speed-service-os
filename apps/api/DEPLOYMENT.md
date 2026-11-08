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
| `ALLOW_STAFF_REGISTRATION` | `true` **only for the bootstrap below**, then `false` | See step 3. |

## 3. First staff accounts (bootstrap, once)

With `ALLOW_STAFF_REGISTRATION=true` on the first deploy:

1. Create the staff accounts you need via `POST /api/v1/auth/register` with
   `"role": "DISPATCHER"` (Service Setters) — Pepper can run these calls with
   emails/passwords you provide through a safe channel, or you can use the
   sign-up screens once the front ends are wired (Stage 3).
2. Set `ALLOW_STAFF_REGISTRATION=false` and redeploy. From then on, staff
   accounts can only be created by a signed-in PLATFORM_ADMIN / COMPANY_OWNER.

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

## How it runs

Vercel serverless: `api/index.js` wraps the Express app. Each cold-started
instance hydrates its working store from the database before serving;
mutations write through to PostgreSQL inside the routes, so the database is
always the source of truth. Referral and notification queues are still
in-memory in this phase (health reports them honestly) — they move to the
database in a later phase.
