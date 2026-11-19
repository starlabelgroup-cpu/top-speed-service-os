import { Router } from 'express';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { buildInterconnectRegistry } from '../services/interconnectRegistry.js';

/**
 * Platform Interconnect console API (2026-11-19).
 *
 * Ramone's direction: "Write a super advanced software that
 * interconnect every platforms." The interconnect layer itself is
 * the one backend every surface already shares — universal signed-in
 * travel (services/sessionHandoff.js + the per-host /auth-handoff/
 * receivers), the durable cross-platform event feed
 * (db/platformEventsRepo.js behind GET /platform/events), and this
 * registry: the Workstation's map of every platform in the ecosystem
 * with its REAL connection state.
 *
 *   GET /interconnect/registry — every surface with its identity
 *   travel state (receiver live / shipped-pending-promotion / not
 *   built, with the date it was verified by an actual fetch), its
 *   API path to the one backend, the shared services it uses, and
 *   its most recent real event from the durable feed.
 *
 * Gate: the staff set exactly (STAFF_ROLES), carried PER ROUTE. This
 * router is mounted at the shared /api/v1 prefix, so there is
 * deliberately NO unscoped router.use gate here — an unscoped gate
 * on a shared-prefix router walls every router mounted after it
 * (the 2026-11-17 incident). Anonymous is 401, non-staff is 403.
 *
 * Data honesty: the registry invents nothing — connection states
 * were verified by fetching the real surfaces at build time (the
 * verification date rides in the payload), event data is read live
 * from the feed, and a feed that cannot be read reports
 * { available: false } instead of activity that never happened.
 */
const router = Router();

const staffGate = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

router.get('/interconnect/registry', ...staffGate, async (req, res) => {
  const registry = await buildInterconnectRegistry();
  return res.json({ data: registry });
});

export default router;
