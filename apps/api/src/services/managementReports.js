import { createId, store } from '../data/store.js';
import { hydrateDepartmentReports, persistDepartmentReport } from '../db/managementReportsRepo.js';

/**
 * Management department reporting (Ramone's directive, 2026-11-14):
 * EVERY request any platform feature produces — booking, referral,
 * subscription/offer sign-up, account creation, job event, payment,
 * training, publish, campaign action — reports back to management with
 * the EXACT request detail, routed to the correct head department,
 * where management reads and acknowledges it (Remote Manager → Reports).
 *
 * How emission works:
 *  - The notification service's staff-alert path (notifyStaffAlert) is
 *    the central choke point: every event that already alerts staff
 *    emits exactly ONE report here, routed by its `kind` through
 *    DEPARTMENT_FOR_STAFF_KIND. Internal outbox notices (dispatch
 *    matched/approved, commercial work orders) emit through
 *    DEPARTMENT_FOR_INTERNAL_TEMPLATE in queueNotification.
 *  - Lifecycle events that fire no staff alert today (referral credit
 *    approve/redeem, payment webhook outcomes, campaign submit/approve,
 *    media/marketing publishes, parts POs, finance sync, Speedy Class
 *    sessions, setter appointment/area actions, job completion) call
 *    emitReport() explicitly at their handler.
 *  - FAILURE-PROOF: emitReport never throws and never blocks the
 *    underlying request — the in-memory push is synchronous, the
 *    database write is fire-and-forget (same pattern as chat capture).
 *  - DEDUPE: reports carry an eventKey; a second emit with the same key
 *    returns the existing report instead of duplicating.
 *  - HONEST DETAIL: detail is composed only from the recorded request
 *    fields — never secrets, tokens, or passwords.
 */

/**
 * The head departments. The first six ids are the canonical set from
 * GET /platform/departments (services/superapp.js departmentBoard);
 * accounts / training / marketing extend it for features that had no
 * home there (registrations, the Academy, the marketing/media/ad OSes).
 */
export const REPORT_DEPARTMENTS = [
  { id: 'booking', name: 'Booking' },
  { id: 'dispatch', name: 'Service Setters — Dispatch' },
  { id: 'field', name: 'Field Service' },
  { id: 'parts', name: 'Parts Supply' },
  { id: 'billing', name: 'Billing' },
  { id: 'referrals', name: 'Referrals & Rewards' },
  { id: 'accounts', name: 'Accounts & Access' },
  { id: 'training', name: 'Training — Academy' },
  { id: 'marketing', name: 'Marketing & Media' },
];
export const REPORT_DEPARTMENT_IDS = REPORT_DEPARTMENTS.map((d) => d.id);
export const DEFAULT_DEPARTMENT = 'booking';

/** notifyStaffAlert `kind` → head department. Unknown kinds fall back
 *  to Booking — the Service Setter intake queue owns every public form
 *  on every surface, and the raw kind is preserved in the report. */
export const DEPARTMENT_FOR_STAFF_KIND = {
  BOOKING: 'booking',
  SERVICE_REQUEST: 'booking',
  PM_SERVICE_REQUEST: 'booking',
  PM_LEAD: 'booking',
  VIDEO_REQUEST: 'booking',
  PHOTO_DIAGNOSIS: 'booking',
  COMMERCIAL_WORK_ORDER: 'booking',
  ACCOUNT_REGISTRATION: 'accounts',
  REFERRAL_REWARD: 'referrals',
  REFERRAL_REWARD_REJECTED: 'referrals',
  PROVIDER_APPLICATION: 'dispatch',
  VOICEMAIL: 'dispatch',
};

/** Internal outbox templates (channel 'internal') → head department. */
export const DEPARTMENT_FOR_INTERNAL_TEMPLATE = {
  DISPATCH_MATCHED: 'dispatch',
  DISPATCH_APPROVED: 'dispatch',
  COMMERCIAL_WORK_ORDER_RECEIVED: 'booking',
};

function sanitizeDetail(detail) {
  if (!detail || typeof detail !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(detail)) {
    // Defence in depth: a report must never carry a credential, even if
    // a future caller passes one by mistake.
    if (/password|secret|token|api[-_]?key|authorization/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Emit ONE management report. Returns the report (or the existing one
 * when the eventKey already reported), or null if anything went wrong —
 * callers never need to handle failure.
 */
export function emitReport({ department, type, title, detail = {}, source = null, reference = null, eventKey = null } = {}) {
  try {
    if (eventKey) {
      const existing = store.departmentReports.find((r) => r.eventKey === eventKey);
      if (existing) return existing;
    }
    const report = {
      id: createId(),
      department: REPORT_DEPARTMENT_IDS.includes(department) ? department : DEFAULT_DEPARTMENT,
      type: String(type || 'EVENT').slice(0, 80),
      title: String(title || 'Platform event').slice(0, 300),
      detail: sanitizeDetail(detail),
      source: source || null,
      reference: reference || null,
      eventKey: eventKey || null,
      status: 'NEW',
      ackById: null,
      ackAt: null,
      createdAt: new Date().toISOString(),
    };
    store.departmentReports.push(report);
    void persistDepartmentReport(report).catch((error) => {
      console.error(JSON.stringify({ level: 'error', message: 'department report persist failed', error: String(error?.message || error) }));
    });
    return report;
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'department report emit failed', error: String(error?.message || error) }));
    return null;
  }
}

/**
 * Re-sync the in-memory working set from the durable DepartmentReport
 * table (the same hydration that runs at cold start). Serverless
 * instances are stateless and long-lived: an instance hydrates once,
 * so an acknowledgment written through instance A is invisible to
 * instance B's working set — B kept serving the report as NEW with a
 * live Acknowledge button even though the database row was ACKED
 * (Ramone's report, 2026-11-23: "when I acknowledged each campaign
 * they all go back to acknowledge again"). The management read + ack
 * paths therefore refresh before they read, so the feed every manager
 * sees reflects every acknowledgment, whichever instance serves it.
 * Failure degrades to the current working set — a refresh error never
 * blocks the feed. No-op in skeleton mode (no database).
 */
export async function refreshDepartmentReports() {
  try {
    await hydrateDepartmentReports();
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'department report refresh failed', error: String(error?.message || error) }));
  }
}

/** Per-department counts for the management summary: NEW + today's. */
export function reportSummary() {
  const today = new Date().toISOString().slice(0, 10);
  const byId = new Map(REPORT_DEPARTMENTS.map((d) => [d.id, { id: d.id, name: d.name, newCount: 0, todayCount: 0, totalCount: 0 }]));
  let totalNew = 0;
  let totalToday = 0;
  for (const report of store.departmentReports) {
    const bucket = byId.get(report.department) || byId.get(DEFAULT_DEPARTMENT);
    bucket.totalCount += 1;
    if (report.status === 'NEW') { bucket.newCount += 1; totalNew += 1; }
    if (String(report.createdAt).slice(0, 10) === today) { bucket.todayCount += 1; totalToday += 1; }
  }
  return { generatedAt: new Date().toISOString(), totalNew, totalToday, departments: [...byId.values()] };
}

export function listReports({ department = null, status = null, limit = 100, offset = 0 } = {}) {
  let rows = [...store.departmentReports].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (department) rows = rows.filter((r) => r.department === department);
  if (status) rows = rows.filter((r) => r.status === status);
  const total = rows.length;
  const cap = Math.min(200, Math.max(1, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);
  return { reports: rows.slice(off, off + cap), total, limit: cap, offset: off };
}

/**
 * Acknowledge a report. Idempotent by design: acknowledging an already
 * ACKED report returns it unchanged with `alreadyAcked: true` (the
 * route answers 200) — a double tap in the console is not an error.
 *
 * The working set is refreshed from the durable table FIRST, so an
 * instance holding a stale NEW copy can never re-stamp over an
 * earlier acknowledgment: the first ack's date/time is the record of
 * the campaign (Ramone, 2026-11-23: "Each campaign must start
 * acknowledged date and time"), and it is preserved.
 *
 * The acknowledgment also covers the submission as the unit: any
 * other still-NEW row carrying the SAME eventKey (the same submission
 * emitted twice into a working set) is stamped with the same ack
 * date/time and by-id, so no rendering of that submission can offer
 * the Acknowledge action again.
 */
export async function ackReport(id, userId) {
  await refreshDepartmentReports();
  const report = store.departmentReports.find((r) => r.id === id);
  if (!report) return null;
  if (report.status === 'ACKED') return { report, alreadyAcked: true };
  report.status = 'ACKED';
  report.ackById = userId || null;
  report.ackAt = new Date().toISOString();
  await persistDepartmentReport(report).catch((error) => {
    console.error(JSON.stringify({ level: 'error', message: 'department report ack persist failed', error: String(error?.message || error) }));
  });
  if (report.eventKey) {
    const siblings = store.departmentReports.filter((r) => r.id !== report.id && r.eventKey === report.eventKey && r.status !== 'ACKED');
    for (const sibling of siblings) {
      sibling.status = 'ACKED';
      sibling.ackById = report.ackById;
      sibling.ackAt = report.ackAt;
      await persistDepartmentReport(sibling).catch((error) => {
        console.error(JSON.stringify({ level: 'error', message: 'department report sibling ack persist failed', error: String(error?.message || error) }));
      });
    }
  }
  return { report, alreadyAcked: false };
}
