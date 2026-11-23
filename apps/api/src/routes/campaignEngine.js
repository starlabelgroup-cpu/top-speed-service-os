import { Router } from 'express';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { checkClaims } from '../services/campaignFactory.js';
import {
  campaignEngineSummary,
  generateForDate,
  generateLaunch,
  listBatches,
  listCampaigns,
} from '../services/campaignEngine.js';

/**
 * Top Speed Campaign Engine (2026-11-23) — the perpetual campaign
 * registry's doors.
 *
 * Auth discipline (the 2026-11-17 auth-trap rule): this router is
 * mounted on the shared /api/v1 prefix, so the staff gate is
 * spread PER ROUTE — never an unscoped router.use() — and every
 * route lives under this router's own /campaign-engine subpath.
 *
 * Generation doors: staff sessions (marketing tier) OR the
 * scheduler, which presents the CRON_SECRET as a Bearer token —
 * the same discipline as the notifications cron drain
 * (routes/integrations.js). An unset CRON_SECRET closes the
 * scheduler door; it is never an open door.
 *
 * Nothing on this router publishes, sends, enables, or funds:
 * generation mints DRAFT/QUEUED/STAGED registry records and
 * born-DRAFT Facebook OS queue posts only.
 */

const router = Router();

const engineStaff = [
  authenticate,
  requireCompany,
  requireRole(
    ROLES.MARKETING_MANAGER,
    ROLES.AD_SPECIALIST,
    ROLES.COMPANY_ADMIN,
    ROLES.COMPANY_OWNER,
    ROLES.PLATFORM_ADMIN,
  ),
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

function parseLimit(value, fallback, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.get('authorization') === `Bearer ${secret}`;
}

// Either a staff session or the scheduler's cron secret may pass.
function generationGate(req, res, next) {
  if (cronAuthorized(req)) return next();
  return engineStaff[0](req, res, () => engineStaff[1](req, res, () => engineStaff[2](req, res, next)));
}

// ─── Registry reads ───────────────────────────────────────────────

router.get('/campaign-engine/summary', ...engineStaff, async (req, res, next) => {
  try {
    return res.json({ data: await campaignEngineSummary() });
  } catch (error) {
    return next(error);
  }
});

router.get('/campaign-engine/campaigns', ...engineStaff, async (req, res, next) => {
  try {
    const rows = await listCampaigns({
      division: req.query.division || undefined,
      surface: req.query.surface || undefined,
      status: req.query.status || undefined,
      batchKey: req.query.batchKey || undefined,
      limit: parseLimit(req.query.limit, 200, 1000),
    });
    return res.json({ data: rows });
  } catch (error) {
    return next(error);
  }
});

router.get('/campaign-engine/batches', ...engineStaff, async (req, res, next) => {
  try {
    return res.json({ data: await listBatches(parseLimit(req.query.limit, 50, 200)) });
  } catch (error) {
    return next(error);
  }
});

// ─── The claim-check gate as a door (tech pack b) ─────────────────
// Any hand-written copy (console, Ad Studio briefs) can be checked
// against the same gate the factory enforces on its own output.

router.post('/campaign-engine/claim-check', ...engineStaff, async (req, res) => {
  const violations = checkClaims(req.body?.copy || '', { divisionKey: req.body?.divisionKey });
  return res.json({ data: { ok: violations.length === 0, violations } });
});

// ─── Generation (the scheduler interface, tech pack d) ────────────

router.post('/campaign-engine/launch', generationGate, async (req, res, next) => {
  try {
    const result = await generateLaunch(req.user?.id ?? null);
    return res.status(201).json({ data: result });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

router.post('/campaign-engine/batches/generate', generationGate, async (req, res, next) => {
  try {
    const result = await generateForDate(req.body?.date || req.query.date, req.user?.id ?? null);
    return res.status(201).json({ data: result });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

export default router;
