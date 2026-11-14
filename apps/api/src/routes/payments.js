import { Router } from 'express';
import { z } from 'zod';
import { addBookingEvent, appendEvent, createId, store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import { findPaymentBySessionId, latestPaymentForBooking, persistPayment } from '../db/paymentsRepo.js';
import { NOTIFICATION_TEMPLATES, queueNotification } from '../services/notifications.js';
import { emitReport } from '../services/managementReports.js';
import { DIAGNOSTIC_AMOUNT_CENTS, createDiagnosticCheckout, stripeConfigured, verifyWebhookSignature, webhookConfigured } from '../services/stripe.js';

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
    appendEvent('PAYMENT_CHECKOUT_CREATED', {
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
            appendEvent('PAYMENT_RECEIVED', {
              source: booking.source || null,
              entityType: 'PAYMENT',
              entityId: payment.id,
              referenceCode: booking.referenceCode || null,
              details: { bookingId: booking.id, amountCents: payment.amountCents },
            });
            const firstName = (booking.customer?.name || 'there').split(' ')[0];
            const message = 'Hi ' + firstName + ' — payment received: $99 diagnostic for booking ' + (booking.referenceCode || '') + '. It is credited in full toward your repair when you approve it. Thank you! — Top Speed Appliance';
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
  return res.json({ received: true });
});

export default router;
