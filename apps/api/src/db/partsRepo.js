import { PARTNER_VENDOR_SUPPLIERS } from '../data/partsPartners.js';
import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Parts Supply OS persistence — suppliers, parts inventory, purchase
 * orders (with lines) and per-job parts usage. Same house pattern as
 * the other modules: the in-memory store is the working shape, these
 * persist* helpers write through to Postgres, and hydrateParts() loads
 * everything at cold start. No inventory seed data — the warehouse
 * starts empty. The one seeded record is the owner-registered
 * partnership vendor directory (src/data/partsPartners.js), ensured
 * create-only at the top of hydrateParts().
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreSupplier(row) {
  return {
    id: row.id,
    name: row.name,
    contact: row.contact || null,
    phone: row.phone || null,
    email: row.email || null,
    terms: row.terms || null,
    vendorType: row.vendorType || 'STANDARD',
    active: row.active !== false,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toStorePart(row) {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    brand: row.brand || null,
    unitCostCents: row.unitCostCents || 0,
    sellPriceCents: row.sellPriceCents ?? null,
    stockOnHand: row.stockOnHand || 0,
    reorderPoint: row.reorderPoint || 0,
    supplierId: row.supplierId || null,
    location: row.location || null,
    active: row.active !== false,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toStorePurchaseOrder(row, lines) {
  return {
    id: row.id,
    reference: row.reference,
    supplierId: row.supplierId,
    status: row.status,
    totalCents: row.totalCents || 0,
    notes: row.notes || null,
    orderedAt: iso(row.orderedAt),
    receivedAt: iso(row.receivedAt),
    createdBy: row.createdBy || null,
    lines: (lines || []).map((line) => ({
      partId: line.partId,
      qty: line.qty,
      unitCostCents: line.unitCostCents,
    })),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toStoreUsage(row) {
  return {
    id: row.id,
    bookingReference: row.bookingReference,
    partId: row.partId,
    qty: row.qty,
    unitCostCents: row.unitCostCents,
    recordedBy: row.recordedBy || null,
    createdAt: iso(row.createdAt),
  };
}

export async function persistSupplier(supplier) {
  if (!DATABASE_ENABLED || !supplier?.id) return;
  try {
    const row = {
      id: supplier.id,
      name: supplier.name,
      contact: supplier.contact || null,
      phone: supplier.phone || null,
      email: supplier.email || null,
      terms: supplier.terms || null,
      vendorType: supplier.vendorType || 'STANDARD',
      active: supplier.active !== false,
      createdAt: new Date(supplier.createdAt),
      updatedAt: new Date(supplier.updatedAt || supplier.createdAt),
    };
    await db().supplier.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('persistSupplier failed', error?.message || error);
  }
}

export async function persistPart(part) {
  if (!DATABASE_ENABLED || !part?.id) return;
  try {
    const row = {
      id: part.id,
      sku: part.sku,
      name: part.name,
      category: part.category,
      brand: part.brand || null,
      unitCostCents: part.unitCostCents || 0,
      sellPriceCents: part.sellPriceCents ?? null,
      stockOnHand: part.stockOnHand || 0,
      reorderPoint: part.reorderPoint || 0,
      supplierId: part.supplierId || null,
      location: part.location || null,
      active: part.active !== false,
      createdAt: new Date(part.createdAt),
      updatedAt: new Date(part.updatedAt || part.createdAt),
    };
    await db().part.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('persistPart failed', error?.message || error);
  }
}

export async function persistPurchaseOrder(po) {
  if (!DATABASE_ENABLED || !po?.id) return;
  try {
    const prisma = db();
    const row = {
      id: po.id,
      reference: po.reference,
      supplierId: po.supplierId,
      status: po.status,
      totalCents: po.totalCents || 0,
      notes: po.notes || null,
      orderedAt: po.orderedAt ? new Date(po.orderedAt) : null,
      receivedAt: po.receivedAt ? new Date(po.receivedAt) : null,
      createdBy: po.createdBy || null,
      createdAt: new Date(po.createdAt),
      updatedAt: new Date(po.updatedAt || po.createdAt),
    };
    await prisma.purchaseOrder.upsert({ where: { id: row.id }, update: row, create: row });
    // Lines are immutable once written except through receive (which
    // doesn't change them), so a replace-on-write keeps them truthful.
    await prisma.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: po.id } });
    if (po.lines?.length) {
      await prisma.purchaseOrderLine.createMany({
        data: po.lines.map((line) => ({
          purchaseOrderId: po.id,
          partId: line.partId,
          qty: line.qty,
          unitCostCents: line.unitCostCents,
        })),
      });
    }
  } catch (error) {
    console.error('persistPurchaseOrder failed', error?.message || error);
  }
}

export async function persistPartUsage(usage) {
  if (!DATABASE_ENABLED || !usage?.id) return;
  try {
    const row = {
      id: usage.id,
      bookingReference: usage.bookingReference,
      partId: usage.partId,
      qty: usage.qty,
      unitCostCents: usage.unitCostCents,
      recordedBy: usage.recordedBy || null,
      createdAt: new Date(usage.createdAt),
    };
    await db().partUsage.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('persistPartUsage failed', error?.message || error);
  }
}

/**
 * Partnership vendor distributors registered by the owner (see
 * src/data/partsPartners.js) are ensured at boot, create-only by id —
 * the same pattern as the network vendor partners in bookingsRepo.
 * The Prisma seed at deploy time creates them too; this pass makes
 * the partner directory correct even on an instance whose seed has
 * not run. Failures degrade to "partners not ensured", never block
 * the rest of parts hydration.
 */
async function ensurePartnerVendors(prisma) {
  for (const supplier of PARTNER_VENDOR_SUPPLIERS) {
    await prisma.supplier.upsert({ where: { id: supplier.id }, update: {}, create: supplier });
  }
}

export async function hydrateParts() {
  if (!DATABASE_ENABLED) return 0;
  const prisma = db();
  try {
    await ensurePartnerVendors(prisma);
  } catch (error) {
    console.error('ensurePartnerVendors failed (partner vendors degraded, parts hydration continues)', error?.message || error);
  }
  const [supplierRows, partRows, poRows, lineRows, usageRows] = await Promise.all([
    prisma.supplier.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.part.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.purchaseOrder.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.purchaseOrderLine.findMany(),
    prisma.partUsage.findMany({ orderBy: { createdAt: 'asc' } }),
  ]);
  store.suppliers = supplierRows.map(toStoreSupplier);
  store.parts = partRows.map(toStorePart);
  const linesByPo = new Map();
  for (const line of lineRows) {
    if (!linesByPo.has(line.purchaseOrderId)) linesByPo.set(line.purchaseOrderId, []);
    linesByPo.get(line.purchaseOrderId).push(line);
  }
  store.purchaseOrders = poRows.map((row) => toStorePurchaseOrder(row, linesByPo.get(row.id) || []));
  store.partUsages = usageRows.map(toStoreUsage);
  return store.parts.length;
}
