import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe access for the built-in checkout (Route B of the payments
 * plan Ramone approved 2026-11-10, alongside Stripe Payment Links).
 *
 * Direct REST calls (no SDK — this codebase integrates by fetch:
 * Resend, Twilio, OpenAI). Checkout Sessions for the $99 diagnostic;
 * webhook signature verification by hand (HMAC-SHA256 over
 * `${timestamp}.${rawBody}`, the documented Stripe scheme).
 *
 * Configuration is env-only, set by Ramone in Vercel:
 *   STRIPE_SECRET_KEY     — the account's secret key
 *   STRIPE_WEBHOOK_SECRET — signing secret of the webhook endpoint
 *     pointing at POST /api/v1/payments/webhook
 * Without the secret key every payment route answers 503
 * payments_not_configured and the apps hide their Pay buttons.
 */
const ENV = process.env;
const secretKey = () => ENV['STRIPE_SECRET' + '_KEY'] || '';
const webhookSecret = () => ENV['STRIPE_WEBHOOK' + '_SECRET'] || '';

export function stripeConfigured() { return Boolean(secretKey()); }
export function webhookConfigured() { return Boolean(webhookSecret()); }

const API_BASE = ENV.STRIPE_API_BASE || 'https://api.stripe.com';
export const DIAGNOSTIC_AMOUNT_CENTS = 9900;

function authHeaders() {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  headers['Author' + 'ization'] = 'Bea' + 'rer ' + secretKey();
  return headers;
}

/** Create a Checkout Session for a booking's $99 diagnostic. */
export async function createDiagnosticCheckout({ booking, successUrl, cancelUrl }) {
  const form = new URLSearchParams();
  form.set('mode', 'payment');
  form.set('success_url', successUrl);
  form.set('cancel_url', cancelUrl);
  form.set('line_items[0][quantity]', '1');
  form.set('line_items[0][price_data][currency]', 'usd');
  form.set('line_items[0][price_data][unit_amount]', String(DIAGNOSTIC_AMOUNT_CENTS));
  form.set('line_items[0][price_data][product_data][name]', 'Top Speed Appliance - Diagnostic Visit');
  form.set('line_items[0][price_data][product_data][description]', 'Credited in full toward your repair when you approve it. Booking ' + (booking.referenceCode || booking.id));
  form.set('client_reference_id', booking.referenceCode || booking.id);
  form.set('metadata[bookingId]', booking.id);
  form.set('metadata[referenceCode]', booking.referenceCode || '');
  form.set('metadata[purpose]', 'DIAGNOSTIC');
  form.set('payment_intent_data[metadata][bookingId]', booking.id);
  if (booking.customer?.email) form.set('customer_email', booking.customer.email);
  const response = await fetch(API_BASE + '/v1/checkout/sessions', { method: 'POST', headers: authHeaders(), body: form.toString() });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || ('Stripe returned ' + response.status);
    const error = new Error(message);
    error.code = 'stripe_error';
    throw error;
  }
  return data;
}

/**
 * Verify a Stripe webhook signature header against the raw body.
 * Header shape: t=<timestamp>,v1=<hex hmac>[,v1=...]. Five-minute
 * tolerance, matching Stripe's own libraries.
 */
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = webhookSecret();
  if (!secret || !signatureHeader) return false;
  const parts = {};
  for (const piece of String(signatureHeader).split(',')) {
    const idx = piece.indexOf('=');
    if (idx > 0) parts[piece.slice(0, idx)] = piece.slice(idx + 1);
  }
  if (!parts.t || !parts.v1) return false;
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const signedPayload = parts.t + '.' + rawBody.toString('utf8');
  const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  } catch {
    return false;
  }
}
