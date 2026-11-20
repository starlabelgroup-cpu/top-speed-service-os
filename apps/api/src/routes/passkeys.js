import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { termsStatusForUser } from '../services/legalTerms.js';
import { beginLayer2Challenge, layer2Applies } from '../services/layer2.js';
import { loginGate as speedyLoginGate } from '../services/speedyVerify.js';
import { recordSignInSession } from '../services/sessions.js';
import {
  beginAuthentication,
  beginRegistration,
  completeAuthentication,
  completeRegistration,
  deleteCredential,
  findUserById,
  listCredentialsForUser,
} from '../services/passkeys.js';
import { publicUser } from './auth.js';

/**
 * Passkey routes (2026-11-20, Wave 3 item F2) — mounted at /api/v1
 * like the auth router, so the /api/v1/auth rate limiter covers them.
 *
 * Registration and management sit behind `authenticate`: a passkey is
 * added from inside a normal session, never from a sign-in challenge
 * (middleware refuses purpose-carrying tokens as sessions).
 *
 * The sign-in pair is public, and its success path runs the account
 * through the SAME pipeline as POST /auth/login — Speedy Verify gate,
 * then Layer 2, then the session — returning the same shapes at every
 * step. A passkey proves the first factor only.
 */
const router = Router();

function serviceError(res, error) {
  const status = error?.status || 500;
  return res.status(status).json({
    error: error?.message || 'Passkey request failed',
    ...(error?.code ? { code: error.code } : {}),
  });
}

const registerOptionsSchema = z.object({
  deviceLabel: z.string().trim().min(1).max(80).optional(),
});

const registerVerifySchema = z.object({
  deviceLabel: z.string().trim().min(1).max(80).optional(),
  response: z.object({}).passthrough(),
});

const loginOptionsSchema = z.object({
  email: z.string().trim().email().max(320),
});

const loginVerifySchema = z.object({
  response: z.object({}).passthrough(),
});

/* --------------------- signed-in management --------------------- */

router.post('/auth/passkeys/register/options', authenticate, async (req, res) => {
  const parsed = registerOptionsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid passkey request', details: parsed.error.flatten() });
  }
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    const { options } = await beginRegistration(user, { deviceLabel: parsed.data.deviceLabel });
    return res.json({ data: { options } });
  } catch (error) {
    return serviceError(res, error);
  }
});

router.post('/auth/passkeys/register/verify', authenticate, async (req, res) => {
  const parsed = registerVerifySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid passkey request', details: parsed.error.flatten() });
  }
  try {
    const credential = await completeRegistration(req.user, {
      response: parsed.data.response,
      deviceLabel: parsed.data.deviceLabel,
    });
    return res.status(201).json({ data: credential });
  } catch (error) {
    return serviceError(res, error);
  }
});

router.get('/auth/passkeys', authenticate, async (req, res) => {
  try {
    const data = await listCredentialsForUser(req.user.id);
    return res.json({ data });
  } catch (error) {
    return serviceError(res, error);
  }
});

router.delete('/auth/passkeys/:id', authenticate, async (req, res) => {
  try {
    const removed = await deleteCredential(req.user.id, req.params.id);
    if (!removed) return res.status(404).json({ error: 'Passkey not found' });
    return res.json({ data: { removed: true } });
  } catch (error) {
    return serviceError(res, error);
  }
});

/* --------------------------- sign-in --------------------------- */

router.post('/auth/passkeys/login/options', async (req, res) => {
  const parsed = loginOptionsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid passkey request', details: parsed.error.flatten() });
  }
  try {
    const { options } = await beginAuthentication(parsed.data.email);
    return res.json({ data: { options } });
  } catch (error) {
    return serviceError(res, error);
  }
});

router.post('/auth/passkeys/login/verify', async (req, res, next) => {
  const parsed = loginVerifySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid passkey request', details: parsed.error.flatten() });
  }
  try {
    const user = await completeAuthentication({ response: parsed.data.response });
    if (!user.active) {
      return res.status(403).json({ error: 'This account is inactive' });
    }

    // The gate pipeline, identical to POST /auth/login from here:
    // Speedy Verify → Layer 2 → session. The passkey replaced the
    // password step and nothing else.
    const gate = await speedyLoginGate(user, { tempAuth: false });
    if (gate.action === 'deny') {
      return res.status(403).json({
        error: 'Speedy Verify required — no access code has been issued for this account yet. Contact the office.',
        code: 'SPEEDY_VERIFY_NO_CODE',
      });
    }
    if (gate.action === 'challenge') {
      return res.json({
        verifyRequired: true,
        code: 'SPEEDY_VERIFY_REQUIRED',
        challenge: gate.challenge,
        expiresInSeconds: gate.expiresInSeconds,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName ?? null,
          lastName: user.lastName ?? null,
        },
      });
    }
    if (layer2Applies(user)) {
      const layer2 = await beginLayer2Challenge(user, { req });
      return res.json(layer2);
    }

    const terms = await termsStatusForUser(user.id);
    const issued = await recordSignInSession(req, user, { alertOnNewDevice: true });
    return res.json({ user: publicUser(user), terms, termsStatus: terms, ...issued });
  } catch (error) {
    if (error?.status) return serviceError(res, error);
    return next(error);
  }
});

export default router;
