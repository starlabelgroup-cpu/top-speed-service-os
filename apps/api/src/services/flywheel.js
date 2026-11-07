import { appendEvent, createReferralCode, store } from '../data/store.js';
import { notifyReferralIssued } from './notifications.js';

/**
 * Flywheel referral engine.
 *
 * The loop: Attract (intake from every surface) → Book → Serve →
 * Review (REVIEW_REQUEST on completion) → Refer. Completion also issues
 * the customer a personal referral code; a neighbor redeeming it creates
 * a new booking with source REFERRAL, which re-enters the loop at Book.
 *
 * Starter rules (documented, deterministic):
 * - One ACTIVE code per customer — completing a second job re-sends the
 *   same code instead of minting a new one.
 * - A code can be redeemed more than once (a customer can refer several
 *   neighbors); every redemption is recorded and linked to its booking.
 */
export function findReferralByCode(code) {
  if (!code) return null;
  const normalized = String(code).trim().toUpperCase();
  for (const referral of store.referrals.values()) {
    if (referral.code === normalized) return referral;
  }
  return null;
}

export function issueReferralForBooking(booking, source = null) {
  const customerId = booking.customerId || booking.customer?.id || null;

  for (const referral of store.referrals.values()) {
    if (referral.customerId === customerId && referral.status === 'ACTIVE') {
      notifyReferralIssued(booking, referral, source);
      return { referral, created: false };
    }
  }

  const referral = {
    code: createReferralCode(),
    customerId,
    customerName: booking.customer?.name || null,
    customerPhone: booking.customer?.phone || null,
    status: 'ACTIVE',
    issuedFromBookingId: booking.id,
    issuedFromReferenceCode: booking.referenceCode || null,
    issuedAt: new Date().toISOString(),
    redemptions: [],
  };
  store.referrals.set(referral.code, referral);
  appendEvent('REFERRAL_CODE_ISSUED', {
    source,
    actor: 'system:flywheel',
    entityType: 'REFERRAL',
    entityId: referral.code,
    referenceCode: booking.referenceCode || null,
    details: { customerId, issuedFromBookingId: booking.id },
  });
  notifyReferralIssued(booking, referral, source);
  return { referral, created: true };
}
