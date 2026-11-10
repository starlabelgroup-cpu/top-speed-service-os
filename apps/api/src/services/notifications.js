import { appendEvent, createId, store } from '../data/store.js';
import { PLATFORM_CONSTANTS } from '../config/platform.js';
import { persistNotification } from '../db/flywheelRepo.js';

/**
 * Notification pipeline.
 *
 * Every message the platform sends is appended to the notification
 * outbox (GET /api/v1/notifications/outbox) with its channel, template,
 * recipient, and payload — and written through to the database
 * (db/flywheelRepo) so queued messages survive cold starts. The live
 * drain in services/senders.js delivers them through Resend (email)
 * and Twilio (SMS) when those providers are configured; entries for an
 * unconfigured provider stay queued with status QUEUED_SIMULATED.
 */
export const NOTIFICATION_TEMPLATES = {
  BOOKING_CONFIRMATION: 'BOOKING_CONFIRMATION',
  TECH_EN_ROUTE: 'TECH_EN_ROUTE',
  DISPATCH_MATCHED: 'DISPATCH_MATCHED',
  DISPATCH_APPROVED: 'DISPATCH_APPROVED',
  REVIEW_REQUEST: 'REVIEW_REQUEST',
  APPOINTMENT_REMINDER: 'APPOINTMENT_REMINDER',
  REFERRAL_CODE: 'REFERRAL_CODE',
  COMMERCIAL_WORK_ORDER_RECEIVED: 'COMMERCIAL_WORK_ORDER_RECEIVED',
  REFUND_REQUEST: 'REFUND_REQUEST',
  SAFETY_ESCALATION: 'SAFETY_ESCALATION',
  VIDEO_REQUEST: 'VIDEO_REQUEST',
};

export function queueNotification({ channel, template, to, payload = {}, source = null }) {
  const entry = {
    id: createId(),
    channel,
    template,
    to,
    payload,
    status: 'QUEUED_SIMULATED',
    createdAt: new Date().toISOString(),
  };
  store.notificationOutbox.push(entry);
  // Write-through so the outbox survives cold starts. Fire-and-forget:
  // the in-memory push above is what this response is built from.
  void persistNotification(entry).catch((error) => {
    console.error(JSON.stringify({ level: 'error', message: 'notification persist failed', error: String(error?.message || error) }));
  });
  appendEvent('NOTIFICATION_QUEUED', {
    source,
    entityType: 'NOTIFICATION',
    entityId: entry.id,
    details: { channel, template, to },
  });
  return entry;
}

function customerChannels(booking) {
  const channels = [];
  if (booking.customer?.phone) channels.push({ channel: 'sms', to: booking.customer.phone });
  if (booking.customer?.email) channels.push({ channel: 'email', to: booking.customer.email });
  return channels;
}

export function notifyBookingConfirmation(booking, source = null) {
  const appointment = booking.appointment?.status === 'SET' ? booking.appointment : null;
  const appointmentText = appointment
    ? ` Your appointment is ${appointment.date}, ${appointment.windowLabel || appointment.window}.`
    : '';
  return customerChannels(booking).map(({ channel, to }) =>
    queueNotification({
      channel,
      template: NOTIFICATION_TEMPLATES.BOOKING_CONFIRMATION,
      to,
      source,
      payload: {
        bookingId: booking.id,
        referenceCode: booking.referenceCode || null,
        customerName: booking.customer?.name,
        appliance: booking.appliance,
        city: booking.city,
        appointment: appointment ? { date: appointment.date, window: appointment.window } : null,
        diagnosticFee: PLATFORM_CONSTANTS.diagnosticFee,
        feeTerms: PLATFORM_CONSTANTS.feeTerms,
        businessPhone: PLATFORM_CONSTANTS.phone,
        message:
          `Top Speed Appliance: your ${booking.appliance} service in ${booking.city} is booked.${appointmentText} ` +
          `${PLATFORM_CONSTANTS.feeTerms} Questions? Call ${PLATFORM_CONSTANTS.phoneDisplay}.`,
      },
    }),
  );
}

/**
 * Day-before reminder queued by the Book OS reminder run for every
 * booking with an appointment set on the target date.
 */
export function notifyAppointmentReminder(booking, source = null) {
  const appointment = booking.appointment || {};
  return customerChannels(booking).map(({ channel, to }) =>
    queueNotification({
      channel,
      template: NOTIFICATION_TEMPLATES.APPOINTMENT_REMINDER,
      to,
      source,
      payload: {
        bookingId: booking.id,
        referenceCode: booking.referenceCode || null,
        customerName: booking.customer?.name,
        appliance: booking.appliance,
        city: booking.city,
        appointment: { date: appointment.date || null, window: appointment.window || null },
        businessPhone: PLATFORM_CONSTANTS.phone,
        message:
          `Top Speed Appliance reminder: your ${booking.appliance} appointment in ${booking.city} is ` +
          `${appointment.date}, ${appointment.windowLabel || appointment.window}. ` +
          `Need a different time? Call ${PLATFORM_CONSTANTS.phoneDisplay}.`,
      },
    }),
  );
}

/**
 * Sent when a job completes: the customer receives their personal
 * referral code — the "refer" stage of the flywheel.
 */
export function notifyReferralIssued(booking, referral, source = null) {
  return customerChannels(booking).map(({ channel, to }) =>
    queueNotification({
      channel,
      template: NOTIFICATION_TEMPLATES.REFERRAL_CODE,
      to,
      source,
      payload: {
        bookingId: booking.id,
        referenceCode: booking.referenceCode || null,
        referralCode: referral.code,
        customerName: booking.customer?.name,
        message:
          `Top Speed Appliance: thanks for choosing us! Know a neighbor with a broken appliance? ` +
          `Share your referral code ${referral.code} — when they book, we will know you sent them.`,
      },
    }),
  );
}

export function notifyTechEnRoute(booking, source = null) {
  return customerChannels(booking).map(({ channel, to }) =>
    queueNotification({
      channel,
      template: NOTIFICATION_TEMPLATES.TECH_EN_ROUTE,
      to,
      source,
      payload: {
        bookingId: booking.id,
        referenceCode: booking.referenceCode || null,
        message: 'Top Speed Appliance: your technician is on the way. You can follow the visit status from your booking updates.',
      },
    }),
  );
}

/** Internal notice to Service Setters: a match is waiting for their approval. */
export function notifyDispatchMatched(booking, candidateCount, source = null) {
  return [
    queueNotification({
      channel: 'internal',
      template: NOTIFICATION_TEMPLATES.DISPATCH_MATCHED,
      to: 'service-setters',
      source,
      payload: {
        bookingId: booking.id,
        referenceCode: booking.referenceCode || null,
        candidateCount,
        message: `Booking ${booking.id} (${booking.appliance}, ${booking.city}) auto-matched ${candidateCount} provider candidate(s). Service Setters approval required before the booking is confirmed.`,
      },
    }),
  ];
}

/** Internal message to the dispatch team when Service Setters approve a match. */
export function notifyDispatchApproved(booking, assignment, source = null) {
  return [
    queueNotification({
      channel: 'internal',
      template: NOTIFICATION_TEMPLATES.DISPATCH_APPROVED,
      to: 'service-setters',
      source,
      payload: {
        bookingId: booking.id,
        referenceCode: booking.referenceCode || null,
        assignmentId: assignment?.id || null,
        providerId: booking.dispatch?.providerId || assignment?.providerId || null,
        approvedBy: booking.dispatch?.approvedBy || null,
        message: `Dispatch approved for booking ${booking.id} (${booking.appliance}, ${booking.city}). Provider notified through the provider channel once live.`,
      },
    }),
  ];
}

/**
 * Internal notice to Service Setters: a commercial work order arrived
 * and its linked booking is in the setter queue. Priority work orders
 * (critical equipment or a PRIORITY / TOTAL_CARE account) are flagged
 * so the queue is worked in the right order.
 */
export function notifyCommercialWorkOrderReceived(workOrder, booking, account, facility, source = null) {
  return [
    queueNotification({
      channel: 'internal',
      template: NOTIFICATION_TEMPLATES.COMMERCIAL_WORK_ORDER_RECEIVED,
      to: 'service-setters',
      source,
      payload: {
        workOrderId: workOrder.id,
        workOrderReference: workOrder.referenceCode,
        bookingId: booking.id,
        bookingReference: booking.referenceCode || null,
        accountId: account.id,
        accountReference: account.referenceCode,
        companyName: account.companyName,
        slaTier: account.slaTier,
        facilityId: facility.id,
        facilityName: facility.name,
        city: facility.city,
        priority: workOrder.priority,
        priorityReasons: workOrder.priorityReasons,
        message:
          `Commercial work order ${workOrder.referenceCode} from ${account.companyName} (${facility.name}, ${facility.city}) ` +
          `is in the setter queue as booking ${booking.referenceCode || booking.id}.` +
          (workOrder.priority ? ` PRIORITY (${workOrder.priorityReasons.join('; ')}).` : ''),
      },
    }),
  ];
}

/** Sent when a job is completed — the review engine's trigger point. */
export function notifyReviewRequest(booking, source = null) {
  return customerChannels(booking).map(({ channel, to }) =>
    queueNotification({
      channel,
      template: NOTIFICATION_TEMPLATES.REVIEW_REQUEST,
      to,
      source,
      payload: {
        bookingId: booking.id,
        referenceCode: booking.referenceCode || null,
        customerName: booking.customer?.name,
        appliance: booking.appliance,
        message:
          `Top Speed Appliance: thanks for your ${booking.appliance} service. ` +
          'If we earned it, a Google review helps neighbors find us — and if anything is not right, call ' +
          `${PLATFORM_CONSTANTS.phoneDisplay} and we will make it right.`,
      },
    }),
  );
}
