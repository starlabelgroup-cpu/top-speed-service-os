# Top Speed Service OS

Phase 1 starter for the Top Speed Ecosystem: a two-domain, multi-tenant service platform owned by **Top Speed Appliance LLC**.

- **Customer domain:** `topspeedappliance.net` — customers, bookings, and property managers
- **Provider domain:** `topspeedapplianceservice.com` — provider network
- **Shared backend:** this Service OS API
- **Tenant boundary:** `companyId`
- **Canonical model:** Company-based records, UUID identifiers, and money stored as `Decimal(10, 2)` in the Prisma/PostgreSQL schema

> **Deployment status:** This starter is **not live at `topspeedappliance.net`**. The existing website remains in place until cutover. Vercel team-access re-approval is still needed before deployment/domain cutover can proceed.

## Monorepo layout

```text
apps/
  api/
    prisma/schema.prisma  Canonical PostgreSQL model (not connected in the skeleton)
    src/
      config/             Security defaults and the 12 service areas
      data/               In-memory starter store and seeded provider candidates
      middleware/         JWT/demo auth, company/role guards, and rate limits
      routes/             /api/v1 booking and dispatch routes
      services/           Hybrid dispatch matching and approval logic
      server.js           Express app entry point
  web/
    index.html            Current static landing page / web placeholder (preserved)
    assets/               Current Top Speed brand assets (preserved)
    package.json          React/Vite migration stub
```

## Locked product rules in the starter

- Diagnostic fee: **$99**
- Fee timing/status: **collected at booking**
- Fee treatment: **credited toward the repair**
- Dispatch: **HYBRID** — system auto-match first, then Service Setters approval
- Roles: `PLATFORM_ADMIN`, `COMPANY_OWNER`, `COMPANY_ADMIN`, `DISPATCHER`, `CUSTOMER`, `PROVIDER_OWNER`, `PROVIDER_TECH`, `TECHNICIAN`
- Service areas: Lauderhill, Plantation, Sunrise, Tamarac, Fort Lauderdale, Lauderdale Lakes, North Lauderdale, Davie, Coral Springs, Pompano Beach, Oakland Park, and Margate

## Run the API locally

Requirements: Node.js 20+.

```bash
cd apps/api
cp .env.example .env
# For the local skeleton, keep ALLOW_DEMO_AUTH=true. Disable it outside local development.
npm install
npm start
```

The API listens on port **4000** by default.

Health check:

```bash
curl http://localhost:4000/api/v1/health
```

Expected shape:

```json
{
  "status": "ok",
  "service": "Top Speed Service OS API",
  "version": "v1",
  "mode": "phase-1-in-memory-skeleton"
}
```

### Important skeleton limitation

The Express API runs **without a database** in Phase 1. Bookings, customers, and dispatch assignments are held in memory and disappear when the process restarts. `prisma/schema.prisma` contains the production PostgreSQL model; connecting Prisma, migrations, Redis/queues, Twilio, Resend, and Stripe are later implementation steps. Do not present this starter as end-to-end production booking.

## Booking-to-dispatch flow

### 1. Create a booking

```bash
curl -X POST http://localhost:4000/api/v1/bookings \
  -H 'Content-Type: application/json' \
  -d '{
    "customer": {
      "name": "Test Customer",
      "phone": "954-555-0100",
      "address": "100 Test Street"
    },
    "city": "Sunrise",
    "zip": "33322",
    "appliance": "Refrigerator",
    "issue": "Refrigerator is not cooling",
    "preferredWindow": "Today, 2–5 PM"
  }'
```

The API validates the city and ZIP against the starter's Broward service-area data, then creates a booking with:

- `diagnosticFee: 99`
- `feeStatus: "collected_at_booking"`
- `diagnosticFeeCreditedTowardRepair: true`
- `status: "PENDING_DISPATCH"`

### 2. Auto-match providers

```bash
curl -X POST http://localhost:4000/api/v1/dispatch/match \
  -H 'Content-Type: application/json' \
  -d '{"bookingId":"<BOOKING_ID>"}'
```

This scores seeded active providers by appliance specialty, service city, and rating. The booking becomes `MATCH_PENDING_APPROVAL`; matching alone does **not** confirm it.

### 3. Service Setters approval

```bash
curl -X POST http://localhost:4000/api/v1/dispatch/approve \
  -H 'Content-Type: application/json' \
  -d '{
    "bookingId":"<BOOKING_ID>",
    "providerId":"<MATCHED_PROVIDER_ID>",
    "approvedBy":"Service Setters"
  }'
```

Approval marks the selected assignment `APPROVED`, marks unselected proposals `NOT_SELECTED`, and changes the booking to `CONFIRMED`.

### 4. Trace the flow

Every booking carries a `history` array. The verified sequence is:

```text
BOOKING_CREATED → DISPATCH_MATCHED → DISPATCH_APPROVED
```

List bookings with:

```bash
curl http://localhost:4000/api/v1/bookings
```

## API surface

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Service health and skeleton mode |
| `GET` | `/api/v1/service-areas` | Twelve service cities and starter ZIP coverage |
| `POST` | `/api/v1/bookings` | Validate and create a booking with the $99 fee fields |
| `GET` | `/api/v1/bookings` | List bookings in the current company context |
| `GET` | `/api/v1/bookings/:id` | Read one booking and its history |
| `POST` | `/api/v1/dispatch/match` | Auto-match provider candidates |
| `POST` | `/api/v1/dispatch/approve` | Service Setters approval; confirms the booking |
| `POST` | `/api/v1/bookings/:id/complete` | Complete a job; queues the review request |
| `POST` | `/api/v1/intake/webhook` | Universal intake for every surface (booking / provider application / PM lead + reference code) |
| `GET` | `/api/v1/intake/provider-applications` | Staff list of provider applications |
| `GET` | `/api/v1/intake/pm-leads` | Staff list of property-manager leads |
| `GET` | `/api/v1/platform/surfaces` | Ecosystem map (both domains, landing pages, channels) + shared constants |
| `GET` | `/api/v1/platform/events` | Platform-wide operational event feed |
| `GET` | `/api/v1/notifications/outbox` | Simulated notification outbox (no real sends in Phase 1) |

## Connection layer

All surfaces — topspeedappliance.net, topspeedapplianceservice.com, the
customer / provider / property-manager landing pages, the interim Google
Form intake, and phone-entered records — feed **one** intake, **one**
notification pipeline, and **one** event feed in this API. See
[`apps/api/INTEGRATIONS.md`](apps/api/INTEGRATIONS.md) for payloads and
curl examples, and the operations document
("Top Speed Ecosystem — Connected Operations") for how the team runs the
connected platform day to day.

## Environment variables

See `.env.example` at the repository root or `apps/api/.env.example`. Placeholder values only — never commit real credentials.

Key variables:

- `PORT` — API port, default `4000`
- `DATABASE_URL` — PostgreSQL connection string for the future Prisma connection
- `REDIS_URL` — future queue/cache connection
- `JWT_SECRET` — server-only HS256 signing secret, at least 32 bytes in a real environment
- `JWT_EXPIRES_IN_SECONDS` — short token lifetime; starter default is 900 seconds
- `BCRYPT_COST` — password hashing cost; locked foundation value is `12`
- `CORS_ORIGIN` — allowed web origin
- `ALLOW_DEMO_AUTH` — local skeleton only; set `false` outside local development
- `TWILIO_*`, `RESEND_API_KEY`, `STRIPE_*` — optional provider integrations, server-side only

## Security foundation

- JWT uses **HS256** with a short expiry.
- Password hashing target is **bcrypt cost 12** when database-backed auth is implemented.
- Request bodies are validated with **Zod**.
- Protected routes use the middleware order: `authenticate → requireCompany → requireRole`.
- Rate limits are **10 requests per 15 minutes for auth routes** and **200 per 15 minutes generally**.
- Helmet and CORS are enabled.
- Secrets belong only in server environment/secret management, never in web code or committed files.
- `companyId` is enforced as the tenant boundary; a non-platform-admin cannot act for another company.

## Web placeholder

`apps/web/index.html` is the current static Ecosystem landing page and is preserved as the web placeholder. The React/Vite app is represented by a package stub and notes in `apps/web/README.md`; it has not replaced the existing site.

## Next steps after Phase 1

1. Re-approve Vercel team access.
2. Connect PostgreSQL and run Prisma migrations.
3. Replace demo auth with production user registration/login and bcrypt password storage.
4. Add Redis-backed queues and provider notifications.
5. Configure Twilio, Resend, and Stripe in server-side deployment secrets.
6. Build the React/Vite customer and provider experiences against `/api/v1`.
7. Test the full booking lifecycle again before any domain cutover.
