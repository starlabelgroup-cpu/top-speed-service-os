# Service OS — Commercial Network & Platform

The commercial module: business accounts, their facilities, an
equipment registry per facility, and work orders that run through the
**same** Service Setters pipeline as residential bookings — one queue,
one dispatch board, one billing roll-up per account. See
`INTEGRATIONS.md` for the connection layer and `BOOKOS-FLYWHEEL.md` for
appointment setting, dispatch, and the growth loop.

All routes are under `/api/v1` and follow the starter's middleware
chain (`authenticate → requireCompany → requireRole`) on the in-memory
Phase 1 store. Account creation rides the universal-intake pattern
(`authenticate → requireCompany`); every other commercial route is
staff-only (`DISPATCHER` or `PLATFORM_ADMIN` — the Service Setters
roles). Local demo auth applies, exactly like the rest of the skeleton.

---

## The model

```
Account (TS-C-XXXX)          the business, with an SLA tier
  └─ Facility                a site we service (ZIP-validated)
       └─ Equipment (TS-EQ-XXXX)  a registered unit with a live status
  Work order (TS-W-XXXX)     a service request on an account/facility
       └─ Booking (source COMMERCIAL)  the same record Book OS and
                                 dispatch already know how to run
```

A work order is the business-side record — SLA tier, priority flag,
billing roll-up. The moment it opens, a **linked booking** is created
in the standard pipeline and the ids are linked both ways
(`workOrder.bookingId` ↔ `booking.commercial.workOrderId`), so the job
is set, matched, Service-Setter-approved, and tracked exactly like a
residential job. A work order counts as **open** until its linked
booking completes.

**Priority is derived, never typed in.** A work order is priority when
the equipment is `CRITICAL`, or the account's SLA tier is `PRIORITY`
or `TOTAL_CARE`. The reasons ride on the work order, the booking, and
the setter-queue entry, so the flag is always explainable.

**Fees in the summary are read, not priced.** The linked booking
carries the standard booking record (its stored diagnostic-fee fields,
like every booking on the platform). The billing summary reports those
stored values verbatim for the consolidated invoice — it never
re-prices commercial work. Commercial agreements themselves are quoted
per facility/agreement; see the operations playbook.

---

## Accounts

### `POST /api/v1/commercial/accounts`

```bash
curl -X POST http://localhost:4000/api/v1/commercial/accounts \
  -H 'content-type: application/json' \
  -d '{
    "companyName": "Sunrise Taqueria Group",
    "accountType": "RESTAURANT",
    "contactName": "Maria Delgado",
    "phone": "9545550142",
    "email": "ops@sunrisetaqueria.example.com",
    "slaTier": "TOTAL_CARE"
  }'
```

- `accountType`: `RESTAURANT`, `HOTEL`, `LAUNDROMAT`, `HEALTHCARE`,
  `OFFICE`, `RETAIL`, `PROPERTY_FACILITY`, `OTHER`
- `slaTier`: `ESSENTIAL` (default), `PRIORITY`, `TOTAL_CARE`
- Returns the account with a `TS-C-XXXX` reference code and
  `status: "ACTIVE"`. Appends `COMMERCIAL_ACCOUNT_CREATED`.

### `GET /api/v1/commercial/accounts` · `GET /api/v1/commercial/accounts/:id`

Staff-only list and detail (detail includes `facilityCount`).

---

## Facilities

### `POST /api/v1/commercial/accounts/:id/facilities`

```bash
curl -X POST http://localhost:4000/api/v1/commercial/accounts/<accountId>/facilities \
  -H 'content-type: application/json' \
  -d '{ "name": "Sunrise Taqueria — Sawgrass", "address": "1280 NW 136th Ave", "city": "Sunrise", "zip": "33323" }'
```

ZIP (and city, when given) are validated against the 12 service areas
exactly like bookings — an out-of-area ZIP returns **422**. `city` may
be omitted and is derived from the ZIP. Appends
`COMMERCIAL_FACILITY_ADDED`.

### `GET /api/v1/commercial/accounts/:id/facilities`

Lists the account's facilities, each with its `equipmentCount`.

---

## Equipment registry

### `POST /api/v1/commercial/facilities/:facilityId/equipment`

```bash
curl -X POST http://localhost:4000/api/v1/commercial/facilities/<facilityId>/equipment \
  -H 'content-type: application/json' \
  -d '{ "type": "Walk-In Cooler", "brand": "True", "model": "T-49-HC", "serial": "SN-8841207", "warrantyExpiry": "2027-03-31" }'
```

Returns the unit with an auto-generated asset tag (`TS-EQ-XXXX`) and
`status: "OPERATIONAL"`. Appends `COMMERCIAL_EQUIPMENT_REGISTERED`.

### `GET /api/v1/commercial/facilities/:facilityId/equipment`

Lists the facility's registered units.

### `PATCH /api/v1/commercial/equipment/:id/status`

```bash
curl -X PATCH http://localhost:4000/api/v1/commercial/equipment/<equipmentId>/status \
  -H 'content-type: application/json' \
  -d '{ "status": "CRITICAL", "changedBy": "Service Setters", "note": "Compressor short-cycling" }'
```

`status`: `OPERATIONAL`, `WARNING`, `CRITICAL`, `OFFLINE`. The change
is recorded in the unit's `statusHistory` and appends
`EQUIPMENT_STATUS_CHANGED` to the platform event feed. Marking a unit
`CRITICAL` makes any new work order on it priority automatically.

---

## Work orders

### `POST /api/v1/commercial/work-orders`

```bash
curl -X POST http://localhost:4000/api/v1/commercial/work-orders \
  -H 'content-type: application/json' \
  -d '{
    "accountId": "<accountId>",
    "facilityId": "<facilityId>",
    "equipmentId": "<equipmentId>",
    "issue": "Walk-in cooler not holding temperature"
  }'
```

- `equipmentId` is optional (a facility-level request with no single
  unit). Facility must belong to the account and equipment to the
  facility (422 otherwise).
- Creates the work order (`TS-W-XXXX`), derives `priority` +
  `priorityReasons`, creates the linked booking (`source: "COMMERCIAL"`,
  `PENDING_DISPATCH`, same fee record as every booking), queues the
  internal `COMMERCIAL_WORK_ORDER_RECEIVED` notification for Service
  Setters, and appends `COMMERCIAL_WORK_ORDER_CREATED`.
- The response returns the work order, a summary of the linked booking,
  and the queued notifications. From here the job is worked in Book OS:
  it is already in `GET /api/v1/bookos/setter-queue` (with its
  `priority` flag and `COMMERCIAL` source) and flows through
  `/bookos/appointments`, `/dispatch/match`, `/dispatch/approve`, and
  `/bookings/:id/complete` unchanged.

### `GET /api/v1/commercial/work-orders?accountId=&open=true`

Staff-only list; each work order carries `effectiveStatus` — the
status of its linked booking — so "open" always means "not yet
completed in the pipeline."

---

## Consolidated billing

### `GET /api/v1/commercial/accounts/:id/billing-summary`

Everything one monthly consolidated invoice is cut from:

```bash
curl http://localhost:4000/api/v1/commercial/accounts/<accountId>/billing-summary
```

Returns the account, work-order totals (`total`, `open`, `byStatus`
using pipeline status), booking totals by status, a
`diagnosticFees.total` summed **from the fees stored on the linked
bookings**, and `lineItems` — one row per work order with its work
order + booking references, facility, asset tag, priority, status, and
the stored fee fields. Nothing is re-priced in this view.

---

## Overview

### `GET /api/v1/commercial/overview`

```bash
curl http://localhost:4000/api/v1/commercial/overview
```

Counts for the commercial book at a glance: accounts total and by
type, facilities total, equipment total and by status, and work orders
(total, open, and how many of the open ones are in the priority queue).

---

## Events added to the platform feed

`COMMERCIAL_ACCOUNT_CREATED` · `COMMERCIAL_FACILITY_ADDED` ·
`COMMERCIAL_EQUIPMENT_REGISTERED` · `EQUIPMENT_STATUS_CHANGED` ·
`COMMERCIAL_WORK_ORDER_CREATED` — plus the linked booking's normal
`BOOKING_CREATED` (source `COMMERCIAL`). Read them all at
`GET /api/v1/platform/events`.

## Verification

`~/workspace/top-speed-service-os/COMMERCIAL-VERIFY.log` — end-to-end
run: account → facility → equipment → `CRITICAL` → priority work order
in the setter queue → billing summary → overview, plus regression
checks on the core booking flow and the flywheel (47 checks).
