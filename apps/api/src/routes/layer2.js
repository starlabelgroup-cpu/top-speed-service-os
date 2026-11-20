import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { recordSignInSession } from '../services/sessions.js';
import { termsStatusForUser } from '../services/legalTerms.js';
import { publicUser } from './auth.js';
import {
  layer2StatusView,
  layer2UsersRepo,
  sendLayer2Code,
  updateLayer2Settings,
  verifyLayer2Code,
} from '../services/layer2.js';
import { changeStateJson } from '../services/tempPasswords.js';

/**
 * Layer 2 — 2-step sign-in routes (2026-11-16). Mounted at /api/v1 so
 * the paths read /auth/layer2/*, behind the auth rate limiter
 * (server.js) — code entry is a credential-shaped surface and gets
 * the same throttle as login, exactly like Speedy Verify.
 *
 * The send/verify pair is public-but-bound: both need the signed
 * 10-minute challenge that POST /auth/login (or the Speedy Verify
 * exchange, or the Google callback) issued after the first factor.
 * The settings trio needs a real session (authenticate) — a Layer 2
 * challenge token is refused there, because middleware/auth.js
 * rejects purpose-carrying tokens as sessions.
 */
const router = Router();

const sendSchema = z.object({
  challenge: z.string().min(10).max(4096),
  channel: z.enum(['EMAIL', 'SMS', 'email', 'sms']).optional(),
});

const verifySchema = z.object({
  challenge: z.string().min(10).max(4096),
  code: z.string().trim().min(1).max(32),
});

const settingsSchema = z.object({
  channel: z.enum(['EMAIL', 'SMS', 'email', 'sms']).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
});

function serviceError(res, error) {
  const status = error?.status || 500;
  return res.status(status).json({
    error: error?.message || 'Layer 2 failed',
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(typeof error?.attemptsRemaining === 'number' ? { attemptsRemaining: error.attemptsRemaining } : {}),
    ...(error?.channels ? { channels: error.channels } : {}),
    ...(error?.channel ? { channel: error.channel } : {}),
  });
}

// Step 2, part 1: send the 6-digit code on the chosen channel.
router.post('/auth/layer2/send', async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid code request', details: parsed.error.flatten() });
  }
  try {
    const result = await sendLayer2Code(parsed.data.challenge, parsed.data.channel);
    return res.json(result);
  } catch (error) {
    return serviceError(res, error);
  }
});

// Step 2, part 2: challenge + code → the real session. The session
// inherits the sv claim when this sign-in already passed Speedy
// Verify upstream (the challenge token carries it).
router.post('/auth/layer2/verify', async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid code-step request', details: parsed.error.flatten() });
  }
  try {
    const { user, speedyVerified, tempAuth } = await verifyLayer2Code(parsed.data.challenge, parsed.data.code);
    // Temporary-password sign-in (2026-11-17): the code step passed,
    // but a temporary password never opens a session — the pipeline
    // ends in the forced password change.
    if (tempAuth) {
      return res.json(await changeStateJson(user, { speedyVerified }));
    }
    const terms = await termsStatusForUser(user.id);
    return res.json({
      user: publicUser(user),
      terms,
      termsStatus: terms,
      ...(await recordSignInSession(req, user, { speedyVerified, alertOnNewDevice: true })),
    });
  } catch (error) {
    return serviceError(res, error);
  }
});

// Settings: the signed-in account's own Layer 2 state.
router.get('/auth/layer2/status', authenticate, async (req, res, next) => {
  try {
    const user = await layer2UsersRepo.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    return res.json({ layer2: layer2StatusView(user) });
  } catch (error) {
    return next(error);
  }
});

// Enroll: turn Layer 2 ON for this account (existing accounts are
// grandfathered until they opt in here, or the Master requires it).
// Takes effect at the next sign-in; the current session is untouched.
router.post('/auth/layer2/enroll', authenticate, async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid enroll request', details: parsed.error.flatten() });
  }
  try {
    const user = await layer2UsersRepo.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    const view = await updateLayer2Settings(user, {
      required: true,
      phone: parsed.data.phone,
      channel: parsed.data.channel ? parsed.data.channel.toUpperCase() : undefined,
    });
    return res.json({ layer2: view });
  } catch (error) {
    return serviceError(res, error);
  }
});

// Update: channel preference and/or the text-message phone number.
router.post('/auth/layer2/update', authenticate, async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid update request', details: parsed.error.flatten() });
  }
  try {
    const user = await layer2UsersRepo.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    const view = await updateLayer2Settings(user, {
      phone: parsed.data.phone,
      channel: parsed.data.channel ? parsed.data.channel.toUpperCase() : undefined,
    });
    return res.json({ layer2: view });
  } catch (error) {
    return serviceError(res, error);
  }
});

// Disable: the account holder turns their own Layer 2 off. (Accounts
// the Master later mandates are a separate, Master-side control —
// see the design note in services/layer2.js.)
router.post('/auth/layer2/disable', authenticate, async (req, res) => {
  try {
    const user = await layer2UsersRepo.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    const view = await updateLayer2Settings(user, { required: false });
    return res.json({ layer2: view });
  } catch (error) {
    return serviceError(res, error);
  }
});

export default router;
