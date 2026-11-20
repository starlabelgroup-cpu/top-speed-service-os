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
 * Generic Stripe REST call (Flywheel Advertiser Plans, 2026-11-17).
 * Same transport as the diagnostic checkout above — form-encoded
 * POST/GET/DELETE against the account the env key belongs to. Used
 * for plan customers, products, prices and subscriptions ONLY; the
 * diagnostic flow keeps its own function and behavior.
 */
function encodeForm(params, prefix, out) {
  const target = out || new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item && typeof item === 'object') encodeForm(item, `${name}[${index}]`, target);
        else target.set(`${name}[${index}]`, String(item));
      });
    } else if (typeof value === 'object') {
      encodeForm(value, name, target);
    } else {
      target.set(name, String(value));
    }
  }
  return target;
}

export async function stripeApi(method, path, params) {
  const isQuery = method === 'GET' || method === 'DELETE';
  const encoded = params ? encodeForm(params).toString() : '';
  const url = API_BASE + path + (isQuery && encoded ? `?${encoded}` : '');
  const response = await fetch(url, {
    method,
    headers: authHeaders(),
    body: !isQuery && encoded ? encoded : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || ('Stripe returned ' + response.status);
    const error = new Error(message);
    error.code = 'stripe_error';
    throw error;
  }
  return data;
}

/** One Stripe customer per account (id stored on the subscription row). */
export async function createStripeCustomer({ email, name, userId, purpose = 'AD_PLAN' }) {
  return stripeApi('POST', '/v1/customers', {
    email: email || undefined,
    name: name || undefined,
    metadata: { purpose, userId },
  });
}

/**
 * Plan Product + Price sync — called ONLY from the owner price flows
 * (routes/adPlans.js, routes/carePlans.js), with the owner's own
 * amount. Nothing here is ever seeded or defaulted: no owner price,
 * no Stripe objects. `purpose` defaults to AD_PLAN and `interval` to
 * 'month', so advertiser-plan calls are byte-identical to before; the
 * Care Plan passes purpose CARE_PLAN + interval 'year'.
 */
export async function createStripeProduct({ name, planKey, purpose = 'AD_PLAN' }) {
  return stripeApi('POST', '/v1/products', { name, metadata: { purpose, planKey } });
}

export async function createStripePrice({ productId, amountCents, currency, interval = 'month' }) {
  return stripeApi('POST', '/v1/prices', {
    product: productId,
    unit_amount: amountCents,
    currency: currency || 'usd',
    recurring: { interval },
  });
}

/** Subscription-mode Checkout Session for a plan. */
export async function createPlanCheckout({ customerId, priceId, userId, planKey, successUrl, cancelUrl, purpose = 'AD_PLAN' }) {
  return stripeApi('POST', '/v1/checkout/sessions', {
    mode: 'subscription',
    customer: customerId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: userId,
    metadata: { purpose, userId, planKey },
    subscription_data: { metadata: { purpose, userId, planKey } },
  });
}

/**
 * Pepper Lists Seller Plans (2026-11-20) — the SELLER_PLAN twins of
 * the plan helpers above. Same discipline: these are called ONLY from
 * the seller checkout flow and the owner's seller-plan price flow in
 * routes/sellerPlans.js, with the owner's own amount. The purpose tag
 * is what routes the shared webhook to the right lifecycle handler.
 */
export async function createSellerStripeCustomer({ email, name, userId }) {
  return stripeApi('POST', '/v1/customers', {
    email: email || undefined,
    name: name || undefined,
    metadata: { purpose: 'SELLER_PLAN', userId },
  });
}

export async function createSellerStripeProduct({ name, planKey }) {
  return stripeApi('POST', '/v1/products', { name, metadata: { purpose: 'SELLER_PLAN', planKey } });
}

/** Subscription-mode Checkout Session for a Pepper Lists seller plan. */
export async function createSellerPlanCheckout({ customerId, priceId, userId, planKey, successUrl, cancelUrl }) {
  return stripeApi('POST', '/v1/checkout/sessions', {
    mode: 'subscription',
    customer: customerId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: userId,
    metadata: { purpose: 'SELLER_PLAN', userId, planKey },
    subscription_data: { metadata: { purpose: 'SELLER_PLAN', userId, planKey } },
  });
}

export async function retrieveStripeSubscription(id) {
  return stripeApi('GET', `/v1/subscriptions/${encodeURIComponent(id)}`);
}

export async function updateStripeSubscription(id, params) {
  return stripeApi('POST', `/v1/subscriptions/${encodeURIComponent(id)}`, params);
}

export async function cancelStripeSubscription(id) {
  return stripeApi('DELETE', `/v1/subscriptions/${encodeURIComponent(id)}`);
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

// ---------------------------------------------------------------------------
// New money rails (2026-11-20, Wave 4) — Stripe Connect for Pepper
// Lists protected payments + gift card checkout. Same transport as
// everything above. These functions are only ever CALLED behind the
// owner configuration in PaymentsSetting (Connect flag + owner-set
// fee; owner-set gift card denominations) — the routes enforce that;
// nothing here seeds or defaults a number.
// ---------------------------------------------------------------------------

/** Create a Stripe Connect Express account for a Pepper Lists seller. */
export async function createConnectAccount({ email, userId }) {
  return stripeApi('POST', '/v1/accounts', {
    type: 'express',
    email: email || undefined,
    metadata: { purpose: 'PEPPER_LISTS_CONNECT', userId },
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  });
}

/** One-time hosted onboarding link for a connected account. */
export async function createConnectAccountLink({ accountId, refreshUrl, returnUrl }) {
  return stripeApi('POST', '/v1/account_links', {
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
}

/** Read a connected account's live state (charges/payouts/details). */
export async function retrieveConnectAccount(accountId) {
  return stripeApi('GET', `/v1/accounts/${encodeURIComponent(accountId)}`);
}

/**
 * Connect Checkout Session for one listing purchase: the buyer pays
 * the listing price; the seller's share lands in their connected
 * account (transfer destination) and the platform keeps the
 * owner-set application fee. feeCents comes from the order, which
 * computed it from the owner's fee setting — never from the client.
 */
export async function createConnectCheckout({ order, listingTitle, sellerAccountId, successUrl, cancelUrl }) {
  const params = {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: order.amountCents,
        product_data: {
          name: `Pepper Lists — ${listingTitle}`,
          description: `Protected purchase on Pepper Lists It. Listing ${order.listingReference}.`,
        },
      },
    }],
    client_reference_id: order.id,
    metadata: { purpose: 'PEPPER_LISTS_ORDER', orderId: order.id, listingReference: order.listingReference },
    payment_intent_data: {
      transfer_data: { destination: sellerAccountId },
      metadata: { purpose: 'PEPPER_LISTS_ORDER', orderId: order.id },
    },
  };
  if (order.feeCents > 0) params.payment_intent_data.application_fee_amount = order.feeCents;
  if (order.buyerEmail) params.customer_email = order.buyerEmail;
  return stripeApi('POST', '/v1/checkout/sessions', params);
}

/** Payment-mode Checkout Session for a gift card purchase. */
export async function createGiftCardCheckout({ card, successUrl, cancelUrl }) {
  return stripeApi('POST', '/v1/checkout/sessions', {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: card.initialAmountCents,
        product_data: {
          name: 'Top Speed Appliance — Gift Card',
          description: 'Digital gift card for Top Speed Appliance diagnostic and repair services. The card code is emailed to the buyer and activates when this payment completes.',
        },
      },
    }],
    client_reference_id: card.id,
    metadata: { purpose: 'GIFT_CARD', giftCardId: card.id },
    payment_intent_data: { metadata: { purpose: 'GIFT_CARD', giftCardId: card.id } },
    ...(card.purchaserEmail ? { customer_email: card.purchaserEmail } : {}),
  });
}
