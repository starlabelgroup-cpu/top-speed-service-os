import { appendEvent, createId, store } from '../data/store.js';
import { PLATFORM_CONSTANTS } from '../config/platform.js';
import { persistNotification } from '../db/flywheelRepo.js';
import { drainEntries } from './senders.js';

/**
 * Notification pipeline — ONE system for every email/SMS alert and
 * update on the network and platform (Ramone's directive, 2026-11-11:
 * "a system for Top Speed service OS email and sms messages alerts and
 * updates following any submissions from network and platform").
 *
 * How it works:
 *  - Every entry point calls one of the notify* functions below with an
 *    EVENT (a submission, a booking lifecycle change, a payment…). The
 *    event fans out into outbox entries: customer confirmation/update
 *    (email + SMS), and staff alerts (email to the business inbox + SMS
 *    to the business line).
 *  - Every entry lands in the notification outbox (GET
 *    /api/v1/notifications) and is written through to the database
 *    (db/flywheelRepo) so messages survive cold starts.
 *  - Delivery runs through services/senders.js (Resend email, Twilio
 *    SMS): opportunistically right after queueing (this process, new
 *    entries only), plus the staff-triggered POST /notifications/send
 *    and the CRON_SECRET-guarded GET /notifications/cron-drain.
 *  - TRUTHFUL STATUSES: QUEUED → SENT / FAILED / GATED. GATED carries a
 *    machine-readable `reason` (RESEND_NOT_CONFIGURED,
 *    TWILIO_NOT_CONFIGURED, NO_RECIPIENT, SETTING_DISABLED). An entry
 *    is only SENT when the provider accepted it — nothing pretends.
 *  - IDEMPOTENCY: one-shot events carry an `eventKey`; queueing the
 *    same key twice returns the existing entry instead of a duplicate.
 *  - GOVERNANCE: messages are composed ONLY from recorded data —
 *    references, names, service, city, windows, real statuses. No
 *    invented prices, ETAs, or statuses; a receipt states paid only
 *    when the recorded payment status is PAID.
 */
export const NOTIFICATION_TEMPLATES = {
  BOOKING_CONFIRMATION: 'BOOKING_CONFIRMATION',
  TECH_EN_ROUTE: 'TECH_EN_ROUTE',
  TRACKING_UPDATE: 'TRACKING_UPDATE',
  DISPATCH_MATCHED: 'DISPATCH_MATCHED',
  DISPATCH_APPROVED: 'DISPATCH_APPROVED',
  REVIEW_REQUEST: 'REVIEW_REQUEST',
  APPOINTMENT_REMINDER: 'APPOINTMENT_REMINDER',
  REFERRAL_CODE: 'REFERRAL_CODE',
  REFERRAL_INVITE: 'REFERRAL_INVITE',
  REFERRAL_BOOKED: 'REFERRAL_BOOKED',
  REFERRAL_COMPLETED: 'REFERRAL_COMPLETED',
  REFERRAL_REWARD_APPROVED: 'REFERRAL_REWARD_APPROVED',
  REFERRAL_CREDIT_EXPIRING: 'REFERRAL_CREDIT_EXPIRING',
  REFERRAL_CREDIT_EXPIRED: 'REFERRAL_CREDIT_EXPIRED',
  COMMERCIAL_WORK_ORDER_RECEIVED: 'COMMERCIAL_WORK_ORDER_RECEIVED',
  REFUND_REQUEST: 'REFUND_REQUEST',
  SAFETY_ESCALATION: 'SAFETY_ESCALATION',
  VIDEO_REQUEST: 'VIDEO_REQUEST',
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  BOOKING_RECEIPT: 'BOOKING_RECEIPT',
  SUBMISSION_CONFIRMATION: 'SUBMISSION_CONFIRMATION',
  STAFF_SUBMISSION_ALERT: 'STAFF_SUBMISSION_ALERT',
  ACCOUNT_WELCOME: 'ACCOUNT_WELCOME',
  SIGNIN_LINK: 'SIGNIN_LINK',
};

/* ------------------------------------------------------------------ */
/* Settings — staff toggles, persisted via db/notificationsRepo.       */
/* Defaults are ALL ON; the store copy is hydrated at cold start.      */
/* ------------------------------------------------------------------ */
export const NOTIFICATION_SETTING_DEFAULTS = {
  staffEmailAlerts: true,
  staffSmsAlerts: true,
  customerEmailConfirmations: true,
  customerSmsConfirmations: true,
};
export const NOTIFICATION_SETTING_KEYS = Object.keys(NOTIFICATION_SETTING_DEFAULTS);

export function getNotificationSettings() {
  return { ...NOTIFICATION_SETTING_DEFAULTS, ...(store.notificationSettings || {}) };
}

/* ------------------------------------------------------------------ */
/* Outbox core                                                         */
/* ------------------------------------------------------------------ */

const pendingDrain = new Set();
let drainTimer = null;

/**
 * Opportunistic delivery: entries queued by THIS process get one drain
 * attempt shortly after queueing, so alerts follow submissions without
 * waiting for a staff member to press "send". Only the new entries are
 * attempted — the historical backlog is never touched implicitly; the
 * staff drain (POST /notifications/send) and the cron drain remain the
 * explicit full-queue processors.
 */
function scheduleEntryDrain(entry) {
  pendingDrain.add(entry);
  if (drainTimer) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    const batch = [...pendingDrain];
    pendingDrain.clear();
    void drainEntries(batch).catch((error) => {
      console.error(JSON.stringify({ level: 'error', message: 'opportunistic drain failed', error: String(error?.message || error) }));
    });
  }, 1200);
  if (typeof drainTimer.unref === 'function') drainTimer.unref();
}

export function queueNotification({ channel, template, to, payload = {}, source = null, eventKey = null, eventType = null, status = null, reason = null }) {
  if (eventKey) {
    const existing = store.notificationOutbox.find((entry) => entry.eventKey === eventKey);
    if (existing) return existing;
  }
  const entry = {
    id: createId(),
    channel,
    template,
    to,
    payload,
    status: status || 'QUEUED',
    createdAt: new Date().toISOString(),
  };
  if (eventKey) entry.eventKey = eventKey;
  if (eventType) entry.eventType = eventType;
  if (reason) entry.reason = reason;
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
  if ((channel === 'email' || channel === 'sms') && entry.status === 'QUEUED') {
    scheduleEntryDrain(entry);
  }
  return entry;
}

/** A notification that cannot be attempted, recorded honestly as GATED. */
function queueGated({ channel, template, to, payload, source, eventKey, eventType, reason }) {
  return queueNotification({ channel, template, to, payload, source, eventKey, eventType, status: 'GATED', reason });
}

function customerChannels(booking) {
  const channels = [];
  if (booking.customer?.phone) channels.push({ channel: 'sms', to: booking.customer.phone });
  if (booking.customer?.email) channels.push({ channel: 'email', to: booking.customer.email });
  return channels;
}

/* ------------------------------------------------------------------ */
/* Staff alerts — real email + SMS to the business, per submission.    */
/* ------------------------------------------------------------------ */

export const STAFF_ALERT_EMAIL = 'service@topspeedappliance.net';
export const STAFF_ALERT_PHONE = PLATFORM_CONSTANTS.phone; // 954-931-7997, the business line

/**
 * Alert the business about a submission. Respects the staff toggles:
 * when a channel is off, a GATED (SETTING_DISABLED) entry is recorded
 * instead so the console shows what was suppressed and why.
 */
export function notifyStaffAlert({ kind, kindLabel, reference, submitterName = null, city = null, lines = [], consolePath = '/portal', source = null, eventKeyBase = null }) {
  const settings = getNotificationSettings();
  const label = kindLabel || kind;
  const keyBase = eventKeyBase || `submission:${reference || kind}`;
  const emailBody =
    `New ${label} submission on the Top Speed platform.\n` +
    `Reference: ${reference || '(none)'}\n` +
    (submitterName ? `From: ${submitterName}\n` : '') +
    (city ? `City: ${city}\n` : '') +
    lines.map((line) => `${line}\n`).join('') +
    `Review it here: https://topspeedserviceos.com${consolePath}\n` +
    `— Top Speed Service OS notifications`;
  const smsBody =
    `Top Speed alert: new ${label} ${reference || ''}`.trimEnd() +
    (submitterName ? ` — ${submitterName}` : '') +
    (city ? `, ${city}` : '') +
    '. Details in the console.';
  const entries = [];
  const emailPayload = { kind, reference: reference || null, message: emailBody, subject: `New ${label} — ${reference || 'submission'}` };
  if (settings.staffEmailAlerts) {
    entries.push(queueNotification({ channel: 'email', template: NOTIFICATION_TEMPLATES.STAFF_SUBMISSION_ALERT, to: STAFF_ALERT_EMAIL, payload: emailPayload, source, eventKey: `${keyBase}:staff:email`, eventType: 'SUBMISSION' }));
  } else {
    entries.push(queueGated({ channel: 'email', template: NOTIFICATION_TEMPLATES.STAFF_SUBMISSION_ALERT, to: STAFF_ALERT_EMAIL, payload: emailPayload, source, eventKey: `${keyBase}:staff:email`, eventType: 'SUBMISSION', reason: 'SETTING_DISABLED' }));
  }
  const smsPayload = { kind, reference: reference || null, message: smsBody };
  if (settings.staffSmsAlerts) {
    entries.push(queueNotification({ channel: 'sms', template: NOTIFICATION_TEMPLATES.STAFF_SUBMISSION_ALERT, to: STAFF_ALERT_PHONE, payload: smsPayload, source, eventKey: `${keyBase}:staff:sms`, eventType: 'SUBMISSION' }));
  } else {
    entries.push(queueGated({ channel: 'sms', template: NOTIFICATION_TEMPLATES.STAFF_SUBMISSION_ALERT, to: STAFF_ALERT_PHONE, payload: smsPayload, source, eventKey: `${keyBase}:staff:sms`, eventType: 'SUBMISSION', reason: 'SETTING_DISABLED' }));
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* Submission confirmations — every public intake, one event API.      */
/* ------------------------------------------------------------------ */

/**
 * How each submission type is presented to the person who sent it.
 * Copy is written from the type alone — never from invented facts.
 */
export const SUBMISSION_TYPES = {
  SERVICE_REQUEST: {
    label: 'service request',
    next: 'A Service Setter will review your request and reach out to confirm your appointment window.',
    consolePath: '/crm',
  },
  PROVIDER_APPLICATION: {
    label: 'provider application',
    next: 'Our network team reviews every application and will contact you about the next steps to join the Top Speed network.',
    consolePath: '/crm',
  },
  COMMERCIAL_ACCOUNT_REQUEST: {
    label: 'commercial account request',
    next: 'Our commercial team will contact you to set up your Appliance Pro Commercial account.',
    consolePath: '/crm',
  },
  COMMERCIAL_WORK_ORDER: {
    label: 'commercial work order',
    next: 'Your work order is in the Service Setters queue; we will update you as it is scheduled.',
    consolePath: '/crm',
  },
  PM_WALKTHROUGH_REQUEST: {
    label: 'property walkthrough request',
    next: 'Our property team will contact you to schedule the walkthrough.',
    consolePath: '/crm',
  },
  PM_LEAD: {
    label: 'property manager inquiry',
    next: 'Our property team will contact you to talk through your portfolio and how Top Speed can help.',
    consolePath: '/crm',
  },
  PM_SERVICE_REQUEST: {
    label: 'property service request batch',
    next: 'Your requests are with the Service Setters. Each unit problem carries its own reference, and we will update you as they are scheduled.',
    consolePath: '/crm',
  },
  ADVERTISER_CONTACT: {
    label: 'advertiser inquiry',
    next: 'Our advertising team will reach out shortly about placements on the Top Speed network.',
    consolePath: '/crm',
  },
  MARKETING_AGENCY_INTAKE: {
    label: 'marketing agency intake',
    next: 'The Top Speed Marketing OS agency team will review your intake and reach out.',
    consolePath: '/crm',
  },
  VIDEO_REQUEST: {
    label: 'Speedy Live Video request',
    next: 'Service Setters will arrange your video consultation and text you the join link when the room is ready.',
    consolePath: '/book-os',
  },
  ACCOUNT_REGISTRATION: {
    label: 'account registration',
    next: 'Your account is ready — sign in any time to book service, track your technician, and manage your appliances.',
    consolePath: '/portal',
  },
};

function submissionPresentation(kind) {
  return SUBMISSION_TYPES[kind] || {
    label: 'submission',
    next: 'We have your submission and the team will follow up.',
    consolePath: '/crm',
  };
}

/**
 * The single event entry point for submissions. Fans out to:
 *  - customer confirmation email + SMS (when the contact details were
 *    provided; a GATED/NO_RECIPIENT entry is recorded when they were
 *    not, so staff can see the gap),
 *  - staff alerts (email + SMS to the business) via notifyStaffAlert.
 *
 * `lines` are extra recorded facts (service, property, unit count…)
 * rendered verbatim into the confirmation — pass only real data.
 */
export function notifySubmission({ kind, reference, submitter = {}, lines = [], source = null, consolePath = null }) {
  const presentation = submissionPresentation(kind);
  const label = presentation.label;
  const path = consolePath || presentation.consolePath;
  const keyBase = `submission:${reference || `${kind}:${submitter.phone || submitter.email || 'unknown'}`}`;
  // UUIDs key the event but never print in customer copy.
  const displayRef = reference && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference) ? reference : null;
  const settings = getNotificationSettings();
  const entries = [];

  const detailLines = (lines || []).filter(Boolean);
  const emailBody =
    `Hi ${submitter.name || 'there'},\n\n` +
    `Thank you — Top Speed Appliance received your ${label}.\n` +
    `Your reference: ${displayRef || 'on file'}\n` +
    (detailLines.length ? `\n${detailLines.join('\n')}\n` : '') +
    `\nWhat happens next: ${presentation.next}\n` +
    `Questions? Call ${PLATFORM_CONSTANTS.phoneDisplay}.\n\n` +
    `— Top Speed Appliance · ${PLATFORM_CONSTANTS.slogan}`;
  const smsBody =
    `Top Speed Appliance: we received your ${label} — ref ${displayRef || 'on file'}. ${presentation.next} ` +
    `Questions? Call ${PLATFORM_CONSTANTS.phoneDisplay}.`;

  const emailPayload = {
    kind,
    reference: reference || null,
    customerName: submitter.name || null,
    message: emailBody,
    subject: displayRef ? `We received your ${label} — ref ${displayRef}` : `We received your ${label}`,
  };
  if (submitter.email) {
    if (settings.customerEmailConfirmations) {
      entries.push(queueNotification({ channel: 'email', template: NOTIFICATION_TEMPLATES.SUBMISSION_CONFIRMATION, to: submitter.email, payload: emailPayload, source, eventKey: `${keyBase}:customer:email`, eventType: 'SUBMISSION' }));
    } else {
      entries.push(queueGated({ channel: 'email', template: NOTIFICATION_TEMPLATES.SUBMISSION_CONFIRMATION, to: submitter.email, payload: emailPayload, source, eventKey: `${keyBase}:customer:email`, eventType: 'SUBMISSION', reason: 'SETTING_DISABLED' }));
    }
  } else {
    entries.push(queueGated({ channel: 'email', template: NOTIFICATION_TEMPLATES.SUBMISSION_CONFIRMATION, to: '(no email on file)', payload: emailPayload, source, eventKey: `${keyBase}:customer:email`, eventType: 'SUBMISSION', reason: 'NO_RECIPIENT' }));
  }

  const smsPayload = { kind, reference: reference || null, customerName: submitter.name || null, message: smsBody };
  if (submitter.phone) {
    if (settings.customerSmsConfirmations) {
      entries.push(queueNotification({ channel: 'sms', template: NOTIFICATION_TEMPLATES.SUBMISSION_CONFIRMATION, to: submitter.phone, payload: smsPayload, source, eventKey: `${keyBase}:customer:sms`, eventType: 'SUBMISSION' }));
    } else {
      entries.push(queueGated({ channel: 'sms', template: NOTIFICATION_TEMPLATES.SUBMISSION_CONFIRMATION, to: submitter.phone, payload: smsPayload, source, eventKey: `${keyBase}:customer:sms`, eventType: 'SUBMISSION', reason: 'SETTING_DISABLED' }));
    }
  } else {
    entries.push(queueGated({ channel: 'sms', template: NOTIFICATION_TEMPLATES.SUBMISSION_CONFIRMATION, to: '(no phone on file)', payload: smsPayload, source, eventKey: `${keyBase}:customer:sms`, eventType: 'SUBMISSION', reason: 'NO_RECIPIENT' }));
  }

  entries.push(...notifyStaffAlert({
    kind,
    kindLabel: label,
    reference,
    submitterName: submitter.name || null,
    lines: [
      ...(submitter.phone ? [`Phone: ${submitter.phone}`] : []),
      ...(submitter.email ? [`Email: ${submitter.email}`] : []),
      ...detailLines,
    ],
    consolePath: path,
    source,
    eventKeyBase: keyBase,
  }));
  return entries;
}

/** Welcome message for a newly registered account (+ staff alert). */
export function notifyAccountCreated(user, source = null) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || null;
  const entries = [];
  if (user.email) {
    const settings = getNotificationSettings();
    const payload = {
      userId: user.id,
      customerName: name,
      message:
        `Hi ${name ? name.split(' ')[0] : 'there'},\n\n` +
        `Welcome to Top Speed Appliance — your account is ready. Sign in any time to book service, ` +
        `track your technician live, and keep your appliances and service history in one place.\n` +
        `Questions? Call ${PLATFORM_CONSTANTS.phoneDisplay}.\n\n` +
        `— Top Speed Appliance · ${PLATFORM_CONSTANTS.slogan}`,
      subject: 'Welcome to Top Speed Appliance',
    };
    if (settings.customerEmailConfirmations) {
      entries.push(queueNotification({ channel: 'email', template: NOTIFICATION_TEMPLATES.ACCOUNT_WELCOME, to: user.email, payload, source, eventKey: `account:${user.id}:welcome:email`, eventType: 'ACCOUNT' }));
    } else {
      entries.push(queueGated({ channel: 'email', template: NOTIFICATION_TEMPLATES.ACCOUNT_WELCOME, to: user.email, payload, source, eventKey: `account:${user.id}:welcome:email`, eventType: 'ACCOUNT', reason: 'SETTING_DISABLED' }));
    }
  }
  entries.push(...notifyStaffAlert({
    kind: 'ACCOUNT_REGISTRATION',
    kindLabel: 'account registration',
    reference: user.email,
    submitterName: name,
    lines: [`Email: ${user.email}`, ...(user.phone ? [`Phone: ${user.phone}`] : []), `Role: ${(user.roles || []).join(', ') || 'CUSTOMER'}`],
    consolePath: '/portal',
    source,
    eventKeyBase: `account:${user.id}`,
  }));
  return entries;
}

/* ------------------------------------------------------------------ */
/* Booking lifecycle (existing pipeline, now with event keys).         */
/* ------------------------------------------------------------------ */

export function notifyBookingConfirmation(booking, source = null) {
  const appointment = booking.appointment?.status === 'SET' ? booking.appointment : null;
  const appointmentText = appointment
    ? ` Your appointment is ${appointment.date}, ${appointment.windowLabel || appointment.window}.`
    : '';
  // The confirmation legitimately re-sends when an appointment is set
  // or moved, so the key carries the appointment's setAt stamp; the
  // initial booking confirmation keys on the booking itself.
  const keyStamp = appointment?.setAt || 'initial';
  return customerChannels(booking).map(({ channel, to }) =>
    queueNotification({
      channel,
      template: NOTIFICATION_TEMPLATES.BOOKING_CONFIRMATION,
      to,
      source,
      eventKey: `booking:${booking.id}:confirmation:${channel}:${keyStamp}`,
      eventType: 'BOOKING',
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
 * Staff alert for a new booking, fired beside the customer
 * confirmation at every booking creation path.
 */
export function notifyNewBooking(booking, source = null) {
  return notifyStaffAlert({
    kind: 'BOOKING',
    kindLabel: 'booking',
    reference: booking.referenceCode,
    submitterName: booking.customer?.name || null,
    city: booking.city || null,
    lines: [
      `Service: ${booking.appliance}${booking.issue ? ` — ${booking.issue}` : ''}`,
      ...(booking.customer?.phone ? [`Phone: ${booking.customer.phone}`] : []),
      ...(booking.preferredWindow ? [`Preferred window: ${booking.preferredWindow}`] : []),
      `Status: ${booking.status}`,
    ],
    consolePath: '/book-os',
    source,
    eventKeyBase: `booking:${booking.id}`,
  });
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
      eventKey: `booking:${booking.id}:reminder:${channel}:${appointment.date || 'unset'}`,
      eventType: 'BOOKING',
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
      eventKey: `referral:${referral.code}:${channel}`,
      eventType: 'BOOKING',
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

/* ------------------------------------------------------------------ */
/* ApplianceReferral program (Phase 1, 2026-11-12).                    */
/*                                                                     */
/* GOVERNANCE: no referrer-reward figure appears in any copy below     */
/* except a value read from the program settings at runtime (the       */
/* journey's reward snapshot / an issued credit's amount). The $25 in  */
/* the invite is the PUBLISHED new-customer welcome offer, not the     */
/* referrer reward. SMS entries queue through the same outbox as       */
/* everything else — on the Twilio trial they gate honestly in the     */
/* sender drain; nothing here claims a text was delivered.             */
/* ------------------------------------------------------------------ */

function firstNameOf(name) {
  const first = String(name || '').trim().split(/\s+/)[0];
  return first || 'Your neighbor';
}

function formatCents(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

/** Contact channels for a referral's owner (the referrer). */
function referrerChannels(referral) {
  const customer = referral?.customerId ? store.customers.get(referral.customerId) : null;
  const channels = [];
  const phone = customer?.phone || referral?.customerPhone || null;
  const email = customer?.email || null;
  if (phone) channels.push({ channel: 'sms', to: phone });
  if (email) channels.push({ channel: 'email', to: email });
  return channels;
}

/**
 * Invite to the friend, one entry per contact channel they provided.
 * eventKey is per journey + channel, so re-sending an invite for the
 * same journey never duplicates.
 */
export function notifyReferralInvite({ referral, journey, source = null }) {
  const referrerFirstName = firstNameOf(referral.customerName || store.customers.get(referral.customerId || '')?.name);
  const link = `https://topspeedserviceos.com/refer?c=${referral.code}`;
  const message =
    `${referrerFirstName} invited you to try Top Speed Appliance — new customers get $25 off a first eligible repair. Book: ${link}`;
  const channels = [];
  if (journey.refereePhone) channels.push({ channel: 'sms', to: journey.refereePhone });
  if (journey.refereeEmail) channels.push({ channel: 'email', to: journey.refereeEmail });
  return channels.map(({ channel, to }) =>
    queueNotification({
      channel,
      template: NOTIFICATION_TEMPLATES.REFERRAL_INVITE,
      to,
      source,
      eventKey: `referral-invite:${journey.id}:${channel}`,
      eventType: 'REFERRAL',
      payload: {
        journeyId: journey.id,
        referralCode: referral.code,
        referrerName: referral.customerName || null,
        refereeName: journey.refereeName || null,
        link,
        message,
        subject: `${referrerFirstName} invited you to Top Speed Appliance`,
      },
    }),
  );
}

/** The referrer hears that their friend booked — no amounts, ever. */
export function notifyReferralBooked(referral, journey, source = null) {
  const refereeName = journey.refereeName || 'Your friend';
  return referrerChannels(referral).map(({ channel, to }) =>
    queueNotification({
      channel,
      template: NOTIFICATION_TEMPLATES.REFERRAL_BOOKED,
      to,
      source,
      eventKey: `referral-journey:${journey.id}:booked:${channel}`,
      eventType: 'REFERRAL',
      payload: {
        journeyId: journey.id,
        referralCode: referral.code,
        customerName: referral.customerName || null,
        refereeName: journey.refereeName || null,
        bookingReference: journey.bookingReference || null,
        message:
          `Top Speed Appliance: good news — ${refereeName} booked service with your referral code ${referral.code}` +
          (journey.bookingReference ? ` (ref ${journey.bookingReference})` : '') +
          `. We'll keep you posted as their job progresses.`,
      },
    }),
  );
}

/**
 * The referrer hears that their friend's job completed. The reward
 * amount is included ONLY when the journey carries a snapshot copied
 * from the configured program settings — otherwise the copy says the
 * reward is under review and states no figure.
 */
export function notifyReferralCompleted(referral, journey, source = null) {
  const refereeName = journey.refereeName || 'Your friend';
  const amountLine = journey.rewardAmountCents != null
    ? ` Your referral reward of ${formatCents(journey.rewardAmountCents)} is pending staff approval.`
    : ' Your referral reward is being reviewed by our team.';
  return referrerChannels(referral).map(({ channel, to }) =>
    queueNotification({
      channel,
      template: NOTIFICATION_TEMPLATES.REFERRAL_COMPLETED,
      to,
      source,
      eventKey: `referral-journey:${journey.id}:completed:${channel}`,
      eventType: 'REFERRAL',
      payload: {
        journeyId: journey.id,
        referralCode: referral.code,
        customerName: referral.customerName || null,
        refereeName: journey.refereeName || null,
        bookingReference: journey.bookingReference || null,
        rewardAmountCents: journey.rewardAmountCents ?? null,
        message:
          `Top Speed Appliance: ${refereeName}'s service (booked with your referral code ${referral.code}) is complete.` +
          amountLine,
      },
    }),
  );
}

/**
 * The referrer hears a reward credit was issued. The amount comes from
 * the issued credit record itself — a real ledger fact, never copy.
 */
export function notifyReferralRewardApproved(referral, journey, credit, bonusCredit = null, source = null) {
  const bonusLine = bonusCredit
    ? ` Plus a milestone bonus credit of ${formatCents(bonusCredit.amountCents)}.`
    : '';
  const expiryLine = credit.expiresAt
    ? ` Use it by ${String(credit.expiresAt).slice(0, 10)}.`
    : '';
  return referrerChannels(referral).map(({ channel, to }) =>
    queueNotification({
      channel,
      template: NOTIFICATION_TEMPLATES.REFERRAL_REWARD_APPROVED,
      to,
      source,
      eventKey: `referral-credit:${credit.id}:approved:${channel}`,
      eventType: 'REFERRAL',
      payload: {
        journeyId: journey.id,
        creditId: credit.id,
        referralCode: referral.code,
        customerName: referral.customerName || null,
        amountCents: credit.amountCents,
        bonusAmountCents: bonusCredit?.amountCents ?? null,
        expiresAt: credit.expiresAt || null,
        message:
          `Top Speed Appliance: your referral reward credit of ${formatCents(credit.amountCents)} has been issued ` +
          `for ${journey.refereeName || 'your friend'}'s completed service.${bonusLine}${expiryLine} ` +
          `Mention it when you book your next service and we'll apply it.`,
      },
    }),
  );
}

/** Contact channels for a credit's owner, resolved by customer id. */
function creditOwnerChannels(credit) {
  const customer = credit?.customerId ? store.customers.get(credit.customerId) : null;
  const channels = [];
  if (customer?.phone) channels.push({ channel: 'sms', to: customer.phone });
  if (customer?.email) channels.push({ channel: 'email', to: customer.email });
  return { customer, channels };
}

/**
 * Pre-expiry reminder (Phase 2): an AVAILABLE credit inside its final
 * 30 days. The eventKey is per credit + channel, and queueNotification
 * dedupes on it — the reminder is queued exactly once, however often
 * the expiry sweep runs. The amount and date come from the credit
 * record itself (a real issued ledger fact).
 */
export function notifyReferralCreditExpiring(credit, source = null) {
  const { customer, channels } = creditOwnerChannels(credit);
  if (!channels.length) return [];
  const expiryDate = String(credit.expiresAt || '').slice(0, 10);
  return channels.map(({ channel, to }) =>
    queueNotification({
      channel,
      template: NOTIFICATION_TEMPLATES.REFERRAL_CREDIT_EXPIRING,
      to,
      source,
      eventKey: `referral-credit:${credit.id}:expiring:${channel}`,
      eventType: 'REFERRAL',
      payload: {
        creditId: credit.id,
        customerName: customer?.name || null,
        amountCents: credit.amountCents,
        expiresAt: credit.expiresAt || null,
        message:
          `Top Speed Appliance: a quick heads-up — your referral reward credit of ${formatCents(credit.amountCents)} ` +
          `expires on ${expiryDate}. Book your next service before then and mention the credit so we can apply it.`,
      },
    }),
  );
}

/** Sent when the expiry sweep lapses an AVAILABLE credit (Phase 2). */
export function notifyReferralCreditExpired(credit, source = null) {
  const { customer, channels } = creditOwnerChannels(credit);
  if (!channels.length) return [];
  const expiryDate = String(credit.expiresAt || '').slice(0, 10);
  return channels.map(({ channel, to }) =>
    queueNotification({
      channel,
      template: NOTIFICATION_TEMPLATES.REFERRAL_CREDIT_EXPIRED,
      to,
      source,
      eventKey: `referral-credit:${credit.id}:expired:${channel}`,
      eventType: 'REFERRAL',
      payload: {
        creditId: credit.id,
        customerName: customer?.name || null,
        amountCents: credit.amountCents,
        expiresAt: credit.expiresAt || null,
        message:
          `Top Speed Appliance: your referral reward credit of ${formatCents(credit.amountCents)} expired on ${expiryDate} ` +
          `before it was used. Your referral code still works — friends you send us can still earn you new credit.`,
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
      eventKey: `booking:${booking.id}:enroute:${channel}`,
      eventType: 'BOOKING',
      payload: {
        bookingId: booking.id,
        referenceCode: booking.referenceCode || null,
        message: 'Top Speed Appliance: your technician is on the way. You can follow the visit status from your booking updates.',
      },
    }),
  );
}

/** A Track My Tech status update, queued from the staff tracking console. */
export function notifyTrackingUpdate(booking, stageLabel, source = null, eventKey = null) {
  return customerChannels(booking).map(({ channel, to }) =>
    queueNotification({
      channel,
      template: NOTIFICATION_TEMPLATES.TRACKING_UPDATE,
      to,
      source,
      eventKey: eventKey ? `${eventKey}:${channel}` : null,
      eventType: 'BOOKING',
      payload: {
        bookingId: booking.id,
        referenceCode: booking.referenceCode || null,
        message: `Top Speed Appliance: update on your service visit (${booking.referenceCode || ''}) — current status: ${stageLabel}. Track your technician any time at topspeedserviceos.com/track.`,
      },
    }),
  );
}

/** Customer notice that a technician has been assigned to their job. */
export function notifyBookingAssigned(booking, assignment, source = null) {
  return customerChannels(booking).map(({ channel, to }) =>
    queueNotification({
      channel,
      template: NOTIFICATION_TEMPLATES.DISPATCH_APPROVED,
      to,
      source,
      eventKey: `booking:${booking.id}:assigned:${assignment?.id || 'none'}:${channel}`,
      eventType: 'BOOKING',
      payload: {
        bookingId: booking.id,
        referenceCode: booking.referenceCode || null,
        customerName: booking.customer?.name,
        appliance: booking.appliance,
        city: booking.city,
        assignmentId: assignment?.id || null,
        message:
          `Top Speed Appliance: a technician has been assigned to your ${booking.appliance} service in ${booking.city} ` +
          `(ref ${booking.referenceCode || ''}). We will update you as the visit progresses — track any time at topspeedserviceos.com/track. ` +
          `Questions? Call ${PLATFORM_CONSTANTS.phoneDisplay}.`,
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
      eventKey: `booking:${booking.id}:dispatch-approved:${assignment?.id || 'none'}`,
      eventType: 'BOOKING',
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
      eventKey: `workorder:${workOrder.referenceCode}:received`,
      eventType: 'COMMERCIAL',
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
      eventKey: `booking:${booking.id}:review:${channel}`,
      eventType: 'BOOKING',
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

/**
 * Customer-requested booking receipt (Phase D+, via Speedy): composed
 * ONLY from recorded booking fields. If a payment is recorded PAID it
 * says so; otherwise it states the $99 diagnostic terms as booked —
 * never an invented paid state. One channel per call, queued through
 * the same outbox as every other platform message.
 */
export function notifyBookingReceipt(booking, channel, source = null) {
  const paid = booking.payment?.status === 'PAID';
  const diagnosticLine = paid
    ? 'Diagnostic: $99 — PAID.'
    : 'Diagnostic: $99 — collected at booking, credited toward your repair.';
  const appointment = booking.appointment?.status === 'SET' ? booking.appointment : null;
  const when = appointment
    ? `${appointment.date}, ${appointment.windowLabel || appointment.window}`
    : booking.preferredWindow || 'Window to be confirmed by Service Setters';
  const trackingUrl = 'https://topspeedserviceos.com/track';
  const to = channel === 'email' ? booking.customer?.email : booking.customer?.phone;
  if (!to) return null;
  const message =
    channel === 'email'
      ? `Top Speed Appliance — booking receipt\nReference: ${booking.referenceCode}\nService: ${booking.appliance} — ${booking.issue}\nCity: ${booking.city}\nWhen: ${when}\nStatus: ${booking.status}\n${diagnosticLine}\nTrack your job live: ${trackingUrl} (use your reference + phone).\nQuestions? Call ${PLATFORM_CONSTANTS.phoneDisplay}.`
      : `Top Speed Appliance receipt: ${booking.appliance} in ${booking.city}, ref ${booking.referenceCode}. ${diagnosticLine} Track live: ${trackingUrl} (ref + this phone).`;
  return queueNotification({
    channel,
    template: NOTIFICATION_TEMPLATES.BOOKING_RECEIPT,
    to,
    source,
    payload: {
      bookingId: booking.id,
      referenceCode: booking.referenceCode || null,
      customerName: booking.customer?.name,
      appliance: booking.appliance,
      city: booking.city,
      when,
      paid,
      diagnosticLine,
      trackingUrl,
      businessPhone: PLATFORM_CONSTANTS.phone,
      message,
    },
  });
}
