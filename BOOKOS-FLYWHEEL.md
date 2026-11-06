# Service OS — Book OS & Flywheel

The two operating engines on top of the connection layer (see
`INTEGRATIONS.md`): **Book OS** runs the Service Setters appointment book
and dispatch board; the **Flywheel** turns completed jobs into reviews
and referrals that bring the next booking in.

All routes are under `/api/v1`, follow the starter's middleware chain
(`authenticate → requireCompany → requireRole`), and run on the in-memory
Phase 1 store. Book OS and flywheel staff routes require `DISPATCHER` or
`PLATFORM_ADMIN` — the Service Setters roles. Local demo auth applies,
exactly like the rest of the skeleton.

---

## A. Book OS — appointment setting & dispatch operations

### Daily rhythm

New bookings (any surface, via the universal intake) land in the
**setter queue** as `PENDING_DISPATCH`. A setter works the queue oldest
first, confirms the visit with the customer, and **sets the appointment**
(date + window). Dispatch still runs through the existing hybrid flow —
`POST /dispatch/match` (system proposes) → `POST /dispatch/approve`
(Service Setters approve). The **dispatch board** shows today's pipeline
grouped by status. The day before a visit, the **reminder run** queues an
`APPOINTMENT_REMINDER` for every booking appointed that day.

Every setter action appends to the platform event feed
(`GET /api/v1/platform/events`) with actor role `DISPATCHER` and
`details.team: "Service Setters"`, and to the booking's own history.

### Capacity model (starter logic)

- Five fixed two-hour windows per day: `08-10`, `10-12`, `12-14`,
  `14-16`, `16-18`.
- Each window holds **2 crew slots per service area**
  (`CREWS_PER_AREA_WINDOW` in `src/services/bookos.js`).
- Booked counts are **derived from live bookings** with an appointment
  SET on that date/window in that area (completed jobs no longer consume
  a slot). There is no separate capacity table to drift. Real crew
  rosters replace the constant later; the response shape stays.

### `GET /api/v1/bookos/slots?date=YYYY-MM-DD`

The day's windows with per-area capacity, booked, and remaining counts
for all 12 service areas.

```bash
curl "http://localhost:4000/api/v1/bookos/slots?date=2026-11-07"
```

### `GET /api/v1/bookos/setter-queue`

Bookings in `PENDING_DISPATCH` — new requests awaiting a setter's
confirmation — sorted oldest first, each with `ageMinutes` (how long it
has been waiting) and its intake `source`.

```bash
curl http://localhost:4000/api/v1/bookos/setter-queue
```

### `POST /api/v1/bookos/appointments`

Set/confirm an appointment on a booking. Fails with `409` if the booking
already has an appointment (use reschedule) or the window is full for
that area. Queues a `BOOKING_CONFIRMATION` notification that now carries
the appointment date and window.

```bash
curl -X POST http://localhost:4000/api/v1/bookos/appointments \
  -H 'Content-Type: application/json' \
  -d '{ "bookingId": "<BOOKING_ID>", "date": "2026-11-07", "window": "10-12" }'
```

### `POST /api/v1/bookos/appointments/:bookingId/reschedule`

Move a set appointment to a new date/window. The previous slot is
recorded in the appointment history, an `APPOINTMENT_RESCHEDULED` event
is appended, and a fresh `BOOKING_CONFIRMATION` with the new time is
queued.

```bash
curl -X POST http://localhost:4000/api/v1/bookos/appointments/<BOOKING_ID>/reschedule \
  -H 'Content-Type: application/json' \
  -d '{ "date": "2026-11-07", "window": "14-16", "reason": "Customer asked for afternoon" }'
```

### `POST /api/v1/bookos/reminders/run`

Day-before reminder simulation: queues an `APPOINTMENT_REMINDER` (sms +
email when on file) for every booking with an appointment SET on the
given date that is not completed yet, and appends an
`APPOINTMENT_REMINDERS_RUN` event.

```bash
curl -X POST http://localhost:4000/api/v1/bookos/reminders/run \
  -H 'Content-Type: application/json' \
  -d '{ "date": "2026-11-07" }'
```

### `GET /api/v1/bookos/dispatch-board`

Today's pipeline grouped by status — `PENDING_DISPATCH`,
`MATCH_PENDING_APPROVAL`, `CONFIRMED`, `COMPLETED` — with counts and a
summary per booking (reference code, source, city, appliance,
appointment, assigned provider). Starter rule: a booking is on today's
board if it was created today or its appointment is today.

```bash
curl http://localhost:4000/api/v1/bookos/dispatch-board
```

---

## B. Flywheel — the advertising growth loop

The loop, as mechanics:

| Stage | Mechanism | Where |
| --- | --- | --- |
| **Attract** | Every surface feeds the universal intake; `INTAKE_RECEIVED` events record the source of each request | `POST /intake/webhook` |
| **Book** | Requests become bookings under the $99 rules; setters confirm appointments in Book OS | `POST /bookings`, Book OS |
| **Serve** | Hybrid dispatch (system matches, Service Setters approve) and job completion | `/dispatch/*`, `POST /bookings/:id/complete` |
| **Review** | Completion queues a `REVIEW_REQUEST` automatically — every job, every time | notifications outbox |
| **Refer** | Completion also issues the customer a personal `TS-REF-XXXX` code; redeeming it creates the next booking with `source: "REFERRAL"` | below |

Metrics are **computed from the live store only** — no estimates, no
projections, no invented numbers.

### Referral issuance (automatic)

`POST /api/v1/bookings/:id/complete` now also issues the customer's
referral code and queues a `REFERRAL_CODE` notification with it. One
ACTIVE code per customer: completing a second job re-sends the same
code. The completion response includes
`referral: { code, created, customerName }`.

### `GET /api/v1/flywheel/referrals`

Issued codes with status, the booking reference each was issued from,
and full redemption history (staff).

```bash
curl http://localhost:4000/api/v1/flywheel/referrals
```

### `POST /api/v1/flywheel/referrals/redeem`

A neighbor books with someone's code. Creates a normal booking — same
ZIP/city validation (`404` unknown code, `422` out-of-area ZIP), same
$99 diagnostic collected at booking and credited toward repair — with
`source: "REFERRAL"`, the `referralCode`, and the referring customer
linked. The redemption is recorded on the code, `REFERRAL_REDEEMED` and
`BOOKING_CREATED` events are appended, a `BOOKING_CONFIRMATION` is
queued, and the new booking lands in the Book OS setter queue like any
other. A code can be redeemed more than once (a customer can refer
several neighbors); every redemption is counted.

```bash
curl -X POST http://localhost:4000/api/v1/flywheel/referrals/redeem \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "TS-REF-HRQW",
    "name": "Neighbor Test",
    "phone": "954-555-0177",
    "appliance": "Dryer",
    "zip": "33322",
    "issue": "Dryer not heating"
  }'
```

### `GET /api/v1/flywheel/reviews`

The review stage: how many `REVIEW_REQUEST` notifications have been
queued and the list itself (staff). Phase 1 tracks requests queued;
sent/delivered/review-received tracking arrives when Resend/Twilio and
the Google review link are wired in.

```bash
curl http://localhost:4000/api/v1/flywheel/reviews
```

### `GET /api/v1/flywheel/metrics`

The loop measured, from live state only (staff):

```bash
curl http://localhost:4000/api/v1/flywheel/metrics
```

```json
{
  "attract": { "totalIntakeEvents": 1, "bySource": { "GOOGLE_FORM": 1, "REFERRAL": 1, "...": 0 } },
  "book":    { "totalBookings": 3 },
  "serve":   { "completed": 1 },
  "review":  { "requestsQueued": 1 },
  "refer":   { "codesIssued": 1, "redemptions": 1 }
}
```

`attract.bySource` covers the eight intake sources; `REFERRAL` appears
once referral bookings exist (referrals enter through redemption, not
the intake webhook).

---

## Route summary (new in Book OS & Flywheel)

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/bookos/slots?date=` | Day's windows with per-area capacity/booked/remaining |
| `GET` | `/api/v1/bookos/setter-queue` | `PENDING_DISPATCH` bookings, oldest first, with age + source |
| `POST` | `/api/v1/bookos/appointments` | Set/confirm an appointment (date + window) on a booking |
| `POST` | `/api/v1/bookos/appointments/:bookingId/reschedule` | Move a set appointment; frees the old slot |
| `POST` | `/api/v1/bookos/reminders/run` | Queue day-before `APPOINTMENT_REMINDER`s for a date |
| `GET` | `/api/v1/bookos/dispatch-board` | Today's pipeline grouped by status, with counts |
| `GET` | `/api/v1/flywheel/referrals` | Issued referral codes + redemption history |
| `POST` | `/api/v1/flywheel/referrals/redeem` | Create a `REFERRAL`-source booking from a code |
| `GET` | `/api/v1/flywheel/reviews` | Review requests queued + list |
| `GET` | `/api/v1/flywheel/metrics` | Attract / book / serve / review / refer counts from live state |

New notification templates: `APPOINTMENT_REMINDER`, `REFERRAL_CODE`
(joining `BOOKING_CONFIRMATION`, `DISPATCH_MATCHED`, `DISPATCH_APPROVED`,
`TECH_EN_ROUTE`, `REVIEW_REQUEST` in the simulated outbox).

New event types: `APPOINTMENT_SET`, `APPOINTMENT_RESCHEDULED`,
`APPOINTMENT_REMINDERS_RUN`, `REFERRAL_CODE_ISSUED`, `REFERRAL_REDEEMED`.

Verification: `~/workspace/top-speed-service-os/BOOKOS-FLYWHEEL-VERIFY.log`
(full intake → queue → appointment → dispatch → reminder → completion →
referral → redemption → metrics run, plus the pre-existing
booking → match → approve regression flow).
