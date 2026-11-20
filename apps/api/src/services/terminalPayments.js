import { addBookingEvent, appendEvent, store } from '../data/store.js';
import { persistPayment } from '../db/paymentsRepo.js';
import { recordReceiptForJob } from './jobMoney.js';
import { notifyStaffAlert } from './notifications.js';

/**
 * Stripe Terminal settlement (F10, 2026-11-20) — the ONE place a
 * tap-to-pay PaymentIntent becomes money on the job record, shared
 * by the Stripe webhook (payment_intent.succeeded) and the Tech App
 * status poll, so the two paths can never diverge.
 *
 * The Payment row (purpose JOB_PAYMENT) flips to PAID, the booking
 * history gains the same PAYMENT_RECEIVED event the diagnostic
 * webhook writes, and the amount lands on the invoice through the
 * standard receipt chain (services/jobMoney.js recordReceiptForJob —
 * server money only: the receipt is for the PaymentIntent's amount,
 * which the server itself set to the balance due at creation).
 *
 * If the balance moved between creation and collection (a receipt
 * was recorded in between), the receipt chain refuses the overpay —
 * the payment stays PAID (Stripe really took the money) and the
 * office is alerted to reconcile, instead of the record silently
 * clamping to a number nobody actually paid.
 */
export async function settleTerminalPayment(payment, { via = 'webhook' } = {}) {
  if (!payment) return { ok: false, error: 'payment not found' };
  if (payment.status === 'PAID') return { ok: true, alreadySettled: true };
  const now = new Date().toISOString();
  payment.status = 'PAID';
  payment.paidAt = now;
  payment.updatedAt = now;
  await persistPayment(payment).catch((error) => console.error(JSON.stringify({ level: 'error', message: 'terminal payment persist failed', error: String(error?.message || error) })));

  const booking = store.bookings.get(payment.bookingId);
  if (!booking) return { ok: false, error: 'booking not found' };

  addBookingEvent(booking, 'PAYMENT_RECEIVED', 'Stripe Terminal', {
    amountCents: payment.amountCents,
    purpose: 'JOB_PAYMENT',
    method: 'CARD_PRESENT',
    via,
    paymentId: payment.id,
  });
  await appendEvent('PAYMENT_RECEIVED', {
    source: 'TECH_APP',
    actor: 'stripe-terminal',
    entityType: 'PAYMENT',
    entityId: payment.id,
    referenceCode: booking.referenceCode || null,
    details: { bookingId: booking.id, amountCents: payment.amountCents, purpose: 'JOB_PAYMENT', method: 'CARD_PRESENT', via },
  });

  const result = await recordReceiptForJob(booking, {
    method: 'CARD_EXTERNAL',
    amountCents: payment.amountCents,
    note: 'Tap to pay — Stripe Terminal',
  }, {
    actor: 'stripe-terminal',
    source: 'TECH_APP',
    confirmedBy: 'STRIPE_TERMINAL',
  });

  if (!result.ok) {
    await appendEvent('TERMINAL_RECEIPT_UNRECORDED', {
      source: 'TECH_APP',
      actor: 'stripe-terminal',
      entityType: 'PAYMENT',
      entityId: payment.id,
      referenceCode: booking.referenceCode || null,
      details: { bookingId: booking.id, amountCents: payment.amountCents, reason: result.error },
    });
    notifyStaffAlert({
      kind: 'TERMINAL_PAYMENT',
      kindLabel: 'tap-to-pay payment needing reconciliation',
      reference: booking.referenceCode,
      submitterName: booking.customer?.name || null,
      city: booking.city || null,
      lines: [
        `Amount collected by card reader: $${(payment.amountCents / 100).toFixed(2)}`,
        `It was not recorded on the invoice: ${result.error}`,
        'Please reconcile this job\u2019s invoice in Book OS.',
      ],
      consolePath: '/book-os',
      source: 'TECH_APP',
      eventKeyBase: `terminal:${payment.id}`,
    });
    return { ok: true, receiptRecorded: false, reason: result.error };
  }
  return { ok: true, receiptRecorded: true, receipt: result.receipt, payments: result.payments };
}

/** A Terminal PaymentIntent that failed or was canceled at the reader. */
export async function failTerminalPayment(payment, { reason = null } = {}) {
  if (!payment || payment.status !== 'PENDING') return { ok: true, alreadyFinal: true };
  payment.status = 'FAILED';
  payment.updatedAt = new Date().toISOString();
  await persistPayment(payment).catch(() => {});
  const booking = store.bookings.get(payment.bookingId);
  await appendEvent('TERMINAL_PAYMENT_FAILED', {
    source: 'TECH_APP',
    actor: 'stripe-terminal',
    entityType: 'PAYMENT',
    entityId: payment.id,
    referenceCode: booking?.referenceCode || null,
    details: { bookingId: payment.bookingId, amountCents: payment.amountCents, reason },
  });
  return { ok: true };
}
