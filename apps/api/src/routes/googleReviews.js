import { Router } from 'express';
import { fetchGoogleReviews } from '../services/googleReviews.js';

/**
 * Google reviews — public display feed (recommendations A2,
 * 2026-11-20).
 *
 * GET /google-reviews serves the flagship website's Google-reviews
 * component. It returns real Google Business Profile reviews ONLY
 * when the GBP OAuth connection exists; while it does not (the
 * current state), the answer is { available: false, reviews: [] }
 * and the component renders nothing — no placeholder, no stars.
 * Public by design: everything it can ever return is already public
 * on Google. Short cache so a page view storm never hammers the
 * upstream API once the connection exists.
 */
const router = Router();

router.get('/google-reviews', async (req, res) => {
  const data = await fetchGoogleReviews();
  res.set('Cache-Control', 'public, max-age=300');
  return res.json({ data });
});

export default router;
