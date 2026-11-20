import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { publicUser } from './auth.js';
import { verifyPassword } from '../services/passwords.js';
import { consumeIntakeAttempt } from '../services/intakeShield.js';
import {
  beginLayer2Challenge,
  layer2Applies,
  sendLayer2Code,
  verifyLayer2Code,
} from '../services/layer2.js';
import {
  EMAIL_CHANGE_INVALID_MESSAGE,
  consumeEmailChange,
  emailChangeUsersRepo,
  findEmailConflict,
  requestEmailChange,
} from '../services/emailChange.js';

/**
 * Username (email) change routes (2026-11-20). A sibling router in
 * the routes/layer2.js shape, mounted at /api/v1 in server.js so the
 * paths read /auth/email-change/* and the /api/v1/auth rate limiter
 * throttles them like every other credential-shaped surface.
 * `authenticate` is applied PER ROUTE — never as a router-wide use()
 * — per the shared-prefix rule in ~/AGENTS.md.
 *
 * The request endpoint is a signed-in, multi-guard door, in order:
 *   1. the intake shield's emailChange family (10/hr/IP, durable) —
 *      this door sends real email to a NEW address, so it is capped
 *      even though it requires a session;
 *   2. the current password (the change-password posture: wrong →
 *      401, and nothing is created);
 *   3. same-email → 400, an address held by another account → 409;
 *   4. the Layer 2 step-up when layer2Applies(user): the Layer 2
 *      service is challenge-bound by design (its codes live on a
 *      LoginChallenge behind a signed challenge token), so the
 *      step-up drives its REAL functions — beginLayer2Challenge
 *      opens a challenge for the signed-in account, sendLayer2Code
 *      delivers the code on the account's preferred channel, and
 *      the client resubmits with { layer2Code, layer2Challenge };
 *      verifyLayer2Code consumes the challenge on a correct code.
 *      No code is checked here that the Layer 2 service did not
 *      issue, and no token is created until every guard passes.
 * The confirm endpoint is public: the emailed link is the proof.
 */
const router = Router();

const requestSchema = z.object({
  newEmail: z.string().trim().toLowerCase().email(),
  currentPassword: z.string().min(1).max(200),
  layer2Code: z.string().trim().min(1).max(32).optional(),
  layer2Challenge: z.string().min(10).max(4096).optional(),
});

const confirmSchema = z.object({
  token: z.string().trim().min(10).max(200),
});

function serviceError(res, error) {
  const status = error?.status || 500;
  return res.status(status).json({
    error: error?.message || 'Username change failed',
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(typeof error?.attemptsRemaining === 'number' ? { attemptsRemaining: error.attemptsRemaining } : {}),
    ...(error?.channels ? { channels: error.channels } : {}),
    ...(error?.channel ? { channel: error.channel } : {}),
  });
}

router.post('/auth/email-change/request', authenticate, async (req, res, next) => {
  try {
    if (req.authMode !== 'jwt') {
      return res.status(400).json({ error: 'Sign in with your password to change your username' });
    }
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Enter a valid new email address and your current password', details: parsed.error.flatten() });
    }
    const { newEmail, currentPassword, layer2Code, layer2Challenge } = parsed.data;

    // Guard 1 — intake shield, emailChange family (durable per-IP).
    const shield = await consumeIntakeAttempt('emailChange', req.ip);
    if (!shield.allowed) {
      res.set('Retry-After', String(shield.retryAfterSeconds));
      return res.status(429).json({
        error: 'Too many username-change requests from this connection — please wait a little while and try again, or call us at 844-460-7038.',
        code: 'RATE_LIMITED',
      });
    }

    const user = await emailChangeUsersRepo.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });

    // Guard 2 — current password, exactly as change-password runs it.
    const currentOk = await verifyPassword(currentPassword, user.passwordHash);
    if (!currentOk) {
      return res.status(401).json({ error: 'Current password is incorrect', code: 'CURRENT_PASSWORD_INCORRECT' });
    }

    // Guard 3 — the address must actually change and be free.
    if (newEmail === String(user.email || '').trim().toLowerCase()) {
      return res.status(400).json({ error: 'That is already your current email address', code: 'SAME_EMAIL' });
    }
    if (await findEmailConflict(newEmail, user.id)) {
      return res.status(409).json({ error: 'That email already has a Top Speed account — use a different one', code: 'EMAIL_TAKEN' });
    }

    // Guard 4 — Layer 2 step-up, through the service's real
    // challenge machinery (see the header note).
    if (layer2Applies(user)) {
      if (!layer2Code) {
        try {
          const view = await beginLayer2Challenge(user, { req });
          const sent = await sendLayer2Code(view.challenge);
          return res.json({
            layer2Required: true,
            codeSent: true,
            challenge: view.challenge,
            channel: sent.channel,
            destination: sent.destination,
            channels: view.channels,
            preferredChannel: view.preferredChannel,
            expiresInSeconds: sent.expiresInSeconds,
            message: 'We sent a 6-digit code to finish verifying it is you — enter it here to continue.',
          });
        } catch (error) {
          return serviceError(res, error);
        }
      }
      if (!layer2Challenge) {
        return res.status(400).json({
          error: 'That code step has expired — request a new code and try again.',
          code: 'LAYER2_CHALLENGE_REQUIRED',
        });
      }
      try {
        await verifyLayer2Code(layer2Challenge, layer2Code);
      } catch (error) {
        return serviceError(res, error);
      }
    }

    const { expiresAt } = await requestEmailChange(user, { newEmail, source: 'EMAIL_CHANGE' });
    return res.json({
      ok: true,
      newEmail,
      expiresAt,
      message: `Check your new inbox — a confirmation link is on its way to ${newEmail}. Tap it within 30 minutes to finish the change.`,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/auth/email-change/confirm', async (req, res, next) => {
  try {
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: EMAIL_CHANGE_INVALID_MESSAGE, code: 'EMAIL_CHANGE_INVALID' });
    }
    const { user, newEmail } = await consumeEmailChange(parsed.data.token);
    return res.json({
      ok: true,
      email: newEmail,
      user: publicUser(user),
      message: `Your username is now ${newEmail} — sign in with it next time.`,
    });
  } catch (error) {
    if (error?.status) {
      return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
    return next(error);
  }
});

export default router;
