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

  // Live GPS: exposed ONLY while the technician is en route (stage 3)
  // and only when their device has actually reported a position. A stale
  // fix is flagged, never hidden or faked.
  let technicianLocation = null;
  if (
    activeAssignment &&
    stageIndex === 3 &&
    activeAssignment.lastLat != null &&
    activeAssignment.lastLng != null &&
    activeAssignment.lastLocationAt
  ) {
    const ageSeconds = Math.max(
      0,
      Math.round((Date.now() - new Date(activeAssignment.lastLocationAt).getTime()) / 1000),
    );
    technicianLocation = {
      lat: activeAssignment.lastLat,
      lng: activeAssignment.lastLng,
      updatedAt: activeAssignment.lastLocationAt,
      ageSeconds,
      stale: ageSeconds > 600,
    };
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
    technicianLocation,
    appliance: booking.appliance,
    city: booking.city,
    preferredWindow: booking.preferredWindow ?? null,
  };
}

/**
 * Visit photo report (2026-11-20, recommendation C20) — the before /
 * during / after photos the technician attached to THIS job in the
 * Tech App, grouped for the customer. Derived from the same booking
 * history events the provider workspace reads (JOB_PHOTO_ADDED minus
 * JOB_PHOTO_REMOVED), so the customer sees exactly the photos of
 * record — nothing staged, nothing from another job. Powers the
 * per-visit photo reports Cleanout Vents plan customers (and every
 * other customer) get on the tracking page. Returns null when the job
 * has no photos, so surfaces render nothing rather than an empty
 * report shell.
 */
export function photoReportOf(booking) {
  const history = Array.isArray(booking?.history) ? booking.history : [];
  const byId = new Map();
  const removed = new Set();
  for (const event of history) {
    if (event.type === 'JOB_PHOTO_ADDED' && event.photo && event.photo.id) byId.set(event.photo.id, event.photo);
    if (event.type === 'JOB_PHOTO_REMOVED' && event.photoId) removed.add(event.photoId);
  }
  const photos = [...byId.values()].filter((photo) => !removed.has(photo.id));
  if (!photos.length) return null;
  const pick = (category) =>
    photos
      .filter((p) => p.category === category)
      .map((p) => ({ id: p.id, dataUrl: p.dataUrl, caption: p.caption || null, at: p.at || null }));
  return {
    before: pick('BEFORE'),
    during: pick('DURING'),
    after: pick('AFTER'),
    total: photos.length,
  };
}
