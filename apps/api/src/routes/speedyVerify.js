import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { signAccessToken } from '../services/tokens.js';
import { termsStatusForUser } from '../services/legalTerms.js';
import { publicUser } from './auth.js';
import {
  confirmMasterRecovery,
  issueCode,
  listVerifyAccounts,
  requestMasterRecovery,
  revokeCode,
  setRequirement,
  verifyChallengeCode,
} from '../services/speedyVerify.js';
import {
  beginLayer2Challenge,
  invalidatePendingChallenges,
  layer2Applies,
} from '../services/layer2.js';

/**
 * Speedy Verify routes (Phase 1, 2026-11-16) — mounted at
 * /api/v1/speedy-verify behind the auth rate limiter (server.js).
 *
 * The code step and the Master recovery path are public-but-bound: the
 * code step needs the signed 10-minute challenge from POST /auth/login,
 * and recovery needs the single-use token from the Master's own mailbox.
 * Everything that changes a code or a requirement is Master-only:
 * requireRole(COMPANY_OWNER) — a manager or platform admin gets 403,
 * because codes are the Master's permission, not a staff tool.
 */
const router = Router();

const verifySchema = z.object({
  challenge: z.string().min(10).max(4096),
  code: z.string().trim().min(1).max(32),
});

const userIdSchema = z.object({ userId: z.string().uuid() });

const requirementSchema = z.object({
  userId: z.string().uuid(),
  required: z.boolean(),
});

function serviceError(res, error) {
  const status = error?.status || 500;
  return res.status(status).json({
    error: error?.message || 'Speedy Verify failed',
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(typeof error?.attemptsRemaining === 'number' ? { attemptsRemaining: error.attemptsRemaining } : {}),
  });
}

async function sessionResponse(res, user, { speedyVerified }) {
  const terms = await termsStatusForUser(user.id);
  return res.json({
    user: publicUser(user),
    terms,
    termsStatus: terms,
    ...signAccessToken(user, { speedyVerified }),
  });
}

// The code step: challenge (from login) + the 8-digit code → session.
// Layer 2 (2026-11-16) sits AFTER this step in the pipeline: when the
// account also has the per-login email/text code on, the exchange
// returns a Layer 2 challenge instead of the session, and the Layer 2
// verify issues the session with the sv claim carried through.
router.post('/verify', async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid code-step request', details: parsed.error.flatten() });
  }
  try {
    const { user, alreadySatisfied } = await verifyChallengeCode(parsed.data.challenge, parsed.data.code);
    if (layer2Applies(user)) {
      const layer2 = await beginLayer2Challenge(user, { speedyVerified: !alreadySatisfied, req });
      return res.json(layer2);
    }
    return sessionResponse(res, user, { speedyVerified: !alreadySatisfied });
  } catch (error) {
    return serviceError(res, error);
  }
});

// Master recovery — step 1: ask for the email. The response is identical
// whether or not the address is the Master's, so it reveals nothing.
router.post('/recover', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email : '';
  try {
    await requestMasterRecovery(email);
  } catch {
    // Queueing trouble must not change the neutral answer.
  }
  return res.status(202).json({
    ok: true,
    message: 'If that email belongs to the Master account, a recovery link is on its way to it.',
  });
});

// Master recovery — step 2: the emailed single-use token. Only the
// Master account can complete it (enforced in the service).
router.post('/recover/confirm', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!token) return res.status(400).json({ error: 'A recovery token is required' });
  try {
    const user = await confirmMasterRecovery(token);
    // Rule Zero hygiene (2026-11-16): owner-email recovery also
    // clears Layer 2 for the recovered account — any pending
    // challenge is invalidated, and the Master is exempt from the
    // layer by construction, so the recovery session is never
    // blocked by it.
    await invalidatePendingChallenges(user.id);
    return sessionResponse(res, user, { speedyVerified: false });
  } catch (error) {
    return serviceError(res, error);
  }
});

const masterOnly = [authenticate, requireRole(ROLES.COMPANY_OWNER)];

// The Master's panel data: covered accounts, states, approval queue.
router.get('/accounts', ...masterOnly, async (req, res) => {
  try {
    const accounts = await listVerifyAccounts();
    return res.json({
      data: accounts,
      pendingApprovals: accounts.filter((row) => row.verify.pendingApproval).length,
    });
  } catch (error) {
    return serviceError(res, error);
  }
});

// Issue (or reset) an account's code. The plain code is in THIS response
// only — shown to the Master once so he can hand it over.
router.post('/issue', ...masterOnly, async (req, res) => {
  const parsed = userIdSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid issue request', details: parsed.error.flatten() });
  try {
    const { code, state } = await issueCode(req.user, parsed.data.userId);
    return res.json({ code, verify: state });
  } catch (error) {
    return serviceError(res, error);
  }
});

router.post('/revoke', ...masterOnly, async (req, res) => {
  const parsed = userIdSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid revoke request', details: parsed.error.flatten() });
  try {
    const state = await revokeCode(parsed.data.userId);
    return res.json({ verify: state });
  } catch (error) {
    return serviceError(res, error);
  }
});

router.post('/requirement', ...masterOnly, async (req, res) => {
  const parsed = requirementSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid requirement request', details: parsed.error.flatten() });
  try {
    const state = await setRequirement(parsed.data.userId, parsed.data.required);
    return res.json({ verify: state });
  } catch (error) {
    return serviceError(res, error);
  }
});

export default router;
