# Service OS — Integration Layer

How every Top Speed surface connects to the one shared backend. All routes
are under `/api/v1`, run on the in-memory Phase 1 store, and follow the
starter's existing pattern: Zod validation and the middleware chain
`authenticate → requireCompany → requireRole` where staff access applies.

> **Auth note (Phase 1):** locally, `ALLOW_DEMO_AUTH=true` injects the demo
> Service Setters context, exactly like the original booking routes. The
> intake webhook currently uses the same chain for consistency. **Before
> public exposure**, each surface (sites, landing pages, Google Form bridge)
> must get its own shared-secret or signed-webhook credential — the payload
> contract below does not change.

## 1. Universal intake — `POST /api/v1/intake/webhook`

One endpoint for every surface. The caller names where the record came from
in `source`:

`NET_SITE` · `COM_SITE` · `CUSTOMER_LANDING` · `PROVIDER_LANDING` ·
`PM_LANDING` · `GOOGLE_FORM` · `PHONE` · `OTHER`

The payload is normalized into one of three record types. Pass `type`
explicitly, or let the API infer it (`PROVIDER_LANDING` → application,
`PM_LANDING` → PM lead, provider/PM fields present → matching type,
otherwise booking). Every accepted record gets a **reference code**
(`TS-XXXXXX`) the customer or applicant can quote on a call.

### A booking from the customer site (.net)

```bash
curl -X POST http://localhost:4000/api/v1/intake/webhook \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "NET_SITE",
    "name": "Maria Lopez",
    "phone": "954-555-0142",
    "appliance": "Refrigerator",
    "zip": "33322",
    "issue": "Fridge is warm, freezer still cold",
    "preferredWindow": "Today, 2–5 PM"
  }'
```

Returns `201` with `recordType: "BOOKING"`, the `referenceCode`, and the
booking — created with the locked rules: `diagnosticFee: 99`,
`feeStatus: "collected_at_booking"`, credited toward repair,
`status: "PENDING_DISPATCH"`. City is derived from the ZIP when omitted;
out-of-area ZIPs get the same `422` as the original booking route.
A `BOOKING_CONFIRMATION` notification is queued automatically (see §3).

### A provider application from the provider landing page

```bash
curl -X POST http://localhost:4000/api/v1/intake/webhook \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "PROVIDER_LANDING",
    "name": "James Carter",
    "phone": "954-555-0119",
    "businessName": "Carter Appliance Repair",
    "serviceAreas": ["Sunrise", "Plantation"],
    "appliances": ["Refrigerator", "Washer", "Dryer"],
    "yearsInBusiness": 6
  }'
```

Returns `201` with `recordType: "PROVIDER_APPLICATION"`, a reference code,
and the application stored as `PENDING_REVIEW` for Service Setters.
`serviceAreas`/`appliances` also accept comma-separated strings (handy for
form bridges); `business` is accepted as an alias of `businessName`.

### A property-manager lead from the PM landing page

```bash
curl -X POST http://localhost:4000/api/v1/intake/webhook \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "PM_LANDING",
    "name": "Dana Whitfield",
    "phone": "954-555-0173",
    "email": "dana@example.com",
    "company": "Whitfield Property Group",
    "units": 48,
    "message": "We need one portal for all unit appliance repairs."
  }'
```

Returns `201` with `recordType: "PM_LEAD"`, a reference code, and the lead
stored as `NEW`.

### Staff lists

```bash
curl http://localhost:4000/api/v1/intake/provider-applications   # DISPATCHER / PLATFORM_ADMIN
curl http://localhost:4000/api/v1/intake/pm-leads                # DISPATCHER / PLATFORM_ADMIN
```

## 2. Cross-surface config — `GET /api/v1/platform/surfaces`

The ecosystem map as data: both domains, the three landing pages, the
interim Google Form intake, and the phone channel — each with its role,
audience, and the record types it produces — plus the **shared constants**
every surface should render from this one source so the facts never drift:
business phone `954-931-7997`, the $99 diagnostic fee and its terms, hybrid
dispatch by Service Setters, and the 12 service areas with ZIPs.

```bash
curl http://localhost:4000/api/v1/platform/surfaces
```

## 3. Notification pipeline (simulated) — `GET /api/v1/notifications/outbox`

Phase 1 sends nothing for real — there are no Twilio/Resend keys in the
skeleton. Instead, every message the platform *would* send is appended to
an in-memory outbox with `channel` (`sms` / `email` / `internal`),
`template`, recipient, and payload, marked `QUEUED_SIMULATED`. When the
providers are configured, a sender drains the same outbox; the triggers
and templates do not change.

| Trigger event | Template | Channel | Recipient |
| --- | --- | --- | --- |
| Booking created (any surface, incl. direct API) | `BOOKING_CONFIRMATION` | sms (+ email if on file) | Customer |
| Dispatch auto-match finished | `DISPATCH_MATCHED` | internal | Service Setters (approval queue notice) |
| Service Setters approve | `DISPATCH_APPROVED` | internal | Service Setters |
| Technician heads to the job (future step) | `TECH_EN_ROUTE` | sms (+ email if on file) | Customer |
| Job completed | `REVIEW_REQUEST` | sms (+ email if on file) | Customer |

```bash
curl http://localhost:4000/api/v1/notifications/outbox
curl "http://localhost:4000/api/v1/notifications/outbox?template=REVIEW_REQUEST"
```

## 4. Job completion — `POST /api/v1/bookings/:id/complete`

Marks a booking `COMPLETED` (staff roles: `DISPATCHER` / `PLATFORM_ADMIN`),
records `JOB_COMPLETED` in the booking history and the event feed, and
queues the `REVIEW_REQUEST` notification — the review engine's trigger.

```bash
curl -X POST http://localhost:4000/api/v1/bookings/<BOOKING_ID>/complete \
  -H 'Content-Type: application/json' \
  -d '{"completedBy":"Service Setters"}'
```

## 5. Event feed — `GET /api/v1/platform/events`

The single operational timeline connecting all surfaces. Every intake and
every booking lifecycle change appends an event: `INTAKE_RECEIVED`,
`BOOKING_CREATED`, `PROVIDER_APPLICATION_RECEIVED`, `PM_LEAD_RECEIVED`,
`DISPATCH_MATCHED`, `DISPATCH_APPROVED`, `JOB_COMPLETED`,
`NOTIFICATION_QUEUED`. Newest first; filter with `?source=NET_SITE`
(DISPATCHER / PLATFORM_ADMIN).

```bash
curl http://localhost:4000/api/v1/platform/events
```

## Route summary (new in the connection layer)

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/intake/webhook` | Universal intake for every surface → booking / provider application / PM lead + reference code |
| `GET` | `/api/v1/intake/provider-applications` | Staff list of provider applications |
| `GET` | `/api/v1/intake/pm-leads` | Staff list of property-manager leads |
| `GET` | `/api/v1/platform/surfaces` | Ecosystem map + shared constants |
| `GET` | `/api/v1/platform/events` | Platform-wide operational event feed |
| `GET` | `/api/v1/notifications/outbox` | Simulated notification outbox |
| `POST` | `/api/v1/bookings/:id/complete` | Complete a job; queues the review request |

## 6. Book OS & Flywheel

Two operating engines sit on top of this connection layer and are
documented in **`BOOKOS-FLYWHEEL.md`**:

- **Book OS** (`/api/v1/bookos/*`) — the Service Setters appointment
  book: slot capacity per area/window, the setter queue, setting and
  rescheduling appointments, the day-before reminder run, and the
  dispatch board.
- **Flywheel** (`/api/v1/flywheel/*`) — the growth loop: completion now
  also issues the customer a `TS-REF-XXXX` referral code (in addition to
  the review request), redemption creates a `REFERRAL`-source booking,
  and `GET /flywheel/metrics` reports attract / book / serve / review /
  refer counts computed from live state.
