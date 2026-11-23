import { Router } from 'express';
import { z } from 'zod';
import { areasForZip, SERVICE_CITIES, SERVICE_ZIPS } from '../config/serviceAreas.js';
import { ROLES, STAFF_ROLES } from '../config/security.js';
import {
  appendEvent,
  createAssetTag,
  createCommercialAccountCode,
  createCommercialQuoteCode,
  createId,
  createMaintenanceAgreementCode,
  createWorkOrderCode,
  store,
} from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { createConnectionRecord } from '../db/connectionsRepo.js';
import { createReferenceCode } from '../data/store.js';
import {
  ACCOUNT_TYPES,
  EQUIPMENT_STATUSES,
  SLA_TIERS,
  createCommercialBooking,
  deriveWorkOrderPriority,
  isWorkOrderOpen,
  workOrderEffectiveStatus,
} from '../services/commercial.js';
import { notifyCommercialQuoteSent, notifyCommercialWorkOrderReceived, notifySubmission } from '../services/notifications.js';
import { drainEntries } from '../services/senders.js';
import {
  AGREEMENT_CADENCES,
  AGREEMENT_STATUSES,
  QUOTE_INVALID_MESSAGE,
  decideQuoteByToken,
  findQuoteApproval,
  generateDueAgreementVisits,
  issueQuoteApprovalToken,
  priceQuoteLineItems,
  publicQuoteView,
  quoteEffectiveStatus,
} from '../services/commercialAgreements.js';
import { intakeRateLimit } from '../middleware/intakeShield.js';
import {
  INVALID_PHONE_MESSAGE,
  honeypotTripped,
  validateNanpPhone,
} from '../services/intakeShield.js';

const router = Router();

/**
 * Commercial — the business network on the same Service OS.
 *
 * Accounts (restaurants, hotels, laundromats, facilities…) hold
 * facilities; each facility keeps an equipment registry; a service
 * request becomes a WORK ORDER (TS-W-XXXX) that also drops a linked
 * booking (source COMMERCIAL) into the standard pipeline, so Service
 * Setters set, match, and dispatch commercial jobs in the same Book OS
 * queue and board as residential work. Priority is derived from the
 * account's SLA tier and the equipment's condition — never typed in.
 * Billing rolls up per account for one consolidated monthly invoice.
 *
 * Auth: account creation rides the universal-intake pattern
 * (authenticate -> requireCompany); everything else is staff-only
 * (DISPATCHER / PLATFORM_ADMIN), consistent with Book OS.
 */

const staffOnly = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];
// Owner tier for destructive commercial controls (2026-11-23): the
// same owner set the admin router uses for its delete endpoints.
const ownerOnly = [authenticate, requireCompany, requireRole('COMPANY_OWNER', 'PLATFORM_ADMIN')];

const accountSchema = z.object({
  companyName: z.string().trim().min(2),
  accountType: z.enum(ACCOUNT_TYPES),
  contactName: z.string().trim().min(2),
  phone: z.string().trim().min(7),
  email: z.string().email(),
  slaTier: z.enum(SLA_TIERS).default('ESSENTIAL'),
});

const facilitySchema = z.object({
  name: z.string().trim().min(2),
  address: z.string().trim().min(5),
  city: z.string().trim().min(2).optional(),
  zip: z.string().regex(/^\d{5}$/),
});

const equipmentSchema = z.object({
  type: z.string().trim().min(2),
  brand: z.string().trim().min(2),
  model: z.string().trim().min(1),
  serial: z.string().trim().min(1),
  warrantyExpiry: z.string().trim().optional(),
});

const equipmentStatusSchema = z.object({
  status: z.enum(EQUIPMENT_STATUSES),
  changedBy: z.string().trim().min(2).default('Service Setters'),
  note: z.string().trim().optional(),
});

const workOrderSchema = z.object({
  accountId: z.string().uuid(),
  facilityId: z.string().uuid(),
  equipmentId: z.string().uuid().optional(),
  issue: z.string().trim().min(3),
});

function isAdmin(req) {
  return req.user.roles.includes(ROLES.PLATFORM_ADMIN);
}

function visible(map, req) {
  return [...map.values()].filter((item) => isAdmin(req) || item.companyId === req.companyId);
}

function findAccount(req, id) {
  const account = store.commercialAccounts.get(id);
  if (!account) return null;
  if (!isAdmin(req) && account.companyId !== req.companyId) return null;
  return account;
}

function findFacility(req, id) {
  const facility = store.commercialFacilities.get(id);
  if (!facility) return null;
  if (!isAdmin(req) && facility.companyId !== req.companyId) return null;
  return facility;
}

function publicWorkOrder(workOrder) {
  return { ...workOrder, effectiveStatus: workOrderEffectiveStatus(workOrder) };
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

router.post('/commercial/accounts', authenticate, requireCompany, async (req, res) => {
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid commercial account', details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const now = new Date().toISOString();
  const account = {
    id: createId(),
    companyId: req.companyId,
    referenceCode: createCommercialAccountCode(),
    companyName: data.companyName,
    accountType: data.accountType,
    contactName: data.contactName,
    phone: data.phone,
    email: data.email,
    slaTier: data.slaTier,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  };
  store.commercialAccounts.set(account.id, account);
  await appendEvent('COMMERCIAL_ACCOUNT_CREATED', {
    source: 'COMMERCIAL',
    actor: req.user.id,
    entityType: 'COMMERCIAL_ACCOUNT',
    entityId: account.id,
    referenceCode: account.referenceCode,
    details: { companyName: account.companyName, accountType: account.accountType, slaTier: account.slaTier },
  });
  return res.status(201).json({ data: account });
});

router.get('/commercial/accounts', ...staffOnly, (req, res) => {
  const accounts = visible(store.commercialAccounts, req).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return res.json({ data: accounts });
});

router.get('/commercial/accounts/:id', ...staffOnly, (req, res) => {
  const account = findAccount(req, req.params.id);
  if (!account) return res.status(404).json({ error: 'Commercial account not found' });
  const facilities = visible(store.commercialFacilities, req).filter((facility) => facility.accountId === account.id);
  return res.json({ data: { ...account, facilityCount: facilities.length } });
});

/* ------------------------------------------------------------------ */
/* Facilities                                                          */
/* ------------------------------------------------------------------ */

router.post('/commercial/accounts/:id/facilities', ...staffOnly, async (req, res) => {
  const account = findAccount(req, req.params.id);
  if (!account) return res.status(404).json({ error: 'Commercial account not found' });

  const parsed = facilitySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid facility', details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const city = data.city || areasForZip(data.zip)[0];
  if (!city || !SERVICE_CITIES.includes(city)) {
    return res.status(422).json({ error: 'City is outside the current service area', serviceCities: SERVICE_CITIES });
  }
  if (!SERVICE_ZIPS.has(data.zip)) {
    return res.status(422).json({ error: 'ZIP is outside the current service area', serviceCities: areasForZip(data.zip) });
  }

  const now = new Date().toISOString();
  const facility = {
    id: createId(),
    companyId: req.companyId,
    accountId: account.id,
    name: data.name,
    address: data.address,
    city,
    zip: data.zip,
    createdAt: now,
    updatedAt: now,
  };
  store.commercialFacilities.set(facility.id, facility);
  await appendEvent('COMMERCIAL_FACILITY_ADDED', {
    source: 'COMMERCIAL',
    actor: req.user.id,
    entityType: 'COMMERCIAL_FACILITY',
    entityId: facility.id,
    referenceCode: account.referenceCode,
    details: { accountId: account.id, name: facility.name, city: facility.city, zip: facility.zip },
  });
  return res.status(201).json({ data: facility });
});

router.get('/commercial/accounts/:id/facilities', ...staffOnly, (req, res) => {
  const account = findAccount(req, req.params.id);
  if (!account) return res.status(404).json({ error: 'Commercial account not found' });
  const facilities = visible(store.commercialFacilities, req)
    .filter((facility) => facility.accountId === account.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((facility) => ({
      ...facility,
      equipmentCount: [...store.commercialEquipment.values()].filter((unit) => unit.facilityId === facility.id).length,
    }));
  return res.json({ data: facilities });
});

/* ------------------------------------------------------------------ */
/* Equipment registry                                                  */
/* ------------------------------------------------------------------ */

router.post('/commercial/facilities/:facilityId/equipment', ...staffOnly, async (req, res) => {
  const facility = findFacility(req, req.params.facilityId);
  if (!facility) return res.status(404).json({ error: 'Facility not found' });

  const parsed = equipmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid equipment', details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const now = new Date().toISOString();
  const unit = {
    id: createId(),
    companyId: req.companyId,
    facilityId: facility.id,
    accountId: facility.accountId,
    assetTag: createAssetTag(),
    type: data.type,
    brand: data.brand,
    model: data.model,
    serial: data.serial,
    warrantyExpiry: data.warrantyExpiry || null,
    status: 'OPERATIONAL',
    statusHistory: [{ status: 'OPERATIONAL', at: now, changedBy: 'registration', note: 'Registered' }],
    createdAt: now,
    updatedAt: now,
  };
  store.commercialEquipment.set(unit.id, unit);
  await appendEvent('COMMERCIAL_EQUIPMENT_REGISTERED', {
    source: 'COMMERCIAL',
    actor: req.user.id,
    entityType: 'COMMERCIAL_EQUIPMENT',
    entityId: unit.id,
    referenceCode: unit.assetTag,
    details: { facilityId: facility.id, accountId: facility.accountId, type: unit.type, brand: unit.brand },
  });
  return res.status(201).json({ data: unit });
});

router.get('/commercial/facilities/:facilityId/equipment', ...staffOnly, (req, res) => {
  const facility = findFacility(req, req.params.facilityId);
  if (!facility) return res.status(404).json({ error: 'Facility not found' });
  const equipment = visible(store.commercialEquipment, req)
    .filter((unit) => unit.facilityId === facility.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return res.json({ data: equipment });
});

router.patch('/commercial/equipment/:id/status', ...staffOnly, async (req, res) => {
  const unit = store.commercialEquipment.get(req.params.id);
  if (!unit || (!isAdmin(req) && unit.companyId !== req.companyId)) {
    return res.status(404).json({ error: 'Equipment not found' });
  }
  const parsed = equipmentStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid equipment status', details: parsed.error.flatten() });
  }
  const { status, changedBy, note } = parsed.data;
  const previousStatus = unit.status;
  const now = new Date().toISOString();
  unit.status = status;
  unit.updatedAt = now;
  unit.statusHistory.push({ status, at: now, changedBy, note: note || null, from: previousStatus });
  await appendEvent('EQUIPMENT_STATUS_CHANGED', {
    source: 'COMMERCIAL',
    actor: changedBy,
    entityType: 'COMMERCIAL_EQUIPMENT',
    entityId: unit.id,
    referenceCode: unit.assetTag,
    details: { facilityId: unit.facilityId, accountId: unit.accountId, from: previousStatus, to: status, note: note || null },
  });
  return res.json({ data: unit });
});

/* ------------------------------------------------------------------ */
/* Work orders                                                         */
/* ------------------------------------------------------------------ */

router.post('/commercial/work-orders', ...staffOnly, async (req, res) => {
  const parsed = workOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid work order', details: parsed.error.flatten() });
  }
  const data = parsed.data;

  const account = findAccount(req, data.accountId);
  if (!account) return res.status(404).json({ error: 'Commercial account not found' });
  const facility = findFacility(req, data.facilityId);
  if (!facility) return res.status(404).json({ error: 'Facility not found' });
  if (facility.accountId !== account.id) {
    return res.status(422).json({ error: 'Facility does not belong to this account' });
  }
  let equipment = null;
  if (data.equipmentId) {
    equipment = store.commercialEquipment.get(data.equipmentId) || null;
    if (!equipment || (!isAdmin(req) && equipment.companyId !== req.companyId)) {
      return res.status(404).json({ error: 'Equipment not found' });
    }
    if (equipment.facilityId !== facility.id) {
      return res.status(422).json({ error: 'Equipment is not registered at this facility' });
    }
  }

  const { priority, reasons } = deriveWorkOrderPriority(account, equipment);
  const now = new Date().toISOString();
  const workOrder = {
    id: createId(),
    companyId: req.companyId,
    referenceCode: createWorkOrderCode(),
    accountId: account.id,
    facilityId: facility.id,
    equipmentId: equipment?.id || null,
    assetTag: equipment?.assetTag || null,
    issue: data.issue,
    priority,
    priorityReasons: reasons,
    status: 'OPEN',
    bookingId: null,
    bookingReferenceCode: null,
    createdAt: now,
    updatedAt: now,
  };

  const booking = await createCommercialBooking({ companyId: req.companyId, account, facility, equipment, workOrder });
  workOrder.bookingId = booking.id;
  workOrder.bookingReferenceCode = booking.referenceCode;
  store.commercialWorkOrders.set(workOrder.id, workOrder);

  await appendEvent('COMMERCIAL_WORK_ORDER_CREATED', {
    source: 'COMMERCIAL',
    actor: req.user.id,
    entityType: 'COMMERCIAL_WORK_ORDER',
    entityId: workOrder.id,
    referenceCode: workOrder.referenceCode,
    details: {
      accountId: account.id,
      accountReference: account.referenceCode,
      facilityId: facility.id,
      equipmentId: equipment?.id || null,
      assetTag: equipment?.assetTag || null,
      slaTier: account.slaTier,
      priority,
      priorityReasons: reasons,
      bookingId: booking.id,
      bookingReferenceCode: booking.referenceCode,
    },
  });
  const notifications = notifyCommercialWorkOrderReceived(workOrder, booking, account, facility, 'COMMERCIAL');

  return res.status(201).json({
    data: {
      workOrder: publicWorkOrder(workOrder),
      booking: {
        id: booking.id,
        referenceCode: booking.referenceCode,
        source: booking.source,
        status: booking.status,
        priority: booking.priority,
        city: booking.city,
        appliance: booking.appliance,
      },
      notificationsQueued: notifications.map((entry) => ({ id: entry.id, channel: entry.channel, template: entry.template, to: entry.to })),
    },
  });
});

router.get('/commercial/work-orders', ...staffOnly, (req, res) => {
  let workOrders = visible(store.commercialWorkOrders, req);
  if (req.query.accountId) workOrders = workOrders.filter((wo) => wo.accountId === req.query.accountId);
  if (req.query.open === 'true') workOrders = workOrders.filter((wo) => isWorkOrderOpen(wo));
  workOrders.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return res.json({ data: workOrders.map(publicWorkOrder) });
});

/* ------------------------------------------------------------------ */
/* Consolidated billing summary                                        */
/* ------------------------------------------------------------------ */

router.get('/commercial/accounts/:id/billing-summary', ...staffOnly, (req, res) => {
  const account = findAccount(req, req.params.id);
  if (!account) return res.status(404).json({ error: 'Commercial account not found' });

  const workOrders = visible(store.commercialWorkOrders, req)
    .filter((wo) => wo.accountId === account.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const workOrdersByStatus = {};
  const bookingsByStatus = {};
  const lineItems = [];
  let feeTotal = 0;
  let openCount = 0;
  for (const workOrder of workOrders) {
    const effectiveStatus = workOrderEffectiveStatus(workOrder);
    workOrdersByStatus[effectiveStatus] = (workOrdersByStatus[effectiveStatus] || 0) + 1;
    if (effectiveStatus !== 'COMPLETED') openCount += 1;

    const booking = workOrder.bookingId ? store.bookings.get(workOrder.bookingId) : null;
    if (booking) {
      bookingsByStatus[booking.status] = (bookingsByStatus[booking.status] || 0) + 1;
      // Fees exactly as stored on the linked booking — reported
      // verbatim for the consolidated invoice, never re-priced here.
      feeTotal += booking.diagnosticFee || 0;
    }
    lineItems.push({
      workOrderReference: workOrder.referenceCode,
      bookingReference: workOrder.bookingReferenceCode,
      facilityId: workOrder.facilityId,
      assetTag: workOrder.assetTag,
      issue: workOrder.issue,
      priority: workOrder.priority,
      status: effectiveStatus,
      diagnosticFee: booking?.diagnosticFee ?? null,
      diagnosticFeeCurrency: booking?.diagnosticFeeCurrency ?? null,
      feeStatus: booking?.feeStatus ?? null,
      createdAt: workOrder.createdAt,
    });
  }

  return res.json({
    data: {
      account: {
        id: account.id,
        referenceCode: account.referenceCode,
        companyName: account.companyName,
        accountType: account.accountType,
        slaTier: account.slaTier,
        status: account.status,
      },
      generatedAt: new Date().toISOString(),
      consolidation: {
        basis: 'monthly',
        currency: 'USD',
        note: 'One consolidated invoice per account per month is cut from these line items. Diagnostic-fee totals are the fees stored on the linked bookings, reported verbatim.',
      },
      workOrders: { total: workOrders.length, open: openCount, byStatus: workOrdersByStatus },
      bookings: { total: lineItems.filter((item) => item.bookingReference).length, byStatus: bookingsByStatus },
      diagnosticFees: { total: feeTotal, currency: 'USD' },
      lineItems,
    },
  });
});

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

router.get('/commercial/overview', ...staffOnly, (req, res) => {
  const accounts = visible(store.commercialAccounts, req);
  const facilities = visible(store.commercialFacilities, req);
  const equipment = visible(store.commercialEquipment, req);
  const workOrders = visible(store.commercialWorkOrders, req);

  const accountsByType = {};
  for (const type of ACCOUNT_TYPES) accountsByType[type] = 0;
  for (const account of accounts) accountsByType[account.accountType] += 1;

  const equipmentByStatus = {};
  for (const status of EQUIPMENT_STATUSES) equipmentByStatus[status] = 0;
  for (const unit of equipment) equipmentByStatus[unit.status] += 1;

  const openWorkOrders = workOrders.filter((wo) => isWorkOrderOpen(wo));

  return res.json({
    data: {
      accounts: { total: accounts.length, byType: accountsByType },
      facilities: { total: facilities.length },
      equipment: { total: equipment.length, byStatus: equipmentByStatus },
      workOrders: {
        total: workOrders.length,
        open: openWorkOrders.length,
        priorityQueue: openWorkOrders.filter((wo) => wo.priority).length,
      },
      generatedAt: new Date().toISOString(),
    },
  });
});

/* ------------------------------------------------------------------ */
/* Maintenance agreements (B7, 2026-11-20)                             */
/*                                                                     */
/* Scheduled preventive visits on a cadence the office sets per      */
/* client. Terms are DATA recorded per agreement (scope / terms /    */
/* billing notes the office types) — the system invents none of      */
/* them. Due visits generate the standard commercial work order via  */
/* services/commercialAgreements.js. Generation runs lazily on       */
/* staff reads of this surface plus the explicit run below (the      */
/* platform's no-cron idiom).                                        */
/* ------------------------------------------------------------------ */

const agreementSchema = z.object({
  accountId: z.string().uuid(),
  facilityId: z.string().uuid().optional(),
  equipmentId: z.string().uuid().optional(),
  cadence: z.enum(AGREEMENT_CADENCES),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  firstVisitAt: z.string().datetime().optional(),
  scopeNotes: z.string().trim().max(1000).optional(),
  termsNotes: z.string().trim().max(2000).optional(),
  billingNotes: z.string().trim().max(1000).optional(),
});

const agreementPatchSchema = z.object({
  status: z.enum(AGREEMENT_STATUSES).optional(),
  cadence: z.enum(AGREEMENT_CADENCES).optional(),
  nextVisitAt: z.string().datetime().optional(),
  scopeNotes: z.string().trim().max(1000).nullable().optional(),
  termsNotes: z.string().trim().max(2000).nullable().optional(),
  billingNotes: z.string().trim().max(1000).nullable().optional(),
});

function findAgreement(req, id) {
  const agreement = store.maintenanceAgreements.get(id);
  if (!agreement) return null;
  if (!isAdmin(req) && agreement.companyId !== req.companyId) return null;
  return agreement;
}

function publicAgreement(agreement) {
  const account = store.commercialAccounts.get(agreement.accountId);
  const facility = store.commercialFacilities.get(agreement.facilityId);
  return {
    ...agreement,
    accountName: account?.companyName || null,
    accountReference: account?.referenceCode || null,
    facilityName: facility?.name || null,
    visitsGenerated: [...store.commercialWorkOrders.values()].filter((wo) => wo.agreementId === agreement.id).length,
  };
}

async function runAgreementGeneration(req) {
  try {
    return await generateDueAgreementVisits({ companyId: isAdmin(req) ? null : req.companyId });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'agreement generation failed', error: String(error?.message || error) }));
    return [];
  }
}

router.post('/commercial/agreements', ...staffOnly, async (req, res) => {
  const parsed = agreementSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid maintenance agreement', details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const account = findAccount(req, data.accountId);
  if (!account) return res.status(404).json({ error: 'Commercial account not found' });

  let facility = null;
  if (data.facilityId) {
    facility = findFacility(req, data.facilityId);
    if (!facility) return res.status(404).json({ error: 'Facility not found' });
    if (facility.accountId !== account.id) {
      return res.status(422).json({ error: 'Facility does not belong to this account' });
    }
  } else {
    const facilities = visible(store.commercialFacilities, req).filter((f) => f.accountId === account.id);
    if (facilities.length === 1) facility = facilities[0];
    else if (facilities.length === 0) return res.status(422).json({ error: 'This account has no facility yet — add one before the agreement' });
    else return res.status(400).json({ error: 'Pick the facility this agreement covers', facilities: facilities.map((f) => ({ id: f.id, name: f.name })) });
  }
  let equipment = null;
  if (data.equipmentId) {
    equipment = store.commercialEquipment.get(data.equipmentId) || null;
    if (!equipment || (!isAdmin(req) && equipment.companyId !== req.companyId)) {
      return res.status(404).json({ error: 'Equipment not found' });
    }
    if (equipment.facilityId !== facility.id) {
      return res.status(422).json({ error: 'Equipment is not registered at this facility' });
    }
  }

  const now = new Date();
  const nextVisitAt = data.firstVisitAt
    || (data.startDate ? `${data.startDate}T13:00:00.000Z` : now.toISOString());
  const agreement = {
    id: createId(),
    companyId: req.companyId,
    referenceCode: createMaintenanceAgreementCode(),
    accountId: account.id,
    facilityId: facility.id,
    equipmentId: equipment?.id || null,
    cadence: data.cadence,
    status: 'ACTIVE',
    startDate: data.startDate || now.toISOString().slice(0, 10),
    nextVisitAt,
    lastVisitAt: null,
    // Terms are the office's own per-client record — stored verbatim,
    // never defaulted or invented here.
    scopeNotes: data.scopeNotes || null,
    termsNotes: data.termsNotes || null,
    billingNotes: data.billingNotes || null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  store.maintenanceAgreements.set(agreement.id, agreement);
  await appendEvent('MAINTENANCE_AGREEMENT_CREATED', {
    source: 'COMMERCIAL',
    actor: req.user.id,
    entityType: 'MAINTENANCE_AGREEMENT',
    entityId: agreement.id,
    referenceCode: agreement.referenceCode,
    details: { accountId: account.id, facilityId: facility.id, equipmentId: equipment?.id || null, cadence: agreement.cadence, nextVisitAt: agreement.nextVisitAt },
  });
  return res.status(201).json({ data: publicAgreement(agreement) });
});

router.get('/commercial/agreements', ...staffOnly, async (req, res) => {
  await runAgreementGeneration(req);
  let agreements = visible(store.maintenanceAgreements, req);
  if (req.query.accountId) agreements = agreements.filter((a) => a.accountId === req.query.accountId);
  if (req.query.status) agreements = agreements.filter((a) => a.status === req.query.status);
  agreements.sort((a, b) => String(a.nextVisitAt).localeCompare(String(b.nextVisitAt)));
  return res.json({ data: agreements.map(publicAgreement) });
});

router.get('/commercial/agreements/:id', ...staffOnly, async (req, res) => {
  await runAgreementGeneration(req);
  const agreement = findAgreement(req, req.params.id);
  if (!agreement) return res.status(404).json({ error: 'Maintenance agreement not found' });
  return res.json({ data: publicAgreement(agreement) });
});

router.patch('/commercial/agreements/:id', ...staffOnly, async (req, res) => {
  const agreement = findAgreement(req, req.params.id);
  if (!agreement) return res.status(404).json({ error: 'Maintenance agreement not found' });
  const parsed = agreementPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid agreement update', details: parsed.error.flatten() });
  }
  Object.assign(agreement, parsed.data, { updatedAt: new Date().toISOString() });
  await appendEvent('MAINTENANCE_AGREEMENT_UPDATED', {
    source: 'COMMERCIAL',
    actor: req.user.id,
    entityType: 'MAINTENANCE_AGREEMENT',
    entityId: agreement.id,
    referenceCode: agreement.referenceCode,
    details: { fields: Object.keys(parsed.data), status: agreement.status, cadence: agreement.cadence, nextVisitAt: agreement.nextVisitAt },
  });
  return res.json({ data: publicAgreement(agreement) });
});

/**
 * Delete a maintenance agreement (owner only, 2026-11-23). Refused
 * with 409 while the agreement has generated work orders — those are
 * live job records, and deleting their parent would orphan them; the
 * owner Ends the agreement instead and it stays on file. An agreement
 * that never generated work deletes cleanly, audit-logged.
 */
router.post('/commercial/agreements/:id/delete', ...ownerOnly, async (req, res) => {
  const agreement = findAgreement(req, req.params.id);
  if (!agreement) return res.status(404).json({ error: 'Maintenance agreement not found' });
  const generated = [...store.commercialWorkOrders.values()].filter((wo) => wo.agreementId === agreement.id).length;
  if (generated > 0) {
    return res.status(409).json({
      error: `This agreement has already generated ${generated} work order${generated === 1 ? '' : 's'} — live job records that must keep their agreement on file. End the agreement instead of deleting it.`,
    });
  }
  store.maintenanceAgreements.delete(agreement.id);
  await appendEvent('MAINTENANCE_AGREEMENT_DELETED', {
    source: 'COMMERCIAL',
    actor: req.user.email,
    entityType: 'MAINTENANCE_AGREEMENT',
    entityId: agreement.id,
    referenceCode: agreement.referenceCode || null,
    details: { status: agreement.status || null, accountId: agreement.accountId || null },
  });
  return res.json({ data: { deleted: publicAgreement(agreement) } });
});

router.post('/commercial/agreements/generate-due', ...staffOnly, async (req, res) => {
  const summary = await runAgreementGeneration(req);
  const created = summary.reduce((sum, row) => sum + (row.workOrdersCreated || 0), 0);
  return res.json({ data: { agreementsProcessed: summary.length, workOrdersCreated: created, summary } });
});

/* ------------------------------------------------------------------ */
/* Commercial quotes + approve-by-link (B8, 2026-11-20)                */
/*                                                                     */
/* Structured custom quotes: line items priced by the OFFICE per     */
/* quote, totals computed server-side. Commercial is quote-only —    */
/* no diagnostic fee exists anywhere in this flow. Approval rides a  */
/* hash-at-rest token link (the email-change idiom); approval        */
/* converts the quote into a commercial work order carrying the      */
/* quote's line items and total verbatim.                            */
/* ------------------------------------------------------------------ */

const quoteLineItemSchema = z.object({
  description: z.string().trim().min(2).max(200),
  quantity: z.number().positive().max(10000),
  unitPriceCents: z.number().int().min(0).max(100000000),
});

const quoteSchema = z.object({
  accountId: z.string().uuid(),
  facilityId: z.string().uuid(),
  equipmentId: z.string().uuid().optional(),
  title: z.string().trim().min(3).max(160),
  lineItems: z.array(quoteLineItemSchema).min(1).max(50),
  notes: z.string().trim().max(1000).optional(),
  termsNotes: z.string().trim().max(2000).optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const quotePatchSchema = z.object({
  title: z.string().trim().min(3).max(160).optional(),
  lineItems: z.array(quoteLineItemSchema).min(1).max(50).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  termsNotes: z.string().trim().max(2000).nullable().optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

function findQuote(req, id) {
  const quote = store.commercialQuotes.get(id);
  if (!quote) return null;
  if (!isAdmin(req) && quote.companyId !== req.companyId) return null;
  return quote;
}

function publicQuoteStaff(quote) {
  return { ...quote, effectiveStatus: quoteEffectiveStatus(quote) };
}

router.post('/commercial/quotes', ...staffOnly, async (req, res) => {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid quote', details: parsed.error.flatten() });
  }
  const data = parsed.data;
  const account = findAccount(req, data.accountId);
  if (!account) return res.status(404).json({ error: 'Commercial account not found' });
  const facility = findFacility(req, data.facilityId);
  if (!facility) return res.status(404).json({ error: 'Facility not found' });
  if (facility.accountId !== account.id) {
    return res.status(422).json({ error: 'Facility does not belong to this account' });
  }
  let equipment = null;
  if (data.equipmentId) {
    equipment = store.commercialEquipment.get(data.equipmentId) || null;
    if (!equipment || (!isAdmin(req) && equipment.companyId !== req.companyId)) {
      return res.status(404).json({ error: 'Equipment not found' });
    }
    if (equipment.facilityId !== facility.id) {
      return res.status(422).json({ error: 'Equipment is not registered at this facility' });
    }
  }

  const { lineItems, totalCents } = priceQuoteLineItems(data.lineItems);
  const now = new Date().toISOString();
  const quote = {
    id: createId(),
    companyId: req.companyId,
    referenceCode: createCommercialQuoteCode(),
    accountId: account.id,
    facilityId: facility.id,
    equipmentId: equipment?.id || null,
    title: data.title,
    lineItems,
    totalCents,
    currency: 'USD',
    notes: data.notes || null,
    termsNotes: data.termsNotes || null,
    validUntil: data.validUntil || null,
    status: 'DRAFT',
    sentAt: null,
    decidedAt: null,
    decidedByName: null,
    workOrderId: null,
    workOrderReference: null,
    createdAt: now,
    updatedAt: now,
  };
  store.commercialQuotes.set(quote.id, quote);
  await appendEvent('COMMERCIAL_QUOTE_CREATED', {
    source: 'COMMERCIAL',
    actor: req.user.id,
    entityType: 'COMMERCIAL_QUOTE',
    entityId: quote.id,
    referenceCode: quote.referenceCode,
    details: { accountId: account.id, facilityId: facility.id, totalCents, lineItems: lineItems.length },
  });
  return res.status(201).json({ data: publicQuoteStaff(quote) });
});

router.get('/commercial/quotes', ...staffOnly, (req, res) => {
  let quotes = visible(store.commercialQuotes, req);
  if (req.query.accountId) quotes = quotes.filter((q) => q.accountId === req.query.accountId);
  if (req.query.status) quotes = quotes.filter((q) => quoteEffectiveStatus(q) === req.query.status);
  quotes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return res.json({ data: quotes.map(publicQuoteStaff) });
});

router.get('/commercial/quotes/:id', ...staffOnly, (req, res) => {
  const quote = findQuote(req, req.params.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  return res.json({ data: publicQuoteStaff(quote) });
});

router.patch('/commercial/quotes/:id', ...staffOnly, async (req, res) => {
  const quote = findQuote(req, req.params.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  if (quote.status !== 'DRAFT') {
    return res.status(422).json({ error: 'Only a draft quote can be edited — this one has already been sent or decided.' });
  }
  const parsed = quotePatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid quote update', details: parsed.error.flatten() });
  }
  const data = { ...parsed.data };
  if (data.lineItems) {
    const priced = priceQuoteLineItems(data.lineItems);
    data.lineItems = priced.lineItems;
    quote.totalCents = priced.totalCents;
  }
  Object.assign(quote, data, { updatedAt: new Date().toISOString() });
  await appendEvent('COMMERCIAL_QUOTE_UPDATED', {
    source: 'COMMERCIAL',
    actor: req.user.id,
    entityType: 'COMMERCIAL_QUOTE',
    entityId: quote.id,
    referenceCode: quote.referenceCode,
    details: { fields: Object.keys(parsed.data), totalCents: quote.totalCents },
  });
  return res.json({ data: publicQuoteStaff(quote) });
});

/**
 * Delete a commercial quote (owner only, 2026-11-23). A quote the
 * customer has APPROVED — or one already converted to a work order —
 * is a financial record and is refused with 409: it stays on file.
 * Any other quote deletes with its outstanding approval tokens, so a
 * sent approval link dies with the quote. Audit-logged.
 */
router.post('/commercial/quotes/:id/delete', ...ownerOnly, async (req, res) => {
  const quote = findQuote(req, req.params.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  if (quote.status === 'APPROVED' || quote.workOrderId) {
    return res.status(409).json({
      error: 'This quote was approved by the customer and converted to a work order — it is a financial record and cannot be deleted. It stays on file.',
    });
  }
  for (const [key, record] of store.commercialQuoteTokens.entries()) {
    if (record && record.quoteId === quote.id) store.commercialQuoteTokens.delete(key);
  }
  store.commercialQuotes.delete(quote.id);
  await appendEvent('COMMERCIAL_QUOTE_DELETED', {
    source: 'COMMERCIAL',
    actor: req.user.email,
    entityType: 'COMMERCIAL_QUOTE',
    entityId: quote.id,
    referenceCode: quote.referenceCode || null,
    details: { status: quote.status || null, accountId: quote.accountId || null },
  });
  return res.json({ data: { deleted: publicQuoteStaff(quote) } });
});

router.post('/commercial/quotes/:id/send', ...staffOnly, async (req, res) => {
  const quote = findQuote(req, req.params.id);
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  if (quote.status === 'APPROVED' || quote.status === 'DECLINED') {
    return res.status(422).json({ error: 'This quote has already been decided — it cannot be sent again.' });
  }
  if (quoteEffectiveStatus(quote) === 'EXPIRED') {
    return res.status(422).json({ error: 'This quote has expired — extend its valid-until date by re-issuing it as a new quote.' });
  }
  const account = findAccount(req, quote.accountId);
  if (!account) return res.status(404).json({ error: 'Commercial account not found' });

  const { token, expiresAt, tokenId } = issueQuoteApprovalToken(quote);
  quote.status = 'SENT';
  quote.sentAt = new Date().toISOString();
  quote.updatedAt = quote.sentAt;
  const approvalUrl = `${process.env.PUBLIC_WEB_BASE || 'https://topspeedserviceos.com'}/quote/?token=${encodeURIComponent(token)}`;

  // The approval email rides the outbox, drained awaited inside the
  // request (the password-reset lesson). A drain failure never fails
  // the send — staff still get the link to share directly.
  const entries = notifyCommercialQuoteSent(account, quote, { tokenId, approvalUrl }, 'COMMERCIAL');
  if (entries.length) {
    await drainEntries(entries).catch((error) => {
      console.error(JSON.stringify({ level: 'error', message: 'quote email drain failed', error: String(error?.message || error) }));
    });
  }
  await appendEvent('COMMERCIAL_QUOTE_SENT', {
    source: 'COMMERCIAL',
    actor: req.user.id,
    entityType: 'COMMERCIAL_QUOTE',
    entityId: quote.id,
    referenceCode: quote.referenceCode,
    details: { accountId: account.id, totalCents: quote.totalCents, emailed: entries.length > 0, expiresAt },
  });
  return res.json({
    data: {
      quote: publicQuoteStaff(quote),
      approvalUrl,
      expiresAt,
      emailed: entries.length > 0,
      emailTo: entries.length ? account.email : null,
    },
  });
});

/* ------- Quote approval link (public; the token is the credential) ------- */

router.get('/commercial/quotes/approval/:token', async (req, res) => {
  const found = findQuoteApproval(req.params.token);
  if (found.state === 'invalid' || found.state === 'expired') {
    return res.status(400).json({ error: QUOTE_INVALID_MESSAGE });
  }
  // A decided quote's link shows the recorded outcome; a superseded
  // link still views the quote (deciding is what's blocked).
  return res.json({ data: publicQuoteView(found.quote) });
});

const decideSchema = z.object({
  decision: z.enum(['APPROVED', 'DECLINED']),
  name: z.string().trim().max(120).optional(),
});

router.post('/commercial/quotes/approval/:token/decide', async (req, res) => {
  const parsed = decideSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid decision', details: parsed.error.flatten() });
  }
  const result = await decideQuoteByToken(req.params.token, parsed.data.decision, { decidedByName: parsed.data.name || null });
  if (!result.ok) {
    if (result.code === 'QUOTE_ALREADY_DECIDED' && result.quote) {
      return res.status(409).json({ error: 'already_decided', data: publicQuoteView(result.quote) });
    }
    return res.status(result.status).json({ error: result.error, code: result.code });
  }
  return res.json({
    data: {
      ...publicQuoteView(result.quote),
      workOrder: result.workOrder
        ? { id: result.workOrder.id, referenceCode: result.workOrder.referenceCode, bookingReferenceCode: result.workOrder.bookingReferenceCode }
        : null,
    },
  });
});

export default router;

/* ------- Property-manager AI bulk requests (public intake) -------
 * The PM portal's Speedy panel turns one pasted message into a batch:
 * one connection record per unit problem, all sharing a batch
 * reference, landing with the Service Setters like every other intake.
 */
const bulkSchema = z.object({
  manager: z.object({
    name: z.string().trim().min(2).max(120),
    phone: z.string().trim().min(7).max(30),
    company: z.string().trim().max(120).optional(),
  }),
  property: z.string().trim().min(3).max(200),
  requests: z.array(z.object({
    unit: z.string().trim().max(40).nullable().optional(),
    appliance: z.string().trim().min(2).max(80),
    issue: z.string().trim().min(3).max(500),
    urgency: z.enum(['standard', 'urgent']).optional(),
  })).min(1).max(25),
});

router.post('/commercial/bulk-requests', intakeRateLimit('connections'), async (req, res) => {
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid bulk request', details: parsed.error.flatten() });
  }
  // Intake shield (2026-11-19): this public intake writes the same
  // connection records and fires the same owner notifications as
  // /connections, so it carries the same shield — honeypot discard
  // (same 201 shape, nothing persisted, nothing notified) and the
  // NANP phone gate on the manager's number.
  if (honeypotTripped(req.body)) {
    return res.status(201).json({
      data: {
        batchReference: createReferenceCode(),
        count: parsed.data.requests.length,
        references: parsed.data.requests.map(() => createReferenceCode()),
      },
    });
  }
  const phoneCheck = validateNanpPhone(parsed.data.manager.phone);
  if (!phoneCheck.ok) {
    return res.status(400).json({ error: INVALID_PHONE_MESSAGE, code: 'INVALID_PHONE' });
  }
  const { manager, property, requests } = parsed.data;
  const batchReference = createReferenceCode();
  const references = [];
  for (const item of requests) {
    const record = await createConnectionRecord({
      name: manager.name,
      phone: manager.phone,
      type: 'PM_SERVICE_REQUEST',
      source: 'pm-bulk-speedy',
      message:
        `Batch ${batchReference} · Property: ${property}` +
        (manager.company ? ` · Manager company: ${manager.company}` : '') +
        ` · ${item.unit ? item.unit + ' — ' : ''}${item.appliance}: ${item.issue}` +
        (item.urgency === 'urgent' ? ' · URGENCY: urgent' : ''),
    });
    references.push(record.reference);
  }
  // Unified notifications: ONE confirmation + staff alert per batch
  // (not one per unit), carrying every recorded reference.
  notifySubmission({
    kind: 'PM_SERVICE_REQUEST',
    reference: batchReference,
    submitter: { name: manager.name, phone: manager.phone },
    lines: [
      `Property: ${property}`,
      ...(manager.company ? [`Manager company: ${manager.company}`] : []),
      `Requests in batch: ${references.length}`,
      `References: ${references.join(', ')}`,
    ],
    source: 'pm-bulk-speedy',
  });
  return res.status(201).json({ data: { batchReference, count: references.length, references } });
});
