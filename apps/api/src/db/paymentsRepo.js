import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Payment persistence (Prisma Payment table ↔ store.payments).
 *
 * Same pattern as flywheelRepo / videoRepo: hydrate the whole ledger
 * into memory at cold start, write through on every change. The PAID
 * rows are the platform's source of truth for "diagnostic paid
 * online" — serializers derive `payment` summaries from here.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStorePayment(row) {
  return {
    id: row.id,
    companyId: row.companyId,
    bookingId: row.serviceRequestId,
    customerId: row.customerId ?? null,
    purpose: row.purpose || 'DIAGNOSTIC',
    amountCents: row.amountCents,
    currency: row.currency || 'usd',
    status: row.status || 'PENDING',
    stripeSessionId: row.stripeSessionId ?? null,
    stripePaymentIntentId: row.stripePaymentIntentId ?? null,
    checkoutUrl: row.checkoutUrl ?? null,
    paidAt: iso(row.paidAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function hydratePayments() {
  if (!DATABASE_ENABLED) return;
  const rows = await db().payment.findMany();
  for (const row of rows) {
    const payment = toStorePayment(row);
    store.payments.set(payment.id, payment);
  }
}

export async function persistPayment(payment) {
  if (!DATABASE_ENABLED) return;
  const data = {
    companyId: payment.companyId,
    serviceRequestId: payment.bookingId,
    customerId: payment.customerId ?? null,
    purpose: payment.purpose || 'DIAGNOSTIC',
    amountCents: payment.amountCents,
    currency: payment.currency || 'usd',
    status: payment.status || 'PENDING',
    stripeSessionId: payment.stripeSessionId ?? null,
    stripePaymentIntentId: payment.stripePaymentIntentId ?? null,
    checkoutUrl: payment.checkoutUrl ?? null,
    paidAt: payment.paidAt ? new Date(payment.paidAt) : null,
  };
  await db().payment.upsert({
    where: { id: payment.id },
    create: { id: payment.id, ...data },
    update: data,
  });
}

export function findPaymentBySessionId(sessionId) {
  if (!sessionId) return null;
  for (const payment of store.payments.values()) {
    if (payment.stripeSessionId === sessionId) return payment;
  }
  return null;
}

export function latestPaymentForBooking(bookingId) {
  let latest = null;
  for (const payment of store.payments.values()) {
    if (payment.bookingId !== bookingId) continue;
    if (!latest || String(payment.createdAt) > String(latest.createdAt)) latest = payment;
  }
  return latest;
}

/** The serializer summary attached to bookings across the API. */
export function paymentSummary(bookingId) {
  const payment = latestPaymentForBooking(bookingId);
  if (!payment) return { diagnosticPaid: false, status: 'UNPAID', paidAt: null };
  return {
    diagnosticPaid: payment.status === 'PAID',
    status: payment.status,
    paidAt: payment.paidAt ?? null,
    amountCents: payment.amountCents,
  };
}
