import { Router } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import {
  approveReward,
  createInvite,
  getCustomerDashboard,
  getProgramSettings,
  recordClick,
  redeemCredit,
  rejectReward,
  resolveCode,
  updateProgramSettings,
} from '../services/referrals.js';

/**
 * ApplianceReferral rewards program — HTTP surface (Phase 1, 2026-11-12).
 *
 * Public: code resolution for the /refer landing (increments the click
 * count) and consent-gated invites. Customer: GET /referrals/me returns
 * the signed-in customer's own dashboard. Staff: the reward approval
 * queue and credit redemption are staffOnly; program settings (the
 * reward amounts) are ownerOnly — money configuration follows the
 * admin/finance precedent.
 *
 * HARD RULE honored here: the public resolve response carries the
 * PUBLISHED new-customer welcome offer only — never a referrer-reward
 * figure. Reward amounts exist solely in the owner-configured program
 * settings and in issued credit records.
 */
const router = Router();

const staffOnly = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];
const ownerOnly = [authenticate, requireCompany, requireRole('COMPANY_OWNER', 'PLATFORM_ADMIN')];

const WELCOME_OFFER = {
  title: 'New Customer Welcome',
  text: '$25 off your first eligible repair — for new registered customers. Minimum service charge and exclusions apply.',
};

function sendServiceError(res, error) {
  const status = error?.status || 500;
  return res.status(status).json({
    error: error?.message || 'Referral request failed',
    ...(error?.code ? { code: error.code } : {}),
  });
}

function companyScoped(req, record) {
  return req.user.roles.includes(ROLES.PLATFORM_ADMIN) || record.companyId === req.companyId;
}

/* ------------------------------------------------------------------ */
/* Customer dashboard                                                  */
/* ------------------------------------------------------------------ */

/**
 * Resolve the signed-in user to one of their customer records, the same
 * way GET /connect/promotions does (userId, then email, then phone —
 * a customer gains a record per booking).
 */
function customerRecordForUser(user) {
  const record = store.users.get(user.id) || {};
  const email = String(record.email || user.email || '').toLowerCase();
  const phoneDigits = String(record.phone || user.phone || '').replace(/\D/g, '').slice(-10);
  for (const customer of store.customers.values()) {
    if (customer.userId && customer.userId === user.id) return customer;
  }
  for (const booking of store.bookings.values()) {
    const booked = booking.customer || {};
    if (booked.userId && booked.userId === user.id) return store.customers.get(booking.customerId) || booked;
    if (email && String(booked.email || '').toLowerCase() === email) return store.customers.get(booking.customerId) || booked;
    if (phoneDigits && String(booked.phone || '').replace(/\D/g, '').slice(-10) === phoneDigits) {
      return store.customers.get(booking.customerId) || booked;
    }
  }
  return null;
}

router.get('/referrals/me', authenticate, (req, res) => {
  const customer = customerRecordForUser(req.user);
  return res.json({ data: getCustomerDashboard(customer) });
});

/* ------------------------------------------------------------------ */
/* Public: resolve + invite                                            */
/* ------------------------------------------------------------------ */

router.get('/referrals/resolve/:code', async (req, res) => {
  const referral = resolveCode(req.params.code);
  if (!referral) {
    return res.json({ data: { found: false, referrerFirstName: null, welcomeOffer: WELCOME_OFFER } });
  }
  await recordClick(referral.code);
  const referrer = referral.customerId ? store.customers.get(referral.customerId) : null;
  const referrerName = referral.customerName || referrer?.name || null;
  const referrerFirstName = referrerName ? String(referrerName).trim().split(/\s+/)[0] : null;
  return res.json({ data: { found: true, referrerFirstName, welcomeOffer: WELCOME_OFFER } });
});

const inviteSchema = z.object({
  code: z.string().trim().min(4).max(32),
  friendName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(30).optional(),
  email: z.string().email().optional(),
  consent: z.boolean().optional(),
});

router.post('/referrals/invite', async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid invite', details: parsed.error.flatten() });
  }
  if (parsed.data.consent !== true) {
    return res.status(422).json({ error: 'Consent is required to send an invite', code: 'CONSENT_REQUIRED' });
  }
  if (!parsed.data.phone && !parsed.data.email) {
    return res.status(422).json({ error: 'Provide a phone number or an email for your friend', code: 'CONTACT_REQUIRED' });
  }
  try {
    const { journey, created } = await createInvite({
      code: parsed.data.code,
      friendName: parsed.data.friendName,
      phone: parsed.data.phone || null,
      email: parsed.data.email || null,
      source: 'REFERRAL_INVITE',
    });
    return res.status(created ? 201 : 200).json({
      data: { journeyId: journey.id, status: journey.status, created },
    });
  } catch (error) {
    return sendServiceError(res, error);
  }
});

/* ------------------------------------------------------------------ */
/* Staff: approval queue, decisions, credit redemption                 */
/* ------------------------------------------------------------------ */

router.get('/referrals/admin/queue', ...staffOnly, (req, res) => {
  const status = String(req.query.status || 'REWARD_PENDING_APPROVAL').trim().toUpperCase();
  const journeys = store.referralJourneys
    .filter((journey) => companyScoped(req, journey))
    .filter((journey) => status === 'ALL' || journey.status === status)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const credits = store.referralCredits
    .filter((credit) => companyScoped(req, credit))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const counts = {};
  for (const journey of store.referralJourneys) {
    if (!companyScoped(req, journey)) continue;
    counts[journey.status] = (counts[journey.status] || 0) + 1;
  }
  counts.creditsAvailable = credits.filter((credit) => credit.status === 'AVAILABLE').length;
  counts.creditsRedeemed = credits.filter((credit) => credit.status === 'REDEEMED').length;
  return res.json({ data: { status, journeys, credits, counts } });
});

const approveSchema = z.object({
  amountCents: z.number().int().positive().optional(),
});

router.post('/referrals/admin/journeys/:id/approve', ...staffOnly, async (req, res) => {
  const parsed = approveSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid approval', details: parsed.error.flatten() });
  }
  try {
    const { journey, credit, bonusCredit } = await approveReward(req.params.id, req.user, parsed.data.amountCents ?? null);
    return res.json({
      data: {
        journey,
        credit,
        ...(bonusCredit ? { bonusCredit, milestoneBonusIssued: true } : { milestoneBonusIssued: false }),
      },
    });
  } catch (error) {
    return sendServiceError(res, error);
  }
});

const rejectSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

router.post('/referrals/admin/journeys/:id/reject', ...staffOnly, async (req, res) => {
  const parsed = rejectSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid rejection', details: parsed.error.flatten() });
  }
  try {
    const { journey } = await rejectReward(req.params.id, req.user, parsed.data.note || null);
    return res.json({ data: { journey } });
  } catch (error) {
    return sendServiceError(res, error);
  }
});

const redeemSchema = z.object({
  bookingReference: z.string().trim().min(4).max(32),
});

router.post('/referrals/admin/credits/:id/redeem', ...staffOnly, async (req, res) => {
  const parsed = redeemSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid redemption', details: parsed.error.flatten() });
  }
  try {
    const { credit, journey } = await redeemCredit(req.params.id, parsed.data.bookingReference, req.user);
    return res.json({ data: { credit, journey } });
  } catch (error) {
    return sendServiceError(res, error);
  }
});

/* ------------------------------------------------------------------ */
/* Owner: program settings (the reward amounts live here, only here)   */
/* ------------------------------------------------------------------ */

router.get('/referrals/admin/settings', ...staffOnly, (req, res) => {
  return res.json({ data: getProgramSettings(req.companyId) });
});

const amountField = z.number().int().positive().nullable().optional();
const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  rewardAmountCents: amountField,
  tier2Threshold: amountField,
  tier2AmountCents: amountField,
  tier3Threshold: amountField,
  tier3AmountCents: amountField,
  milestoneBonuses: z.array(z.object({
    at: z.number().int().positive(),
    amountCents: z.number().int().positive(),
  }).strict()).nullable().optional(),
  monthlyCapPerReferrer: amountField,
  rewardExpiryDays: amountField,
}).strict();

router.put('/referrals/admin/settings', ...ownerOnly, async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid referral program settings', details: parsed.error.flatten() });
  }
  const settings = await updateProgramSettings(req.companyId, parsed.data, req.user?.email || null);
  return res.json({ data: settings });
});

export default router;
