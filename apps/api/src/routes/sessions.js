import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  listSessionsForUser,
  revokeOtherSessions,
  revokeSession,
} from '../services/sessions.js';

/**
 * Session manager routes (2026-11-20, Wave 3 item F3) — mounted at
 * /api/v1 like the auth router. Every route is behind `authenticate`
 * and scoped to the caller's own account: a session id belonging to
 * someone else reads as not found, never as forbidden fruit.
 *
 * Signing out a device revokes only that session's row; the account,
 * its password, and every other device are untouched. If the caller
 * revokes the session they are using, the response still succeeds —
 * the client discards its token and lands on the sign-in form.
 */
const router = Router();

router.get('/auth/sessions', authenticate, async (req, res, next) => {
  try {
    const data = await listSessionsForUser(req.user.id, req.sessionId);
    return res.json({ data });
  } catch (error) {
    return next(error);
  }
});

router.delete('/auth/sessions/:id', authenticate, async (req, res, next) => {
  try {
    const revoked = await revokeSession(req.user.id, req.params.id);
    if (!revoked) return res.status(404).json({ error: 'Session not found' });
    return res.json({ data: { revoked: true, current: req.sessionId === req.params.id } });
  } catch (error) {
    return next(error);
  }
});

router.post('/auth/sessions/revoke-others', authenticate, async (req, res, next) => {
  try {
    const revoked = await revokeOtherSessions(req.user.id, req.sessionId);
    return res.json({ data: { revoked } });
  } catch (error) {
    return next(error);
  }
});

export default router;
