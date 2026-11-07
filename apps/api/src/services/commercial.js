import { PLATFORM_CONSTANTS } from '../config/platform.js';
import { addBookingEvent, appendEvent, createId, createReferenceCode, store } from '../data/store.js';

/**
 * Commercial — accounts, facilities, equipment, work orders.
 *
 * A commercial work order is the business-side record (its own TS-W
 * reference, SLA tier, priority flag, billing roll-up). The moment it
 * opens, it ALSO creates a linked booking in the standard pipeline
 * (source COMMERCIAL) so the job is set, matched, approved, and tracked
 * by Service Setters in the same Book OS queue and dispatch board as
 * every residential job — one pipeline, no side channel. The ids are
 * linked both ways (workOrder.bookingId <-> booking.commercial).
 */

export const ACCOUNT_TYPES = [
  'RESTAURANT',
  'HOTEL',
  'LAUNDROMAT',
  'HEALTHCARE',
  'OFFICE',
  'RETAIL',
  'PROPERTY_FACILITY',
  'OTHER',
];

export const SLA_TIERS = ['ESSENTIAL', 'PRIORITY', 'TOTAL_CARE'];

/** Tiers whose work orders jump the queue by agreement. */
export const PRIORITY_SLA_TIERS = ['PRIORITY', 'TOTAL_CARE'];

export const EQUIPMENT_STATUSES = ['OPERATIONAL', 'WARNING', 'CRITICAL', 'OFFLINE'];

/**
 * Priority is derived, never typed in: critical equipment is always
 * priority, and PRIORITY / TOTAL_CARE accounts are priority by
 * agreement. Reasons are returned so the flag is explainable in the
 * queue and on the work order.
 */
export function deriveWorkOrderPriority(account, equipment) {
  const reasons = [];
  if (equipment?.status === 'CRITICAL') {
    reasons.push(`equipment ${equipment.assetTag} is CRITICAL`);
  }
  if (PRIORITY_SLA_TIERS.includes(account.slaTier)) {
    reasons.push(`${account.slaTier} SLA tier`);
  }
  return { priority: reasons.length > 0, reasons };
}

/**
 * Create the standard-pipeline booking linked to a commercial work
 * order. Mirrors the booking shape the universal intake and referral
 * redeem create (same fee fields as stored platform-wide — the billing
 * summary reports them verbatim rather than re-pricing commercial work).
 */
export function createCommercialBooking({ companyId, account, facility, equipment, workOrder }) {
  const customerRecord = {
    id: createId(),
    companyId,
    name: account.contactName,
    phone: account.phone,
    email: account.email || undefined,
    address: facility.address,
    city: facility.city,
    zip: facility.zip,
    source: 'COMMERCIAL',
    commercialAccountId: account.id,
    createdAt: new Date().toISOString(),
  };
  store.customers.set(customerRecord.id, customerRecord);

  const booking = {
    id: createId(),
    companyId,
    customerId: customerRecord.id,
    customer: customerRecord,
    referenceCode: createReferenceCode(),
    source: 'COMMERCIAL',
    city: facility.city,
    zip: facility.zip,
    appliance: equipment?.type || 'Commercial Equipment',
    issue: workOrder.issue,
    preferredWindow: null,
    priority: workOrder.priority,
    priorityReasons: workOrder.priorityReasons,
    commercial: {
      accountId: account.id,
      accountReference: account.referenceCode,
      facilityId: facility.id,
      equipmentId: equipment?.id || null,
      assetTag: equipment?.assetTag || null,
      workOrderId: workOrder.id,
      workOrderReference: workOrder.referenceCode,
      slaTier: account.slaTier,
    },
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
  addBookingEvent(booking, 'BOOKING_CREATED', 'commercial:work-order', {
    workOrderReference: workOrder.referenceCode,
    accountReference: account.referenceCode,
    priority: workOrder.priority,
    diagnosticFee: booking.diagnosticFee,
    feeStatus: booking.feeStatus,
  });
  store.bookings.set(booking.id, booking);
  appendEvent('BOOKING_CREATED', {
    source: 'COMMERCIAL',
    actor: 'commercial:work-order',
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: {
      appliance: booking.appliance,
      city: booking.city,
      status: booking.status,
      workOrderReference: workOrder.referenceCode,
      accountReference: account.referenceCode,
      priority: booking.priority,
    },
  });
  return booking;
}

/** A work order is open until its linked booking completes. */
export function workOrderEffectiveStatus(workOrder) {
  const booking = workOrder.bookingId ? store.bookings.get(workOrder.bookingId) : null;
  return booking?.status || workOrder.status;
}

export function isWorkOrderOpen(workOrder) {
  return workOrderEffectiveStatus(workOrder) !== 'COMPLETED';
}
