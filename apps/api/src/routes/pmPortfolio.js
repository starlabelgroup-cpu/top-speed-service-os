import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { areasForZip, SERVICE_CITIES, SERVICE_ZIPS } from '../config/serviceAreas.js';
import { STAFF_ROLES } from '../config/security.js';
import { appendEvent, createReferenceCode, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { authenticate, requireCompany } from '../middleware/auth.js';
import { createConnectionRecord } from '../db/connectionsRepo.js';
import { invoiceMoney } from '../services/jobMoney.js';
import { notifySubmission } from '../services/notifications.js';
import { intakeRateLimit } from '../middleware/intakeShield.js';
import {
  INVALID_PHONE_MESSAGE,
  honeypotTripped,
  validateNanpPhone,
} from '../services/intakeShield.js';
import {
  createProperty,
  createRequest,
  createUnit,
  findRequestByStatusHash,
  findTenantLinkByHash,
  getProperty,
  getRequest,
  getTenantLinkByProperty,
  getUnit,
  listProperties,
  listRequests,
  listUnits,
  rotateTenantLink,
  setTenantLinkStatus,
  touchTenantLink,
  updateRequest,
} from '../db/pmPortfolioRepo.js';

const router = Router();

/**
 * Connect Pro — PM Portfolio + Tenant Request Links (2026-11-20,
 * Ramone's approved recommendations B5 + B6).
 *
 * B5 — the property-manager console behind the Connect Pro business
 * door: the PM's properties and units, per-unit service history, a
 * structured bulk intake (one form, many unit requests — each becomes
 * its OWN PM_SERVICE_REQUEST connection record and therefore its own
 * lead booking in the same Book OS setter queue as every other
 * intake; no silo), and monthly statements computed from real
 * completed jobs and their invoices/receipts (services/jobMoney —
 * server money only; a month with no completed jobs says so).
 *
 * B6 — tenant request links: one unguessable link per property (the
 * raw token is shown to the PM once; only its SHA-256 hash is
 * stored). A tenant needs no account and sees exactly two things: the
 * request form for that property, and — through a second private
 * token issued at submission — the status of their own request. A
 * tenant request is born PENDING_APPROVAL and reaches the setter
 * queue ONLY when the PM approves it (approval performs the same
 * createConnectionRecord hand-off as every other intake). Rejection
 * closes it with the PM's note, which the tenant reads on the status
 * view. No auto-dispatch anywhere: setters still assign every job.
 *
 * Gate (per-route, per the shared-prefix rule): the PM's own account
 * — a signed-in user whose record carries signupAudience
 * 'property-manager' (pinned server-side at portal signup) — plus the
 * standing staff exception (STAFF_ROLES enter every door; a staff
 * caller may pass ?ownerId= to work a PM's portfolio in support).
 * Homeowner and plain customer accounts get an honest 403.
 */

// The in-memory store only holds users touched this process lifetime, so
// the account record is read the way /auth/me reads it: from the database
// when one is configured, the store otherwise.
async function userRecord(id) {
  if (DATABASE_ENABLED) {
    try { return await db().user.findUnique({ where: { id } }); } catch { return store.users.get(id) ?? null; }
  }
  return store.users.get(id) ?? null;
}

async function pmAccess(req, res, next) {
  const roles = req.user?.roles || [];
  if (roles.some((role) => STAFF_ROLES.includes(role))) {
    req.pmStaff = true;
    return next();
  }
  const record = (await userRecord(req.user.id)) || {};
  if (record.signupAudience === 'property-manager') return next();
  return res.status(403).json({
    error: 'This console is for property-manager accounts — sign in with the property-manager account you created on the Connect Pro web portal.',
    code: 'PM_ACCOUNT_REQUIRED',
  });
}

const pmGate = [authenticate, requireCompany, pmAccess];

/** The portfolio owner for this call: the caller, unless staff named one. */
function scopeOwner(req) {
  if (req.pmStaff) {
    const named = req.query?.ownerId || req.body?.ownerId;
    if (named) return String(named);
  }
  return req.user.id;
}

async function profileOf(userId) {
  const record = (await userRecord(userId)) || {};
  return {
    name: [record.firstName, record.lastName].filter(Boolean).join(' ').trim() || record.email || 'Property manager',
    phone: record.phone || null,
    email: record.email || null,
  };
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function newToken() {
  return randomBytes(24).toString('base64url');
}

/* --------------------------- request hand-off --------------------------- */

/**
 * The ONE path from a PM service request into the Service Setters
 * pipeline: a PM_SERVICE_REQUEST connection record through the
 * universal intake, whose lead booking lands in Book OS. Used by
 * console submissions (immediately) and by tenant approvals (only
 * then) — identical shape either way, so setters see one queue.
 */
async function dispatchToSetters(row) {
  const property = await getProperty(row.ownerId, row.propertyId);
  const unit = row.unitId ? await getUnit(row.unitId) : null;
  const message = [
    `Property: ${property?.name || 'Property'}${property?.address ? ` — ${property.address}` : ''}`,
    unit ? `Unit: ${unit.label}` : null,
    `Appliance: ${row.appliance}`,
    `Issue: ${row.issue}`,
    row.accessNotes ? `Access: ${row.accessNotes}` : null,
    row.urgency === 'urgent' ? 'URGENCY: urgent' : null,
    row.origin === 'TENANT_LINK'
      ? 'Origin: tenant request link — approved by the property manager'
      : 'Origin: property-manager console',
  ].filter(Boolean).join(' · ');
  const record = await createConnectionRecord({
    name: row.contactName,
    phone: row.contactPhone,
    email: row.tenantEmail || (await profileOf(row.ownerId)).email,
    type: 'PM_SERVICE_REQUEST',
    source: row.origin === 'TENANT_LINK' ? 'pm-tenant-link' : 'pm-console',
    message,
  });
  const booking = record.leadBookingId ? store.bookings.get(record.leadBookingId) : null;
  return updateRequest(row.id, {
    connectionId: record.id,
    connectionReference: record.reference,
    bookingId: booking?.id || null,
    bookingReference: booking?.referenceCode || null,
  });
}

function requestView(row, bookingsById) {
  const booking = row.bookingId ? bookingsById.get(row.bookingId) : null;
  return { ...row, bookingStatus: booking?.status || null };
}

/** Views with the property name + unit label resolved for display. */
async function requestViews(ownerId, rows) {
  const byId = bookingsMap();
  const propertyName = new Map();
  const unitLabel = new Map();
  for (const propertyId of new Set(rows.map((r) => r.propertyId).filter(Boolean))) {
    const property = await getProperty(ownerId, propertyId);
    if (property) propertyName.set(propertyId, property.name);
  }
  for (const unitId of new Set(rows.map((r) => r.unitId).filter(Boolean))) {
    const unit = await getUnit(unitId);
    if (unit) unitLabel.set(unitId, unit.label);
  }
  return rows.map((r) => ({
    ...requestView(r, byId),
    propertyName: propertyName.get(r.propertyId) || null,
    unitLabel: r.unitId ? unitLabel.get(r.unitId) || null : null,
  }));
}

function bookingsMap() {
  return store.bookings;
}

/* ------------------------------- properties ------------------------------ */

const propertySchema = z.object({
  name: z.string().trim().min(2).max(160),
  address: z.string().trim().min(5).max(240),
  city: z.string().trim().min(2).max(80).optional(),
  zip: z.string().regex(/^\d{5}$/),
});

router.post('/pm/properties', ...pmGate, async (req, res) => {
  const parsed = propertySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid property', details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const city = data.city || areasForZip(data.zip)[0];
  if (!city || !SERVICE_CITIES.includes(city)) {
    return res.status(422).json({ error: 'City is outside the current service area', serviceCities: SERVICE_CITIES });
  }
  if (!SERVICE_ZIPS.has(data.zip)) {
    return res.status(422).json({ error: 'ZIP is outside the current service area', serviceCities: areasForZip(data.zip) });
  }
  const ownerId = scopeOwner(req);
  const property = await createProperty({
    companyId: req.companyId, ownerId,
    name: data.name, address: data.address, city, zip: data.zip,
  });
  await appendEvent('PM_PROPERTY_ADDED', {
    source: 'CONNECT_PRO', actor: req.user.id,
    entityType: 'PM_PROPERTY', entityId: property.id,
    details: { ownerId, name: property.name, city: property.city, zip: property.zip },
  });
  return res.status(201).json({ data: property });
});

router.get('/pm/properties', ...pmGate, async (req, res) => {
  const ownerId = scopeOwner(req);
  const properties = await listProperties(ownerId);
  const requests = await listRequests(ownerId, {});
  const data = [];
  for (const property of properties) {
    const units = await listUnits(property.id);
    const own = requests.filter((r) => r.propertyId === property.id);
    data.push({
      ...property,
      unitCount: units.length,
      pendingApprovals: own.filter((r) => r.status === 'PENDING_APPROVAL').length,
      requestCount: own.length,
    });
  }
  return res.json({ data });
});

const unitSchema = z.object({
  label: z.string().trim().min(1).max(60),
  tenantName: z.string().trim().max(120).optional(),
  tenantPhone: z.string().trim().max(30).optional(),
  tenantEmail: z.string().email().optional(),
});

router.post('/pm/properties/:id/units', ...pmGate, async (req, res) => {
  const ownerId = scopeOwner(req);
  const property = await getProperty(ownerId, req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  const parsed = unitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid unit', details: parsed.error.flatten() });
  }
  const unit = await createUnit({
    companyId: req.companyId, ownerId, propertyId: property.id,
    label: parsed.data.label,
    tenantName: parsed.data.tenantName || null,
    tenantPhone: parsed.data.tenantPhone || null,
    tenantEmail: parsed.data.tenantEmail || null,
  });
  return res.status(201).json({ data: unit });
});

router.get('/pm/properties/:id', ...pmGate, async (req, res) => {
  const ownerId = scopeOwner(req);
  const property = await getProperty(ownerId, req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  const units = await listUnits(property.id);
  const requests = await listRequests(ownerId, { propertyId: property.id });
  const views = await requestViews(ownerId, requests);
  const unitsWithHistory = units.map((unit) => ({
    ...unit,
    history: views.filter((r) => r.unitId === unit.id),
  }));
  const propertyRequests = views.filter((r) => !r.unitId);
  const tenantLink = await getTenantLinkByProperty(property.id);
  return res.json({
    data: {
      ...property,
      units: unitsWithHistory,
      propertyRequests,
      tenantLink: tenantLink ? { status: tenantLink.status, createdAt: tenantLink.createdAt, lastUsedAt: tenantLink.lastUsedAt } : null,
    },
  });
});

/* ------------------------------ tenant links ----------------------------- */

router.post('/pm/properties/:id/tenant-link', ...pmGate, async (req, res) => {
  const ownerId = scopeOwner(req);
  const property = await getProperty(ownerId, req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  const token = newToken();
  await rotateTenantLink({
    companyId: req.companyId, ownerId, propertyId: property.id, tokenHash: sha256Hex(token),
  });
  await appendEvent('PM_TENANT_LINK_ROTATED', {
    source: 'CONNECT_PRO', actor: req.user.id,
    entityType: 'PM_PROPERTY', entityId: property.id,
    details: { ownerId },
  });
  // The raw token is returned exactly once — only its hash is stored.
  return res.status(201).json({ data: { token, path: `/tenant-request?t=${token}`, status: 'ACTIVE' } });
});

router.post('/pm/properties/:id/tenant-link/revoke', ...pmGate, async (req, res) => {
  const ownerId = scopeOwner(req);
  const property = await getProperty(ownerId, req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  const link = await getTenantLinkByProperty(property.id);
  if (!link) return res.status(404).json({ error: 'This property has no tenant link yet' });
  const updated = await setTenantLinkStatus(property.id, 'REVOKED');
  return res.json({ data: { status: updated.status } });
});

/* --------------------------- console submissions -------------------------- */

const requestItemSchema = z.object({
  unitId: z.string().uuid().optional(),
  appliance: z.string().trim().min(2).max(80),
  issue: z.string().trim().min(3).max(1000),
  urgency: z.enum(['standard', 'urgent']).optional(),
  accessNotes: z.string().trim().max(500).optional(),
  tenantName: z.string().trim().max(120).optional(),
  tenantPhone: z.string().trim().max(30).optional(),
  tenantEmail: z.string().email().optional(),
});

async function createConsoleRequest({ req, ownerId, property, item, batchReference }) {
  let unit = null;
  if (item.unitId) {
    unit = await getUnit(item.unitId);
    if (!unit || unit.propertyId !== property.id) {
      return { error: 'A unit in this batch does not belong to the selected property' };
    }
  }
  const profile = await profileOf(ownerId);
  const contactName = item.tenantName || unit?.tenantName || profile.name;
  const contactPhone = item.tenantPhone || unit?.tenantPhone || profile.phone;
  if (!contactPhone) {
    return { error: 'A callback phone is required for every request — add one on the request or on your account.' };
  }
  const row = await createRequest({
    companyId: req.companyId,
    ownerId,
    propertyId: property.id,
    unitId: unit?.id || null,
    origin: 'CONSOLE',
    batchReference: batchReference || null,
    reference: createReferenceCode(),
    tenantName: item.tenantName || unit?.tenantName || null,
    tenantPhone: item.tenantPhone || unit?.tenantPhone || null,
    tenantEmail: item.tenantEmail || unit?.tenantEmail || null,
    contactName,
    contactPhone,
    appliance: item.appliance,
    issue: item.issue,
    urgency: item.urgency || 'standard',
    accessNotes: item.accessNotes || null,
    status: 'SENT',
    statusTokenHash: null,
  });
  const dispatched = await dispatchToSetters(row);
  return { request: dispatched };
}

const singleRequestSchema = requestItemSchema.extend({
  propertyId: z.string().uuid(),
});

router.post('/pm/requests', ...pmGate, async (req, res) => {
  const parsed = singleRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid service request', details: parsed.error.flatten() });
  }
  const ownerId = scopeOwner(req);
  const property = await getProperty(ownerId, parsed.data.propertyId);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  const result = await createConsoleRequest({ req, ownerId, property, item: parsed.data, batchReference: null });
  if (result.error) return res.status(400).json({ error: result.error });
  await appendEvent('PM_REQUEST_SUBMITTED', {
    source: 'CONNECT_PRO', actor: req.user.id,
    entityType: 'PM_SERVICE_REQUEST', entityId: result.request.id,
    referenceCode: result.request.connectionReference,
    details: { ownerId, propertyId: property.id, origin: 'CONSOLE' },
  });
  return res.status(201).json({ data: result.request });
});

const bulkRequestSchema = z.object({
  propertyId: z.string().uuid(),
  requests: z.array(requestItemSchema).min(1).max(25),
});

router.post('/pm/requests/bulk', ...pmGate, async (req, res) => {
  const parsed = bulkRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid bulk request', details: parsed.error.flatten() });
  }
  const ownerId = scopeOwner(req);
  const property = await getProperty(ownerId, parsed.data.propertyId);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  // Validate the whole batch before creating anything: units must
  // belong to this property and every request needs a reachable phone.
  const profile = await profileOf(ownerId);
  for (const item of parsed.data.requests) {
    let unit = null;
    if (item.unitId) {
      unit = await getUnit(item.unitId);
      if (!unit || unit.propertyId !== property.id) {
        return res.status(400).json({ error: 'A unit in this batch does not belong to the selected property' });
      }
    }
    if (!(item.tenantPhone || unit?.tenantPhone || profile.phone)) {
      return res.status(400).json({ error: 'A callback phone is required for every request — add one on the request or on your account.' });
    }
  }
  const batchReference = createReferenceCode();
  const created = [];
  for (const item of parsed.data.requests) {
    const result = await createConsoleRequest({ req, ownerId, property, item, batchReference });
    if (result.error) return res.status(400).json({ error: result.error });
    created.push(result.request);
  }
  await appendEvent('PM_REQUESTS_BULK_SUBMITTED', {
    source: 'CONNECT_PRO', actor: req.user.id,
    entityType: 'PM_PROPERTY', entityId: property.id,
    referenceCode: batchReference,
    details: { ownerId, propertyId: property.id, count: created.length },
  });
  return res.status(201).json({
    data: {
      batchReference,
      count: created.length,
      requests: created.map((r) => ({
        id: r.id, reference: r.reference,
        connectionReference: r.connectionReference, bookingReference: r.bookingReference,
        unitId: r.unitId, appliance: r.appliance, status: r.status,
      })),
    },
  });
});

/* ------------------------------ PM queue view ----------------------------- */

router.get('/pm/requests', ...pmGate, async (req, res) => {
  const ownerId = scopeOwner(req);
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const rows = await listRequests(ownerId, { status });
  return res.json({ data: await requestViews(ownerId, rows) });
});

const decisionSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

router.post('/pm/requests/:id/approve', ...pmGate, async (req, res) => {
  const ownerId = scopeOwner(req);
  const row = await getRequest(ownerId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Request not found' });
  if (row.origin !== 'TENANT_LINK' || row.status !== 'PENDING_APPROVAL') {
    return res.status(409).json({ error: 'This request is not waiting for approval', code: 'NOT_PENDING' });
  }
  const dispatched = await dispatchToSetters(row);
  const decided = await updateRequest(row.id, { status: 'APPROVED', decidedAt: new Date() });
  const final = { ...dispatched, ...decided, connectionId: dispatched.connectionId, connectionReference: dispatched.connectionReference, bookingId: dispatched.bookingId, bookingReference: dispatched.bookingReference };
  // The approval IS the intake moment: the tenant gets the standard
  // submission confirmation and the office gets the standard alert,
  // exactly like every other PM_SERVICE_REQUEST submission.
  notifySubmission({
    kind: 'PM_SERVICE_REQUEST',
    reference: final.connectionReference,
    submitter: { name: row.tenantName || row.contactName, phone: row.tenantPhone || row.contactPhone, email: row.tenantEmail || undefined },
    lines: [
      `Approved by the property manager — now with the Service Setters.`,
      `Appliance: ${row.appliance} — ${row.issue}`,
    ],
    source: 'pm-tenant-link',
  });
  await appendEvent('PM_TENANT_REQUEST_APPROVED', {
    source: 'CONNECT_PRO', actor: req.user.id,
    entityType: 'PM_SERVICE_REQUEST', entityId: row.id,
    referenceCode: final.connectionReference,
    details: { ownerId, bookingReference: final.bookingReference },
  });
  return res.json({ data: final });
});

router.post('/pm/requests/:id/reject', ...pmGate, async (req, res) => {
  const parsed = decisionSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid decision', details: parsed.error.flatten() });
  }
  const ownerId = scopeOwner(req);
  const row = await getRequest(ownerId, req.params.id);
  if (!row) return res.status(404).json({ error: 'Request not found' });
  if (row.origin !== 'TENANT_LINK' || row.status !== 'PENDING_APPROVAL') {
    return res.status(409).json({ error: 'This request is not waiting for approval', code: 'NOT_PENDING' });
  }
  const decided = await updateRequest(row.id, {
    status: 'REJECTED',
    decidedAt: new Date(),
    decisionNote: parsed.data.note || null,
  });
  await appendEvent('PM_TENANT_REQUEST_REJECTED', {
    source: 'CONNECT_PRO', actor: req.user.id,
    entityType: 'PM_SERVICE_REQUEST', entityId: row.id,
    referenceCode: row.reference,
    details: { ownerId, hasNote: Boolean(parsed.data.note) },
  });
  return res.json({ data: decided });
});

/* ------------------------------- statements ------------------------------- */

async function buildStatement(ownerId, month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!match) return null;
  const year = Number(match[1]);
  const mon = Number(match[2]);
  if (mon < 1 || mon > 12) return null;
  const start = Date.UTC(year, mon - 1, 1);
  const end = Date.UTC(year, mon, 1);

  const properties = await listProperties(ownerId);
  const propertyById = new Map(properties.map((p) => [p.id, p]));
  const unitLabelById = new Map();
  for (const property of properties) {
    for (const unit of await listUnits(property.id)) unitLabelById.set(unit.id, unit.label);
  }

  const requests = await listRequests(ownerId, {});
  const lines = [];
  for (const row of requests) {
    if (!row.bookingId) continue;
    const booking = store.bookings.get(row.bookingId);
    if (!booking || booking.status !== 'COMPLETED') continue;
    const completedAt = booking.completedAt || booking.updatedAt || null;
    const when = completedAt ? Date.parse(completedAt) : NaN;
    if (!Number.isFinite(when) || when < start || when >= end) continue;
    // Server money only: the invoice of record + recorded receipts,
    // folded by the same helper every job surface reads.
    const money = invoiceMoney(booking);
    lines.push({
      requestReference: row.reference,
      bookingReference: booking.referenceCode,
      propertyId: row.propertyId,
      propertyName: propertyById.get(row.propertyId)?.name || null,
      unitId: row.unitId,
      unitLabel: row.unitId ? unitLabelById.get(row.unitId) || null : null,
      appliance: booking.appliance || row.appliance,
      completedAt,
      invoiceStatus: money.invoice?.status || null,
      invoiceTotalCents: money.invoiceTotalCents,
      paidCents: money.receiptsTotalCents,
      balanceDueCents: money.balanceDueCents,
    });
  }
  lines.sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
  const totals = {
    jobs: lines.length,
    invoicedCents: lines.reduce((sum, l) => sum + (l.invoiceTotalCents || 0), 0),
    paidCents: lines.reduce((sum, l) => sum + (l.paidCents || 0), 0),
    balanceDueCents: lines.reduce((sum, l) => sum + (l.balanceDueCents || 0), 0),
    jobsWithoutInvoice: lines.filter((l) => l.invoiceTotalCents == null).length,
  };
  return {
    month,
    currency: 'USD',
    generatedAt: new Date().toISOString(),
    lines,
    totals,
    note: lines.length
      ? 'Computed from completed jobs and their invoices of record for your properties. Amounts are the recorded figures — nothing is estimated.'
      : 'No completed jobs for your properties this month.',
  };
}

router.get('/pm/statements/:month', ...pmGate, async (req, res) => {
  const statement = await buildStatement(scopeOwner(req), req.params.month);
  if (!statement) return res.status(400).json({ error: 'Month must be YYYY-MM' });
  return res.json({ data: statement });
});

router.get('/pm/overview', ...pmGate, async (req, res) => {
  const ownerId = scopeOwner(req);
  const properties = await listProperties(ownerId);
  let unitCount = 0;
  for (const property of properties) unitCount += (await listUnits(property.id)).length;
  const requests = await listRequests(ownerId, {});
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const statement = await buildStatement(ownerId, month);
  return res.json({
    data: {
      properties: properties.length,
      units: unitCount,
      pendingApprovals: requests.filter((r) => r.status === 'PENDING_APPROVAL').length,
      totalRequests: requests.length,
      thisMonth: { month, completedJobs: statement?.totals.jobs || 0, invoicedCents: statement?.totals.invoicedCents || 0, paidCents: statement?.totals.paidCents || 0 },
    },
  });
});

/* --------------------------- public tenant doors -------------------------- */

async function resolveActiveLink(token) {
  if (!token || typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
  const link = await findTenantLinkByHash(sha256Hex(token));
  if (!link || link.status !== 'ACTIVE') return null;
  return link;
}

router.get('/tenant-link/:token', intakeRateLimit('connections'), async (req, res) => {
  const link = await resolveActiveLink(req.params.token);
  if (!link) return res.status(404).json({ error: 'This request link is not active — ask your property manager for a current link.' });
  const property = await getProperty(link.ownerId, link.propertyId);
  if (!property) return res.status(404).json({ error: 'This request link is not active — ask your property manager for a current link.' });
  const units = await listUnits(property.id);
  await touchTenantLink(link.id);
  // The tenant sees the property and its unit labels — never tenant
  // names, contact details, or anything about other properties.
  return res.json({
    data: {
      property: { name: property.name, address: property.address, city: property.city, zip: property.zip },
      units: units.map((u) => ({ id: u.id, label: u.label })),
    },
  });
});

const tenantRequestSchema = z.object({
  unitId: z.string().uuid().optional(),
  tenantName: z.string().trim().min(2).max(120),
  tenantPhone: z.string().trim().min(7).max(30),
  tenantEmail: z.string().email().optional(),
  appliance: z.string().trim().min(2).max(80),
  issue: z.string().trim().min(3).max(1000),
  urgency: z.enum(['standard', 'urgent']).optional(),
  accessNotes: z.string().trim().max(500).optional(),
});

router.post('/tenant-link/:token/requests', intakeRateLimit('connections'), async (req, res) => {
  const link = await resolveActiveLink(req.params.token);
  if (!link) return res.status(404).json({ error: 'This request link is not active — ask your property manager for a current link.' });
  const parsed = tenantRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid service request', details: parsed.error.flatten() });
  }
  // Intake shield, same as every public intake: a tripped honeypot
  // gets the success shape and persists NOTHING.
  if (honeypotTripped(req.body)) {
    return res.status(201).json({ data: { reference: createReferenceCode(), status: 'PENDING_APPROVAL' } });
  }
  const phoneCheck = validateNanpPhone(parsed.data.tenantPhone);
  if (!phoneCheck.ok) {
    return res.status(400).json({ error: INVALID_PHONE_MESSAGE, code: 'INVALID_PHONE' });
  }
  const property = await getProperty(link.ownerId, link.propertyId);
  if (!property) return res.status(404).json({ error: 'This request link is not active — ask your property manager for a current link.' });
  let unit = null;
  if (parsed.data.unitId) {
    unit = await getUnit(parsed.data.unitId);
    if (!unit || unit.propertyId !== property.id) {
      return res.status(400).json({ error: 'Please choose one of this property\u2019s units' });
    }
  }
  const statusToken = newToken();
  const row = await createRequest({
    companyId: link.companyId,
    ownerId: link.ownerId,
    propertyId: property.id,
    unitId: unit?.id || null,
    origin: 'TENANT_LINK',
    batchReference: null,
    reference: createReferenceCode(),
    tenantName: parsed.data.tenantName,
    tenantPhone: parsed.data.tenantPhone,
    tenantEmail: parsed.data.tenantEmail || null,
    contactName: parsed.data.tenantName,
    contactPhone: parsed.data.tenantPhone,
    appliance: parsed.data.appliance,
    issue: parsed.data.issue,
    urgency: parsed.data.urgency || 'standard',
    accessNotes: parsed.data.accessNotes || null,
    status: 'PENDING_APPROVAL',
    statusTokenHash: sha256Hex(statusToken),
  });
  await touchTenantLink(link.id);
  await appendEvent('PM_TENANT_REQUEST_CREATED', {
    source: 'TENANT_LINK', actor: 'tenant',
    entityType: 'PM_SERVICE_REQUEST', entityId: row.id,
    referenceCode: row.reference,
    details: { propertyId: property.id, unitId: unit?.id || null },
  });
  // The status token is shown exactly once — the tenant's private
  // window on this one request. Only its hash is stored.
  return res.status(201).json({
    data: { reference: row.reference, status: row.status, statusToken, statusPath: `/tenant-request?s=${statusToken}` },
  });
});

router.get('/tenant-request-status/:token', intakeRateLimit('connections'), async (req, res) => {
  const token = req.params.token;
  if (!token || token.length < 16 || token.length > 128) {
    return res.status(404).json({ error: 'Request not found' });
  }
  const row = await findRequestByStatusHash(sha256Hex(token));
  if (!row) return res.status(404).json({ error: 'Request not found' });
  const property = await getProperty(row.ownerId, row.propertyId);
  const unit = row.unitId ? await getUnit(row.unitId) : null;
  // Exactly one request, nothing else: no other units, no PM data,
  // no other requests — and the decision note only on a rejection,
  // the booking reference only on an approval.
  return res.json({
    data: {
      reference: row.reference,
      status: row.status,
      propertyName: property?.name || null,
      unitLabel: unit?.label || null,
      appliance: row.appliance,
      issue: row.issue,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      decisionNote: row.status === 'REJECTED' ? row.decisionNote : null,
      bookingReference: row.status === 'APPROVED' ? row.bookingReference : null,
    },
  });
});

export default router;
