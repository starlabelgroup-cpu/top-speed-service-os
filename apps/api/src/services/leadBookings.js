import { PLATFORM_CONSTANTS } from '../config/platform.js';
import { addBookingEvent, appendEvent, createId, createReferenceCode, PLATFORM_COMPANY_ID, store } from '../data/store.js';
import { persistBooking, persistCustomer } from '../db/bookingsRepo.js';

/**
 * Lead bookings — the bridge from public web intake to the Service
 * Setters queue.
 *
 * Forms across the apps and portals (the commercial account request,
 * the /service page quick + commercial forms, property-manager
 * requests) post to the universal intake and become CONNECTION
 * records. A connection alone never enters Book OS — the setter queue
 * reads BOOKINGS — so every customer lead type ALSO creates a linked
 * booking in the same store: PENDING_DISPATCH like every other
 * booking, with its source and segment recorded.
 *
 * - COMMERCIAL_ACCOUNT_REQUEST / COMMERCIAL_WORK_ORDER -> source
 *   COMMERCIAL, segment COMMERCIAL (the queue's COMMERCIAL tag).
 * - SERVICE_REQUEST / PM_SERVICE_REQUEST / PM_WALKTHROUGH_REQUEST ->
 *   source WEB_FORM, segment RESIDENTIAL.
 *
 * Non-lead intake (provider applications, advertiser contacts,
 * diagnostic evidence, business/network inquiries) is NOT turned into
 * a booking — those are worked from the CRM / intake lists, not the
 * dispatch queue.
 *
 * A lead is not a confirmed job. The booking carries only what the
 * form actually submitted (name, phone, email, and the message
 * verbatim as the issue). These forms usually collect no city/ZIP, so
 * the booking is recorded with empty city/zip and areaStatus
 * AREA_REVIEW: it appears in the setter queue flagged for area review,
 * and a Service Setter resolves the area on the call (existing
 * POST /bookos/bookings/:id/resolve-area) before any appointment or
 * dispatch step. No field is invented, and no dispatch is automated —
 * setters still make every assignment decision.
 */
const LEAD_TYPES = {
  COMMERCIAL_ACCOUNT_REQUEST: { segment: 'COMMERCIAL', source: 'COMMERCIAL', label: 'Commercial account request' },
  COMMERCIAL_WORK_ORDER: { segment: 'COMMERCIAL', source: 'COMMERCIAL', label: 'Commercial work order request' },
  SERVICE_REQUEST: { segment: 'RESIDENTIAL', source: 'WEB_FORM', label: 'Service request' },
  PM_SERVICE_REQUEST: { segment: 'RESIDENTIAL', source: 'WEB_FORM', label: 'Property-manager service request' },
  PM_WALKTHROUGH_REQUEST: { segment: 'RESIDENTIAL', source: 'WEB_FORM', label: 'Portal walkthrough request' },
  // Pepper Lists Speedy Brain (2026-11-16): a signed-in customer's
  // scan & send submission (photos/videos of an appliance issue) and
  // their live-video request both land in the same setter queue as
  // residential leads — the media rides on the connection record's
  // SubmissionMedia rows, the facts ride in the message verbatim.
  PEPPER_LISTS_SCAN: { segment: 'RESIDENTIAL', source: 'WEB_FORM', label: 'Pepper Lists scan submission' },
  PEPPER_LISTS_LIVE_VIDEO: { segment: 'RESIDENTIAL', source: 'WEB_FORM', label: 'Live video request' },
};

export function leadTypeOf(type) {
  return LEAD_TYPES[type] || null;
}

/**
 * Some lead forms pack their fields into the message text with labels
 * the platform's own pages generate ("Appliance: Refrigerator",
 * "Equipment: Walk-in cooler"). Reading that label back is exact, not
 * a guess; anything else falls back to the lead-type label.
 */
function applianceFromMessage(message, fallback) {
  if (typeof message === 'string') {
    for (const line of message.split('\n')) {
      const match = /^(Appliance|Equipment):\s*(.+)$/.exec(line.trim());
      if (match && match[2].trim()) return match[2].trim().slice(0, 80);
    }
  }
  return fallback;
}

export async function createLeadBooking(record) {
  const lead = leadTypeOf(record?.type);
  if (!lead) return null;

  const customerRecord = {
    id: createId(),
    companyId: PLATFORM_COMPANY_ID,
    name: record.name,
    phone: record.phone,
    email: record.email || undefined,
    city: '',
    zip: '',
    source: record.source || null,
    createdAt: new Date().toISOString(),
  };
  store.customers.set(customerRecord.id, customerRecord);

  const booking = {
    id: createId(),
    companyId: PLATFORM_COMPANY_ID,
    customerId: customerRecord.id,
    customer: customerRecord,
    referenceCode: createReferenceCode(),
    source: lead.source,
    segment: lead.segment,
    lead: {
      connectionId: record.id,
      connectionReference: record.reference,
      connectionType: record.type,
      connectionSource: record.source || null,
    },
    city: '',
    zip: '',
    area: null,
    areaStatus: 'AREA_REVIEW',
    serviceAddress: null,
    appliance: applianceFromMessage(record.message, lead.label),
    issue: record.message || lead.label,
    preferredWindow: null,
    diagnosticFee: PLATFORM_CONSTANTS.diagnosticFee,
    diagnosticFeeCurrency: PLATFORM_CONSTANTS.diagnosticFeeCurrency,
    diagnosticFeeCreditedTowardRepair: true,
    feeStatus: PLATFORM_CONSTANTS.feeStatus,
    status: 'PENDING_DISPATCH',
    dispatch: {
      mode: PLATFORM_CONSTANTS.dispatchMode,
      stage: 'AWAITING_MATCH',
      candidateProviderIds: [],
      assignmentIds: [],
    },
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  addBookingEvent(booking, 'BOOKING_CREATED', 'lead-intake', {
    connectionReference: record.reference,
    connectionType: record.type,
    segment: lead.segment,
  });
  store.bookings.set(booking.id, booking);
  await persistCustomer(customerRecord);
  await persistBooking(booking);
  appendEvent('BOOKING_CREATED', {
    source: booking.source,
    actor: 'lead-intake',
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: {
      lead: true,
      connectionReference: record.reference,
      connectionType: record.type,
      segment: lead.segment,
      status: booking.status,
    },
  });
  return booking;
}
