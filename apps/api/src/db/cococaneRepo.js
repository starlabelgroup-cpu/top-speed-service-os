import { randomUUID } from 'node:crypto';
import { createReferenceCode } from '../data/store.js';
import { DATABASE_ENABLED, db } from './client.js';
import { ensureCocoCaneCatalog } from '../services/cococaneCatalog.js';

/**
 * CocoCane Express — flex warehouse repository (2026-11-21).
 *
 * Stock truth lives in CocoCaneStock (onHand / reserved per product ×
 * location); every change is ledgered in CocoCaneStockMovement. All
 * multi-row writes run inside ONE Prisma transaction and every stock
 * mutation is a CONDITIONAL raw UPDATE whose WHERE clause encodes the
 * invariant (available = onHand - reserved >= quantity), so two
 * concurrent orders can never reserve the same coconut — the loser's
 * UPDATE matches 0 rows and the whole transaction rolls back.
 *
 * Lifecycle: create (reserve) → cancel (release) / fulfill (consume).
 * Transfers move AVAILABLE stock only and conserve total onHand.
 */

export class CocoCaneError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const insufficient = (productName) =>
  new CocoCaneError('INSUFFICIENT_STOCK', `Not enough available stock for ${productName}`, { productName });

async function stockRow(tx, productId, locationId) {
  return tx.cocoCaneStock.upsert({
    where: { productId_locationId: { productId, locationId } },
    update: {},
    create: { productId, locationId },
  });
}

async function movement(tx, { productId, locationId, type, onHandDelta = 0, reservedDelta = 0, reason = null, orderId = null, transferGroup = null, createdById = null }) {
  await tx.cocoCaneStockMovement.create({
    data: { productId, locationId, type, onHandDelta, reservedDelta, reason, orderId, transferGroup, createdById },
  });
}

async function reserveLines(tx, lines, locationId, orderId, createdById) {
  for (const line of lines) {
    await stockRow(tx, line.productId, locationId);
    const count = await tx.$executeRaw`
      UPDATE "CocoCaneStock" SET "reserved" = "reserved" + ${line.quantity}, "updatedAt" = NOW()
      WHERE "productId" = ${line.productId}::uuid AND "locationId" = ${locationId}::uuid
        AND "onHand" - "reserved" >= ${line.quantity}`;
    if (count !== 1) throw insufficient(line.productName);
    await movement(tx, { productId: line.productId, locationId, type: 'RESERVE', reservedDelta: line.quantity, orderId, createdById });
  }
}

async function releaseLines(tx, lines, locationId, orderId, createdById) {
  for (const line of lines) {
    const count = await tx.$executeRaw`
      UPDATE "CocoCaneStock" SET "reserved" = "reserved" - ${line.quantity}, "updatedAt" = NOW()
      WHERE "productId" = ${line.productId}::uuid AND "locationId" = ${locationId}::uuid
        AND "reserved" >= ${line.quantity}`;
    if (count !== 1) throw new CocoCaneError('RESERVATION_MISMATCH', `Reservation bookkeeping mismatch for ${line.productName}`);
    await movement(tx, { productId: line.productId, locationId, type: 'RELEASE', reservedDelta: -line.quantity, orderId, createdById });
  }
}

async function consumeLines(tx, lines, locationId, orderId, createdById) {
  for (const line of lines) {
    const count = await tx.$executeRaw`
      UPDATE "CocoCaneStock" SET "onHand" = "onHand" - ${line.quantity}, "reserved" = "reserved" - ${line.quantity}, "updatedAt" = NOW()
      WHERE "productId" = ${line.productId}::uuid AND "locationId" = ${locationId}::uuid
        AND "onHand" >= ${line.quantity} AND "reserved" >= ${line.quantity}`;
    if (count !== 1) throw new CocoCaneError('RESERVATION_MISMATCH', `Fulfilment bookkeeping mismatch for ${line.productName}`);
    await movement(tx, { productId: line.productId, locationId, type: 'CONSUME', onHandDelta: -line.quantity, reservedDelta: -line.quantity, orderId, createdById });
  }
}

function lineSnapshots(productsById, items) {
  const quantities = new Map();
  for (const item of items) {
    quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity);
  }
  const lines = [];
  let totalLowCents = 0;
  let totalHighCents = 0;
  for (const [productId, quantity] of quantities) {
    const product = productsById.get(productId);
    if (!product || !product.active) {
      throw new CocoCaneError('PRODUCT_UNAVAILABLE', 'A product in this order is not available', { productId });
    }
    const low = product.priceCents ?? product.priceLowCents;
    const high = product.priceCents ?? product.priceHighCents;
    if (low == null || high == null) {
      throw new CocoCaneError('PRODUCT_UNPRICED', `${product.name} has no locked price and cannot be ordered`, { productId });
    }
    totalLowCents += low * quantity;
    totalHighCents += high * quantity;
    lines.push({
      productId,
      productName: product.name,
      quantity,
      unitPriceCents: product.priceCents ?? null,
      unitPriceLowCents: product.priceLowCents ?? null,
      unitPriceHighCents: product.priceHighCents ?? null,
    });
  }
  return { lines, totalLowCents, totalHighCents };
}

export async function createCocoCaneOrder({
  channel, method, customerName, phone, email = null,
  items = [], fulfillmentLocationId = null, reserveNow = false,
  connectionId = null, pickupDay = null, pickupTime = null,
  deliveryAddress = null, notes = null, createdById = null,
}) {
  const client = db();
  const products = items.length
    ? await client.cocoCaneProduct.findMany({ where: { id: { in: items.map((i) => i.productId) } } })
    : [];
  const { lines, totalLowCents, totalHighCents } = lineSnapshots(new Map(products.map((p) => [p.id, p])), items);
  if (reserveNow && (!fulfillmentLocationId || !lines.length)) {
    throw new CocoCaneError('RESERVATION_NEEDS_LOCATION', 'Reserving stock needs a fulfillment location and at least one item');
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await client.$transaction(async (tx) => {
        const order = await tx.cocoCaneOrder.create({
          data: {
            reference: createReferenceCode(),
            channel, method, customerName, phone, email,
            connectionId, fulfillmentLocationId,
            pickupDay, pickupTime, deliveryAddress, notes,
            totalLowCents, totalHighCents,
            lines: { create: lines },
          },
          include: { lines: true },
        });
        if (reserveNow) {
          await reserveLines(tx, lines, fulfillmentLocationId, order.id, createdById);
          await tx.cocoCaneOrder.update({ where: { id: order.id }, data: { stockReserved: true } });
          order.stockReserved = true;
        }
        return order;
      });
    } catch (error) {
      if (error?.code === 'P2002' && attempt < 2) continue; // reference collision — mint another
      throw error;
    }
  }
  throw new CocoCaneError('REFERENCE_COLLISION', 'Could not mint a unique order reference');
}

const TRANSITIONS = {
  REQUESTED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['READY', 'CANCELLED'],
  READY: ['FULFILLED', 'CANCELLED'],
  FULFILLED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export async function transitionCocoCaneOrder(orderId, nextStatus, createdById = null) {
  const client = db();
  return client.$transaction(async (tx) => {
    const order = await tx.cocoCaneOrder.findUnique({ where: { id: orderId }, include: { lines: true } });
    if (!order) throw new CocoCaneError('ORDER_NOT_FOUND', 'Order not found');
    if (!TRANSITIONS[order.status]?.includes(nextStatus)) {
      throw new CocoCaneError('INVALID_TRANSITION', `An order in ${order.status} cannot move to ${nextStatus}`, { from: order.status, to: nextStatus });
    }
    if (nextStatus === 'CONFIRMED' && !order.stockReserved && order.lines.length) {
      // Wholesale path: the reservation is taken when the desk confirms
      // an order that carries lines and a fulfillment location.
      if (!order.fulfillmentLocationId) {
        throw new CocoCaneError('RESERVATION_NEEDS_LOCATION', 'Assign a fulfillment location before confirming an order with items');
      }
      await reserveLines(tx, order.lines, order.fulfillmentLocationId, order.id, createdById);
      await tx.cocoCaneOrder.update({ where: { id: order.id }, data: { stockReserved: true } });
    }
    if (nextStatus === 'CANCELLED' && order.stockReserved) {
      await releaseLines(tx, order.lines, order.fulfillmentLocationId, order.id, createdById);
      await tx.cocoCaneOrder.update({ where: { id: order.id }, data: { stockReserved: false } });
    }
    if (nextStatus === 'FULFILLED' && order.stockReserved) {
      await consumeLines(tx, order.lines, order.fulfillmentLocationId, order.id, createdById);
      await tx.cocoCaneOrder.update({ where: { id: order.id }, data: { stockReserved: false } });
    }
    return tx.cocoCaneOrder.update({
      where: { id: order.id },
      data: { status: nextStatus },
      include: { lines: true },
    });
  });
}

export async function assignCocoCaneOrderLocation(orderId, locationId, createdById = null) {
  const client = db();
  return client.$transaction(async (tx) => {
    const order = await tx.cocoCaneOrder.findUnique({ where: { id: orderId }, include: { lines: true } });
    if (!order) throw new CocoCaneError('ORDER_NOT_FOUND', 'Order not found');
    if (!['REQUESTED', 'CONFIRMED', 'READY'].includes(order.status)) {
      throw new CocoCaneError('INVALID_TRANSITION', `A ${order.status} order cannot change fulfillment location`, { from: order.status });
    }
    const location = await tx.cocoCaneLocation.findUnique({ where: { id: locationId } });
    if (!location || !location.active) throw new CocoCaneError('LOCATION_UNAVAILABLE', 'That stock location is not available');
    if (order.fulfillmentLocationId === locationId) return order;
    if (order.stockReserved) {
      // Release at the old location and reserve at the new one inside
      // this transaction: if the new location cannot cover the order,
      // reserveLines throws and the transaction rolls EVERYTHING back —
      // the order keeps its original reservation, untouched.
      await releaseLines(tx, order.lines, order.fulfillmentLocationId, order.id, createdById);
      await reserveLines(tx, order.lines, locationId, order.id, createdById);
    }
    return tx.cocoCaneOrder.update({
      where: { id: order.id },
      data: { fulfillmentLocationId: locationId },
      include: { lines: true },
    });
  });
}

export async function adjustCocoCaneStock({ productId, locationId, delta, reason, createdById = null }) {
  const client = db();
  return client.$transaction(async (tx) => {
    const product = await tx.cocoCaneProduct.findUnique({ where: { id: productId } });
    if (!product) throw new CocoCaneError('PRODUCT_UNAVAILABLE', 'Product not found');
    await stockRow(tx, productId, locationId);
    const count = await tx.$executeRaw`
      UPDATE "CocoCaneStock" SET "onHand" = "onHand" + ${delta}, "updatedAt" = NOW()
      WHERE "productId" = ${productId}::uuid AND "locationId" = ${locationId}::uuid
        AND "onHand" + ${delta} >= "reserved" AND "onHand" + ${delta} >= 0`;
    if (count !== 1) {
      throw new CocoCaneError('ADJUSTMENT_REFUSED', `That adjustment would drop on-hand below the reserved count for ${product.name}`);
    }
    await movement(tx, { productId, locationId, type: 'ADJUSTMENT', onHandDelta: delta, reason, createdById });
    return tx.cocoCaneStock.findUnique({ where: { productId_locationId: { productId, locationId } } });
  });
}

export async function transferCocoCaneStock({ productId, fromLocationId, toLocationId, quantity, reason = null, createdById = null }) {
  if (fromLocationId === toLocationId) {
    throw new CocoCaneError('INVALID_TRANSFER', 'Source and destination locations are the same');
  }
  const client = db();
  const transferGroup = randomUUID();
  return client.$transaction(async (tx) => {
    const product = await tx.cocoCaneProduct.findUnique({ where: { id: productId } });
    if (!product) throw new CocoCaneError('PRODUCT_UNAVAILABLE', 'Product not found');
    await stockRow(tx, productId, fromLocationId);
    await stockRow(tx, productId, toLocationId);
    const out = await tx.$executeRaw`
      UPDATE "CocoCaneStock" SET "onHand" = "onHand" - ${quantity}, "updatedAt" = NOW()
      WHERE "productId" = ${productId}::uuid AND "locationId" = ${fromLocationId}::uuid
        AND "onHand" - "reserved" >= ${quantity}`;
    if (out !== 1) throw insufficient(product.name);
    await tx.$executeRaw`
      UPDATE "CocoCaneStock" SET "onHand" = "onHand" + ${quantity}, "updatedAt" = NOW()
      WHERE "productId" = ${productId}::uuid AND "locationId" = ${toLocationId}::uuid`;
    await movement(tx, { productId, locationId: fromLocationId, type: 'TRANSFER_OUT', onHandDelta: -quantity, reason, transferGroup, createdById });
    await movement(tx, { productId, locationId: toLocationId, type: 'TRANSFER_IN', onHandDelta: quantity, reason, transferGroup, createdById });
    const [from, to] = await Promise.all([
      tx.cocoCaneStock.findUnique({ where: { productId_locationId: { productId, locationId: fromLocationId } } }),
      tx.cocoCaneStock.findUnique({ where: { productId_locationId: { productId, locationId: toLocationId } } }),
    ]);
    return { transferGroup, from, to };
  });
}

function presentStock(row) {
  return {
    productId: row.productId,
    locationId: row.locationId,
    onHand: row.onHand,
    reserved: row.reserved,
    available: row.onHand - row.reserved,
  };
}

export async function getCocoCaneCatalog() {
  await ensureCocoCaneCatalog();
  const client = db();
  const [products, locations, stock] = await Promise.all([
    client.cocoCaneProduct.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    client.cocoCaneLocation.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' } }),
    client.cocoCaneStock.findMany(),
  ]);
  const byProduct = new Map();
  for (const row of stock) {
    if (!byProduct.has(row.productId)) byProduct.set(row.productId, []);
    byProduct.get(row.productId).push(presentStock(row));
  }
  return {
    locations: locations.map((l) => ({ id: l.id, code: l.code, name: l.name, kind: l.kind })),
    products: products.map((p) => {
      const perLocation = locations.map((l) =>
        byProduct.get(p.id)?.find((s) => s.locationId === l.id) || { productId: p.id, locationId: l.id, onHand: 0, reserved: 0, available: 0 });
      return {
        id: p.id, sku: p.sku, name: p.name, description: p.description, category: p.category, unit: p.unit,
        priceCents: p.priceCents, priceLowCents: p.priceLowCents, priceHighCents: p.priceHighCents,
        availableTotal: perLocation.reduce((sum, s) => sum + s.available, 0),
        stock: perLocation,
      };
    }),
  };
}

export async function getCocoCaneBoard() {
  await ensureCocoCaneCatalog();
  const client = db();
  const [products, locations, stock, movements, orders] = await Promise.all([
    client.cocoCaneProduct.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    client.cocoCaneLocation.findMany({ orderBy: { createdAt: 'asc' } }),
    client.cocoCaneStock.findMany(),
    client.cocoCaneStockMovement.findMany({ orderBy: { createdAt: 'desc' }, take: 60 }),
    client.cocoCaneOrder.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { lines: true } }),
  ]);
  const stockByKey = new Map(stock.map((r) => [`${r.productId}:${r.locationId}`, presentStock(r)]));
  return {
    locations: locations.map((l) => ({ id: l.id, code: l.code, name: l.name, kind: l.kind, active: l.active })),
    products: products.map((p) => ({
      id: p.id, sku: p.sku, name: p.name, category: p.category, unit: p.unit, active: p.active,
      priceCents: p.priceCents, priceLowCents: p.priceLowCents, priceHighCents: p.priceHighCents, lowStockAt: p.lowStockAt,
      stock: locations.map((l) => stockByKey.get(`${p.id}:${l.id}`) || { productId: p.id, locationId: l.id, onHand: 0, reserved: 0, available: 0 }),
    })),
    movements: movements.map((m) => ({
      id: m.id, productId: m.productId, locationId: m.locationId, type: m.type,
      onHandDelta: m.onHandDelta, reservedDelta: m.reservedDelta, reason: m.reason,
      orderId: m.orderId, transferGroup: m.transferGroup, createdAt: m.createdAt,
    })),
    orders: orders.map(presentOrder),
  };
}

export function presentOrder(order) {
  return {
    id: order.id,
    reference: order.reference,
    channel: order.channel,
    method: order.method,
    status: order.status,
    customerName: order.customerName,
    phone: order.phone,
    email: order.email,
    connectionId: order.connectionId,
    fulfillmentLocationId: order.fulfillmentLocationId,
    stockReserved: order.stockReserved,
    pickupDay: order.pickupDay,
    pickupTime: order.pickupTime,
    deliveryAddress: order.deliveryAddress,
    notes: order.notes,
    totalLowCents: order.totalLowCents,
    totalHighCents: order.totalHighCents,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    lines: (order.lines || []).map((l) => ({
      id: l.id, productId: l.productId, productName: l.productName, quantity: l.quantity,
      unitPriceCents: l.unitPriceCents, unitPriceLowCents: l.unitPriceLowCents, unitPriceHighCents: l.unitPriceHighCents,
    })),
  };
}

export { DATABASE_ENABLED };
