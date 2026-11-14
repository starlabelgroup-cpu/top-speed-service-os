import { Router } from 'express';
import { z } from 'zod';
import { createId, store } from '../data/store.js';
import {
  persistPart,
  persistPartUsage,
  persistPurchaseOrder,
  persistSupplier,
} from '../db/partsRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { emitReport } from '../services/managementReports.js';

/**
 * Parts Supply OS — suppliers, parts inventory, purchase orders and
 * per-job parts usage. Operations data: every route is staff-gated.
 * Stock moves only through three doors: adjust-stock (manual, with a
 * reason on the event), PO receive (adds line quantities), and usage
 * (removes for a job, refuses to go negative). Inventory starts empty;
 * suppliers include owner-registered partnership vendor distributors
 * (vendorType PARTNER_DISTRIBUTOR — see src/data/partsPartners.js),
 * which staff can also flag on any supplier they create here.
 */
const router = Router();
const staff = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

const now = () => new Date().toISOString();

function partView(part) {
  const supplier = part.supplierId ? store.suppliers.find((s) => s.id === part.supplierId) : null;
  return {
    ...part,
    supplierName: supplier ? supplier.name : null,
    lowStock: part.stockOnHand <= part.reorderPoint,
  };
}

function poView(po) {
  const supplier = store.suppliers.find((s) => s.id === po.supplierId);
  return {
    ...po,
    supplierName: supplier ? supplier.name : null,
    lines: po.lines.map((line) => {
      const part = store.parts.find((p) => p.id === line.partId);
      return { ...line, sku: part ? part.sku : null, partName: part ? part.name : null };
    }),
  };
}

/* ------------------------------- Suppliers ------------------------------ */

const supplierSchema = z.object({
  name: z.string().trim().min(2).max(120),
  contact: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.string().email().optional(),
  terms: z.string().trim().max(200).optional(),
  vendorType: z.enum(['STANDARD', 'PARTNER_DISTRIBUTOR']).optional(),
  active: z.boolean().optional(),
});

router.get('/parts/suppliers', ...staff, (req, res) => {
  return res.json({ data: [...store.suppliers].reverse() });
});

router.post('/parts/suppliers', ...staff, async (req, res) => {
  const parsed = supplierSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid supplier', details: parsed.error.flatten() });
  }
  const t = now();
  const supplier = {
    id: createId(),
    name: parsed.data.name,
    contact: parsed.data.contact || null,
    phone: parsed.data.phone || null,
    email: parsed.data.email || null,
    terms: parsed.data.terms || null,
    vendorType: parsed.data.vendorType || 'STANDARD',
    active: parsed.data.active !== false,
    createdAt: t,
    updatedAt: t,
  };
  store.suppliers.push(supplier);
  await persistSupplier(supplier);
  return res.status(201).json({ data: supplier });
});

/* --------------------------------- Parts -------------------------------- */

const partCreateSchema = z.object({
  sku: z.string().trim().min(1).max(60),
  name: z.string().trim().min(2).max(160),
  category: z.string().trim().min(2).max(80),
  brand: z.string().trim().max(80).optional(),
  unitCostCents: z.number().int().min(0).max(100000000),
  sellPriceCents: z.number().int().min(0).max(100000000).optional(),
  stockOnHand: z.number().int().min(0).max(1000000).optional(),
  reorderPoint: z.number().int().min(0).max(1000000).optional(),
  supplierId: z.string().uuid().optional(),
  location: z.string().trim().max(80).optional(),
});

const partUpdateSchema = partCreateSchema.partial().extend({
  active: z.boolean().optional(),
});

router.get('/parts/parts', ...staff, (req, res) => {
  return res.json({ data: [...store.parts].reverse().map(partView) });
});

router.post('/parts/parts', ...staff, async (req, res) => {
  const parsed = partCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid part', details: parsed.error.flatten() });
  }
  if (store.parts.some((p) => p.sku.toLowerCase() === parsed.data.sku.toLowerCase())) {
    return res.status(409).json({ error: `SKU ${parsed.data.sku} already exists` });
  }
  if (parsed.data.supplierId && !store.suppliers.some((s) => s.id === parsed.data.supplierId)) {
    return res.status(422).json({ error: 'supplierId does not match a supplier' });
  }
  const t = now();
  const part = {
    id: createId(),
    sku: parsed.data.sku,
    name: parsed.data.name,
    category: parsed.data.category,
    brand: parsed.data.brand || null,
    unitCostCents: parsed.data.unitCostCents,
    sellPriceCents: parsed.data.sellPriceCents ?? null,
    stockOnHand: parsed.data.stockOnHand || 0,
    reorderPoint: parsed.data.reorderPoint || 0,
    supplierId: parsed.data.supplierId || null,
    location: parsed.data.location || null,
    active: true,
    createdAt: t,
    updatedAt: t,
  };
  store.parts.push(part);
  await persistPart(part);
  return res.status(201).json({ data: partView(part) });
});

router.patch('/parts/parts/:id', ...staff, async (req, res) => {
  const part = store.parts.find((p) => p.id === req.params.id);
  if (!part) return res.status(404).json({ error: 'Part not found' });
  const parsed = partUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid part update', details: parsed.error.flatten() });
  }
  if (parsed.data.sku && store.parts.some((p) => p.id !== part.id && p.sku.toLowerCase() === parsed.data.sku.toLowerCase())) {
    return res.status(409).json({ error: `SKU ${parsed.data.sku} already exists` });
  }
  if (parsed.data.supplierId && !store.suppliers.some((s) => s.id === parsed.data.supplierId)) {
    return res.status(422).json({ error: 'supplierId does not match a supplier' });
  }
  Object.assign(part, parsed.data, { updatedAt: now() });
  await persistPart(part);
  return res.json({ data: partView(part) });
});

const adjustSchema = z.object({
  delta: z.number().int().refine((v) => v !== 0, { message: 'delta must be non-zero' }),
  reason: z.string().trim().max(300).optional(),
});

router.post('/parts/parts/:id/adjust-stock', ...staff, async (req, res) => {
  const part = store.parts.find((p) => p.id === req.params.id);
  if (!part) return res.status(404).json({ error: 'Part not found' });
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid stock adjustment', details: parsed.error.flatten() });
  }
  const next = part.stockOnHand + parsed.data.delta;
  if (next < 0) {
    return res.status(422).json({ error: `Adjustment would take stock below zero (${part.stockOnHand} on hand)` });
  }
  part.stockOnHand = next;
  part.updatedAt = now();
  await persistPart(part);
  return res.json({ data: partView(part), reason: parsed.data.reason || null });
});

/* ---------------------------- Purchase orders --------------------------- */

const poCreateSchema = z.object({
  supplierId: z.string().uuid(),
  status: z.enum(['DRAFT', 'ORDERED']).optional(),
  notes: z.string().trim().max(500).optional(),
  lines: z.array(z.object({
    partId: z.string().uuid(),
    qty: z.number().int().min(1).max(100000),
    unitCostCents: z.number().int().min(0).max(100000000).optional(),
  })).min(1).max(100),
});

function nextPoReference() {
  return `PS-PO-${String(store.purchaseOrders.length + 1).padStart(4, '0')}`;
}

router.get('/parts/purchase-orders', ...staff, (req, res) => {
  return res.json({ data: [...store.purchaseOrders].reverse().map(poView) });
});

router.post('/parts/purchase-orders', ...staff, async (req, res) => {
  const parsed = poCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid purchase order', details: parsed.error.flatten() });
  }
  if (!store.suppliers.some((s) => s.id === parsed.data.supplierId)) {
    return res.status(422).json({ error: 'supplierId does not match a supplier' });
  }
  const lines = [];
  for (const line of parsed.data.lines) {
    const part = store.parts.find((p) => p.id === line.partId);
    if (!part) return res.status(422).json({ error: `partId ${line.partId} not found` });
    lines.push({
      partId: line.partId,
      qty: line.qty,
      unitCostCents: line.unitCostCents ?? part.unitCostCents,
    });
  }
  const t = now();
  const status = parsed.data.status || 'DRAFT';
  const po = {
    id: createId(),
    reference: nextPoReference(),
    supplierId: parsed.data.supplierId,
    status,
    totalCents: lines.reduce((sum, line) => sum + line.qty * line.unitCostCents, 0),
    notes: parsed.data.notes || null,
    orderedAt: status === 'ORDERED' ? t : null,
    receivedAt: null,
    createdBy: req.user?.id || null,
    lines,
    createdAt: t,
    updatedAt: t,
  };
  store.purchaseOrders.push(po);
  await persistPurchaseOrder(po);
  emitReport({
    department: 'parts',
    type: 'PART_PURCHASE_ORDER_CREATED',
    title: `Parts purchase order ${po.reference} created`,
    detail: { purchaseOrderId: po.id, reference: po.reference, supplierId: po.supplierId, status: po.status, totalCents: po.totalCents, lineCount: po.lines.length, createdBy: po.createdBy },
    source: 'parts-console',
    reference: po.reference,
    eventKey: `purchase-order:${po.id}:created:report`,
  });
  return res.status(201).json({ data: poView(po) });
});

router.post('/parts/purchase-orders/:id/receive', ...staff, async (req, res) => {
  const po = store.purchaseOrders.find((p) => p.id === req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.status === 'RECEIVED') return res.status(409).json({ error: 'Purchase order already received' });
  if (po.status === 'CANCELLED') return res.status(409).json({ error: 'Purchase order is cancelled' });
  const t = now();
  for (const line of po.lines) {
    const part = store.parts.find((p) => p.id === line.partId);
    if (part) {
      part.stockOnHand += line.qty;
      part.updatedAt = t;
      await persistPart(part);
    }
  }
  po.status = 'RECEIVED';
  po.receivedAt = t;
  po.updatedAt = t;
  await persistPurchaseOrder(po);
  emitReport({
    department: 'parts',
    type: 'PART_PURCHASE_ORDER_RECEIVED',
    title: `Parts purchase order ${po.reference} received`,
    detail: { purchaseOrderId: po.id, reference: po.reference, supplierId: po.supplierId, totalCents: po.totalCents, receivedAt: po.receivedAt },
    source: 'parts-console',
    reference: po.reference,
    eventKey: `purchase-order:${po.id}:received:report`,
  });
  return res.json({ data: poView(po) });
});

/* --------------------------------- Usage -------------------------------- */

const usageSchema = z.object({
  bookingReference: z.string().trim().min(2).max(60),
  partId: z.string().uuid(),
  qty: z.number().int().min(1).max(100000),
});

router.get('/parts/usage', ...staff, (req, res) => {
  const data = [...store.partUsages].reverse().slice(0, 200).map((usage) => {
    const part = store.parts.find((p) => p.id === usage.partId);
    return { ...usage, sku: part ? part.sku : null, partName: part ? part.name : null };
  });
  return res.json({ data });
});

router.post('/parts/usage', ...staff, async (req, res) => {
  const parsed = usageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid usage record', details: parsed.error.flatten() });
  }
  const part = store.parts.find((p) => p.id === parsed.data.partId);
  if (!part) return res.status(404).json({ error: 'Part not found' });
  if (part.stockOnHand < parsed.data.qty) {
    return res.status(422).json({
      error: `Not enough stock for ${part.sku}: ${part.stockOnHand} on hand, ${parsed.data.qty} requested`,
    });
  }
  const usage = {
    id: createId(),
    bookingReference: parsed.data.bookingReference,
    partId: part.id,
    qty: parsed.data.qty,
    unitCostCents: part.unitCostCents,
    recordedBy: req.user?.id || null,
    createdAt: now(),
  };
  part.stockOnHand -= parsed.data.qty;
  part.updatedAt = usage.createdAt;
  store.partUsages.push(usage);
  await persistPartUsage(usage);
  await persistPart(part);
  return res.status(201).json({ data: usage });
});

/* ------------------------------ Low stock ------------------------------- */

router.get('/parts/low-stock', ...staff, (req, res) => {
  const data = store.parts
    .filter((p) => p.active && p.stockOnHand <= p.reorderPoint)
    .map(partView);
  return res.json({ data });
});

/* ------------------------------- Summary -------------------------------- */

export function partsSummary() {
  const activeParts = store.parts.filter((p) => p.active);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthMs = monthStart.getTime();
  const usageThisMonth = store.partUsages.filter((u) => new Date(u.createdAt).getTime() >= monthMs);
  const openPOs = store.purchaseOrders.filter((po) => po.status === 'DRAFT' || po.status === 'ORDERED');
  return {
    suppliers: store.suppliers.filter((s) => s.active).length,
    parts: activeParts.length,
    inventoryUnits: activeParts.reduce((sum, p) => sum + p.stockOnHand, 0),
    inventoryValueCents: activeParts.reduce((sum, p) => sum + p.stockOnHand * p.unitCostCents, 0),
    lowStockCount: activeParts.filter((p) => p.stockOnHand <= p.reorderPoint).length,
    openPurchaseOrders: openPOs.length,
    openPurchaseOrdersCents: openPOs.reduce((sum, po) => sum + po.totalCents, 0),
    partsCostThisMonthCents: usageThisMonth.reduce((sum, u) => sum + u.qty * u.unitCostCents, 0),
    usageRecords: store.partUsages.length,
  };
}

router.get('/parts/summary', ...staff, (req, res) => {
  return res.json({ data: partsSummary() });
});

export default router;
