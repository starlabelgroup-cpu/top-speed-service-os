import { Router } from 'express';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import {
  listCycles,
  listCycleTasks,
  listDivisions,
  listPacks,
  listPlatforms,
  openCycle,
  osUpdatesSummary,
  refreshLatestVersions,
  setTaskStatus,
} from '../services/osUpdates.js';

/**
 * OS Systems Updating System (2026-11-23) — the registry + cycle
 * doors.
 *
 * Auth discipline (the 2026-11-17 auth-trap rule): this router is
 * mounted on the shared /api/v1 prefix, so the systems gate is
 * spread PER ROUTE — never an unscoped router.use() — and every
 * route lives under this router's own /os-updates subpath.
 *
 * The gate is the systems tier: COMPANY_OWNER / COMPANY_ADMIN /
 * PLATFORM_ADMIN. The cycle-open and refresh doors ALSO accept the
 * scheduler's CRON_SECRET as a Bearer token (the campaign-engine
 * pattern) so the semiannual job can open a cycle and refresh
 * latest versions; an unset CRON_SECRET closes that door.
 *
 * Nothing on this router applies an update: it registers, refreshes,
 * plans and tracks. Applying stays the build + push + approval flow.
 */

const router = Router();

const systemsStaff = [
  authenticate,
  requireCompany,
  requireRole(ROLES.COMPANY_OWNER, ROLES.COMPANY_ADMIN, ROLES.PLATFORM_ADMIN),
];

function handleServiceError(error, res, next) {
  if (error?.status) {
    return res.status(error.status).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
  return next(error);
}

function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.get('authorization') === `Bearer ${secret}`;
}

// Either a systems-tier staff session or the scheduler's cron secret.
function cycleGate(req, res, next) {
  if (cronAuthorized(req)) return next();
  return systemsStaff[0](req, res, () => systemsStaff[1](req, res, () => systemsStaff[2](req, res, next)));
}

// ─── Registry reads ───────────────────────────────────────────────

router.get('/os-updates/summary', ...systemsStaff, async (req, res, next) => {
  try {
    return res.json({ data: await osUpdatesSummary() });
  } catch (error) {
    return next(error);
  }
});

router.get('/os-updates/divisions', ...systemsStaff, async (req, res, next) => {
  try {
    return res.json({ data: await listDivisions() });
  } catch (error) {
    return next(error);
  }
});

router.get('/os-updates/platforms', ...systemsStaff, async (req, res, next) => {
  try {
    return res.json({ data: await listPlatforms() });
  } catch (error) {
    return next(error);
  }
});

router.get('/os-updates/packs', ...systemsStaff, async (req, res, next) => {
  try {
    return res.json({ data: await listPacks() });
  } catch (error) {
    return next(error);
  }
});

router.get('/os-updates/cycles', ...systemsStaff, async (req, res, next) => {
  try {
    return res.json({ data: await listCycles() });
  } catch (error) {
    return next(error);
  }
});

router.get('/os-updates/cycles/:key/tasks', ...systemsStaff, async (req, res, next) => {
  try {
    return res.json({ data: await listCycleTasks(req.params.key) });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

// ─── Cycle + refresh (staff session or the scheduler) ─────────────

router.post('/os-updates/cycles/open', cycleGate, async (req, res, next) => {
  try {
    const result = await openCycle(req.body?.key, {
      openedAt: req.body?.openedAt,
      dueAt: req.body?.dueAt,
      note: req.body?.note,
    });
    return res.status(result.alreadyOpen ? 200 : 201).json({ data: result });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

router.post('/os-updates/refresh-latest', cycleGate, async (req, res, next) => {
  try {
    return res.json({ data: await refreshLatestVersions() });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

// ─── Task tracking ────────────────────────────────────────────────

router.post('/os-updates/tasks/:id/status', ...systemsStaff, async (req, res, next) => {
  try {
    const task = await setTaskStatus(req.params.id, req.body?.status, req.body?.note);
    return res.json({ data: task });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

export default router;
