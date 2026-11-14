import { Router } from 'express';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { ackReport, listReports, reportSummary } from '../services/managementReports.js';

/**
 * Management department reports (2026-11-14) — the read + acknowledge
 * side of services/managementReports.js. Every feature request on every
 * platform lands in this feed, routed to its head department, with the
 * exact request detail. Staff read it in the Remote Manager (/manager →
 * Reports tab); acknowledging stamps who saw it and when.
 *
 * Acknowledge is idempotent BY DESIGN (documented choice): POSTing ack
 * for an already-ACKED report returns 200 with `alreadyAcked: true`
 * and the original ack stamp — a double tap is not an error.
 */
const router = Router();

const staffOnly = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

function publicReport(report) {
  return {
    id: report.id,
    department: report.department,
    type: report.type,
    title: report.title,
    detail: report.detail || {},
    source: report.source || null,
    reference: report.reference || null,
    status: report.status,
    ackById: report.ackById || null,
    ackAt: report.ackAt || null,
    createdAt: report.createdAt,
  };
}

router.get('/management/reports/summary', ...staffOnly, (req, res) => {
  return res.json({ data: reportSummary() });
});

router.get('/management/reports', ...staffOnly, (req, res) => {
  const department = String(req.query.department || '').trim() || null;
  const status = String(req.query.status || '').trim().toUpperCase() || null;
  if (status && !['NEW', 'ACKED'].includes(status)) {
    return res.status(400).json({ error: 'status must be NEW or ACKED' });
  }
  const { reports, total, limit, offset } = listReports({
    department,
    status,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  return res.json({ data: { reports: reports.map(publicReport), total, limit, offset } });
});

router.post('/management/reports/:id/ack', ...staffOnly, async (req, res) => {
  const result = await ackReport(req.params.id, req.user?.id || null);
  if (!result) return res.status(404).json({ error: 'Report not found' });
  return res.json({ data: { report: publicReport(result.report), alreadyAcked: result.alreadyAcked } });
});

export default router;
