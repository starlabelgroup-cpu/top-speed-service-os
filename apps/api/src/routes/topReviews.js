import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { topReviewsSummary, topReviewsConsole } from '../services/topReviews.js';

/**
 * Top Reviews and Rewards (Ramone's directive, 2026-11-25).
 *
 * GET /top-reviews/summary — public: the aggregate the customer
 * platforms render (real published-review stats, the honest Google
 * connection state, rewards totals). Nothing customer-identifying
 * is ever in it.
 *
 * GET /top-reviews/console — staff (STAFF_ROLES, per-route so the
 * gate scopes to this router's own paths only): the funnel, the
 * rewards ledger, and the Map Pack / Local Services Ads readiness
 * boards behind the Top Reviews console page.
 */
const router = Router();

router.get('/top-reviews/summary', async (req, res) => {
  const data = await topReviewsSummary();
  res.set('Cache-Control', 'public, max-age=120');
  return res.json({ data });
});

router.get('/top-reviews/console', authenticate, requireRole(...STAFF_ROLES), async (req, res) => {
  const data = await topReviewsConsole();
  return res.json({ data });
});

export default router;
