import { store } from '../data/store.js';

/**
 * Track My Tech — the single source of truth for a booking's customer-
 * facing tracking state. The public track route, the signed-in
 * customer's "my jobs" view, and the staff tracking console all compute
 * from here so every surface tells the customer the same story.
 *
 * The 8 stages (Ramone's spec, 2026-11-10):
 *   0 Request received → 1 Appointment confirmed → 2 Technician assigned
 *   → 3 Technician en route → 4 Technician arrived → 5 Diagnosis in
 *   progress → 6 Estimate approved → 7 Repair completed
 * Stages 3–6 advance only from real technician job events recorded in
 * the Tech App (or a Service Setter acting in the console); the ETA is
 * the technician's own estimate, never generated.
 */
export const STAGE8_LABELS = [
  'Request received',
  'Appointment confirmed',
  'Technician assigned',
  'Technician en route',
  'Technician arrived',
  'Diagnosis in progress',
  'Estimate approved',
  'Repair completed',
];

const STAGE4_LABELS = [
  'Request received — a Service Setter is reviewing it',
  'Appointment confirmed',
  'Technician assigned',
  'Job completed',
];

export function providerById(providerId) {
  if (!providerId) return null;
  if (Array.isArray(store.providers)) {
    return store.providers.find((p) => p.id === providerId) || null;
  }
  return store.providers?.get?.(providerId) || null;
}

export function activeAssignmentFor(bookingId) {
  return (
    [...store.dispatchAssignments.values()].find(
      (a) => a.bookingId === bookingId && (a.status === 'APPROVED' || a.status === 'ACCEPTED'),
    ) || null
  );
}

export function computeTracking(booking) {
  const activeAssignment = activeAssignmentFor(booking.id);
  const hasTech = Boolean(activeAssignment);
  let stage = 0;
  if (booking.status === 'COMPLETED') stage = 3;
  else if (hasTech) stage = 2;
  else if (booking.status === 'CONFIRMED' || booking.status === 'MATCH_PENDING_APPROVAL') stage = 1;

  const history = Array.isArray(booking.history) ? booking.history : [];
  const hasEvent = (type) => history.some((e) => e.type === type);
  let stageIndex = 0;
  if (booking.status === 'CONFIRMED' || booking.status === 'MATCH_PENDING_APPROVAL') stageIndex = Math.max(stageIndex, 1);
  if (hasTech) stageIndex = Math.max(stageIndex, 2);
  if (hasEvent('TECH_EN_ROUTE')) stageIndex = Math.max(stageIndex, 3);
  if (hasEvent('TECH_ARRIVED')) stageIndex = Math.max(stageIndex, 4);
  if (hasEvent('DIAGNOSIS_STARTED')) stageIndex = Math.max(stageIndex, 5);
  if (hasEvent('ESTIMATE_APPROVED')) stageIndex = Math.max(stageIndex, 6);
  if (booking.status === 'COMPLETED') stageIndex = 7;

  let etaMinutes = null;
  if (stageIndex === 3) {
    const enRoute = [...history].reverse().find((e) => e.type === 'TECH_EN_ROUTE');
    etaMinutes = enRoute?.etaMinutes ?? enRoute?.details?.etaMinutes ?? activeAssignment?.etaMinutes ?? null;
  }

  let technician = { assigned: false, name: null };
  if (activeAssignment) {
    const provider = providerById(activeAssignment.providerId);
    technician = { assigned: true, name: provider?.businessName || 'Your Top Speed technician' };
  }

  return {
    reference: booking.referenceCode,
    status: booking.status,
    stage,
    stageLabel: STAGE4_LABELS[stage],
    stages: STAGE4_LABELS,
    stageIndex,
    stageLabels: STAGE8_LABELS,
    stageLabel8: STAGE8_LABELS[stageIndex],
    technician,
    etaMinutes,
    appliance: booking.appliance,
    city: booking.city,
    preferredWindow: booking.preferredWindow ?? null,
  };
}
