import { Router } from 'express';
import { z } from 'zod';
import { areasForZip, SERVICE_CITIES, SERVICE_ZIPS } from '../config/serviceAreas.js';
import { ROLES } from '../config/security.js';
import {
  appendEvent,
  createAssetTag,
  createCommercialAccountCode,
  createId,
  createWorkOrderCode,
  store,
} from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import {
  ACCOUNT_TYPES,
  EQUIPMENT_STATUSES,
  SLA_TIERS,
  createCommercialBooking,
  deriveWorkOrderPriority,
  isWorkOrderOpen,
  workOrderEffectiveStatus,
} from '../services/commercial.js';
import { notifyCommercialWorkOrderReceived } from '../services/notifications.js';

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

const staffOnly = [authenticate, requireCompany, requireRole(ROLES.DISPATCHER, ROLES.PLATFORM_ADMIN)];

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

router.post('/commercial/accounts', authenticate, requireCompany, (req, res) => {
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
  appendEvent('COMMERCIAL_ACCOUNT_CREATED', {
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

router.post('/commercial/accounts/:id/facilities', ...staffOnly, (req, res) => {
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
  appendEvent('COMMERCIAL_FACILITY_ADDED', {
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

router.post('/commercial/facilities/:facilityId/equipment', ...staffOnly, (req, res) => {
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
  appendEvent('COMMERCIAL_EQUIPMENT_REGISTERED', {
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

router.patch('/commercial/equipment/:id/status', ...staffOnly, (req, res) => {
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
  appendEvent('EQUIPMENT_STATUS_CHANGED', {
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

router.post('/commercial/work-orders', ...staffOnly, (req, res) => {
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

  const booking = createCommercialBooking({ companyId: req.companyId, account, facility, equipment, workOrder });
  workOrder.bookingId = booking.id;
  workOrder.bookingReferenceCode = booking.referenceCode;
  store.commercialWorkOrders.set(workOrder.id, workOrder);

  appendEvent('COMMERCIAL_WORK_ORDER_CREATED', {
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

export default router;
