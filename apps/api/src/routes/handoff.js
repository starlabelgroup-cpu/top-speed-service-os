import { Router } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { authenticate } from '../middleware/auth.js';
import { HANDOFF_AUDIENCES, consumeHandoff, createHandoff, findUserById, findUsersByEmailOrPhone } from '../services/handoff.js';
import { signAccessToken } from '../services/tokens.js';
import { queueNotification } from '../services/notifications.js';

/**
 * Cross-site sign-in handoff (Super Apps, 2026-11-12).
 *
 * POST /auth/handoff (signed in): mint a one-time token for a target
 * audience. POST /auth/handoff/consume (public): exchange it — once,
 * within five minutes, for the audience it was issued to — for a fresh
 * session on that surface.
 *
 * POST /auth/claim-link (public) is the topspeedappliance.net path: a
 * .net booking is a guest booking on this same backend, so the customer
 * proves the booking the way the public tracker does (reference +
 * phone) and we email a handoff link to the address on the account that
 * matches the booking. Nothing is signed in by the claim itself, and
 * the response never reveals whether an account exists beyond what the
 * booking check itself proves.
 */
const router = Router();

const handoffSchema = z.object({
  audience: z.enum(HANDOFF_AUDIENCES),
});

const consumeSchema = z.object({
  token: z.string().trim().min(16).max(200),
  audience: z.enum(HANDOFF_AUDIENCES),
});

const claimSchema = z.object({
  reference: z.string().trim().min(4).max(32),
  phone: z.string().trim().min(7).max(30),
});

function publicUser(user) {
  return {
    id: user.id,
    companyId: user.companyId,
    email: user.email,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    phone: user.phone ?? null,
    roles: user.roles,
    active: user.active,
  };
}

const AUDIENCE_URLS = {
  'connect-pro': 'https://topspeedserviceos.com/connect-pro-app',
  'appliance-pro': 'https://topspeedserviceos.com/appliance-pro',
  'customer-app': 'https://topspeedserviceos.com/app',
  flagship: 'https://topspeedserviceos.com/',
};

router.post('/auth/handoff', authenticate, async (req, res) => {
  const parsed = handoffSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid handoff request', details: parsed.error.flatten() });
  }
  try {
    const handoff = await createHandoff(req.user.id, parsed.data.audience);
    return res.status(201).json({
      data: { ...handoff, url: `${AUDIENCE_URLS[parsed.data.audience]}?handoff=${handoff.token}` },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Handoff failed', ...(error.code ? { code: error.code } : {}) });
  }
});

router.post('/auth/handoff/consume', async (req, res) => {
  const parsed = consumeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid handoff token', details: parsed.error.flatten() });
  }
  try {
    const { userId } = await consumeHandoff(parsed.data.token, parsed.data.audience);
    const user = await findUserById(userId);
    if (!user || user.active === false) {
      return res.status(403).json({ error: 'This account is inactive' });
    }
    return res.json({ user: publicUser(user), ...signAccessToken(user) });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Handoff failed', ...(error.code ? { code: error.code } : {}) });
  }
});

router.post('/auth/claim-link', async (req, res) => {
  const parsed = claimSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid claim request', details: parsed.error.flatten() });
  }
  const reference = parsed.data.reference.toUpperCase();
  const phoneDigits = parsed.data.phone.replace(/\D/g, '').slice(-10);
  const booking = [...store.bookings.values()].find(
    (b) => String(b.referenceCode || '').toUpperCase() === reference,
  );
  // Same verification bar as the public tracker: reference + phone.
  if (!booking || String(booking.customer?.phone || '').replace(/\D/g, '').slice(-10) !== phoneDigits) {
    return res.status(404).json({ error: 'No booking found for that reference and phone' });
  }
  const customerEmail = String(booking.customer?.email || '').toLowerCase();
  const accounts = await findUsersByEmailOrPhone(customerEmail, phoneDigits);
  const account = accounts.find((u) => u.active !== false);
  if (account && account.email) {
    const handoff = await createHandoff(account.id, 'connect-pro');
    const link = `${AUDIENCE_URLS['connect-pro']}?handoff=${handoff.token}`;
    queueNotification({
      channel: 'email',
      template: 'SIGNIN_LINK',
      to: account.email,
      payload: {
        subject: 'Your Top Speed sign-in link',
        message:
          `Hi ${account.firstName || 'there'} — here is your one-time sign-in link for the Top Speed app ` +
          `(booking ${booking.referenceCode}). It works once and expires in 5 minutes:\n\n${link}\n\n` +
          'Your appliances, service history, tracking and referrals are all on the same account. ' +
          'If you did not request this, you can ignore this email — your password is unchanged.',
        reference: booking.referenceCode,
      },
      eventKey: `signin-link:${booking.id}:${handoff.token.slice(0, 8)}`,
      eventType: 'ACCOUNT',
    });
  }
  // Identical response whether or not an account matched: the booking
  // check above is the only fact this endpoint confirms.
  return res.json({
    data: {
      ok: true,
      message: account
        ? 'Your sign-in link is on its way to the email on your account. It works once and expires in 5 minutes.'
        : 'That booking is on file. No app account matches it yet — create your free account with the same email or phone and your history connects automatically.',
    },
  });
});

export default router;
