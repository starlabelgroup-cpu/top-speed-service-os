import { Router } from 'express';
import { z } from 'zod';
import { consumeIntakeAttempt } from '../services/intakeShield.js';
import { decideEstimateApproval, resolveEstimateApproval } from '../services/estimateApproval.js';

/**
 * Estimate approval page API (2026-11-20, Wave 1 D3) — the public,
 * token-gated half of services/estimateApproval.js. The customer
 * arrives from a link staff sent through the Link Center; the
 * booking reference + the per-estimate token are the credential
 * (the receipt pattern: ref plus a secret only the recipient holds).
 *
 *   GET  /estimate-approval?ref&token — the estimate exactly as
 *        saved + the link's state (PENDING / DECIDED / EXPIRED /
 *        SUPERSEDED). Unknown ref/token pairs answer one generic
 *        404 so the endpoint never confirms which half was wrong.
 *   POST /estimate-approval/decide { ref, token, decision, reason? }
 *        — records APPROVED / DECLINED through the shared job-money
 *        recorder. One decision per link: a decided link answers
 *        with the recorded outcome and changes nothing.
 *
 * Both handlers sit behind the intake shield's estimateApproval
 * family (60/hr/IP — a guessing brake; the token is a 32-byte
 * secret). Per-route wiring only: this router mounts at the shared
 * /api/v1 prefix, so nothing here gates a sibling router.
 */
const router = Router();

async function shieldGuard(req, res) {
  const shield = await consumeIntakeAttempt('estimateApproval', req.ip);
  if (shield.allowed) return true;
  res.set('Retry-After', String(shield.retryAfterSeconds));
  res.status(429).json({
    error: 'Too many attempts from this connection — please wait a little while and try again, or call us at 844-460-7038.',
    code: 'RATE_LIMITED',
  });
  return false;
}

function sendError(res, error) {
  const status = error?.status || 500;
  return res.status(status).json({
    error: error?.message || 'Something went wrong',
    ...(error?.code ? { code: error.code } : {}),
  });
}

router.get('/estimate-approval', async (req, res) => {
  try {
    if (!(await shieldGuard(req, res))) return;
    const ref = String(req.query.ref || '');
    const token = String(req.query.token || '');
    if (!ref || !token) {
      return res.status(404).json({ error: 'This estimate link is invalid', code: 'ESTIMATE_LINK_INVALID' });
    }
    const view = await resolveEstimateApproval(ref, token);
    return res.json({ data: view });
  } catch (error) {
    return sendError(res, error);
  }
});

const decideSchema = z.object({
  ref: z.string().trim().min(1).max(40),
  token: z.string().trim().min(1).max(200),
  decision: z.enum(['APPROVED', 'DECLINED']),
  reason: z.string().trim().max(300).optional().nullable(),
});

router.post('/estimate-approval/decide', async (req, res) => {
  try {
    if (!(await shieldGuard(req, res))) return;
    const parsed = decideSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid decision', details: parsed.error.flatten() });
    }
    const result = await decideEstimateApproval(parsed.data.ref, parsed.data.token, {
      decision: parsed.data.decision,
      reason: parsed.data.reason || null,
    });
    return res.json({ data: result });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
