import { Router } from 'express';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { MANAGER_ROLES } from '../config/security.js';
import { ackReport, deleteReport, findReport, listReports, refreshDepartmentReports, reportSummary, resetReport } from '../services/managementReports.js';
import { appendEvent, store } from '../data/store.js';
import { bookingDetailOf, bookingForReport } from '../services/bookingDetail.js';

/**
 * Management department reports (2026-11-14) — the read + acknowledge
 * side of services/managementReports.js. Every feature request on every
 * platform lands in this feed, routed to its head department, with the
 * exact request detail. Managers read it in the Remote Manager
 * (/manager → Reports tab) and ApplianceMan; acknowledging stamps who
 * saw it and when.
 *
 * MANAGER ONLY since 2026-11-18 (Ramone's order): these reports are
 * the primary data of the Manager and ApplianceMan consoles, both
 * restricted to the manager tier (MANAGER_ROLES — the same set the
 * Turbo Boss gate uses). Service Setters get 403 here now, matching
 * the consoles' badges.
 *
 * Acknowledge is idempotent BY DESIGN (documented choice): POSTing ack
 * for an already-ACKED report returns 200 with `alreadyAcked: true`
 * and the original ack stamp — a double tap is not an error.
 */
const router = Router();

const managerOnly = [authenticate, requireCompany, requireRole(...MANAGER_ROLES)];
// Owner tier for the destructive report controls (delete / reset):
// the Master and platform admins — the same owner set the admin
// router uses for its delete endpoints. Managers keep read + ack.
const ownerOnly = [authenticate, requireCompany, requireRole('COMPANY_OWNER', 'PLATFORM_ADMIN')];

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

router.get('/management/reports/summary', ...managerOnly, async (req, res) => {
  // Refresh the working set from the durable table before reading:
  // an acknowledgment recorded by another serverless instance must
  // show here, or acknowledged reports come back as NEW (2026-11-23).
  await refreshDepartmentReports();
  return res.json({ data: reportSummary() });
});

router.get('/management/reports', ...managerOnly, async (req, res) => {
  await refreshDepartmentReports();
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

router.post('/management/reports/:id/ack', ...managerOnly, async (req, res) => {
  const result = await ackReport(req.params.id, req.user?.id || null);
  if (!result) return res.status(404).json({ error: 'Report not found' });
  return res.json({ data: { report: publicReport(result.report), alreadyAcked: result.alreadyAcked } });
});

/**
 * Full detail for one report (2026-11-23, the report cards' View /
 * More-info): the report itself — eventKey included, so duplicate
 * submissions are visible as such — plus, when the report is linked
 * to a booking, the full booking record and its tracking sources
 * (attribution exactly as recorded; absent fields read null and the
 * consoles render them "Not recorded"). Manager tier, like the feed.
 */
router.get('/management/reports/:id/detail', ...managerOnly, async (req, res) => {
  const report = await findReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const booking = bookingForReport(store, report);
  return res.json({
    data: {
      report: { ...publicReport(report), eventKey: report.eventKey || null },
      booking: bookingDetailOf(booking),
    },
  });
});

/**
 * Delete a report (owner only, 2026-11-23). Removes the submission as
 * the unit — the row and any same-eventKey rows — from the feed and
 * the durable table. The record the report POINTS AT (a booking, a
 * campaign) is never touched: this is report record-keeping, not
 * record deletion. The removal itself is audit-logged.
 */
router.post('/management/reports/:id/delete', ...ownerOnly, async (req, res) => {
  const result = await deleteReport(req.params.id);
  if (!result) return res.status(404).json({ error: 'Report not found' });
  await appendEvent('MANAGEMENT_REPORT_DELETED', {
    source: 'MANAGEMENT_REPORTS',
    actor: req.user.email,
    entityType: 'DEPARTMENT_REPORT',
    entityId: result.report.id,
    details: { type: result.report.type, reference: result.report.reference || null, removedRows: result.removedRows },
  });
  return res.json({ data: { deleted: publicReport(result.report), removedRows: result.removedRows } });
});

/**
 * Reset a report (owner only, 2026-11-23): an acknowledged report
 * returns to NEW with its ack stamp cleared, unit-wide like ack, so
 * it asks for a decision again on every surface. Resetting a NEW
 * report answers 200 with `alreadyNew: true` — not an error.
 */
router.post('/management/reports/:id/reset', ...ownerOnly, async (req, res) => {
  const result = await resetReport(req.params.id);
  if (!result) return res.status(404).json({ error: 'Report not found' });
  if (!result.alreadyNew) {
    await appendEvent('MANAGEMENT_REPORT_RESET', {
      source: 'MANAGEMENT_REPORTS',
      actor: req.user.email,
      entityType: 'DEPARTMENT_REPORT',
      entityId: result.report.id,
      details: { type: result.report.type, reference: result.report.reference || null, resetRows: result.resetRows },
    });
  }
  return res.json({ data: { report: publicReport(result.report), alreadyNew: result.alreadyNew, resetRows: result.resetRows } });
});

export default router;
