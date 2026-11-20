import { z } from 'zod';
import { addBookingEvent, appendEvent, createId, createReferenceCode, PLATFORM_COMPANY_ID, store } from '../data/store.js';
import { persistAssignment, persistBooking, persistCustomer } from '../db/bookingsRepo.js';
import { persistProperty } from '../db/techPackageRepo.js';
import { resolveArea } from '../config/serviceAreas.js';
import { notifyNewBooking } from './notifications.js';

/**
 * Work-order origination — the ONE create path every surface uses
 * (2026-11-19 create flows). Tonight's Tech package shipped the
 * read/edit/record side of a job; this adds where jobs are BORN:
 *
 *   - Tech App (provider): POST /provider/work-orders — a tech in the
 *     field creates the job, assigned to themselves or released
 *     unassigned into the Service Setters queue.
 *   - Book OS (Service Setters): POST /bookos/work-orders — phone and
 *     walk-in jobs, source OFFICE, optionally assigned straight to a
 *     provider (an APPROVED offer, the setters' standing action).
 *   - CRM: POST /crm/customers/:id/work-orders — from a customer
 *     record, customer prefilled by the record itself.
 *
 * Every path writes the SAME records the web form writes — a CRM
 * customer + a ServiceRequest booking on the platform company (so the
 * setter queue, the dispatch board and the CRM all see it) — with the
 * create attributed honestly: booking.source says which surface made
 * it, and the BOOKING_CREATED platform event carries source + via.
 * The customer is matched by phone before a new record is created, so
 * repeat customers never fork into duplicates. No customer
 * confirmation is sent for an office/field-created job (the customer
 * is standing in front of you or on the phone) — the office alert
 * (notifyNewBooking) fires exactly as for a web booking.
 */

export const workOrderCreateSchema = z.object({
  customerId: z.string().trim().max(80).optional(),
  customer: z.object({
    name: z.string().trim().min(2).max(120),
    phone: z.string().trim().min(7).max(30),
    email: z.string().trim().email().max(160).optional(),
    address: z.string().trim().max(300).optional(),
  }).optional(),
  city: z.string().trim().max(80).optional(),
  zip: z.string().trim().max(16).optional(),
  address: z.string().trim().max(300).optional(),
  segment: z.enum(['RESIDENTIAL', 'COMMERCIAL']).optional(),
  appliance: z.string().trim().min(2).max(80),
  issue: z.string().trim().min(3).max(1000),
  preferredWindow: z.string().trim().max(60).nullable().optional(),
  // Provider create only: 'SELF' (default) works the job themselves;
  // 'QUEUE' releases it unassigned into the setter queue.
  assign: z.enum(['SELF', 'QUEUE']).optional(),
  // Book OS create only: assign straight to this provider as an
  // APPROVED offer (the provider still accepts in the Tech App).
  providerId: z.string().trim().max(80).optional(),
});

function digitsOf(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

/** Customer lookup for the create forms: by name or phone fragment.
 * Scoped by the caller — the office sees the platform book; a provider
 * sees only customers attached to jobs their business has worked
 * (enforced by the route, which passes the visible id set). */
export function findCustomersForCreate(query, visibleCustomerIds = null) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const qDigits = digitsOf(q);
  const out = [];
  for (const customer of store.customers.values()) {
    if (visibleCustomerIds && !visibleCustomerIds.has(customer.id)) continue;
    const nameHit = (customer.name || '').toLowerCase().includes(q);
    const phoneHit = qDigits.length >= 4 && digitsOf(customer.phone).includes(qDigits);
    if (!nameHit && !phoneHit) continue;
    out.push({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      email: customer.email || null,
      city: customer.city || null,
      zip: customer.zip || null,
      address: customer.address || null,
    });
    if (out.length >= 12) break;
  }
  return out;
}

function resolveCustomer(input, { actor, source }) {
  if (input.customerId) {
    const existing = store.customers.get(input.customerId);
    if (existing) return { customer: existing, created: false };
    return { error: 'That customer record no longer exists — search again or enter the customer fresh' };
  }
  if (!input.customer) {
    return { error: 'Pick an existing customer or enter the new customer\u2019s name and phone' };
  }
  const wanted = digitsOf(input.customer.phone);
  if (wanted) {
    for (const customer of store.customers.values()) {
      if (digitsOf(customer.phone) === wanted) return { customer, created: false };
    }
  }
  const t = new Date().toISOString();
  const customer = {
    id: createId(),
    companyId: PLATFORM_COMPANY_ID,
    name: input.customer.name,
    phone: input.customer.phone,
    email: input.customer.email || null,
    address: input.address || input.customer.address || null,
    city: input.city || null,
    zip: input.zip || null,
    source,
    createdBy: actor,
    createdAt: t,
  };
  store.customers.set(customer.id, customer);
  return { customer, created: true };
}

/**
 * Create the work order. opts: { actor, source, via, input,
 * assignProvider } — assignProvider is a resolved Provider record
 * when the job starts life assigned (provider SELF create, or a
 * Book OS direct assignment), with opts.assignmentStatus 'ACCEPTED'
 * (self) or 'APPROVED' (office offer). Without it the booking lands
 * PENDING_DISPATCH in the setter queue.
 */
export async function createWorkOrder({ actor, source, via, input, assignProvider = null, assignmentStatus = 'ACCEPTED' }) {
  const resolved = resolveCustomer(input, { actor, source });
  if (resolved.error) return { ok: false, status: 400, error: resolved.error };
  const { customer } = resolved;

  const segment = input.segment || 'RESIDENTIAL';
  const commercial = segment === 'COMMERCIAL';
  const hasAreaInput = Boolean(input.city || input.zip);
  const resolution = hasAreaInput ? resolveArea({ city: input.city, zip: input.zip }) : null;
  let city = resolution?.area || input.city || customer.city || null;
  const serviceAddress = input.address || customer.address || null;
  // ZIP resolution (2026-11-19 hygiene fix): the request body first,
  // then the customer record, then the customer's existing Property
  // record (the one at the service address when there is one).
  // ServiceRequest.zip is a required column — when NO source yields a
  // ZIP the create used to sail through and die as a 500 at
  // persistence. Fail BEFORE anything is persisted with a clean 400
  // the surfaces can show. Never invent a default ZIP.
  let zip = input.zip || customer.zip || null;
  if (!zip && Array.isArray(store.properties)) {
    const owned = store.properties.filter((p) => p.customerId === customer.id && p.zip);
    const atAddress = serviceAddress ? owned.find((p) => p.address === serviceAddress) : null;
    zip = (atAddress || owned[0])?.zip || null;
  }
  if (!zip) {
    // A just-created customer exists only in memory at this point
    // (persistCustomer runs below) — drop it so a rejected create
    // leaves no orphan record behind.
    if (resolved.created) store.customers.delete(customer.id);
    return { ok: false, status: 400, error: 'A ZIP code is required to create a work order', code: 'ZIP_REQUIRED' };
  }
  // CITY resolution (2026-11-19 hygiene fix, mirroring ZIP above):
  // the city computed above comes from the area resolution, then the
  // request body, then the customer record. When none of those yields
  // one, fall back to the customer's Property record (the one at the
  // service address when there is one), exactly as ZIP does.
  // ServiceRequest.city is a required column — when NO source yields
  // a city the create died as a 500 at persistence. Fail BEFORE
  // anything is persisted with a clean 400 the surfaces can show.
  // Never invent a default city. ZIP is checked first, so a request
  // missing both gets ZIP_REQUIRED.
  if (!city && Array.isArray(store.properties)) {
    const owned = store.properties.filter((p) => p.customerId === customer.id && p.city);
    const atAddress = serviceAddress ? owned.find((p) => p.address === serviceAddress) : null;
    city = (atAddress || owned[0])?.city || null;
  }
  if (!city) {
    if (resolved.created) store.customers.delete(customer.id);
    return { ok: false, status: 400, error: 'A city is required to create a work order', code: 'CITY_REQUIRED' };
  }
  if (resolved.created) await persistCustomer(customer);
  const area = resolution ? resolution.area : null;
  const areaStatus = resolution ? resolution.areaStatus : 'AREA_REVIEW';
  const t = new Date().toISOString();

  const booking = {
    id: createId(),
    companyId: PLATFORM_COMPANY_ID,
    customerId: customer.id,
    customer,
    referenceCode: createReferenceCode(),
    source,
    segment,
    city,
    zip,
    area,
    areaStatus,
    serviceAddress,
    appliance: input.appliance,
    issue: input.issue,
    preferredWindow: input.preferredWindow || null,
    // Launch Pack: the $99 diagnostic is residential-only and, on a
    // phone/walk-in/field job, has NOT been collected yet — it is due
    // at the visit and credited toward an approved repair. Commercial
    // jobs never carry it.
    diagnosticFee: commercial ? 0 : 99,
    diagnosticFeeCurrency: 'USD',
    diagnosticFeeCreditedTowardRepair: !commercial,
    feeStatus: 'not_collected',
    status: 'PENDING_DISPATCH',
    dispatch: {
      mode: 'HYBRID',
      stage: 'AWAITING_MATCH',
      candidateProviderIds: [],
      assignmentIds: [],
    },
    history: [],
    createdAt: t,
    updatedAt: t,
  };

  addBookingEvent(booking, 'BOOKING_CREATED', actor, {
    source,
    via,
    diagnosticFee: booking.diagnosticFee,
    feeStatus: booking.feeStatus,
  });
  if (resolution) {
    addBookingEvent(booking, 'AREA_RESOLVED', 'service-book', {
      area: resolution.area,
      areaStatus: resolution.areaStatus,
      areaSource: resolution.areaSource,
      zipAreas: resolution.zipAreas,
    });
  }

  let assignment = null;
  if (assignProvider) {
    assignment = {
      id: createId(),
      companyId: booking.companyId,
      bookingId: booking.id,
      providerId: assignProvider.id,
      providerCompanyId: assignProvider.companyId ?? null,
      status: assignmentStatus,
      dispatchMode: 'HYBRID',
      approvalRequired: true,
      matchScore: null,
      createdAt: t,
      approvedBy: actor,
      approvedAt: t,
      ...(assignmentStatus === 'ACCEPTED' ? { acceptedAt: t } : {}),
      updatedAt: t,
    };
    store.dispatchAssignments.set(assignment.id, assignment);
    booking.status = 'CONFIRMED';
    booking.dispatch = {
      ...booking.dispatch,
      stage: assignmentStatus === 'ACCEPTED' ? 'ASSIGNED_TO_PROVIDER' : 'APPROVED_BY_SERVICE_SETTERS',
      assignmentId: assignment.id,
      assignmentIds: [assignment.id],
      providerId: assignProvider.id,
      approvedBy: actor,
      approvedAt: t,
    };
    addBookingEvent(booking, assignmentStatus === 'ACCEPTED' ? 'ASSIGNMENT_ACCEPTED' : 'DISPATCH_APPROVED', actor, {
      assignmentId: assignment.id,
      providerId: assignProvider.id,
      via,
    });
  }

  store.bookings.set(booking.id, booking);
  await persistBooking(booking);
  if (assignment) await persistAssignment(assignment);

  // A service address becomes the customer's Property record — the
  // same record the Tech App workspace reads (never a second copy).
  let property = null;
  if (booking.serviceAddress) {
    property = (store.properties || []).find((p) => p.customerId === customer.id && p.address === booking.serviceAddress) || null;
    if (!property) {
      property = {
        id: createId(),
        companyId: booking.companyId,
        customerId: customer.id,
        label: null,
        address: booking.serviceAddress,
        city: city || '',
        zip: zip || '',
        unit: null,
        accessNotes: null,
        createdAt: t,
        updatedAt: t,
      };
      store.properties.push(property);
      await persistProperty(property).catch(() => {});
    }
  }

  await appendEvent('BOOKING_CREATED', {
    source,
    actor,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: {
      via,
      appliance: booking.appliance,
      city: booking.city,
      area: booking.area,
      areaStatus: booking.areaStatus,
      status: booking.status,
      ...(assignment ? { assignmentId: assignment.id, providerId: assignProvider.id, assignmentStatus } : {}),
    },
  });
  if (assignment) {
    await appendEvent(assignmentStatus === 'ACCEPTED' ? 'ASSIGNMENT_ACCEPTED' : 'DISPATCH_APPROVED', {
      source,
      actor,
      entityType: 'BOOKING',
      entityId: booking.id,
      referenceCode: booking.referenceCode,
      details: { providerId: assignProvider.id, businessName: assignProvider.businessName, via },
    });
  }
  notifyNewBooking(booking, source);

  return { ok: true, booking, assignment, property, customerCreated: resolved.created };
}
