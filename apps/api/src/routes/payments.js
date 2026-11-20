import { Router } from 'express';
import { z } from 'zod';
import { addBookingEvent, appendEvent, createId, store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { findPaymentBySessionId, latestPaymentForBooking, persistPayment } from '../db/paymentsRepo.js';
import { NOTIFICATION_TEMPLATES, queueNotification } from '../services/notifications.js';
import { emitReport } from '../services/managementReports.js';
import { DIAGNOSTIC_AMOUNT_CENTS, createDiagnosticCheckout, stripeConfigured, verifyWebhookSignature, webhookConfigured } from '../services/stripe.js';
import { handleStripePlanEvent } from '../services/adPlans.js';
import { handleStripeCarePlanEvent } from '../services/carePlans.js';
import { handleStripeMarketplaceEvent } from '../services/marketplacePayments.js';
import { handleStripeSellerPlanEvent } from '../services/sellerPlans.js';
import {
  beginCardSetup,
  bookingBelongsToAccount,
  cardOnFileEligibility,
  chargeInvoiceToCard,
  createInvoiceCheckout,
  deleteStoredCard,
  findAccountUserById,
  getStoredCardView,
  handleCardOnFileEvent,
  invoiceAutoPayState,
  payOverTimeAvailableFor,
  payOverTimeConfig,
  recordInvoiceReceipt,
  setAutoPayEnabled,
  setInvoiceAutoPayApproval,
} from '../services/cardPayments.js';

/**
 * Payments — the built-in checkout (Route B, approved by Ramone
 * 2026-11-10 alongside Stripe Payment Links).
 *
 * Flow: a booking exists → the customer (from the app) or a Service
 * Setter (from Book OS, to text the link) requests a diagnostic
 * checkout → Stripe hosts the card page → Stripe's webhook flips the
 * Payment to PAID → the booking shows the paid state everywhere and
 * the customer gets a receipt through the notification outbox.
 *
 * Card data never touches this server — Stripe hosts the page, and
 * the webhook is signature-verified before it can change anything.
 */
const router = Router();

const checkoutSchema = z.object({ bookingId: z.string().min(1) });

const APP_BASE = process.env.PUBLIC_WEB_BASE || 'https://topspeedserviceos.com';

router.get('/payments/status', (req, res) => {
  return res.json({ data: { configured: stripeConfigured(), webhookConfigured: webhookConfigured(), diagnosticAmountCents: DIAGNOSTIC_AMOUNT_CENTS } });
});

router.post('/payments/diagnostic/checkout', authenticate, requireCompany, async (req, res, next) => {
  try {
    if (!stripeConfigured()) {
      return res.status(503).json({ error: 'payments_not_configured', hint: 'Stripe keys are not set on the API yet.' });
    }
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid checkout request' });
    const booking = store.bookings.get(parsed.data.bookingId);
    if (!booking || booking.companyId !== req.companyId) return res.status(404).json({ error: 'Booking not found' });

    const roles = req.user?.roles || [];
    const isStaff = roles.some((role) => STAFF_ROLES.includes(role));
    const isOwningCustomer = roles.includes(ROLES.CUSTOMER)
      && booking.customer?.email
      && req.user?.email
      && booking.customer.email.toLowerCase() === req.user.email.toLowerCase();
    if (!isStaff && !isOwningCustomer) return res.status(403).json({ error: 'This booking belongs to a different account' });

    // Reuse a live pending session instead of minting duplicates.
    const existing = latestPaymentForBooking(booking.id);
    if (existing && existing.status === 'PENDING' && existing.checkoutUrl
      && Date.now() - new Date(existing.createdAt).getTime() < 23 * 60 * 60 * 1000) {
      return res.json({ data: { url: existing.checkoutUrl, paymentId: existing.id, reused: true } });
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
      source: booking.source || null,
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
      source: booking.source || null,
      reference: booking.referenceCode || null,
      eventKey: `payment:${payment.id}:checkout:report`,
    });
    return res.status(201).json({ data: { url: session.url, paymentId: payment.id } });
  } catch (error) {
    if (error?.code === 'stripe_error') return res.status(502).json({ error: 'stripe_error', message: error.message });
    return next(error);
  }
});

/**
 * Stripe webhook. The raw-body parser for this exact path is mounted
 * in server.js BEFORE the JSON parser — signature verification needs
 * the untouched bytes.
 */
/* ---------- Invoice checkout + pay over time (2026-11-20, F4) ----------
 * A customer (or staff, for a phone order) pays the balance due on a
 * job invoice through Stripe Checkout. The amount is always the
 * server-side balance due from jobMoney — never a client figure.
 * Pay over time (card installments) is surfaced ONLY when the owner
 * has configured PAY_OVER_TIME_MIN_CENTS and this invoice qualifies;
 * the response says plainly whether it was offered. */

const invoiceCheckoutSchema = z.object({ bookingId: z.string().min(1) });

router.post('/payments/invoice/checkout', authenticate, requireCompany, async (req, res, next) => {
  try {
    if (!stripeConfigured()) {
      return res.status(503).json({ error: 'Online payments are not configured yet' });
    }
    const parsed = invoiceCheckoutSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid invoice payment request', details: parsed.error.flatten() });
    }
    const booking = store.bookings.get(parsed.data.bookingId);
    if (!booking || booking.companyId !== req.user.companyId) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    const isStaff = STAFF_ROLES.includes(req.user.roles?.[0]);
    if (!isStaff && !bookingBelongsToAccount(booking, req.user)) {
      return res.status(403).json({ error: 'You can only pay invoices for your own bookings' });
    }

    const latest = latestPaymentForBooking(booking.id);
    if (latest && latest.purpose === 'INVOICE' && latest.status === 'PENDING' && latest.checkoutUrl
      && Date.now() - new Date(latest.createdAt).getTime() < 23 * 60 * 60 * 1000) {
      return res.json({
        data: {
          url: latest.checkoutUrl,
          paymentId: latest.id,
          amountCents: latest.amountCents,
          payOverTimeAvailable: payOverTimeAvailableFor(latest.amountCents),
          payOverTimeThresholdConfigured: payOverTimeConfig().enabled,
        },
      });
    }

    const { session, amountCents, payOverTimeAvailable } = await createInvoiceCheckout({
      booking,
      successUrl: `${APP_BASE}/app?payment=success&booking=${encodeURIComponent(booking.id)}`,
      cancelUrl: `${APP_BASE}/app?payment=cancelled&booking=${encodeURIComponent(booking.id)}`,
    });
    const payment = {
      id: createId(),
      companyId: booking.companyId,
      bookingId: booking.id,
      customerId: booking.customerId ?? null,
      purpose: 'INVOICE',
      amountCents,
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
    await persistPayment(payment);
    addBookingEvent(booking, 'INVOICE_CHECKOUT_STARTED', req.user.email || 'customer', { amountCents, payOverTimeAvailable });
    await appendEvent('INVOICE_CHECKOUT_STARTED', {
      source: 'api',
      actor: isStaff ? 'staff' : 'customer',
      entityType: 'PAYMENT',
      entityId: payment.id,
      referenceCode: booking.referenceCode || null,
      details: { bookingId: booking.id, amountCents, payOverTimeAvailable },
    });
    return res.status(201).json({
      data: {
        url: session.url,
        paymentId: payment.id,
        amountCents,
        payOverTimeAvailable,
        payOverTimeThresholdConfigured: payOverTimeConfig().enabled,
      },
    });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    return next(error);
  }
});

/* ---------- Card on file + auto-pay (2026-11-20, F5) ----------
 * Business and property-manager accounts only. The card itself is
 * collected on Stripe's hosted setup page; this API only ever sees
 * the brand and last four. Charging additionally requires the
 * account's standing auto-pay opt-in AND a per-invoice approval from
 * the account holder — both gates are enforced in the service. */

router.get('/payments/card-on-file', authenticate, async (req, res, next) => {
  try {
    const account = await findAccountUserById(req.user.id);
    const eligible = cardOnFileEligibility(account);
    return res.json({
      data: {
        eligible,
        card: eligible ? await getStoredCardView(req.user.id) : null,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/payments/card-on-file/setup', authenticate, async (req, res, next) => {
  try {
    if (!stripeConfigured()) {
      return res.status(503).json({ error: 'Online payments are not configured yet' });
    }
    const account = await findAccountUserById(req.user.id);
    if (!cardOnFileEligibility(account)) {
      return res.status(403).json({ error: 'Card on file is available to business and property-manager accounts.', code: 'NOT_BUSINESS_ACCOUNT' });
    }
    const { url } = await beginCardSetup(account);
    return res.json({ data: { url } });
  } catch (error) {
    return next(error);
  }
});

const autoPayToggleSchema = z.object({ enabled: z.boolean() });

router.post('/payments/card-on-file/autopay', authenticate, async (req, res, next) => {
  try {
    const parsed = autoPayToggleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid auto-pay request', details: parsed.error.flatten() });
    }
    const updated = await setAutoPayEnabled(req.user.id, parsed.data.enabled);
    if (!updated) {
      return res.status(409).json({ error: 'Save a card first — auto-pay needs a card on file.', code: 'NO_CARD_ON_FILE' });
    }
    return res.json({ data: { autoPayEnabled: parsed.data.enabled } });
  } catch (error) {
    return next(error);
  }
});

router.delete('/payments/card-on-file', authenticate, async (req, res, next) => {
  try {
    const removed = await deleteStoredCard(req.user.id);
    if (!removed) return res.status(404).json({ error: 'No card on file' });
    return res.json({ data: { removed: true } });
  } catch (error) {
    return next(error);
  }
});

const autoPayApprovalSchema = z.object({ approved: z.boolean() });

router.post('/payments/invoice/:bookingId/autopay-approval', authenticate, async (req, res, next) => {
  try {
    const parsed = autoPayApprovalSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid approval request', details: parsed.error.flatten() });
    }
    const booking = store.bookings.get(req.params.bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    // The approval is the account holder's own say-so — staff cannot
    // grant it on the customer's behalf.
    if (!bookingBelongsToAccount(booking, req.user)) {
      return res.status(403).json({ error: 'Only the account holder can approve auto-pay for this invoice.' });
    }
    const state = await setInvoiceAutoPayApproval(booking, req.user, parsed.data.approved);
    return res.json({ data: { bookingId: booking.id, autoPayApproval: state } });
  } catch (error) {
    return next(error);
  }
});

const autoPayChargeSchema = z.object({ bookingId: z.string().min(1) });

router.post('/payments/invoice/autopay-charge', authenticate, async (req, res, next) => {
  try {
    if (!stripeConfigured()) {
      return res.status(503).json({ error: 'Online payments are not configured yet' });
    }
    const parsed = autoPayChargeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid auto-pay charge request', details: parsed.error.flatten() });
    }
    const booking = store.bookings.get(parsed.data.bookingId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    const isStaff = STAFF_ROLES.includes(req.user.roles?.[0]);
    if (!isStaff && !bookingBelongsToAccount(booking, req.user)) {
      return res.status(403).json({ error: 'You can only charge invoices for your own bookings' });
    }
    const { payment, receipt } = await chargeInvoiceToCard({
      booking,
      actor: isStaff ? req.user.email || 'staff' : 'customer',
    });
    return res.json({
      data: {
        paymentId: payment.id,
        amountCents: payment.amountCents,
        status: payment.status,
        receiptApplied: receipt.ok === true,
        autoPayApproval: invoiceAutoPayState(booking),
      },
    });
  } catch (error) {
    if (error?.status) return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    return next(error);
  }
});

router.post('/payments/webhook', async (req, res) => {
  if (!webhookConfigured()) return res.status(400).json({ error: 'webhook_not_configured' });
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!verifyWebhookSignature(rawBody, req.headers['stripe-signature'])) {
    return res.status(400).json({ error: 'invalid_signature' });
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  try {
    const session = event?.data?.object || {};
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.expired') {
      const payment = findPaymentBySessionId(session.id);
      if (payment) {
        if (event.type === 'checkout.session.completed' && payment.status !== 'PAID') {
          payment.status = 'PAID';
          payment.paidAt = new Date().toISOString();
          payment.stripePaymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : payment.stripePaymentIntentId;
          payment.updatedAt = payment.paidAt;
          await persistPayment(payment).catch((error) => console.error(JSON.stringify({ level: 'error', message: 'payment persist failed', error: String(error?.message || error) })));
          const booking = store.bookings.get(payment.bookingId);
          if (booking) {
            addBookingEvent(booking, 'PAYMENT_RECEIVED', 'Stripe webhook', { amountCents: payment.amountCents, purpose: payment.purpose });
            await appendEvent('PAYMENT_RECEIVED', {
              source: booking.source || null,
              entityType: 'PAYMENT',
              entityId: payment.id,
              referenceCode: booking.referenceCode || null,
              details: { bookingId: booking.id, amountCents: payment.amountCents },
            });
            // Invoice payments (F4/F5) land on the job's money record
            // through the canonical receipt path; diagnostic payments
            // keep their original handling.
            if (payment.purpose === 'INVOICE') {
              await recordInvoiceReceipt(payment, booking);
            }
            const firstName = (booking.customer?.name || 'there').split(' ')[0];
            const message = payment.purpose === 'INVOICE'
              ? 'Hi ' + firstName + ' — payment received: $' + (payment.amountCents / 100).toFixed(2) + ' toward the invoice for booking ' + (booking.referenceCode || '') + '. Thank you! — Top Speed Appliance. Track your visit: https://topspeedserviceos.com/track'
              : 'Hi ' + firstName + ' — payment received: $99 diagnostic for booking ' + (booking.referenceCode || '') + '. It is credited in full toward your repair when you approve it. Thank you! — Top Speed Appliance. Track your visit: https://topspeedserviceos.com/track';
            emitReport({
              department: 'billing',
              type: 'PAYMENT_RECEIVED',
              title: `Payment received — ${booking.referenceCode || booking.id}`,
              detail: { paymentId: payment.id, bookingId: booking.id, bookingReference: booking.referenceCode || null, customerName: booking.customer?.name || null, amountCents: payment.amountCents, purpose: payment.purpose, paidAt: payment.paidAt },
              source: booking.source || null,
              reference: booking.referenceCode || null,
              eventKey: `payment:${payment.id}:received:report`,
            });
            if (booking.customer?.phone) queueNotification({ channel: 'sms', template: NOTIFICATION_TEMPLATES.PAYMENT_RECEIVED, to: booking.customer.phone, payload: { message, bookingId: booking.id }, source: booking.source || null, eventKey: `payment:${payment.id}:received:sms`, eventType: 'PAYMENT' });
            if (booking.customer?.email) queueNotification({ channel: 'email', template: NOTIFICATION_TEMPLATES.PAYMENT_RECEIVED, to: booking.customer.email, payload: { message, bookingId: booking.id }, source: booking.source || null, eventKey: `payment:${payment.id}:received:email`, eventType: 'PAYMENT' });
          }
        } else if (event.type === 'checkout.session.expired' && payment.status === 'PENDING') {
          payment.status = 'EXPIRED';
          payment.updatedAt = new Date().toISOString();
          await persistPayment(payment).catch(() => {});
          emitReport({
            department: 'billing',
            type: 'PAYMENT_CHECKOUT_EXPIRED',
            title: `Diagnostic checkout expired — payment ${payment.id}`,
            detail: { paymentId: payment.id, bookingId: payment.bookingId, amountCents: payment.amountCents, purpose: payment.purpose },
            reference: null,
            eventKey: `payment:${payment.id}:expired:report`,
          });
        }
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'payment webhook handling failed', error: String(error?.message || error) }));
  }

  // Flywheel Advertiser Plans (2026-11-17): subscription lifecycle
  // events (plan checkouts, subscription updates/deletes, failed
  // invoices) are handled by the plans service. It runs AFTER the
  // diagnostic handling above, never throws, and plan checkout
  // sessions have no diagnostic Payment row — the two flows share
  // only the endpoint and the signature check.
  await handleStripePlanEvent(event);
  // Appliance Care Plan (2026-11-20): membership subscription
  // lifecycle, same discipline — runs after the diagnostic and
  // advertiser-plan handling, never throws, and answers only
  // purpose CARE_PLAN checkouts / its own subscription ids.
  await handleStripeCarePlanEvent(event);
  // Card-on-file setup sessions (F5, 2026-11-20) ride the same
  // endpoint: mode=setup with the CARD_ON_FILE purpose stores the
  // card for its account. The handler never throws.
  await handleCardOnFileEvent(event);

  // Pepper Lists Seller Plans (2026-11-20): same lane discipline —
  // this handler only acts on metadata purpose SELLER_PLAN, runs
  // after the diagnostic and advertiser handling above, and never
  // throws (it logs and returns instead).
  await handleStripeSellerPlanEvent(event);

  // New money rails (2026-11-20): Pepper Lists Connect orders +
  // gift cards. Runs LAST, never throws, and its sessions are told
  // apart by metadata purpose — diagnostic sessions carry purpose
  // DIAGNOSTIC and plan sessions AD_PLAN, so the flows share only
  // the endpoint and the signature check.
  await handleStripeMarketplaceEvent(event);
  return res.json({ received: true });
});

export default router;
