import { Router } from 'express';
import { z } from 'zod';
import { createReferenceCode } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { createConnectionRecord } from '../db/connectionsRepo.js';
import {
  CocoCaneError,
  adjustCocoCaneStock,
  assignCocoCaneOrderLocation,
  createCocoCaneOrder,
  getCocoCaneBoard,
  getCocoCaneCatalog,
  presentOrder,
  transferCocoCaneStock,
  transitionCocoCaneOrder,
} from '../db/cococaneRepo.js';
import { ensureCocoCaneCatalog } from '../services/cococaneCatalog.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { notifySubmission } from '../services/notifications.js';
import { intakeRateLimit } from '../middleware/intakeShield.js';
import {
  INVALID_PHONE_MESSAGE,
  evaluateFormShield,
  honeypotTripped,
  validateNanpPhone,
} from '../services/intakeShield.js';

/**
 * CocoCane Express — flex warehouse API (2026-11-21).
 *
 * Public: the catalog (real per-location availability) and order
 * requests. A retail order RESERVES stock transactionally at its
 * fulfillment location and still creates the COCOCANE_ORDER /
 * COCOCANE_WHOLESALE Connection record, so the existing intake,
 * notification and CRM flows see every request exactly as before.
 * NO payment collection — orders are requests; pay at pickup.
 *
 * Staff (workstation roles only): the CocoCane Express console board,
 * locations, products, stock adjustments/transfers, and the order
 * queue with its status flow.
 */
const router = Router();

const staffOnly = [authenticate, requireCompany, requireRole(...STAFF_ROLES)];

function dbRequired(res) {
  return res.status(503).json({ error: 'CocoCane Express needs the platform database, which is not connected on this instance' });
}

function sendError(res, error) {
  if (error instanceof CocoCaneError) {
    const status = {
      INSUFFICIENT_STOCK: 409,
      INVALID_TRANSITION: 409,
      ADJUSTMENT_REFUSED: 409,
      ORDER_NOT_FOUND: 404,
      PRODUCT_UNPRICED: 422,
    }[error.code] || 400;
    return res.status(status).json({ error: error.message, code: error.code });
  }
  console.error('cococane route failed', error?.message || error);
  return res.status(500).json({ error: 'Internal server error' });
}

// ---------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------

router.get('/cococane/catalog', async (req, res) => {
  if (!DATABASE_ENABLED) return dbRequired(res);
  try {
    return res.json({ data: await getCocoCaneCatalog() });
  } catch (error) {
    return sendError(res, error);
  }
});

const publicOrderSchema = z.object({
  channel: z.enum(['RETAIL', 'WHOLESALE']).default('RETAIL'),
  method: z.enum(['PICKUP', 'DELIVERY']).default('PICKUP'),
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(30),
  email: z.string().email().optional(),
  locationCode: z.string().trim().max(40).optional(),
  pickupDay: z.string().trim().max(40).optional(),
  pickupTime: z.string().trim().max(60).optional(),
  deliveryAddress: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(1000).optional(),
  business: z.string().trim().max(160).optional(),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(999),
  })).max(20).optional(),
});

router.post('/cococane/orders', intakeRateLimit('cococaneOrders'), async (req, res) => {
  if (!DATABASE_ENABLED) return dbRequired(res);
  const parsed = publicOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid order request', details: parsed.error.flatten() });
  }
  const body = parsed.data;
  // Same intake-shield discipline as /connections: honeypot ghosts
  // first, then the NANP phone check, then the scored form shield.
  const honeypot = honeypotTripped(req.body);
  if (!honeypot) {
    const phoneCheck = validateNanpPhone(body.phone);
    if (!phoneCheck.ok) {
      return res.status(400).json({ error: INVALID_PHONE_MESSAGE, code: 'INVALID_PHONE' });
    }
  }
  const shieldVerdict = await evaluateFormShield(req.body, {
    names: [body.name],
    email: body.email ?? null,
    ip: req.ip,
    door: 'connections',
    enforceTurnstile: false,
  });
  if (honeypot || shieldVerdict.discard) {
    return res.status(201).json({ data: { reference: createReferenceCode(), type: body.channel === 'WHOLESALE' ? 'COCOCANE_WHOLESALE' : 'COCOCANE_ORDER' } });
  }

  try {
    await ensureCocoCaneCatalog();
    const client = db();
    const type = body.channel === 'WHOLESALE' ? 'COCOCANE_WHOLESALE' : 'COCOCANE_ORDER';

    if (body.channel === 'WHOLESALE') {
      // Wholesale stays a request/quote flow: no catalog lines, no
      // reservation. The desk builds lines + a location on the order
      // in the console; confirming it takes the reservation then.
      const connection = await createConnectionRecord({
        name: body.name, phone: body.phone, email: body.email ?? null,
        type, source: 'cococane-site',
        message: body.notes || null,
      });
      const order = await createCocoCaneOrder({
        channel: 'WHOLESALE',
        method: 'DELIVERY',
        customerName: body.name, phone: body.phone, email: body.email ?? null,
        connectionId: connection.id,
        deliveryAddress: body.deliveryAddress ?? null,
        notes: body.notes ?? null,
        items: [],
        reserveNow: false,
      });
      notifySubmission({
        kind: type, reference: order.reference,
        submitter: { name: body.name, phone: body.phone, email: body.email },
        lines: [
          'Wholesale request via CocoCane Express — the desk replies with availability, a quote for the quantity, deposit details and a delivery date.',
          ...(body.notes ? [`Request: ${body.notes.slice(0, 240)}`] : []),
        ],
        source: 'cococane-site', consolePath: '/cococane-express',
      });
      return res.status(201).json({ data: { reference: order.reference, type, order: presentOrder(order) } });
    }

    // Retail: items + a fulfillment location, reserved transactionally.
    if (!body.items?.length) {
      return res.status(400).json({ error: 'Add at least one item to the order', code: 'ITEMS_REQUIRED' });
    }
    if (body.method === 'DELIVERY' && !body.deliveryAddress) {
      return res.status(400).json({ error: 'A delivery address is required for delivery orders', code: 'ADDRESS_REQUIRED' });
    }
    const locationCode = body.locationCode || (body.method === 'DELIVERY' ? 'WAREHOUSE' : 'SHOP');
    const location = await client.cocoCaneLocation.findFirst({ where: { code: locationCode, active: true } });
    if (!location) {
      return res.status(400).json({ error: 'That fulfillment location is not available', code: 'LOCATION_UNAVAILABLE' });
    }
    const order = await createCocoCaneOrder({
      channel: 'RETAIL',
      method: body.method,
      customerName: body.name, phone: body.phone, email: body.email ?? null,
      items: body.items,
      fulfillmentLocationId: location.id,
      reserveNow: true,
      pickupDay: body.pickupDay ?? null,
      pickupTime: body.pickupTime ?? null,
      deliveryAddress: body.deliveryAddress ?? null,
      notes: body.notes ?? null,
    });
    const itemLines = order.lines.map((l) => `${l.quantity} x ${l.productName}`);
    const connection = await createConnectionRecord({
      name: body.name, phone: body.phone, email: body.email ?? null,
      type, source: 'cococane-site',
      message: [
        `CocoCane Express ${body.method === 'DELIVERY' ? 'delivery' : 'pickup'} order ${order.reference} — reserved at ${location.name}.`,
        ...itemLines,
        body.method === 'DELIVERY' ? `Delivery to: ${body.deliveryAddress}` : `Pickup: ${body.pickupDay || 'no day given'} · ${body.pickupTime || 'as soon as possible'}`,
        ...(body.notes ? [`Notes: ${body.notes}`] : []),
      ].join('\n'),
    });
    await client.cocoCaneOrder.update({ where: { id: order.id }, data: { connectionId: connection.id } });
    order.connectionId = connection.id;
    notifySubmission({
      kind: type, reference: order.reference,
      submitter: { name: body.name, phone: body.phone, email: body.email },
      lines: [
        `Order ${order.reference} — ${body.method === 'DELIVERY' ? 'delivery' : 'pickup'} from ${location.name}.`,
        ...itemLines,
        'Pay at pickup — no payment is taken online.',
      ],
      source: 'cococane-site', consolePath: '/cococane-express',
    });
    return res.status(201).json({ data: { reference: order.reference, type, order: presentOrder(order) } });
  } catch (error) {
    return sendError(res, error);
  }
});

// ---------------------------------------------------------------------
// Staff console
// ---------------------------------------------------------------------

router.get('/cococane/console', staffOnly, async (req, res) => {
  if (!DATABASE_ENABLED) return dbRequired(res);
  try {
    return res.json({ data: await getCocoCaneBoard() });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/cococane/orders', staffOnly, async (req, res) => {
  if (!DATABASE_ENABLED) return dbRequired(res);
  try {
    const where = {};
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.channel) where.channel = String(req.query.channel);
    const orders = await db().cocoCaneOrder.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 200, include: { lines: true },
    });
    return res.json({ data: orders.map(presentOrder) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/cococane/orders/:id', staffOnly, async (req, res) => {
  if (!DATABASE_ENABLED) return dbRequired(res);
  try {
    const order = await db().cocoCaneOrder.findUnique({ where: { id: req.params.id }, include: { lines: true } });
    if (!order) return res.status(404).json({ error: 'Order not found', code: 'ORDER_NOT_FOUND' });
    return res.json({ data: presentOrder(order) });
  } catch (error) {
    return sendError(res, error);
  }
});

const staffOrderSchema = z.object({
  channel: z.enum(['RETAIL', 'WHOLESALE']).default('RETAIL'),
  method: z.enum(['PICKUP', 'DELIVERY']).default('PICKUP'),
  customerName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(30),
  email: z.string().email().optional(),
  locationId: z.string().uuid().optional(),
  pickupDay: z.string().trim().max(40).optional(),
  pickupTime: z.string().trim().max(60).optional(),
  deliveryAddress: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(1000).optional(),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(100000),
  })).max(40).default([]),
});

router.post('/cococane/orders/staff', staffOnly, async (req, res) => {
  if (!DATABASE_ENABLED) return dbRequired(res);
  const parsed = staffOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid order', details: parsed.error.flatten() });
  }
  const body = parsed.data;
  try {
    await ensureCocoCaneCatalog();
    const order = await createCocoCaneOrder({
      channel: body.channel, method: body.method,
      customerName: body.customerName, phone: body.phone, email: body.email ?? null,
      items: body.items,
      fulfillmentLocationId: body.locationId ?? null,
      // Staff orders with items reserve immediately at their location.
      reserveNow: body.items.length > 0,
      pickupDay: body.pickupDay ?? null, pickupTime: body.pickupTime ?? null,
      deliveryAddress: body.deliveryAddress ?? null, notes: body.notes ?? null,
      createdById: req.user.id,
    });
    return res.status(201).json({ data: presentOrder(order) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/cococane/orders/:id/status', staffOnly, async (req, res) => {
  if (!DATABASE_ENABLED) return dbRequired(res);
  const parsed = z.object({ status: z.enum(['CONFIRMED', 'READY', 'FULFILLED', 'COMPLETED', 'CANCELLED']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid status' });
  try {
    const order = await transitionCocoCaneOrder(req.params.id, parsed.data.status, req.user.id);
    return res.json({ data: presentOrder(order) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/cococane/orders/:id/assign', staffOnly, async (req, res) => {
  if (!DATABASE_ENABLED) return dbRequired(res);
  const parsed = z.object({ locationId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'A locationId is required' });
  try {
    const order = await assignCocoCaneOrderLocation(req.params.id, parsed.data.locationId, req.user.id);
    return res.json({ data: presentOrder(order) });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/cococane/orders/:id/lines', staffOnly, async (req, res) => {
  if (!DATABASE_ENABLED) return dbRequired(res);
  const parsed = z.object({
    items: z.array(z.object({
      productId: z.string().uuid(),
      quantity: z.number().int().min(1).max(100000),
    })).min(1).max(40),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid items' });
  try {
    // Lines can only be built on an order that has not reserved yet
    // (the wholesale quote path) and is still live.
    const client = db();
    const order = await client.cocoCaneOrder.findUnique({ where: { id: req.params.id }, include: { lines: true } });
    if (!order) return res.status(404).json({ error: 'Order not found', code: 'ORDER_NOT_FOUND' });
    if (order.stockReserved || order.status !== 'REQUESTED') {
      return res.status(409).json({ error: 'Lines can only be added to an unreserved REQUESTED order', code: 'INVALID_TRANSITION' });
    }
    const products = await client.cocoCaneProduct.findMany({ where: { id: { in: parsed.data.items.map((i) => i.productId) } } });
    const byId = new Map(products.map((p) => [p.id, p]));
    const create = [];
    let addLow = 0;
    let addHigh = 0;
    for (const item of parsed.data.items) {
      const product = byId.get(item.productId);
      if (!product || !product.active) return res.status(400).json({ error: 'A product is not available', code: 'PRODUCT_UNAVAILABLE' });
      const low = product.priceCents ?? product.priceLowCents;
      const high = product.priceCents ?? product.priceHighCents;
      if (low == null || high == null) return res.status(422).json({ error: `${product.name} has no locked price`, code: 'PRODUCT_UNPRICED' });
      addLow += low * item.quantity;
      addHigh += high * item.quantity;
      create.push({
        productId: product.id, productName: product.name, quantity: item.quantity,
        unitPriceCents: product.priceCents ?? null,
        unitPriceLowCents: product.priceLowCents ?? null,
        unitPriceHighCents: product.priceHighCents ?? null,
      });
    }
    const updated = await client.cocoCaneOrder.update({
      where: { id: order.id },
      data: {
        totalLowCents: order.totalLowCents + addLow,
        totalHighCents: order.totalHighCents + addHigh,
        lines: { create },
      },
      include: { lines: true },
    });
    return res.json({ data: presentOrder(updated) });
  } catch (error) {
    return sendError(res, error);
  }
});

// ---------------------------------------------------------------------
// Staff: locations, products, stock
// ---------------------------------------------------------------------

const locationSchema = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[A-Z0-9_-]+$/i).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(2).max(120),
  kind: z.enum(['WAREHOUSE', 'SHOP', 'VEHICLE', 'OTHER']).default('OTHER'),
});

router.post('/cococane/locations', staffOnly, async (req, res) => {
  if (!DATABASE_ENABLED) return dbRequired(res);
  const parsed = locationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid location', details: parsed.error.flatten() });
  try {
    await ensureCocoCaneCatalog();
    const location = await db().cocoCaneLocation.create({ data: parsed.data });
    return res.status(201).json({ data: location });
  } catch (error) {
    if (error?.code === 'P2002') return res.status(409).json({ error: 'A location with that code already exists', code: 'LOCATION_EXISTS' });
    return sendError(res, error);
  }
});

router.patch('/cococane/locations/:id', staffOnly, async (req, res) => {
  if (!DATABASE_ENABLED) return dbRequired(res);
  const parsed = z.object({ name: z.string().trim().min(2).max(120).optional(), active: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid location update' });
  try {
    const location = await db().cocoCaneLocation.update({ where: { id: req.params.id }, data: parsed.data });
    return res.json({ data: location });
  } catch (error) {
    return sendError(res, error);
  }
});

const productSchema = z.object({
  sku: z.string().trim().min(2).max(48).regex(/^[A-Z0-9_-]+$/i).transform((v) => v.toUpperCase()),
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(500).default(''),
  category: z.string().trim().min(2).max(80),
  unit: z.string().trim().min(1).max(40).default('each'),
  priceCents: z.number().int().nonnegative().nullable().optional(),
  priceLowCents: z.number().int().nonnegative().nullable().optional(),
  priceHighCents: z.number().int().nonnegative().nullable().optional(),
  lowStockAt: z.number().int().nonnegative().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

function pricingShape(body) {
  const fixed = body.priceCents != null;
  const ranged = body.priceLowCents != null || body.priceHighCents != null;
  if (fixed && ranged) return 'Give either a fixed price or a by-size price range, not both';
  if (ranged && (body.priceLowCents == null || body.priceHighCents == null)) return 'A by-size range needs both the low and the high price';
  if (ranged && body.priceLowCents > body.priceHighCents) return 'The low price cannot be above the high price';
  if (!fixed && !ranged) return 'A sellable product needs a price (fixed or by-size range)';
  return null;
}

router.post('/cococane/products', staffOnly, async (req, res) => {
  if (!DATABASE_ENABLED) return dbRequired(res);
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid product', details: parsed.error.flatten() });
  const shapeError = pricingShape(parsed.data);
  if (shapeError) return res.status(400).json({ error: shapeError, code: 'PRICING_SHAPE' });
  try {
    await ensureCocoCaneCatalog();
    const product = await db().cocoCaneProduct.create({ data: parsed.data });
    return res.status(201).json({ data: product });
  } catch (error) {
    if (error?.code === 'P2002') return res.status(409).json({ error: 'A product with that SKU already exists', code: 'PRODUCT_EXISTS' });
    return sendError(res, error);
  }
});

router.patch('/cococane/products/:id', staffOnly, async (req, res) => {
  if (!DATABASE_ENABLED) return dbRequired(res);
  const parsed = productSchema.partial().omit({ sku: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid product update', details: parsed.error.flatten() });
  try {
    const client = db();
    const existing = await client.cocoCaneProduct.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    const merged = { ...existing, ...parsed.data };
    const shapeError = pricingShape(merged);
    if (shapeError) return res.status(400).json({ error: shapeError, code: 'PRICING_SHAPE' });
    const product = await client.cocoCaneProduct.update({ where: { id: req.params.id }, data: parsed.data });
    return res.json({ data: product });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/cococane/stock/adjust', staffOnly, async (req, res) => {
  if (!DATABASE_ENABLED) return dbRequired(res);
  const parsed = z.object({
    productId: z.string().uuid(),
    locationId: z.string().uuid(),
    delta: z.number().int().min(-100000).max(100000).refine((v) => v !== 0, 'delta must not be zero'),
    reason: z.string().trim().min(2).max(300),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid adjustment', details: parsed.error.flatten() });
  try {
    const stock = await adjustCocoCaneStock({ ...parsed.data, createdById: req.user.id });
    return res.json({ data: { ...stock, available: stock.onHand - stock.reserved } });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/cococane/stock/transfer', staffOnly, async (req, res) => {
  if (!DATABASE_ENABLED) return dbRequired(res);
  const parsed = z.object({
    productId: z.string().uuid(),
    fromLocationId: z.string().uuid(),
    toLocationId: z.string().uuid(),
    quantity: z.number().int().min(1).max(100000),
    reason: z.string().trim().max(300).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid transfer', details: parsed.error.flatten() });
  try {
    const result = await transferCocoCaneStock({ ...parsed.data, reason: parsed.data.reason ?? null, createdById: req.user.id });
    return res.json({ data: result });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
