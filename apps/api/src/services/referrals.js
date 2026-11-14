import { appendEvent, createId, PLATFORM_COMPANY_ID, store } from '../data/store.js';
import { findReferralByCode } from './flywheel.js';
import { persistReferral } from '../db/flywheelRepo.js';
import { persistBooking, persistCustomer } from '../db/bookingsRepo.js';
import { persistProgramSettings, persistReferralCredit, persistReferralJourney } from '../db/referralsRepo.js';
import { paymentSummary } from '../db/paymentsRepo.js';
import {
  notifyReferralBooked,
  notifyReferralCompleted,
  notifyReferralCreditExpired,
  notifyReferralCreditExpiring,
  notifyReferralInvite,
  notifyReferralRewardApproved,
  notifyStaffAlert,
} from './notifications.js';
import { emitReport } from './managementReports.js';

/**
 * ApplianceReferral rewards program — service layer (Phase 1, 2026-11-12).
 *
 * Extends the existing flywheel code system (services/flywheel.js): one
 * personal TS-REF-XXXX code per customer, issued on job completion. This
 * module adds everything that makes it a rewards PROGRAM:
 *
 *  - ReferralJourney: one referred friend's lifecycle
 *    INVITED → BOOKED → COMPLETED → REWARD_PENDING_APPROVAL →
 *    CREDIT_ISSUED → REDEEMED (or REJECTED / EXPIRED / VOID).
 *  - ReferralCredit: the reward ledger — created ONLY by a staff
 *    approval (money moves require a human, per platform governance).
 *  - ReferralProgramSetting: per-company configuration. Every amount
 *    defaults to NULL (unset). HARD RULE: no referrer-reward figure is
 *    hard-coded anywhere — amounts only ever come from these settings
 *    at runtime, snapshotted onto the journey at completion. Until the
 *    owner configures a figure, approvals fail honestly with
 *    AMOUNT_NOT_CONFIGURED and customer copy states no amount.
 *
 * Fraud starter rules: self-referral (same phone/email as the referrer)
 * is rejected; one reward-track journey per referee household — a second
 * booking from the same household is still attributed to the referrer
 * but does not open a second reward track.
 */

export const JOURNEY_STATUSES = [
  'INVITED', 'CLICKED', 'BOOKED', 'COMPLETED', 'REWARD_PENDING_APPROVAL',
  'REWARD_APPROVED', 'CREDIT_ISSUED', 'REDEEMED', 'REJECTED', 'EXPIRED', 'VOID',
];

// Statuses that mean the referred job finished — used for tier counting
// and dashboard stats.
const COMPLETED_STATUSES = ['COMPLETED', 'REWARD_PENDING_APPROVAL', 'REWARD_APPROVED', 'CREDIT_ISSUED', 'REDEEMED'];
// Statuses that occupy a household's single reward track.
const REWARD_TRACK_STATUSES = ['BOOKED', ...COMPLETED_STATUSES];

export function referralError(code, status, message) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function persistQuietly(label, run) {
  try {
    await run();
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: label, error: String(error?.message || error) }));
  }
}

const digits10 = (value) => String(value || '').replace(/\D/g, '').slice(-10);
const normEmail = (value) => String(value || '').trim().toLowerCase() || null;

function staffActor(staffUser) {
  return staffUser?.email || staffUser?.id || 'staff';
}

/* ------------------------------------------------------------------ */
/* Program settings                                                    */
/* ------------------------------------------------------------------ */

export const REFERRAL_PROGRAM_DEFAULTS = {
  enabled: true,
  rewardAmountCents: null,
  tier2Threshold: null,
  tier2AmountCents: null,
  tier3Threshold: null,
  tier3AmountCents: null,
  milestoneBonuses: null,
  monthlyCapPerReferrer: null,
  rewardExpiryDays: null,
  updatedBy: null,
};

export function getProgramSettings(companyId) {
  const key = companyId || PLATFORM_COMPANY_ID;
  const stored = store.referralSettings instanceof Map ? store.referralSettings.get(key) : null;
  return { ...REFERRAL_PROGRAM_DEFAULTS, ...(stored || {}), companyId: key };
}

export async function updateProgramSettings(companyId, patch, updatedBy = null) {
  const key = companyId || PLATFORM_COMPANY_ID;
  const next = { ...getProgramSettings(key), ...patch, companyId: key, updatedBy };
  await persistQuietly('referral settings persist failed', () => persistProgramSettings(next));
  return getProgramSettings(key);
}

/* ------------------------------------------------------------------ */
/* Code resolution + clicks                                            */
/* ------------------------------------------------------------------ */

export function resolveCode(code) {
  return findReferralByCode(code);
}

export async function recordClick(code) {
  const referral = resolveCode(code);
  if (!referral) return null;
  referral.clickCount = (referral.clickCount || 0) + 1;
  await persistQuietly('referral click persist failed', () => persistReferral(referral));
  return referral;
}

/* ------------------------------------------------------------------ */
/* Self-referral + journey lookup helpers                              */
/* ------------------------------------------------------------------ */

function referrerContactKeys(referral) {
  const customer = referral?.customerId ? store.customers.get(referral.customerId) : null;
  return {
    phones: new Set([digits10(referral?.customerPhone), digits10(customer?.phone)].filter((d) => d.length >= 10)),
    emails: new Set([normEmail(customer?.email)].filter(Boolean)),
  };
}

function isSelfReferral(referral, { phone = null, email = null } = {}) {
  const keys = referrerContactKeys(referral);
  const phoneDigits = digits10(phone);
  if (phoneDigits.length >= 10 && keys.phones.has(phoneDigits)) return true;
  const emailNorm = normEmail(email);
  if (emailNorm && keys.emails.has(emailNorm)) return true;
  return false;
}

function sameReferee(journey, { phone = null, email = null } = {}) {
  const phoneDigits = digits10(phone);
  if (phoneDigits.length >= 10 && digits10(journey.refereePhone) === phoneDigits) return true;
  const emailNorm = normEmail(email);
  if (emailNorm && normEmail(journey.refereeEmail) === emailNorm) return true;
  return false;
}

function journeysForReferral(referral) {
  return store.referralJourneys.filter((journey) => journey.referralId === referral.id || journey.code === referral.code);
}

async function createJourneyRecord({ referral, refereeName = null, refereePhone = null, refereeEmail = null, status = 'INVITED', booking = null }) {
  const now = new Date().toISOString();
  const journey = {
    id: createId(),
    companyId: referral.companyId || booking?.companyId || PLATFORM_COMPANY_ID,
    referralId: referral.id || null,
    code: referral.code,
    referrerCustomerId: referral.customerId ?? null,
    refereeName: refereeName || null,
    refereePhone: refereePhone || null,
    refereeEmail: refereeEmail || null,
    bookingId: booking?.id ?? null,
    bookingReference: booking?.referenceCode ?? null,
    // Track snapshot from the code (Phase 2 partner track).
    track: referral.track || 'CUSTOMER',
    status,
    rewardAmountCents: null,
    tierSnapshot: null,
    staffDecisionBy: null,
    staffDecisionAt: null,
    staffNote: null,
    createdAt: now,
    updatedAt: now,
  };
  // persistReferralJourney upserts by id; the Referral row id is assigned
  // by persistReferral at issuance, but guard anyway for skeleton mode.
  if (!journey.referralId) journey.referralId = journey.id;
  store.referralJourneys.push(journey);
  await persistQuietly('referral journey persist failed', () => persistReferralJourney(journey));
  return journey;
}

/* ------------------------------------------------------------------ */
/* Invites                                                             */
/* ------------------------------------------------------------------ */

/**
 * A referrer invites a friend by phone and/or email. The friend gets a
 * REFERRAL_INVITE through the unified outbox for each channel provided
 * (email via Resend; SMS queues honestly and gates on the Twilio trial
 * in the sender drain — delivery is never faked here).
 */
export async function createInvite({ code, friendName, phone = null, email = null, source = null }) {
  const referral = resolveCode(code);
  if (!referral) throw referralError('CODE_NOT_FOUND', 404, 'Referral code not found');
  const settings = getProgramSettings(referral.companyId);
  if (settings.enabled === false) throw referralError('REFERRAL_PROGRAM_DISABLED', 422, 'The referral program is not currently enabled');
  if (!phone && !email) throw referralError('CONTACT_REQUIRED', 422, 'A phone number or an email is required to send an invite');
  if (isSelfReferral(referral, { phone, email })) {
    throw referralError('SELF_REFERRAL', 422, 'You cannot refer yourself — share your code with a friend or neighbor instead');
  }

  const existing = journeysForReferral(referral).find(
    (journey) => (journey.status === 'INVITED' || journey.status === 'CLICKED') && sameReferee(journey, { phone, email }),
  );
  if (existing) return { journey: existing, created: false, notifications: [] };

  const journey = await createJourneyRecord({
    referral,
    refereeName: friendName || null,
    refereePhone: phone,
    refereeEmail: email,
    status: 'INVITED',
  });
  appendEvent('REFERRAL_JOURNEY_CREATED', {
    source,
    actor: 'referral-program',
    entityType: 'REFERRAL_JOURNEY',
    entityId: journey.id,
    details: { code: referral.code, status: journey.status, via: 'INVITE' },
  });
  const notifications = notifyReferralInvite({ referral, journey, source });
  emitReport({
    department: 'referrals',
    type: 'REFERRAL_INVITE_SENT',
    title: `Referral invite sent — code ${referral.code}`,
    detail: { referralCode: referral.code, referrerName: referral.customerName || null, refereeName: journey.refereeName || null, refereePhone: journey.refereePhone || null, refereeEmail: journey.refereeEmail || null, journeyId: journey.id },
    source,
    reference: referral.code,
    eventKey: `referral-invite:${journey.id}:report`,
  });
  return { journey, created: true, notifications };
}

/**
 * A public /connections lead that arrived carrying a referral code.
 * Phase 1 scope: the lead opens an INVITED journey with the referee's
 * contact details; it advances to BOOKED only when a real booking is
 * created (attachReferralToBooking matches it by phone/email). No
 * invite notification is sent — the lead contacted us themselves. The
 * source/reference rides in the platform event feed as the source note.
 */
export async function recordReferralLead({ code, name = null, phone = null, email = null, reference = null, source = null }) {
  const referral = resolveCode(code);
  if (!referral) return { recorded: false, reason: 'CODE_NOT_FOUND' };
  if (isSelfReferral(referral, { phone, email })) return { recorded: false, reason: 'SELF_REFERRAL' };
  const existing = journeysForReferral(referral).find(
    (journey) => ['INVITED', 'CLICKED', 'BOOKED'].includes(journey.status) && sameReferee(journey, { phone, email }),
  );
  if (existing) return { recorded: true, created: false, journey: existing };

  const journey = await createJourneyRecord({
    referral,
    refereeName: name,
    refereePhone: phone,
    refereeEmail: email,
    status: 'INVITED',
  });
  appendEvent('REFERRAL_LEAD_RECORDED', {
    source: source || 'connections',
    actor: 'referral-program',
    entityType: 'REFERRAL_JOURNEY',
    entityId: journey.id,
    referenceCode: reference || null,
    details: { code: referral.code, status: journey.status, via: 'CONNECTION_LEAD', connectionReference: reference || null },
  });
  return { recorded: true, created: true, journey };
}

/* ------------------------------------------------------------------ */
/* Booking attribution                                                 */
/* ------------------------------------------------------------------ */

/**
 * Tag a freshly created booking with a referral code. Sets the booking's
 * referralCode / referredByCustomerId (now persisted columns), the
 * referee customer's referredByCode, and the REFERRAL via-tag (existing
 * UTM attribution is kept). Opens or advances the reward-track journey
 * to BOOKED and notifies the referrer. Never throws for an unknown code
 * or a self-referral — it reports { attached: false, reason } so callers
 * can log and move on; a booking must never fail over a referral.
 */
export async function attachReferralToBooking({ code, booking, refereeCustomer = null, source = null }) {
  const referral = resolveCode(code);
  if (!referral) return { attached: false, reason: 'CODE_NOT_FOUND' };
  const referee = refereeCustomer || booking?.customer || {};
  const refereePhone = referee.phone || null;
  const refereeEmail = referee.email || null;
  if (isSelfReferral(referral, { phone: refereePhone, email: refereeEmail })) {
    return { attached: false, reason: 'SELF_REFERRAL' };
  }

  booking.referralCode = referral.code;
  booking.referredByCustomerId = referral.customerId ?? null;
  booking.attribution = { ...(booking.attribution || {}), via: 'REFERRAL' };
  if (refereeCustomer) {
    refereeCustomer.referredByCode = referral.code;
    await persistQuietly('referral referee customer persist failed', () => persistCustomer(refereeCustomer));
  }

  const journeys = journeysForReferral(referral);
  const householdJourney = journeys.find(
    (journey) => REWARD_TRACK_STATUSES.includes(journey.status) && (journey.bookingId === booking.id || sameReferee(journey, { phone: refereePhone, email: refereeEmail })),
  );
  if (householdJourney) {
    // One reward track per referee household: attribution is recorded
    // above, but no second journey opens.
    await persistQuietly('referral booking persist failed', () => persistBooking(booking));
    return { attached: true, rewardTrack: false, reason: 'HOUSEHOLD_ALREADY_ON_REWARD_TRACK', journey: householdJourney };
  }

  let journey = journeys.find(
    (candidate) => (candidate.status === 'INVITED' || candidate.status === 'CLICKED') && sameReferee(candidate, { phone: refereePhone, email: refereeEmail }),
  );
  if (journey) {
    journey.status = 'BOOKED';
    journey.bookingId = booking.id;
    journey.bookingReference = booking.referenceCode || null;
    journey.refereeName = journey.refereeName || referee.name || null;
    journey.refereePhone = journey.refereePhone || refereePhone;
    journey.refereeEmail = journey.refereeEmail || refereeEmail;
    await persistQuietly('referral journey persist failed', () => persistReferralJourney(journey));
  } else {
    journey = await createJourneyRecord({
      referral,
      refereeName: referee.name || null,
      refereePhone,
      refereeEmail,
      status: 'BOOKED',
      booking,
    });
  }

  // Keep the flywheel redemption log continuous: staff flywheel views
  // and metrics count redemptions from Referral.redemptions.
  if (Array.isArray(referral.redemptions) && !referral.redemptions.some((r) => r.bookingId === booking.id)) {
    referral.redemptions.push({
      bookingId: booking.id,
      referenceCode: booking.referenceCode || null,
      customerName: referee.name || null,
      city: booking.city || null,
      journeyId: journey.id,
      at: new Date().toISOString(),
    });
    await persistQuietly('referral redemption persist failed', () => persistReferral(referral));
  }

  await persistQuietly('referral booking persist failed', () => persistBooking(booking));
  appendEvent('REFERRAL_BOOKED', {
    source: source || booking.source || null,
    actor: 'referral-program',
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode || null,
    details: { referralCode: referral.code, referredByCustomerId: referral.customerId ?? null, journeyId: journey.id },
  });
  notifyReferralBooked(referral, journey, source || booking.source || null);
  return { attached: true, rewardTrack: true, journey };
}

/* ------------------------------------------------------------------ */
/* Completion advancement                                              */
/* ------------------------------------------------------------------ */

function tierForCompletedCount(settings, completedCount) {
  if (settings.tier3Threshold != null && completedCount >= settings.tier3Threshold && settings.tier3AmountCents != null) {
    return { tier: 'TIER3', amountCents: settings.tier3AmountCents };
  }
  if (settings.tier2Threshold != null && completedCount >= settings.tier2Threshold && settings.tier2AmountCents != null) {
    return { tier: 'TIER2', amountCents: settings.tier2AmountCents };
  }
  return { tier: settings.rewardAmountCents != null ? 'TIER1' : null, amountCents: settings.rewardAmountCents ?? null };
}

function completedCountForReferrer(referrerCustomerId) {
  if (!referrerCustomerId) return 0;
  return store.referralJourneys.filter(
    (journey) => journey.referrerCustomerId === referrerCustomerId && COMPLETED_STATUSES.includes(journey.status),
  ).length;
}

/**
 * Advance the reward track when a referred booking completes. Called by
 * BOTH completion paths (POST /bookings/:id/complete and the tracking
 * console COMPLETE stage) so console completions behave identically.
 * Idempotent: a journey past BOOKED is returned untouched.
 */
export async function advanceReferralOnCompletion(booking, source = null) {
  let journey = store.referralJourneys.find(
    (candidate) => candidate.bookingId === booking.id && !['REJECTED', 'VOID', 'EXPIRED'].includes(candidate.status),
  );
  if (!journey && booking.referralCode) {
    // Bookings created through the flywheel redeem route (or before
    // Phase 1) carry the code but no journey — open the track now so
    // the completion still counts.
    const attached = await attachReferralToBooking({
      code: booking.referralCode,
      booking,
      refereeCustomer: booking.customer || null,
      source: source || booking.source || null,
    });
    journey = attached.journey || null;
  }
  if (!journey) return { advanced: false, reason: 'NO_JOURNEY' };
  if (journey.status !== 'BOOKED' && journey.status !== 'INVITED' && journey.status !== 'CLICKED') {
    return { advanced: false, reason: 'ALREADY_ADVANCED', journey };
  }

  const referral = resolveCode(journey.code);
  if (!referral) return { advanced: false, reason: 'CODE_NOT_FOUND' };
  const settings = getProgramSettings(journey.companyId || booking.companyId);

  journey.status = 'COMPLETED';
  // Payment gate: the reward track proceeds to approval only when the
  // platform has a recorded payment state for this booking — a PAID
  // Payment row, or the booking's recorded feeStatus showing the fee
  // collected. Otherwise the journey stays COMPLETED with a hold note
  // for staff (it can still be reviewed from the admin queue).
  const summary = paymentSummary(booking.id);
  const feeCollected = ['COLLECTED_AT_BOOKING', 'collected_at_booking'].includes(booking.feeStatus || '');
  const paymentRecorded = Boolean(summary?.diagnosticPaid) || feeCollected;

  if (paymentRecorded) {
    const completedCount = completedCountForReferrer(journey.referrerCustomerId);
    const { tier, amountCents } = tierForCompletedCount(settings, Math.max(completedCount, 1));
    journey.rewardAmountCents = amountCents;
    journey.tierSnapshot = tier;
    journey.status = 'REWARD_PENDING_APPROVAL';
  } else if (!journey.staffNote) {
    journey.staffNote = 'Reward held: no recorded payment for this booking yet (no PAID payment on file and the diagnostic fee is not marked collected).';
  }
  await persistQuietly('referral journey persist failed', () => persistReferralJourney(journey));

  appendEvent('REFERRAL_COMPLETED', {
    source: source || booking.source || null,
    actor: 'referral-program',
    entityType: 'REFERRAL_JOURNEY',
    entityId: journey.id,
    referenceCode: booking.referenceCode || null,
    details: { referralCode: journey.code, status: journey.status, paymentRecorded },
  });
  notifyReferralCompleted(referral, journey, source || booking.source || null);
  notifyStaffAlert({
    kind: 'REFERRAL_REWARD',
    kindLabel: paymentRecorded ? 'referral reward pending approval' : 'referral completed — reward held (no recorded payment)',
    reference: journey.bookingReference || journey.code,
    submitterName: referral.customerName || null,
    lines: [
      `Referral code: ${journey.code}`,
      `Referred customer: ${journey.refereeName || '(name on booking)'}`,
      `Journey status: ${journey.status}`,
      ...(journey.rewardAmountCents != null ? [`Reward snapshot (cents): ${journey.rewardAmountCents}`] : ['Reward amount: not configured / not snapshotted']),
    ],
    consolePath: '/portal',
    source: source || booking.source || null,
    eventKeyBase: `referral-journey:${journey.id}:completed`,
  });
  return { advanced: true, journey, paymentRecorded };
}

/* ------------------------------------------------------------------ */
/* Staff decisions: approve / reject / redeem                          */
/* ------------------------------------------------------------------ */

export async function approveReward(journeyId, staffUser, amountCentsOverride = null) {
  const journey = store.referralJourneys.find((candidate) => candidate.id === journeyId);
  if (!journey) throw referralError('JOURNEY_NOT_FOUND', 404, 'Referral journey not found');
  if (journey.status !== 'REWARD_PENDING_APPROVAL') {
    throw referralError('INVALID_JOURNEY_STATUS', 409, `Reward can only be approved from REWARD_PENDING_APPROVAL (current: ${journey.status})`);
  }
  if (!journey.referrerCustomerId) throw referralError('REFERRER_NOT_LINKED', 422, 'This journey has no referrer customer to credit');
  const settings = getProgramSettings(journey.companyId);

  const amountCents = amountCentsOverride ?? journey.rewardAmountCents ?? settings.rewardAmountCents ?? null;
  if (amountCents == null) {
    throw referralError('AMOUNT_NOT_CONFIGURED', 422, 'No reward amount is configured for the referral program — set rewardAmountCents in the referral program settings (owner) or pass amountCents with the approval');
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw referralError('INVALID_AMOUNT', 422, 'Reward amount must be a positive integer number of cents');
  }

  if (settings.monthlyCapPerReferrer != null) {
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const issuedThisMonth = store.referralCredits.filter(
      (credit) => credit.customerId === journey.referrerCustomerId && credit.status !== 'VOIDED' && String(credit.createdAt || '') >= monthStart,
    ).length;
    if (issuedThisMonth >= settings.monthlyCapPerReferrer) {
      throw referralError('MONTHLY_CAP_REACHED', 422, 'This referrer has reached the configured monthly reward cap');
    }
  }

  const now = new Date().toISOString();
  const credit = {
    id: createId(),
    companyId: journey.companyId,
    customerId: journey.referrerCustomerId,
    journeyId: journey.id,
    amountCents,
    status: 'AVAILABLE',
    issuedBy: staffActor(staffUser),
    expiresAt: settings.rewardExpiryDays != null
      ? new Date(Date.now() + settings.rewardExpiryDays * 24 * 3600 * 1000).toISOString()
      : null,
    redeemedBookingId: null,
    redeemedReference: null,
    redeemedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  store.referralCredits.push(credit);
  await persistQuietly('referral credit persist failed', () => persistReferralCredit(credit));

  journey.status = 'CREDIT_ISSUED';
  journey.rewardAmountCents = amountCents;
  journey.staffDecisionBy = staffActor(staffUser);
  journey.staffDecisionAt = now;
  await persistQuietly('referral journey persist failed', () => persistReferralJourney(journey));

  // Milestone bonus: when the referrer's lifetime completed count lands
  // exactly on a configured milestone, issue the bonus credit too.
  let bonusCredit = null;
  const milestones = Array.isArray(settings.milestoneBonuses) ? settings.milestoneBonuses : [];
  const completedCount = completedCountForReferrer(journey.referrerCustomerId);
  const milestone = milestones.find((entry) => entry && entry.at === completedCount && Number.isInteger(entry.amountCents) && entry.amountCents > 0);
  if (milestone) {
    bonusCredit = {
      ...credit,
      id: createId(),
      amountCents: milestone.amountCents,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.referralCredits.push(bonusCredit);
    await persistQuietly('referral bonus credit persist failed', () => persistReferralCredit(bonusCredit));
  }

  const referral = resolveCode(journey.code);
  if (referral) notifyReferralRewardApproved(referral, journey, credit, bonusCredit);
  appendEvent('REFERRAL_REWARD_APPROVED', {
    actor: staffActor(staffUser),
    entityType: 'REFERRAL_JOURNEY',
    entityId: journey.id,
    referenceCode: journey.bookingReference || null,
    details: { creditId: credit.id, amountCents, bonusCreditId: bonusCredit?.id ?? null, bonusAmountCents: bonusCredit?.amountCents ?? null },
  });
  emitReport({
    department: 'referrals',
    type: 'REFERRAL_CREDIT_APPROVED',
    title: `Referral credit approved — ${journey.code}`,
    detail: { referralCode: journey.code, journeyId: journey.id, creditId: credit.id, amountCents, bonusAmountCents: bonusCredit?.amountCents ?? null, decidedBy: staffActor(staffUser), refereeName: journey.refereeName || null },
    reference: journey.bookingReference || journey.code,
    eventKey: `referral-credit:${credit.id}:approved:report`,
  });
  return { journey, credit, bonusCredit };
}

export async function rejectReward(journeyId, staffUser, note = null) {
  const journey = store.referralJourneys.find((candidate) => candidate.id === journeyId);
  if (!journey) throw referralError('JOURNEY_NOT_FOUND', 404, 'Referral journey not found');
  if (journey.status !== 'REWARD_PENDING_APPROVAL') {
    throw referralError('INVALID_JOURNEY_STATUS', 409, `Reward can only be rejected from REWARD_PENDING_APPROVAL (current: ${journey.status})`);
  }
  journey.status = 'REJECTED';
  journey.staffDecisionBy = staffActor(staffUser);
  journey.staffDecisionAt = new Date().toISOString();
  if (note) journey.staffNote = note;
  await persistQuietly('referral journey persist failed', () => persistReferralJourney(journey));
  // Staff-side only: the referrer is not notified of a rejection.
  notifyStaffAlert({
    kind: 'REFERRAL_REWARD_REJECTED',
    kindLabel: 'referral reward rejection',
    reference: journey.bookingReference || journey.code,
    submitterName: journey.refereeName || null,
    lines: [
      `Referral code: ${journey.code}`,
      `Decided by: ${staffActor(staffUser)}`,
      ...(note ? [`Note: ${note}`] : []),
    ],
    consolePath: '/portal',
    eventKeyBase: `referral-journey:${journey.id}:rejected`,
  });
  appendEvent('REFERRAL_REWARD_REJECTED', {
    actor: staffActor(staffUser),
    entityType: 'REFERRAL_JOURNEY',
    entityId: journey.id,
    referenceCode: journey.bookingReference || null,
    details: { note: note || null },
  });
  return { journey };
}

export async function redeemCredit(creditId, bookingReference = null, staffUser = null) {
  const credit = store.referralCredits.find((candidate) => candidate.id === creditId);
  if (!credit) throw referralError('CREDIT_NOT_FOUND', 404, 'Referral credit not found');
  if (credit.status !== 'AVAILABLE') {
    throw referralError('CREDIT_NOT_AVAILABLE', 409, `Credit is not available to redeem (current: ${credit.status})`);
  }
  if (credit.expiresAt && new Date(credit.expiresAt).getTime() < Date.now()) {
    credit.status = 'EXPIRED';
    await persistQuietly('referral credit persist failed', () => persistReferralCredit(credit));
    throw referralError('CREDIT_EXPIRED', 422, 'This referral credit has expired');
  }
  let booking = null;
  if (bookingReference) {
    const wanted = String(bookingReference).trim().toUpperCase();
    booking = [...store.bookings.values()].find(
      (candidate) => String(candidate.referenceCode || '').toUpperCase() === wanted,
    ) || null;
    if (!booking) throw referralError('BOOKING_NOT_FOUND', 404, 'No booking found with that reference');
  }
  credit.status = 'REDEEMED';
  credit.redeemedAt = new Date().toISOString();
  credit.redeemedReference = booking?.referenceCode || bookingReference || null;
  credit.redeemedBookingId = booking?.id || null;
  await persistQuietly('referral credit persist failed', () => persistReferralCredit(credit));

  const journey = store.referralJourneys.find((candidate) => candidate.id === credit.journeyId) || null;
  if (journey && journey.status === 'CREDIT_ISSUED') {
    journey.status = 'REDEEMED';
    await persistQuietly('referral journey persist failed', () => persistReferralJourney(journey));
  }
  appendEvent('REFERRAL_CREDIT_REDEEMED', {
    actor: staffActor(staffUser),
    entityType: 'REFERRAL_CREDIT',
    entityId: credit.id,
    referenceCode: credit.redeemedReference,
    details: { journeyId: credit.journeyId, amountCents: credit.amountCents },
  });
  emitReport({
    department: 'referrals',
    type: 'REFERRAL_CREDIT_REDEEMED',
    title: `Referral credit redeemed — ${credit.redeemedReference || credit.id}`,
    detail: { creditId: credit.id, journeyId: credit.journeyId, amountCents: credit.amountCents, redeemedReference: credit.redeemedReference, decidedBy: staffActor(staffUser) },
    reference: credit.redeemedReference || null,
    eventKey: `referral-credit:${credit.id}:redeemed:report`,
  });
  return { credit, journey };
}

/* ------------------------------------------------------------------ */
/* Aggregate status by code (Speedy's get_referral_status tool)        */
/* ------------------------------------------------------------------ */

/**
 * Aggregate, safe referral status for one code — the ONLY referral
 * status Speedy may report. Returns journey counts by plain stage and
 * the customer's AVAILABLE issued credits (count + totalCents). No
 * referee contact details, no per-journey rows, and NO program reward
 * amounts: a total appears here only because those credits were
 * actually issued to this customer by a staff approval.
 */
export function getReferralStatusForCode(code) {
  const referral = resolveCode(code);
  if (!referral) {
    return {
      found: false,
      referrerFirstName: null,
      counts: { invited: 0, booked: 0, completed: 0, pendingApproval: 0, creditIssued: 0, redeemed: 0 },
      creditsAvailable: { count: 0, totalCents: 0 },
    };
  }
  const customer = referral.customerId ? store.customers.get(referral.customerId) : null;
  const referrerName = referral.customerName || customer?.name || null;
  const journeys = journeysForReferral(referral);
  const count = (...statuses) => journeys.filter((journey) => statuses.includes(journey.status)).length;
  const available = store.referralCredits.filter(
    (credit) => referral.customerId
      && credit.customerId === referral.customerId
      && credit.status === 'AVAILABLE'
      && (!credit.expiresAt || new Date(credit.expiresAt).getTime() >= Date.now()),
  );
  return {
    found: true,
    referrerFirstName: referrerName ? String(referrerName).trim().split(/\s+/)[0] : null,
    counts: {
      invited: count('INVITED', 'CLICKED'),
      booked: count('BOOKED'),
      completed: count('COMPLETED'),
      pendingApproval: count('REWARD_PENDING_APPROVAL', 'REWARD_APPROVED'),
      creditIssued: count('CREDIT_ISSUED'),
      redeemed: count('REDEEMED'),
    },
    creditsAvailable: {
      count: available.length,
      totalCents: available.reduce((sum, credit) => sum + (credit.amountCents || 0), 0),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Customer dashboard                                                  */
/* ------------------------------------------------------------------ */

function safeJourney(journey) {
  return {
    id: journey.id,
    code: journey.code,
    track: journey.track || 'CUSTOMER',
    refereeName: journey.refereeName || null,
    status: journey.status,
    bookingReference: journey.bookingReference || null,
    rewardAmountCents: journey.rewardAmountCents ?? null,
    tierSnapshot: journey.tierSnapshot ?? null,
    createdAt: journey.createdAt,
    updatedAt: journey.updatedAt,
  };
}

function safeCredit(credit) {
  return {
    id: credit.id,
    amountCents: credit.amountCents,
    status: credit.status,
    expiresAt: credit.expiresAt || null,
    redeemedReference: credit.redeemedReference || null,
    redeemedAt: credit.redeemedAt || null,
    createdAt: credit.createdAt,
  };
}

/**
 * The signed-in customer's referral dashboard. `customer` is one of the
 * customer's records; identity is widened the way GET /connect/promotions
 * resolves a person — every customer record sharing their phone/email
 * counts, because a customer gains a record per booking. Stats are real
 * recorded data only: clicks from the code record, journey counts, and
 * issued credits (the available total sums AVAILABLE credits only).
 */
export function getCustomerDashboard(customer) {
  const empty = {
    code: null,
    link: null,
    track: null,
    explanation: 'Your personal referral code is issued when your first repair is completed.',
    stats: { clicks: 0, invited: 0, booked: 0, completed: 0, creditsAvailable: { count: 0, totalCents: 0 } },
    journeys: [],
    credits: [],
  };
  if (!customer) return empty;

  const customerIds = new Set([customer.id].filter(Boolean));
  const myPhone = digits10(customer.phone);
  const myEmail = normEmail(customer.email);
  for (const record of store.customers.values()) {
    if ((myPhone && digits10(record.phone) === myPhone) || (myEmail && normEmail(record.email) === myEmail)) {
      customerIds.add(record.id);
    }
  }
  for (const booking of store.bookings.values()) {
    const booked = booking.customer || {};
    if (
      customerIds.has(booking.customerId) ||
      (myPhone && digits10(booked.phone) === myPhone) ||
      (myEmail && normEmail(booked.email) === myEmail)
    ) {
      if (booking.customerId) customerIds.add(booking.customerId);
    }
  }

  const referral = [...store.referrals.values()].find(
    (candidate) => customerIds.has(candidate.customerId) && candidate.status === 'ACTIVE',
  ) || [...store.referrals.values()].find((candidate) => customerIds.has(candidate.customerId));
  if (!referral) return empty;

  const journeys = store.referralJourneys
    .filter((journey) => journey.referralId === referral.id || (journey.code === referral.code && customerIds.has(journey.referrerCustomerId)))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const credits = store.referralCredits
    .filter((credit) => customerIds.has(credit.customerId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const available = credits.filter(
    (credit) => credit.status === 'AVAILABLE' && (!credit.expiresAt || new Date(credit.expiresAt).getTime() >= Date.now()),
  );

  return {
    code: referral.code,
    link: `https://topspeedserviceos.com/refer?c=${referral.code}`,
    track: referral.track || 'CUSTOMER',
    explanation: null,
    stats: {
      clicks: referral.clickCount || 0,
      invited: journeys.filter((j) => j.status === 'INVITED' || j.status === 'CLICKED').length,
      booked: journeys.filter((j) => j.status === 'BOOKED').length,
      completed: journeys.filter((j) => COMPLETED_STATUSES.includes(j.status)).length,
      creditsAvailable: {
        count: available.length,
        totalCents: available.reduce((sum, credit) => sum + (credit.amountCents || 0), 0),
      },
    },
    journeys: journeys.map(safeJourney),
    credits: credits.map(safeCredit),
  };
}

/* ------------------------------------------------------------------ */
/* Phase 2 (2026-11-12): partner track, leaderboard, funnel, expiry    */
/* ------------------------------------------------------------------ */

export const REFERRAL_TRACKS = ['CUSTOMER', 'PARTNER'];

/**
 * Staff flag: move a referral CODE between the customer and partner
 * tracks (Book OS). Journeys already created keep their snapshot; new
 * journeys inherit the code's new track. Same program and settings —
 * the track only separates reporting.
 */
export async function setReferralTrack(code, track, staffUser = null) {
  const referral = resolveCode(code);
  if (!referral) throw referralError('CODE_NOT_FOUND', 404, 'Referral code not found');
  const next = String(track || '').trim().toUpperCase();
  if (!REFERRAL_TRACKS.includes(next)) {
    throw referralError('INVALID_TRACK', 422, 'Track must be CUSTOMER or PARTNER');
  }
  referral.track = next;
  await persistQuietly('referral track persist failed', () => persistReferral(referral));
  appendEvent('REFERRAL_TRACK_SET', {
    actor: staffActor(staffUser),
    entityType: 'REFERRAL',
    entityId: referral.code,
    details: { code: referral.code, track: next },
  });
  return referral;
}

/** "Maria G." — first name + last initial, nothing more, ever. */
function maskedDisplayName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const first = parts[0];
  const lastInitial = parts.length > 1 ? `${parts[parts.length - 1][0].toUpperCase()}.` : '';
  return lastInitial ? `${first} ${lastInitial}` : first;
}

/**
 * Public leaderboard: referrers ranked by COMPLETED referrals.
 * Privacy-safe by construction — display names are masked to first
 * name + last initial, and only counts are exposed (never credit
 * amounts, never referee details, never contact data).
 */
export function getLeaderboard(limit = 10) {
  const byReferrer = new Map();
  for (const journey of store.referralJourneys) {
    if (!COMPLETED_STATUSES.includes(journey.status)) continue;
    if (!journey.referrerCustomerId) continue;
    const key = journey.referrerCustomerId;
    const entry = byReferrer.get(key) || { customerId: key, code: journey.code, completed: 0, firstCompletedAt: journey.updatedAt || journey.createdAt };
    entry.completed += 1;
    if (String(journey.updatedAt || journey.createdAt) < String(entry.firstCompletedAt)) {
      entry.firstCompletedAt = journey.updatedAt || journey.createdAt;
    }
    byReferrer.set(key, entry);
  }
  const leaders = [...byReferrer.values()]
    .map((entry) => {
      const referral = resolveCode(entry.code);
      const customer = store.customers.get(entry.customerId) || null;
      const displayName = maskedDisplayName(referral?.customerName || customer?.name);
      return displayName ? { displayName, completedReferrals: entry.completed, firstCompletedAt: entry.firstCompletedAt } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.completedReferrals - a.completedReferrals || String(a.firstCompletedAt).localeCompare(String(b.firstCompletedAt)))
    .slice(0, Math.max(1, Math.min(limit, 50)))
    .map(({ displayName, completedReferrals }) => ({ displayName, completedReferrals }));
  return { leaders, totalReferrers: byReferrer.size };
}

/**
 * The referral funnel for Marketing OS / flywheel reporting — every
 * number computed from live records: codes issued, link clicks,
 * invites, attributed bookings, completions, and the credit ledger
 * (issued / redeemed / expired), split by track. Zero-state honest:
 * an empty program reports zeros, never placeholders.
 */
export function getReferralFunnel(companyId = null) {
  const inCompany = (record) => !companyId || record.companyId === companyId;
  const funnelFor = (trackFilter) => {
    const journeys = store.referralJourneys.filter(
      (journey) => inCompany(journey) && (!trackFilter || (journey.track || 'CUSTOMER') === trackFilter),
    );
    const codes = [...store.referrals.values()].filter(
      (referral) => inCompany(referral) && (!trackFilter || (referral.track || 'CUSTOMER') === trackFilter),
    );
    const journeyIds = new Set(journeys.map((journey) => journey.id));
    const credits = store.referralCredits.filter(
      (credit) => inCompany(credit) && (!trackFilter || journeyIds.has(credit.journeyId)),
    );
    const count = (...statuses) => journeys.filter((journey) => statuses.includes(journey.status)).length;
    return {
      codesIssued: codes.length,
      linkClicks: codes.reduce((sum, referral) => sum + (referral.clickCount || 0), 0),
      invites: count('INVITED', 'CLICKED'),
      journeysTotal: journeys.length,
      bookingsAttributed: count('BOOKED', ...COMPLETED_STATUSES),
      completions: count(...COMPLETED_STATUSES),
      pendingApproval: count('REWARD_PENDING_APPROVAL'),
      creditsIssued: credits.filter((credit) => credit.status !== 'VOIDED').length,
      creditsIssuedCents: credits.filter((credit) => credit.status !== 'VOIDED').reduce((sum, credit) => sum + (credit.amountCents || 0), 0),
      creditsAvailable: credits.filter((credit) => credit.status === 'AVAILABLE').length,
      creditsRedeemed: credits.filter((credit) => credit.status === 'REDEEMED').length,
      creditsExpired: credits.filter((credit) => credit.status === 'EXPIRED').length,
      bookingsViaReferral: [...store.bookings.values()].filter(
        (booking) => inCompany(booking) && (booking.referralCode || booking.attribution?.via === 'REFERRAL')
          && (!trackFilter || journeys.some((journey) => journey.bookingId === booking.id)),
      ).length,
    };
  };
  return {
    all: funnelFor(null),
    customer: funnelFor('CUSTOMER'),
    partner: funnelFor('PARTNER'),
    generatedAt: new Date().toISOString(),
  };
}

const EXPIRY_REMINDER_WINDOW_MS = 30 * 24 * 3600 * 1000;

/**
 * Credit expiry enforcement (Phase 2). Phase 1 stamped expiresAt on
 * every issued credit (approved terms: 365 days) but only the redeem
 * path noticed a lapsed date. This sweep is the enforcer:
 *  - AVAILABLE credits past expiresAt become EXPIRED (persisted), the
 *    customer is notified through the outbox, and the parent journey
 *    moves CREDIT_ISSUED → EXPIRED when no live credit remains on it.
 *  - AVAILABLE credits inside their final 30 days get ONE reminder
 *    (the outbox eventKey makes it exactly-once per channel).
 * Called opportunistically: from the staff/cron outbox drains and
 * lazily from the customer dashboard + staff queue reads. Cheap
 * in-memory scan; safe to call often.
 */
export async function sweepReferralCreditExpiry() {
  const now = Date.now();
  let expired = 0;
  let reminded = 0;
  for (const credit of store.referralCredits) {
    if (credit.status !== 'AVAILABLE' || !credit.expiresAt) continue;
    const expiresMs = new Date(credit.expiresAt).getTime();
    if (Number.isNaN(expiresMs)) continue;
    if (expiresMs < now) {
      credit.status = 'EXPIRED';
      credit.updatedAt = new Date().toISOString();
      await persistQuietly('referral credit expiry persist failed', () => persistReferralCredit(credit));
      expired += 1;
      notifyReferralCreditExpired(credit);
      const journey = store.referralJourneys.find((candidate) => candidate.id === credit.journeyId) || null;
      if (journey && journey.status === 'CREDIT_ISSUED') {
        const anyLive = store.referralCredits.some(
          (candidate) => candidate.journeyId === journey.id && candidate.status === 'AVAILABLE',
        );
        if (!anyLive) {
          journey.status = 'EXPIRED';
          await persistQuietly('referral journey expiry persist failed', () => persistReferralJourney(journey));
        }
      }
      appendEvent('REFERRAL_CREDIT_EXPIRED', {
        actor: 'referral-program',
        entityType: 'REFERRAL_CREDIT',
        entityId: credit.id,
        details: { journeyId: credit.journeyId, amountCents: credit.amountCents, expiresAt: credit.expiresAt },
      });
    } else if (expiresMs - now <= EXPIRY_REMINDER_WINDOW_MS) {
      // queueNotification dedupes on the eventKey, so repeat sweeps
      // never re-send the reminder — it is queued exactly once.
      const queued = notifyReferralCreditExpiring(credit);
      if (Array.isArray(queued) && queued.length) reminded += 1;
    }
  }
  return { expired, reminded, scannedAt: new Date(now).toISOString() };
}
