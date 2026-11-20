import { createHash, randomInt } from 'node:crypto';
import { appendEvent, store } from '../data/store.js';
import {
  addLedgerEntry, getGiftCardBySessionId, getOrderBySessionId, updateGiftCard, updateOrder,
} from '../db/paymentsRailsRepo.js';
import { emitReport } from './managementReports.js';
import { NOTIFICATION_TEMPLATES, queueNotification } from './notifications.js';

/**
 * New money rails — shared logic (2026-11-20, Wave 4).
 *
 * Two features, one honesty rule (the advertiser-plans rule): the
 * machinery is built first and money moves only behind OWNER
 * configuration — Stripe Connect activation + the application fee
 * for Pepper Lists protected payments, and the denomination list
 * for gift cards. This file holds the pieces both the routes and
 * the Stripe webhook need: gift card codes (hash-only at rest, the
 * password-reset discipline), the fee math (integer cents, computed
 * server-side from the owner's basis points — never from a client),
 * and the webhook lifecycle for Connect orders + gift cards.
 *
 * The webhook handler is called from routes/payments.js AFTER the
 * diagnostic handling and the advertiser-plan handling. It never
 * throws: billing noise on the new rails must not break the
 * diagnostic webhook it shares the endpoint with.
 */

// ---------------------------------------------------------------------------
// Gift card codes
// ---------------------------------------------------------------------------

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L lookalikes

/** A fresh raw code, shown to the buyer exactly once. Never stored. */
export function generateGiftCardCode() {
  const group = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  return `TSGC-${group()}-${group()}-${group()}`;
}

/** Canonical form for hashing: uppercase, alphanumerics only. */
export function normalizeGiftCardCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashGiftCardCode(code) {
  return createHash('sha256').update(normalizeGiftCardCode(code)).digest('hex');
}

export function giftCardLast4(code) {
  const canonical = normalizeGiftCardCode(code);
  return canonical.slice(-4);
}

// ---------------------------------------------------------------------------
// Fee math
// ---------------------------------------------------------------------------

/**
 * The platform application fee for a protected purchase: the
 * owner's basis points of the listing price, rounded to the nearest
 * cent, in integer cents. feeBps NULL (owner has not set a fee) is
 * NOT zero — the routes refuse checkout with pricing_not_set before
 * this is ever called with a null.
 */
export function computeFeeCents(amountCents, feeBps) {
  if (!Number.isInteger(feeBps) || feeBps < 0) return 0;
  return Math.round((amountCents * feeBps) / 10000);
}

// ---------------------------------------------------------------------------
// Notifications (outbox — the code email is composed at purchase
// time in the route, where the raw code exists; the webhook only
// ever sends code-free follow-ups referencing the last four).
// ---------------------------------------------------------------------------

function emailUser(userId, template, payload, eventKey, eventType) {
  const user = userId ? store.users.get(userId) : null;
  const to = payload.to || user?.email || null;
  if (!to) return;
  queueNotification({
    channel: 'email', template, to,
    payload: { subject: payload.subject, message: payload.message },
    source: 'marketplace-payments', eventKey, eventType,
  });
}

// ---------------------------------------------------------------------------
// Stripe webhook lifecycle for the new rails.
// ---------------------------------------------------------------------------

async function onOrderCheckoutCompleted(session) {
  const order = await getOrderBySessionId(session.id);
  if (!order || order.status === 'PAID') return;
  const paidAt = new Date().toISOString();
  const updated = await updateOrder(order.id, {
    status: 'PAID',
    paidAt,
    stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : order.stripePaymentIntentId,
  });
  await appendEvent('PEPPER_LISTS_ORDER_PAID', {
    source: 'stripe-webhook', entityType: 'PEPPER_LISTS_ORDER', entityId: order.id,
    referenceCode: order.listingReference,
    details: { amountCents: order.amountCents, feeCents: order.feeCents, sellerUserId: order.sellerUserId },
  });
  emitReport({
    department: 'billing', type: 'PEPPER_LISTS_ORDER_PAID',
    title: `Pepper Lists protected purchase paid — listing ${order.listingReference}`,
    detail: { orderId: order.id, listingReference: order.listingReference, amountCents: order.amountCents, feeCents: order.feeCents, sellerUserId: order.sellerUserId, buyerUserId: order.buyerUserId },
    source: 'stripe-webhook', reference: order.listingReference,
    eventKey: `pl-order:${order.id}:paid:report`,
  });
  const dollars = (order.amountCents / 100).toFixed(2);
  emailUser(order.buyerUserId, NOTIFICATION_TEMPLATES.PEPPER_LISTS_ORDER_PAID, {
    to: order.buyerEmail || undefined,
    subject: `Your Pepper Lists purchase is confirmed — ${order.listingReference}`,
    message: `Hi — your protected payment of $${dollars} for listing ${order.listingReference} on Pepper Lists It is confirmed. The seller has been notified; coordinate the handover with them through Pepper Lists. Thank you! — Top Speed Appliance.`,
  }, `pl-order:${order.id}:paid:buyer`, 'PAYMENT');
  emailUser(order.sellerUserId, NOTIFICATION_TEMPLATES.PEPPER_LISTS_ORDER_PAID, {
    subject: `Your Pepper Lists item sold — ${order.listingReference}`,
    message: `Good news — your listing ${order.listingReference} on Pepper Lists It just sold through protected payment ($${dollars}). Your share is on its way to your connected payout account. Coordinate the handover with the buyer through Pepper Lists. — Top Speed Appliance.`,
  }, `pl-order:${order.id}:paid:seller`, 'PAYMENT');
  return updated;
}

async function onOrderCheckoutExpired(session) {
  const order = await getOrderBySessionId(session.id);
  if (!order || order.status !== 'PENDING') return;
  await updateOrder(order.id, { status: 'EXPIRED' });
}

async function onGiftCardCheckoutCompleted(session) {
  const card = await getGiftCardBySessionId(session.id);
  if (!card || card.status !== 'PENDING') return;
  const issuedAt = new Date().toISOString();
  await updateGiftCard(card.id, {
    status: 'ACTIVE',
    balanceCents: card.initialAmountCents,
    issuedAt,
    stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : card.stripePaymentIntentId,
  });
  await addLedgerEntry({
    giftCardId: card.id, kind: 'ISSUE', amountCents: card.initialAmountCents,
    balanceAfterCents: card.initialAmountCents,
    note: 'Gift card activated by Stripe checkout completion',
  });
  await appendEvent('GIFT_CARD_ISSUED', {
    source: 'stripe-webhook', entityType: 'GIFT_CARD', entityId: card.id,
    details: { amountCents: card.initialAmountCents, codeLast4: card.codeLast4 },
  });
  emitReport({
    department: 'billing', type: 'GIFT_CARD_ISSUED',
    title: `Gift card issued — $${(card.initialAmountCents / 100).toFixed(2)} (card •${card.codeLast4})`,
    detail: { giftCardId: card.id, amountCents: card.initialAmountCents, codeLast4: card.codeLast4, purchaserUserId: card.purchaserUserId },
    source: 'stripe-webhook', reference: null,
    eventKey: `giftcard:${card.id}:issued:report`,
  });
  const to = card.recipientEmail || card.purchaserEmail;
  if (to) {
    queueNotification({
      channel: 'email', template: NOTIFICATION_TEMPLATES.GIFT_CARD_ACTIVE, to,
      payload: {
        subject: 'Your Top Speed gift card is now active',
        message: `Your Top Speed Appliance gift card (ending ${card.codeLast4}) for $${(card.initialAmountCents / 100).toFixed(2)} is now active. The gift card code itself was in the purchase email — enter it when you book or pay and the balance comes off your visit. — Top Speed Appliance.`,
      },
      source: 'marketplace-payments', eventKey: `giftcard:${card.id}:active:email`, eventType: 'PAYMENT',
    });
  }
}

async function onGiftCardCheckoutExpired(session) {
  const card = await getGiftCardBySessionId(session.id);
  if (!card || card.status !== 'PENDING') return;
  await updateGiftCard(card.id, { status: 'VOID' });
}

/**
 * New-rails Stripe webhook handling. Returns true when the event
 * belonged to these rails. Never throws — it shares the endpoint
 * with the diagnostic payment flow, which runs first and must never
 * be disturbed by a failure here.
 */
export async function handleStripeMarketplaceEvent(event) {
  try {
    const session = event?.data?.object || {};
    const purpose = session.metadata?.purpose;
    if (event.type === 'checkout.session.completed') {
      if (purpose === 'PEPPER_LISTS_ORDER') { await onOrderCheckoutCompleted(session); return true; }
      if (purpose === 'GIFT_CARD') { await onGiftCardCheckoutCompleted(session); return true; }
    }
    if (event.type === 'checkout.session.expired') {
      if (purpose === 'PEPPER_LISTS_ORDER') { await onOrderCheckoutExpired(session); return true; }
      if (purpose === 'GIFT_CARD') { await onGiftCardCheckoutExpired(session); return true; }
    }
    return false;
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'marketplace payments webhook handling failed', error: String(error?.message || error) }));
    return false;
  }
}
