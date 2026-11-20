import { appendEvent, createId, store } from '../data/store.js';
import { PLATFORM_CONSTANTS } from '../config/platform.js';
import { latestPaymentForBooking, persistPayment } from '../db/paymentsRepo.js';
import { createDiagnosticCheckout, DIAGNOSTIC_AMOUNT_CENTS, stripeConfigured } from './stripe.js';
import { emitReport } from './managementReports.js';
import { ESTIMATE_APPROVAL_TTL_LABEL, issueEstimateApprovalLink } from './estimateApproval.js';
import { latestEstimate } from './jobMoney.js';

/**
 * Link Center (Ramone's handwritten note, 2026-11-18: "Create a system
 * to send links to SMS, email for payment, booking, accounts,
 * reviews").
 *
 * The catalog of customer links a staff member can send, where each
 * one really points, and the message copy. Delivery itself is NOT
 * re-implemented here: routes/linkCenter.js queues every send through
 * the notification outbox (services/notifications.js) so statuses stay
 * truthful — SENT only when Resend/Twilio accepted, FAILED with the
 * provider's error, GATED when a provider is not configured.
 *
 * PAYMENT links are never invented: they come from the same Stripe
 * checkout machinery as POST /payments/diagnostic/checkout (reuse a
 * live pending session, otherwise create + persist a Payment), so a
 * payment link exists only for a real booking on a configured account.
 */

export const LINK_TYPES = {
  BOOKING: 'BOOKING',
  PAYMENT: 'PAYMENT',
  ACCOUNT: 'ACCOUNT',
  REVIEW: 'REVIEW',
  ESTIMATE: 'ESTIMATE',
};

const APP_BASE = process.env.PUBLIC_WEB_BASE || 'https://topspeedserviceos.com';

export const LINK_CATALOG = [
  {
    type: LINK_TYPES.BOOKING,
    name: 'Booking link',
    description: 'Book a repair — the classic web form, with the Link Center recorded as the source.',
    url: 'https://topspeedserviceos.com/book?src=linkcenter',
    requiresBookingRef: false,
  },
  {
    type: LINK_TYPES.PAYMENT,
    name: 'Payment link',
    description: 'Pay the $99 diagnostic for an existing booking (credited toward the repair). Needs the booking reference.',
    url: null,
    requiresBookingRef: true,
    destNote: 'Minted per booking from Stripe checkout',
  },
  {
    type: LINK_TYPES.ESTIMATE,
    name: 'Estimate approval link',
    description: 'The customer reviews the written estimate saved on a booking and approves or declines it online — the decision lands on the job record. Needs the booking reference and a saved estimate.',
    url: null,
    requiresBookingRef: true,
    destNote: 'Minted per booking — secure approval page',
  },
  {
    type: LINK_TYPES.ACCOUNT,
    name: 'Account link',
    description: 'Sign in or create a Top Speed account — book, track your tech, manage your appliances.',
    url: 'https://topspeedserviceos.com/app',
    requiresBookingRef: false,
  },
  {
    type: LINK_TYPES.REVIEW,
    name: 'Review link',
    description: 'The Pepper Lists reviews wall — read reviews and post one for a finished job.',
    url: 'https://pepperlists.com/#reviews',
    requiresBookingRef: false,
  },
];

export function catalogEntry(linkType) {
  return LINK_CATALOG.find((entry) => entry.type === linkType) || null;
}

/** Find a booking in the working store by its reference code (TS-XXXXXX). */
export function findBookingByReference(reference) {
  const wanted = String(reference || '').trim().toUpperCase();
  if (!wanted) return null;
  for (const booking of store.bookings.values()) {
    if (String(booking.referenceCode || '').toUpperCase() === wanted) return booking;
  }
  return null;
}

/**
 * The Stripe checkout URL for a booking's $99 diagnostic — the exact
 * reuse/create discipline of POST /payments/diagnostic/checkout.
 * Throws { status, error } objects the route can answer honestly.
 */
export async function diagnosticCheckoutUrl(booking) {
  if (!stripeConfigured()) {
    const error = new Error('Stripe keys are not set on the API yet.');
    error.status = 503;
    error.code = 'payments_not_configured';
    throw error;
  }
  const latest = latestPaymentForBooking(booking.id);
  if (latest && latest.status === 'PAID') {
    const error = new Error('The diagnostic for this booking is already paid.');
    error.status = 409;
    error.code = 'diagnostic_already_paid';
    throw error;
  }
  if (latest && latest.status === 'PENDING' && latest.checkoutUrl
    && Date.now() - new Date(latest.createdAt).getTime() < 23 * 60 * 60 * 1000) {
    return { url: latest.checkoutUrl, paymentId: latest.id, reused: true };
  }

  const session = await createDiagnosticCheckout({
    booking,
    successUrl: APP_BASE + '/app?payment=success&ref=' + encodeURIComponent(booking.referenceCode || ''),
    cancelUrl: APP_BASE + '/app?payment=cancelled&ref=' + encodeURIComponent(booking.referenceCode || ''),
  });

  const payment = {
    id: createId(),
    companyId: booking.companyId,
    bookingId: booking.id,
    customerId: booking.customerId ?? null,
    purpose: 'DIAGNOSTIC',
    amountCents: DIAGNOSTIC_AMOUNT_CENTS,
    currency: 'usd',
    status: 'PENDING',
    stripeSessionId: session.id,
    stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
    checkoutUrl: session.url,
    paidAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.payments.set(payment.id, payment);
  await persistPayment(payment).catch((error) => console.error(JSON.stringify({ level: 'error', message: 'payment persist failed', error: String(error?.message || error) })));
  await appendEvent('PAYMENT_CHECKOUT_CREATED', {
    source: 'link-center',
    entityType: 'PAYMENT',
    entityId: payment.id,
    referenceCode: booking.referenceCode || null,
    details: { bookingId: booking.id, amountCents: payment.amountCents, purpose: payment.purpose },
  });
  emitReport({
    department: 'billing',
    type: 'PAYMENT_CHECKOUT_CREATED',
    title: `Diagnostic checkout created — ${booking.referenceCode || booking.id}`,
    detail: { paymentId: payment.id, bookingId: booking.id, bookingReference: booking.referenceCode || null, customerName: booking.customer?.name || null, amountCents: payment.amountCents, purpose: payment.purpose, status: payment.status },
    source: 'link-center',
    reference: booking.referenceCode || null,
    eventKey: `payment:${payment.id}:checkout:report`,
  });
  return { url: session.url, paymentId: payment.id, reused: false };
}

/**
 * Resolve the destination URL for a link type. PAYMENT and ESTIMATE
 * are minted per-send: PAYMENT from the booking's Stripe checkout,
 * ESTIMATE as a fresh token link to the approval page for the
 * booking's saved estimate (services/estimateApproval.js). A booking
 * with no saved estimate gets an honest 409 — never a link to an
 * empty page.
 */
export async function resolveLinkUrl(linkType, { bookingRef = null, sentBy = null } = {}) {
  const entry = catalogEntry(linkType);
  if (!entry) {
    const error = new Error(`Unknown link type: ${linkType}`);
    error.status = 400;
    error.code = 'unknown_link_type';
    throw error;
  }
  if (linkType !== LINK_TYPES.PAYMENT && linkType !== LINK_TYPES.ESTIMATE) {
    return { url: entry.url, booking: null };
  }
  const booking = findBookingByReference(bookingRef);
  if (!booking) {
    const error = new Error(`No booking found with reference ${bookingRef || '(none given)'}.`);
    error.status = 404;
    error.code = 'booking_not_found';
    throw error;
  }
  if (linkType === LINK_TYPES.ESTIMATE) {
    if (!latestEstimate(booking)) {
      const error = new Error('There is no saved estimate on this booking yet — save the estimate first, then send the approval link.');
      error.status = 409;
      error.code = 'no_estimate';
      throw error;
    }
    const issued = await issueEstimateApprovalLink(booking, { createdBy: sentBy });
    return {
      url: issued.url,
      booking,
      estimateId: issued.estimateId,
      estimateTotalCents: issued.estimateTotalCents,
      expiresAt: issued.expiresAt,
    };
  }
  const checkout = await diagnosticCheckoutUrl(booking);
  return { url: checkout.url, booking, paymentId: checkout.paymentId, reused: checkout.reused };
}

function firstNameOf(name) {
  const first = String(name || '').trim().split(/\s+/)[0];
  return first || 'there';
}

/**
 * Message copy per link type + channel, in the platform's voice:
 * short, branded, one action link, the business phone. Prices appear
 * only where the platform's own payment copy already states them
 * (the $99 diagnostic terms, from PLATFORM_CONSTANTS.feeTerms).
 */
export function composeLinkMessage({ linkType, channel, recipientName = null, url, booking = null }) {
  const first = firstNameOf(recipientName);
  const phone = PLATFORM_CONSTANTS.phoneDisplay;
  const isEmail = channel === 'email';
  const signOff = `\n\n— Top Speed Appliance · ${PLATFORM_CONSTANTS.slogan}`;
  switch (linkType) {
    case LINK_TYPES.BOOKING:
      return isEmail
        ? {
            subject: 'Book your appliance repair — Top Speed Appliance',
            message:
              `Hi ${first},\n\n` +
              `Here is your link to book a repair with Top Speed Appliance:\n${url}\n\n` +
              `Pick your service and a window that suits you — a Service Setter confirms every booking personally. ` +
              `Questions? Call ${phone}.${signOff}`,
          }
        : {
            subject: null,
            message: `Top Speed Appliance: book your repair here: ${url} Questions? Call ${phone}.`,
          };
    case LINK_TYPES.ACCOUNT:
      return isEmail
        ? {
            subject: 'Your Top Speed Appliance account',
            message:
              `Hi ${first},\n\n` +
              `Here is your link to sign in — or create your free account:\n${url}\n\n` +
              `With an account you can book service, track your technician live, and keep your appliances and service history in one place. ` +
              `Questions? Call ${phone}.${signOff}`,
          }
        : {
            subject: null,
            message: `Top Speed Appliance: sign in or create your account here: ${url} Questions? Call ${phone}.`,
          };
    case LINK_TYPES.REVIEW:
      return isEmail
        ? {
            subject: 'How did we do? — Top Speed Appliance',
            message:
              `Hi ${first},\n\n` +
              `Thanks for choosing Top Speed Appliance. If we earned it, a review helps neighbors find us — ` +
              `you can read reviews and post yours here:\n${url}\n\n` +
              `And if anything is not right, call ${phone} and we will make it right.${signOff}`,
          }
        : {
            subject: null,
            message: `Top Speed Appliance: thanks for choosing us! Review your visit here: ${url} Anything not right? Call ${phone}.`,
          };
    case LINK_TYPES.ESTIMATE: {
      const ref = booking?.referenceCode || '';
      const estimate = booking ? latestEstimate(booking) : null;
      const total = estimate ? `$${(estimate.totalCents / 100).toFixed(2)}` : null;
      return isEmail
        ? {
            subject: `Your written estimate is ready — booking ${ref} · Top Speed Appliance`,
            message:
              `Hi ${first},\n\n` +
              `Your written estimate for booking ${ref}${total ? ` — total ${total}` : ''} is ready to review:\n${url}\n\n` +
              `The page shows every line exactly as quoted. You can approve it there, or decline it and tell us why — ` +
              `no work ever begins without your approval. The link stays open for ${ESTIMATE_APPROVAL_TTL_LABEL}. ` +
              `Questions? Call ${phone}.${signOff}`,
          }
        : {
            subject: null,
            message: `Top Speed Appliance: your written estimate for booking ${ref}${total ? ` (total ${total})` : ''} is ready — review and approve it here: ${url} No work begins without your approval. Questions? Call ${phone}.`,
          };
    }
    case LINK_TYPES.PAYMENT: {
      const ref = booking?.referenceCode || '';
      return isEmail
        ? {
            subject: `Pay your $99 diagnostic — booking ${ref} · Top Speed Appliance`,
            message:
              `Hi ${first},\n\n` +
              `Here is the secure payment link for your booking ${ref}:\n${url}\n\n` +
              `${PLATFORM_CONSTANTS.feeTerms} Paying online holds your appointment — a Service Setter confirms your window. ` +
              `Questions? Call ${phone}.${signOff}`,
          }
        : {
            subject: null,
            message: `Top Speed Appliance: pay your $99 diagnostic for booking ${ref} here: ${url} It is credited toward your repair. Questions? Call ${phone}.`,
          };
    }
    default:
      return { subject: null, message: `Top Speed Appliance: ${url} Questions? Call ${phone}.` };
  }
}
