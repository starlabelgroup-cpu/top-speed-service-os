import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { buildPepperStatus } from '../services/pepperConsole.js';
import { PEPPER_REPORT_CATEGORIES, pepperReportsRepo } from '../db/pepperReportsRepo.js';

/**
 * Pepper — Systems Manager console API (2026-11-18).
 *
 * Ramone's direction: "I need pepper/muze agent working inside work
 * station as systems manager reporting to me Ramone Williams." This
 * router is Pepper's duty post inside the Workstation:
 *
 *   GET  /pepper-console/status   the systems board — an aggregate of
 *                                 REAL states read from the existing
 *                                 services/repos (services/
 *                                 pepperConsole.js), plus Pepper's
 *                                 identity block: name, title, the
 *                                 reporting line to Ramone Williams,
 *                                 the 2026-11-10 authority limits and
 *                                 Rule Zero.
 *   GET  /pepper-console/reports  the report log, newest first.
 *   POST /pepper-console/reports  staff file a report.
 *
 * Gate: the staff set exactly (STAFF_ROLES — Service Setters,
 * managers, the Master, platform admin), carried PER ROUTE. This
 * router is mounted at the shared /api/v1 prefix, so there is
 * deliberately NO unscoped router.use gate here — an unscoped gate
 * on a shared-prefix router walls every router mounted after it
 * (the 2026-11-17 incident). Anonymous is 401, non-staff is 403.
 *
 * Data honesty: the status aggregate invents nothing — a system
 * that cannot be read reports { available: false, reason }; the
 * report log holds exactly what staff filed.
 */
const router = Router();

const staffGate = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function publicReport(row) {
  // Field-by-field: only the log's own fields and the filer's public
  // identity ever leave the server.
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    category: row.category,
    createdByUserId: row.createdByUserId ?? null,
    createdBy: row.createdBy
      ? {
          email: row.createdBy.email,
          name: [row.createdBy.firstName, row.createdBy.lastName].filter(Boolean).join(' ') || null,
          roles: row.createdBy.roles,
        }
      : null,
    createdAt: iso(row.createdAt),
  };
}

router.get('/pepper-console/status', ...staffGate, async (req, res, next) => {
  try {
    return res.json({ data: await buildPepperStatus() });
  } catch (error) {
    return next(error);
  }
});

router.get('/pepper-console/reports', ...staffGate, async (req, res, next) => {
  try {
    const rows = await pepperReportsRepo.listRecent(50);
    return res.json({ data: rows.map(publicReport) });
  } catch (error) {
    return next(error);
  }
});

const reportSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(160),
  body: z.string().trim().min(1, 'Body is required').max(4000),
  category: z.enum(PEPPER_REPORT_CATEGORIES),
});

router.post('/pepper-console/reports', ...staffGate, async (req, res, next) => {
  try {
    const parsed = reportSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid report', details: parsed.error.flatten() });
    }
    const row = await pepperReportsRepo.create({
      title: parsed.data.title,
      body: parsed.data.body,
      category: parsed.data.category,
      createdByUserId: req.user.id,
    });
    return res.status(201).json({ data: publicReport(row) });
  } catch (error) {
    return next(error);
  }
});

export default router;
