import { addBookingEvent, appendEvent, createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { persistBooking } from '../db/bookingsRepo.js';
import { persistPayment } from '../db/paymentsRepo.js';
import { invoiceMoney, recordReceiptForJob } from './jobMoney.js';
import { NOTIFICATION_TEMPLATES, queueNotification } from './notifications.js';
import { stripeApi, stripeConfigured } from './stripe.js';

/**
 * Invoice payments trust package (2026-11-20, Wave 3 items F4 + F5).
 *
 * F4 — Pay over time at invoice: a customer paying a job invoice
 * through Stripe Checkout is offered card installments ONLY when the
 * owner has configured a threshold (env PAY_OVER_TIME_MIN_CENTS, the
 * smallest invoice balance in cents that qualifies) AND the Stripe
 * account itself has installments enabled (the owner's Stripe-side
 * step). With no threshold configured the option is never offered
 * and never mentioned — no terms are invented here, ever; Stripe
 * presents whatever the account is actually enabled for.
 *
 * F5 — Card on file + auto-pay for business / property-manager
 * accounts: the account holder saves a card (Stripe-hosted setup —
 * card data never touches this server), turns on a standing auto-pay
 * opt-in, and approves each invoice individually. A charge is
 * attempted ONLY when all three are true at charge time: a card is
 * on file, the standing opt-in is on, and that invoice carries the
 * account's approval. Every charge — success or failure — is
 * recorded as a Payment row and a receipt on the booking through the
 * same jobMoney path a hand-recorded receipt takes.
 */

const APP_BASE = process.env.PUBLIC_WEB_BASE || 'https://topspeedserviceos.com';

/* --------------------------- F4 config --------------------------- */

export function payOverTimeConfig() {
  const raw = Number(process.env.PAY_OVER_TIME_MIN_CENTS || '');
  const minCents = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  return { enabled: minCents != null, minCents };
}

export function payOverTimeAvailableFor(amountCents) {
  const { enabled, minCents } = payOverTimeConfig();
  return Boolean(enabled && typeof amountCents === 'number' && amountCents >= minCents);
}

/* --------------------------- helpers --------------------------- */

export async function findAccountUserById(id) {
  if (!id) return null;
  if (DATABASE_ENABLED) return db().user.findUnique({ where: { id } });
  return store.users.get(id) || null;
}

export function cardOnFileEligibility(user) {
  return ['commercial', 'property-manager'].includes(user?.signupAudience || '');
}

/** The account that owns a booking: Customer.userId link, else email match. */
export function accountForBooking(booking) {
  const customer = booking?.customerId ? store.customers.get(booking.customerId) : null;
  const userId = customer?.userId || null;
  return { customer, userId };
}

export function bookingBelongsToAccount(booking, user) {
  if (!booking || !user) return false;
  const { userId } = accountForBooking(booking);
  if (userId && userId === user.id) return true;
  const email = String(user.email || '').toLowerCase();
  return Boolean(email && String(booking.customer?.email || '').toLowerCase() === email);
}

function gateError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

/* --------------------- F4: invoice checkout --------------------- */

export async function createInvoiceCheckout({ booking, successUrl, cancelUrl }) {
  const money = invoiceMoney(booking);
  if (!money.invoice) {
    throw gateError(409, 'NO_INVOICE', 'There is no invoice for this job yet — the office issues the invoice before it can be paid online.');
  }
  if (!money.balanceDueCents) {
    throw gateError(409, 'NOTHING_DUE', 'This invoice is already fully paid.');
  }
  const amountCents = money.balanceDueCents;
  const overTime = payOverTimeAvailableFor(amountCents);
  const params = {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: amountCents,
        product_data: {
          name: 'Top Speed Appliance - Invoice payment',
          description: 'Balance due for booking ' + (booking.referenceCode || booking.id),
        },
      },
    }],
    client_reference_id: booking.referenceCode || booking.id,
    metadata: { bookingId: booking.id, referenceCode: booking.referenceCode || '', purpose: 'INVOICE' },
    payment_intent_data: { metadata: { bookingId: booking.id, purpose: 'INVOICE' } },
  };
  // Pay over time (F4): surfaced only when the owner's threshold
  // config is present and this invoice qualifies. Stripe decides at
  // its own page whether the account's installments are live.
  if (overTime) {
    params.payment_method_options = { card: { installments: { enabled: true } } };
  }
  if (booking.customer?.email) params.customer_email = booking.customer.email;
  const session = await stripeApi('POST', '/v1/checkout/sessions', params);
  return { session, amountCents, payOverTimeAvailable: overTime };
}

/**
 * Webhook follow-through for a PAID invoice checkout: record the
 * money on the booking through the canonical receipt path so the
 * invoice status (PAID / PARTIALLY_PAID) and the balance stay honest.
 * Never throws — a receipt that cannot be applied (the balance moved
 * after checkout opened) is surfaced as a platform event for staff.
 */
export async function recordInvoiceReceipt(payment, booking) {
  try {
    const result = await recordReceiptForJob(
      booking,
      { method: 'STRIPE', amountCents: payment.amountCents, note: 'Paid online by card (Stripe checkout)' },
      { actor: 'stripe-webhook', source: 'stripe' },
    );
    if (!result.ok) {
      await appendEvent('INVOICE_PAYMENT_UNAPPLIED', {
        source: 'stripe',
        actor: 'stripe-webhook',
        entityType: 'PAYMENT',
        entityId: payment.id,
        referenceCode: booking.referenceCode || null,
        details: { bookingId: booking.id, amountCents: payment.amountCents, reason: result.error || 'receipt refused' },
      });
    }
    return result;
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'invoice receipt recording failed', error: String(error?.message || error) }));
    return { ok: false };
  }
}

/* --------------------- F5: stored card CRUD --------------------- */

function storedCardView(row) {
  if (!row) return null;
  return {
    brand: row.brand || null,
    last4: row.last4 || null,
    expMonth: row.expMonth ?? null,
    expYear: row.expYear ?? null,
    autoPayEnabled: row.autoPayEnabled === true,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

export async function getStoredCard(userId) {
  if (DATABASE_ENABLED) {
    return db().storedCard.findUnique({ where: { userId } });
  }
  return store.storedCards.get(userId) || null;
}

export async function getStoredCardView(userId) {
  return storedCardView(await getStoredCard(userId));
}

async function upsertStoredCard({ user, stripeCustomerId, paymentMethod }) {
  const card = paymentMethod?.card || {};
  const data = {
    stripeCustomerId,
    stripePaymentMethodId: paymentMethod.id,
    brand: card.brand || null,
    last4: card.last4 || null,
    expMonth: card.exp_month ?? null,
    expYear: card.exp_year ?? null,
  };
  if (DATABASE_ENABLED) {
    return db().storedCard.upsert({
      where: { userId: user.id },
      create: { id: createId(), userId: user.id, companyId: user.companyId, ...data },
      update: data,
    });
  }
  const existing = store.storedCards.get(user.id);
  const row = {
    id: existing?.id || createId(),
    userId: user.id,
    companyId: user.companyId,
    autoPayEnabled: existing?.autoPayEnabled === true,
    createdAt: existing?.createdAt || new Date().toISOString(),
    ...data,
    updatedAt: new Date().toISOString(),
  };
  store.storedCards.set(user.id, row);
  return row;
}

export async function setAutoPayEnabled(userId, enabled) {
  if (DATABASE_ENABLED) {
    const result = await db().storedCard.updateMany({
      where: { userId },
      data: { autoPayEnabled: enabled },
    });
    return result.count > 0;
  }
  const row = store.storedCards.get(userId);
  if (!row) return false;
  row.autoPayEnabled = enabled;
  row.updatedAt = new Date().toISOString();
  store.storedCards.set(userId, row);
  return true;
}

export async function deleteStoredCard(userId) {
  const existing = await getStoredCard(userId);
  if (!existing) return false;
  if (stripeConfigured() && existing.stripePaymentMethodId) {
    await stripeApi('POST', `/v1/payment_methods/${encodeURIComponent(existing.stripePaymentMethodId)}/detach`, {})
      .catch(() => { /* detaching is best-effort; the local record rules */ });
  }
  if (DATABASE_ENABLED) {
    await db().storedCard.deleteMany({ where: { userId } });
  } else {
    store.storedCards.delete(userId);
  }
  return true;
}

/* --------------------- F5: card setup flow --------------------- */

export async function beginCardSetup(user) {
  const existing = await getStoredCard(user.id);
  let customerId = existing?.stripeCustomerId || null;
  if (!customerId) {
    const customer = await stripeApi('POST', '/v1/customers', {
      email: user.email || undefined,
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined,
      metadata: { purpose: 'CARD_ON_FILE', userId: user.id },
    });
    customerId = customer.id;
  }
  const session = await stripeApi('POST', '/v1/checkout/sessions', {
    mode: 'setup',
    customer: customerId,
    success_url: `${APP_BASE}/app?card=saved`,
    cancel_url: `${APP_BASE}/app?card=cancelled`,
    metadata: { purpose: 'CARD_ON_FILE', userId: user.id },
    setup_intent_data: { metadata: { purpose: 'CARD_ON_FILE', userId: user.id } },
  });
  return { url: session.url, customerId };
}

/**
 * Webhook follow-through for card setup sessions (mode=setup,
 * metadata purpose CARD_ON_FILE). Mirrors handleStripePlanEvent's
 * contract: runs after the payment handling, never throws.
 */
export async function handleCardOnFileEvent(event) {
  try {
    if (!event || event.type !== 'checkout.session.completed') return;
    const session = event.data?.object || {};
    if (session.mode !== 'setup' || session.metadata?.purpose !== 'CARD_ON_FILE') return;
    const userId = session.metadata.userId;
    if (!userId || !session.setup_intent) return;
    const user = await findAccountUserById(userId);
    if (!user) return;
    const setupIntent = await stripeApi('GET', `/v1/setup_intents/${encodeURIComponent(session.setup_intent)}`);
    const paymentMethodId = typeof setupIntent?.payment_method === 'string' ? setupIntent.payment_method : null;
    if (!paymentMethodId) return;
    const paymentMethod = await stripeApi('GET', `/v1/payment_methods/${encodeURIComponent(paymentMethodId)}`);
    await upsertStoredCard({
      user,
      stripeCustomerId: typeof session.customer === 'string' ? session.customer : setupIntent.customer || '',
      paymentMethod,
    });
    await appendEvent('CARD_ON_FILE_SAVED', {
      source: 'stripe',
      actor: 'stripe-webhook',
      entityType: 'USER',
      entityId: user.id,
      details: { brand: paymentMethod?.card?.brand || null, last4: paymentMethod?.card?.last4 || null },
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'card-on-file webhook handling failed', error: String(error?.message || error) }));
  }
}

/* ----------------- F5: per-invoice approval ----------------- */

export function invoiceAutoPayState(booking) {
  let state = 'NONE';
  for (const event of booking?.history || []) {
    if (event.type === 'INVOICE_AUTOPAY_APPROVED') state = 'APPROVED';
    if (event.type === 'INVOICE_AUTOPAY_REVOKED') state = 'NONE';
  }
  return state;
}

export async function setInvoiceAutoPayApproval(booking, user, approved) {
  addBookingEvent(booking, approved ? 'INVOICE_AUTOPAY_APPROVED' : 'INVOICE_AUTOPAY_REVOKED', user.email || 'account', {
    byUserId: user.id,
  });
  booking.updatedAt = new Date().toISOString();
  await persistBooking(booking);
  await appendEvent(approved ? 'INVOICE_AUTOPAY_APPROVED' : 'INVOICE_AUTOPAY_REVOKED', {
    source: 'app',
    actor: 'customer',
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode || null,
    details: { byUserId: user.id },
  });
  return invoiceAutoPayState(booking);
}

/* --------------------- F5: the charge itself --------------------- */

export async function chargeInvoiceToCard({ booking, actor }) {
  const money = invoiceMoney(booking);
  if (!money.invoice) {
    throw gateError(409, 'NO_INVOICE', 'There is no invoice for this job yet.');
  }
  if (!money.balanceDueCents) {
    throw gateError(409, 'NOTHING_DUE', 'This invoice is already fully paid.');
  }
  const { userId } = accountForBooking(booking);
  const account = userId ? await findAccountUserById(userId) : null;
  if (!account || !cardOnFileEligibility(account)) {
    throw gateError(403, 'NOT_BUSINESS_ACCOUNT', 'Card on file auto-pay is for business and property-manager accounts.');
  }
  const card = await getStoredCard(account.id);
  if (!card) {
    throw gateError(409, 'NO_CARD_ON_FILE', 'No card is on file for this account.');
  }
  if (card.autoPayEnabled !== true) {
    throw gateError(409, 'AUTOPAY_NOT_ENABLED', 'Auto-pay is not turned on for this account.');
  }
  if (invoiceAutoPayState(booking) !== 'APPROVED') {
    throw gateError(409, 'INVOICE_NOT_APPROVED', 'This invoice has not been approved for auto-pay by the account holder.');
  }

  const amountCents = money.balanceDueCents;
  const payment = {
    id: createId(),
    companyId: booking.companyId,
    bookingId: booking.id,
    customerId: booking.customerId ?? null,
    purpose: 'INVOICE',
    amountCents,
    currency: 'usd',
    status: 'PENDING',
    stripeSessionId: null,
    stripePaymentIntentId: null,
    checkoutUrl: null,
    paidAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let intent;
  try {
    intent = await stripeApi('POST', '/v1/payment_intents', {
      amount: amountCents,
      currency: 'usd',
      customer: card.stripeCustomerId,
      payment_method: card.stripePaymentMethodId,
      off_session: true,
      confirm: true,
      metadata: { purpose: 'INVOICE_AUTOPAY', bookingId: booking.id, referenceCode: booking.referenceCode || '' },
    });
  } catch (error) {
    payment.status = 'FAILED';
    payment.updatedAt = new Date().toISOString();
    store.payments.set(payment.id, payment);
    await persistPayment(payment).catch(() => {});
    await appendEvent('INVOICE_AUTOPAY_FAILED', {
      source: 'autopay',
      actor,
      entityType: 'PAYMENT',
      entityId: payment.id,
      referenceCode: booking.referenceCode || null,
      details: { bookingId: booking.id, amountCents, reason: error.message },
    });
    throw gateError(402, 'CARD_CHARGE_FAILED', `The card on file could not be charged: ${error.message}`);
  }

  payment.stripePaymentIntentId = intent?.id || null;
  if (intent?.status !== 'succeeded') {
    payment.status = 'FAILED';
    payment.updatedAt = new Date().toISOString();
    store.payments.set(payment.id, payment);
    await persistPayment(payment).catch(() => {});
    await appendEvent('INVOICE_AUTOPAY_FAILED', {
      source: 'autopay',
      actor,
      entityType: 'PAYMENT',
      entityId: payment.id,
      referenceCode: booking.referenceCode || null,
      details: { bookingId: booking.id, amountCents, reason: `Stripe reported ${intent?.status || 'unknown'}` },
    });
    throw gateError(402, 'CARD_CHARGE_FAILED', 'The card on file could not be charged — Stripe did not complete the payment.');
  }

  payment.status = 'PAID';
  payment.paidAt = new Date().toISOString();
  payment.updatedAt = payment.paidAt;
  store.payments.set(payment.id, payment);
  await persistPayment(payment).catch((error) => console.error(JSON.stringify({ level: 'error', message: 'autopay payment persist failed', error: String(error?.message || error) })));

  const receipt = await recordReceiptForJob(
    booking,
    { method: 'CARD_ON_FILE', amountCents, note: `Auto-pay — card on file (•••• ${card.last4 || ''})`.trim() },
    { actor, source: 'autopay' },
  );
  await appendEvent('INVOICE_AUTOPAY_CHARGED', {
    source: 'autopay',
    actor,
    entityType: 'PAYMENT',
    entityId: payment.id,
    referenceCode: booking.referenceCode || null,
    details: { bookingId: booking.id, amountCents, receiptApplied: receipt.ok === true },
  });
  if (booking.customer?.email) {
    queueNotification({
      channel: 'email',
      template: NOTIFICATION_TEMPLATES.PAYMENT_RECEIVED,
      to: booking.customer.email,
      payload: {
        message: `Hi ${(booking.customer?.name || 'there').split(' ')[0]} — we charged the card on file for booking ${booking.referenceCode || ''}: $${(amountCents / 100).toFixed(2)}. Your invoice balance is now ${receipt.ok ? 'paid' : 'updated'}. Thank you! — Top Speed Appliance.`,
        bookingId: booking.id,
      },
      source: 'autopay',
      eventKey: `payment:${payment.id}:received:email`,
      eventType: 'PAYMENT',
    });
  }
  return { payment, receipt };
}
