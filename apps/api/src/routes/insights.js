import { Router } from 'express';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { db } from '../db/client.js';
import {
  buildOverview,
  buildCallsBySource,
  refreshPageSpeed,
  latestPageSpeed,
  googleConnections,
} from '../services/insights.js';

/**
 * Service OS Insights — web traffic & website activity manager
 * (2026-11-17).
 *
 * Staff-gated, scoped to this router's own subpath (the /api/v1
 * shared-prefix rule): the gate below applies ONLY under /insights.
 * Roles: the staff set (Service Setters, managers, the Master, platform
 * admin) plus MARKETING_MANAGER, who runs the Flywheel/Marketing OS
 * consoles this board feeds.
 *
 * Data honesty: /overview serves FIRST-PARTY counts from the OS
 * database only; /connections reports the real Google connection state
 * and never a metric; /pagespeed serves stored snapshots from live
 * PageSpeed Insights API fetches, failures recorded as failures.
 */
const router = Router();

const insightsStaff = [
  authenticate,
  requireCompany,
  requireRole(
    ROLES.DISPATCHER,
    ROLES.COMPANY_ADMIN,
    ROLES.COMPANY_OWNER,
    ROLES.PLATFORM_ADMIN,
    ROLES.MARKETING_MANAGER,
    ROLES.AD_SPECIALIST,
  ),
];
router.use('/insights', ...insightsStaff);

router.get('/insights/overview', async (req, res) => {
  try {
    return res.json({ data: await buildOverview(db()) });
  } catch (error) {
    console.error('insights overview failed:', error);
    return res.status(500).json({ error: 'Insights overview failed' });
  }
});

router.get('/insights/pagespeed', async (req, res) => {
  try {
    return res.json({ data: await latestPageSpeed(db()) });
  } catch (error) {
    console.error('insights pagespeed read failed:', error);
    return res.status(500).json({ error: 'PageSpeed snapshots failed to load' });
  }
});

router.post('/insights/pagespeed/refresh', async (req, res) => {
  const prisma = db();
  if (!prisma) {
    return res.status(503).json({
      error: 'Database not connected — PageSpeed snapshots cannot be stored in skeleton mode.',
    });
  }
  try {
    const summary = await refreshPageSpeed(prisma);
    return res.json({ data: summary });
  } catch (error) {
    console.error('insights pagespeed refresh failed:', error);
    return res.status(500).json({ error: 'PageSpeed refresh failed' });
  }
});

router.get('/insights/connections', async (req, res) => {
  return res.json({ data: googleConnections() });
});

/**
 * Calls & texts by source (2026-11-20, Wave 3 E7) — the Tracking
 * Number System's real ContactEvent counts (28 days), grouped by
 * surface, by number, and an honest unattributed bucket. Sits next
 * to the Google data on the Insights board; first-party records
 * only, no Google data is mixed in.
 */
router.get('/insights/calls', async (req, res) => {
  try {
    return res.json({ data: await buildCallsBySource() });
  } catch (error) {
    console.error('insights calls-by-source failed:', error);
    return res.status(500).json({ error: 'Calls-by-source failed to load' });
  }
});

export default router;
