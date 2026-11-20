import { Router } from 'express';
import { store } from '../data/store.js';
import {
  ADS_OS_KEY_HEADER,
  adsOsConfigured,
  adsOsKeyMatches,
  buildAdsOsSummary,
} from '../services/adsOsSummary.js';

/**
 * Top Speed Ads OS integration (2026-11-20): the read-only summary
 * feed the Ads OS console's advertising flywheel reads from Service
 * OS — bookings grouped by advertising source label, bookings by
 * status, and completed-job counts, all-time and last 30 days.
 * Counts and labels only; no PII ever leaves through this door,
 * and the route writes nothing.
 *
 * Auth is a dedicated service key in the x-ads-os-key header,
 * checked against the ADS_OS_SERVICE_KEY environment variable —
 * the same env-secret discipline as the cron drains in
 * routes/integrations.js, with one deliberate difference in shape:
 * an unset key answers 503 ADS_OS_NOT_CONFIGURED ("integration not
 * configured") rather than 403, so the console can distinguish
 * "not set up yet" from "set up and refusing" (401). The key value
 * itself is set in the host environment by the owner; it never
 * appears in code.
 */

const router = Router();

router.get('/integrations/ads-os/summary', (req, res) => {
  if (!adsOsConfigured()) {
    return res.status(503).json({
      error: 'Ads OS integration is not configured (the service key environment variable is not set)',
      code: 'ADS_OS_NOT_CONFIGURED',
    });
  }
  if (!adsOsKeyMatches(req.get(ADS_OS_KEY_HEADER))) {
    return res.status(401).json({ error: 'Invalid Ads OS service key', code: 'ADS_OS_UNAUTHORIZED' });
  }
  return res.json({ data: buildAdsOsSummary([...store.bookings.values()]) });
});

export default router;
