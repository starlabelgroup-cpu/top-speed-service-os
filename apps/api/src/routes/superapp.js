import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  buildActivityFeed,
  buildOrderTrail,
  commercialSummaryFor,
  departmentBoard,
  listCustomerJobs,
  resolveCustomerContext,
} from '../services/superapp.js';

/**
 * Super Apps surface (2026-11-12): the unified customer views over the
 * one Service OS — activity feed, per-job department trail, job list,
 * the commercial file, and the public department board. All reads are
 * scoped to the signed-in customer's own records via the same identity
 * matching the Connect surfaces use.
 */
const router = Router();

router.get('/connect/activity', authenticate, (req, res) => {
  const context = resolveCustomerContext(req.user);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 60));
  return res.json({ data: { events: buildActivityFeed(context, { limit }) } });
});

router.get('/connect/jobs', authenticate, (req, res) => {
  const context = resolveCustomerContext(req.user);
  return res.json({ data: { jobs: listCustomerJobs(context) } });
});

router.get('/connect/jobs/:reference', authenticate, (req, res) => {
  const context = resolveCustomerContext(req.user);
  const trail = buildOrderTrail(context, req.params.reference);
  if (!trail) return res.status(404).json({ error: 'Job not found on your account' });
  return res.json({ data: trail });
});

router.get('/connect/commercial', authenticate, (req, res) => {
  const context = resolveCustomerContext(req.user);
  return res.json({ data: commercialSummaryFor(context) });
});

/** Public, aggregate-only: counts and status lines, never names or money. */
router.get('/platform/departments', (req, res) => {
  return res.json({ data: departmentBoard() });
});

export default router;
