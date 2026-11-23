import { createId } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Top Speed Sales OS repository (2026-11-23). Same dual-mode
 * discipline as facebookOsRepo: Prisma when DATABASE_URL is set, an
 * in-memory fallback with identical shapes when it is not.
 *
 * Invariants enforced here:
 *  - a product is BORN a DRAFT — create() forces the status, so no
 *    caller can mint an ACTIVE (publicly sellable) row directly;
 *    activation is a deliberate staff PATCH;
 *  - an order is BORN PENDING_PAYMENT / PENDING — create() forces
 *    both statuses and the server-computed totals the service
 *    passes in; client-named prices never reach this layer;
 *  - order items are SNAPSHOTS (title + priceCents copied at order
 *    time), so a later product edit never rewrites a placed order.
 *
 * The single SalesVendor ("Top Speed Appliances", the used-appliance
 * shop at topspeedappliances.com) is resolved lazily: the first read
 * creates the row from the SALES_VENDOR_IDENTITY constant in
 * services/salesOs.js when the table is empty. No vendor/product
 * data is seeded by migration — staff enter the real catalog.
 */

function iso(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function rowFromDb(row) {
  if (!row) return null;
  return {
    ...row,
    photos: Array.isArray(row.photos) ? row.photos : [],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function orderFromDb(row) {
  if (!row) return null;
  const { items, ...rest } = row;
  return {
    ...rest,
    items: (items || []).map((item) => ({
      id: item.id,
      productId: item.productId,
      title: item.title,
      priceCents: item.priceCents,
      qty: item.qty,
    })),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

const PRODUCT_EDITABLE = [
  'vendorId', 'title', 'category', 'brand', 'modelRef', 'conditionGrade',
  'priceCents', 'compareAtCents', 'stockQty', 'status', 'photos', 'serialRef',
  'warrantyDays', 'deliveryAvailable', 'pickupAvailable', 'description',
];
const ORDER_EDITABLE = [
  'vendorId',
  'customerName', 'customerPhone', 'customerEmail', 'subtotalCents', 'totalCents',
  'fulfillment', 'paymentStatus', 'status', 'stripeRef', 'checkoutUrl', 'notes',
];
const VENDOR_EDITABLE = [
  'name', 'slug', 'domain', 'phone', 'email',
  'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'active',
];

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

// ─── Prisma mode ────────────────────────────────────────────────────

const prismaVendors = {
  async findFirst() {
    return rowFromDb(await db().salesVendor.findFirst({ orderBy: { createdAt: 'asc' } }));
  },
  async create(data) {
    const row = await db().salesVendor.create({ data: pick(data, VENDOR_EDITABLE) });
    return rowFromDb(row);
  },
  async update(id, patch) {
    const row = await db().salesVendor.update({ where: { id }, data: pick(patch, VENDOR_EDITABLE) });
    return rowFromDb(row);
  },
};

const prismaProducts = {
  async create(data) {
    const row = await db().salesProduct.create({
      data: { ...pick(data, PRODUCT_EDITABLE), status: 'DRAFT' },
    });
    return rowFromDb(row);
  },
  async findById(id) {
    return rowFromDb(await db().salesProduct.findUnique({ where: { id } }));
  },
  async list({ status, category, limit = 200 } = {}) {
    const where = {};
    if (status) where.status = status;
    if (category) where.category = category;
    const rows = await db().salesProduct.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(rowFromDb);
  },
  async update(id, patch) {
    const row = await db().salesProduct.update({
      where: { id },
      data: pick(patch, PRODUCT_EDITABLE),
    });
    return rowFromDb(row);
  },
  async countsByStatus() {
    const grouped = await db().salesProduct.groupBy({ by: ['status'], _count: true });
    const counts = {};
    for (const g of grouped) counts[g.status] = g._count;
    return counts;
  },
};

const prismaOrders = {
  async create(data, items) {
    const row = await db().salesOrder.create({
      data: {
        ...pick(data, ORDER_EDITABLE),
        paymentStatus: 'PENDING',
        status: 'PENDING_PAYMENT',
        items: {
          create: (items || []).map((item) => ({
            productId: item.productId,
            title: item.title,
            priceCents: item.priceCents,
            qty: item.qty,
          })),
        },
      },
      include: { items: true },
    });
    return orderFromDb(row);
  },
  async findById(id) {
    return orderFromDb(await db().salesOrder.findUnique({ where: { id }, include: { items: true } }));
  },
  async findByOrderNumber(orderNumber) {
    return orderFromDb(await db().salesOrder.findUnique({ where: { orderNumber }, include: { items: true } }));
  },
  async list({ status, paymentStatus, limit = 200 } = {}) {
    const where = {};
    if (status) where.status = status;
    if (paymentStatus) where.paymentStatus = paymentStatus;
    const rows = await db().salesOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { items: true },
    });
    return rows.map(orderFromDb);
  },
  async update(id, patch) {
    const row = await db().salesOrder.update({
      where: { id },
      data: pick(patch, ORDER_EDITABLE),
      include: { items: true },
    });
    return orderFromDb(row);
  },
  async countsByStatus() {
    const grouped = await db().salesOrder.groupBy({ by: ['status'], _count: true });
    const counts = {};
    for (const g of grouped) counts[g.status] = g._count;
    return counts;
  },
};

// ─── In-memory (skeleton) mode ──────────────────────────────────────

const memoryVendors = [];
const memoryProducts = [];
const memoryOrders = [];

const memoryVendorsRepo = {
  async findFirst() {
    return memoryVendors[0] || null;
  },
  async create(data) {
    const now = new Date().toISOString();
    const row = {
      id: createId(),
      name: data.name,
      slug: data.slug,
      domain: data.domain,
      phone: data.phone ?? null,
      email: data.email ?? null,
      addressLine1: data.addressLine1 ?? null,
      addressLine2: data.addressLine2 ?? null,
      city: data.city ?? null,
      state: data.state ?? null,
      postalCode: data.postalCode ?? null,
      active: data.active !== false,
      createdAt: now,
      updatedAt: now,
    };
    memoryVendors.push(row);
    return row;
  },
  async update(id, patch) {
    const row = memoryVendors.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, pick(patch, VENDOR_EDITABLE));
    row.updatedAt = new Date().toISOString();
    return row;
  },
};

const memoryProductsRepo = {
  async create(data) {
    const now = new Date().toISOString();
    const row = {
      id: createId(),
      vendorId: data.vendorId,
      title: data.title,
      category: data.category,
      brand: data.brand ?? null,
      modelRef: data.modelRef ?? null,
      conditionGrade: data.conditionGrade,
      priceCents: data.priceCents,
      compareAtCents: data.compareAtCents ?? null,
      stockQty: data.stockQty ?? 0,
      status: 'DRAFT',
      photos: Array.isArray(data.photos) ? data.photos : [],
      serialRef: data.serialRef ?? null,
      warrantyDays: data.warrantyDays ?? 0,
      deliveryAvailable: data.deliveryAvailable === true,
      pickupAvailable: data.pickupAvailable !== false,
      description: data.description ?? null,
      createdAt: now,
      updatedAt: now,
    };
    memoryProducts.push(row);
    return row;
  },
  async findById(id) {
    return memoryProducts.find((r) => r.id === id) || null;
  },
  async list({ status, category, limit = 200 } = {}) {
    return memoryProducts
      .filter((r) => (!status || r.status === status) && (!category || r.category === category))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  },
  async update(id, patch) {
    const row = memoryProducts.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, pick(patch, PRODUCT_EDITABLE));
    row.updatedAt = new Date().toISOString();
    return row;
  },
  async countsByStatus() {
    const counts = {};
    for (const r of memoryProducts) counts[r.status] = (counts[r.status] || 0) + 1;
    return counts;
  },
};

const memoryOrdersRepo = {
  async create(data, items) {
    const now = new Date().toISOString();
    const row = {
      id: createId(),
      orderNumber: data.orderNumber,
      vendorId: data.vendorId ?? null,
      customerName: data.customerName,
      customerPhone: data.customerPhone ?? null,
      customerEmail: data.customerEmail ?? null,
      items: (items || []).map((item) => ({
        id: createId(),
        productId: item.productId,
        title: item.title,
        priceCents: item.priceCents,
        qty: item.qty,
      })),
      subtotalCents: data.subtotalCents,
      totalCents: data.totalCents,
      fulfillment: data.fulfillment || 'PICKUP',
      paymentStatus: 'PENDING',
      status: 'PENDING_PAYMENT',
      stripeRef: null,
      checkoutUrl: null,
      notes: data.notes ?? null,
      createdAt: now,
      updatedAt: now,
    };
    memoryOrders.push(row);
    return row;
  },
  async findById(id) {
    return memoryOrders.find((r) => r.id === id) || null;
  },
  async findByOrderNumber(orderNumber) {
    return memoryOrders.find((r) => r.orderNumber === orderNumber) || null;
  },
  async list({ status, paymentStatus, limit = 200 } = {}) {
    return memoryOrders
      .filter(
        (r) =>
          (!status || r.status === status) &&
          (!paymentStatus || r.paymentStatus === paymentStatus),
      )
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  },
  async update(id, patch) {
    const row = memoryOrders.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, pick(patch, ORDER_EDITABLE));
    row.updatedAt = new Date().toISOString();
    return row;
  },
  async countsByStatus() {
    const counts = {};
    for (const r of memoryOrders) counts[r.status] = (counts[r.status] || 0) + 1;
    return counts;
  },
};

export const salesVendorsRepo = DATABASE_ENABLED ? prismaVendors : memoryVendorsRepo;
export const salesProductsRepo = DATABASE_ENABLED ? prismaProducts : memoryProductsRepo;
export const salesOrdersRepo = DATABASE_ENABLED ? prismaOrders : memoryOrdersRepo;
