import { randomBytes } from 'node:crypto';
import {
  salesOrdersRepo,
  salesProductsRepo,
  salesVendorsRepo,
} from '../db/salesOsRepo.js';
import { stripeApi, stripeConfigured } from './stripe.js';

/**
 * Top Speed Sales OS (2026-11-23) — the sales platform inside the
 * Service OS: one vendor (Top Speed Appliances, the used-appliance
 * shop at topspeedappliances.com), a staff-entered catalog of used
 * appliances, and customer orders paid through the platform's
 * existing Stripe checkout pattern.
 *
 * HONESTY RULES (the house rules, applied to sales):
 *  - NO invented products, prices, or stock: the catalog launches
 *    EMPTY and fills only with real units staff enter in the Sales
 *    OS console. Nothing in this file seeds a product.
 *  - Totals are computed SERVER-SIDE from the stored product prices
 *    at order time; a price a client sends is never read. Total =
 *    subtotal — no tax, delivery fee, or any other charge is
 *    invented here; if the shop ever charges one, it is added as an
 *    explicit, named line in the same change that creates it.
 *  - The public catalog serves ACTIVE products only. DRAFT, SOLD,
 *    and ARCHIVED units never appear on the storefront.
 *  - Checkout reuses the platform's Stripe pattern (services/
 *    stripe.js stripeApi → POST /v1/checkout/sessions, the same
 *    transport as createGiftCardCheckout / the invoice checkout in
 *    services/cardPayments.js). When Stripe is not configured the
 *    order still saves as PENDING_PAYMENT with checkout: null — the
 *    shop never pretends a payment link exists when it does not.
 *  - Payment confirmation arrives through the EXISTING payments
 *    webhook (POST /api/v1/payments/webhook): a future handler
 *    branch keyed on metadata purpose 'SALES_ORDER' flips the order
 *    to PAID. That branch is deliberately NOT wired in this build —
 *    see BUILD-NOTES.md; until it lands, staff reconcile paid orders
 *    in the console from the recorded Stripe session reference.
 */

export const PRODUCT_CATEGORIES = [
  'REFRIGERATOR', 'WASHER', 'DRYER', 'OVEN_RANGE', 'DISHWASHER',
  'FREEZER_ICE_MAKER', 'MICROWAVE', 'GARBAGE_DISPOSAL', 'OTHER',
];

/**
 * The condition scale (one scale, used everywhere): LIKE_NEW is a
 * unit indistinguishable from new in function and appearance;
 * EXCELLENT shows minimal wear; GOOD shows normal used wear and
 * works fully; FAIR shows visible wear and works, with the wear
 * described in the listing. Staff pick the grade when they enter
 * the unit — the grade is a staff attestation, never auto-derived.
 */
export const CONDITION_GRADES = ['LIKE_NEW', 'EXCELLENT', 'GOOD', 'FAIR'];

export const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'SOLD', 'ARCHIVED'];
export const ORDER_STATUSES = ['PENDING_PAYMENT', 'PAID', 'FULFILLING', 'COMPLETED', 'CANCELLED'];
export const PAYMENT_STATUSES = ['PENDING', 'PAID', 'FAILED', 'REFUNDED'];
export const FULFILLMENT_KINDS = ['PICKUP', 'DELIVERY'];

/**
 * The single vendor's identity — a CONSTANT, not seed data: this is
 * who the shop IS (the business's own name, domain, and public
 * number), in the same posture as MEDIA_FACEBOOK_PAGE / the Facebook
 * OS page constant. Contact/address fields the constant does not
 * carry stay null until staff record them on the vendor row. The
 * service resolves the SalesVendor row lazily (first read creates
 * it from this identity when the table is empty) so orders and
 * products always reference a real vendor row in database mode.
 */
export const SALES_VENDOR_IDENTITY = {
  name: 'Top Speed Appliances',
  slug: 'top-speed-appliances',
  domain: 'topspeedappliances.com',
  phone: '844-460-7038',
  email: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  postalCode: null,
  active: true,
};

export const STOREFRONT_BASE = 'https://topspeedappliances.com';

function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

/** Human order code, TS-S-XXXXXX — the createReferenceCode idiom. */
export function createSalesOrderNumber() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let suffix = '';
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `TS-S-${suffix}`;
}

// ─── Vendor ─────────────────────────────────────────────────────────

export async function getVendor() {
  const existing = await salesVendorsRepo.findFirst();
  if (existing) return existing;
  return salesVendorsRepo.create({ ...SALES_VENDOR_IDENTITY });
}

function publicVendor(vendor) {
  return {
    name: vendor.name,
    slug: vendor.slug,
    domain: vendor.domain,
    storefrontUrl: `https://${vendor.domain}`,
    phone: vendor.phone,
    email: vendor.email,
    address: {
      line1: vendor.addressLine1,
      line2: vendor.addressLine2,
      city: vendor.city,
      state: vendor.state,
      postalCode: vendor.postalCode,
    },
    active: vendor.active !== false,
  };
}

// ─── Products (staff) ───────────────────────────────────────────────

function cleanPhotos(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw fail(400, 'PHOTOS_INVALID', 'Photos must be an array of image URLs');
  const photos = value.map((v) => String(v || '').trim()).filter(Boolean);
  if (photos.length > 12) throw fail(400, 'PHOTOS_INVALID', 'A product carries at most 12 photos');
  return photos;
}

function validateProductFields(input, { partial = false } = {}) {
  const out = {};
  const has = (field) => input[field] !== undefined;
  if (!partial || has('title')) {
    if (!input.title || !String(input.title).trim()) {
      throw fail(400, 'TITLE_REQUIRED', 'A product needs a title');
    }
    out.title = String(input.title).trim();
  }
  if (!partial || has('category')) {
    if (!PRODUCT_CATEGORIES.includes(input.category)) {
      throw fail(400, 'CATEGORY_INVALID', `Unknown category: ${input.category}`);
    }
    out.category = input.category;
  }
  if (!partial || has('conditionGrade')) {
    if (!CONDITION_GRADES.includes(input.conditionGrade)) {
      throw fail(400, 'CONDITION_GRADE_INVALID', `Unknown condition grade: ${input.conditionGrade}`);
    }
    out.conditionGrade = input.conditionGrade;
  }
  if (!partial || has('priceCents')) {
    if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
      throw fail(400, 'PRICE_INVALID', 'priceCents must be a non-negative integer (the real price staff entered)');
    }
    out.priceCents = input.priceCents;
  }
  if (has('compareAtCents')) {
    if (input.compareAtCents !== null && (!Number.isInteger(input.compareAtCents) || input.compareAtCents < 0)) {
      throw fail(400, 'PRICE_INVALID', 'compareAtCents must be a non-negative integer or null');
    }
    out.compareAtCents = input.compareAtCents;
  }
  if (has('stockQty')) {
    if (!Number.isInteger(input.stockQty) || input.stockQty < 0) {
      throw fail(400, 'STOCK_INVALID', 'stockQty must be a non-negative integer');
    }
    out.stockQty = input.stockQty;
  }
  if (has('warrantyDays')) {
    if (!Number.isInteger(input.warrantyDays) || input.warrantyDays < 0) {
      throw fail(400, 'WARRANTY_INVALID', 'warrantyDays must be a non-negative integer');
    }
    out.warrantyDays = input.warrantyDays;
  }
  if (has('status')) {
    if (!PRODUCT_STATUSES.includes(input.status)) {
      throw fail(400, 'STATUS_INVALID', `Unknown product status: ${input.status}`);
    }
    out.status = input.status;
  }
  if (has('photos')) out.photos = cleanPhotos(input.photos);
  for (const field of ['brand', 'modelRef', 'serialRef', 'description']) {
    if (has(field)) out[field] = input[field] === null ? null : String(input[field]);
  }
  for (const field of ['deliveryAvailable', 'pickupAvailable']) {
    if (has(field)) out[field] = input[field] === true;
  }
  return out;
}

export async function createProduct(input, actorId) {
  const fields = validateProductFields(input || {});
  const vendor = await getVendor();
  return salesProductsRepo.create({
    ...fields,
    vendorId: vendor.id,
    brand: fields.brand ?? null,
    modelRef: fields.modelRef ?? null,
    compareAtCents: fields.compareAtCents ?? null,
    stockQty: fields.stockQty ?? 0,
    photos: fields.photos ?? [],
    serialRef: fields.serialRef ?? null,
    warrantyDays: fields.warrantyDays ?? 0,
    deliveryAvailable: fields.deliveryAvailable ?? false,
    pickupAvailable: fields.pickupAvailable ?? true,
    description: fields.description ?? null,
  });
}

export async function updateProduct(id, input) {
  const existing = await salesProductsRepo.findById(id);
  if (!existing) throw fail(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  const fields = validateProductFields(input || {}, { partial: true });
  return salesProductsRepo.update(id, fields);
}

export async function listProducts({ status, category, limit = 200 } = {}) {
  return salesProductsRepo.list({ status, category, limit });
}

// ─── Public catalog ─────────────────────────────────────────────────

function publicProduct(product) {
  return {
    id: product.id,
    title: product.title,
    category: product.category,
    brand: product.brand,
    modelRef: product.modelRef,
    conditionGrade: product.conditionGrade,
    priceCents: product.priceCents,
    compareAtCents: product.compareAtCents,
    stockQty: product.stockQty,
    photos: Array.isArray(product.photos) ? product.photos : [],
    warrantyDays: product.warrantyDays,
    deliveryAvailable: product.deliveryAvailable === true,
    pickupAvailable: product.pickupAvailable !== false,
    description: product.description,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

export async function getCatalog({ category, limit = 50 } = {}) {
  if (category && !PRODUCT_CATEGORIES.includes(category)) {
    throw fail(400, 'CATEGORY_INVALID', `Unknown category: ${category}`);
  }
  const vendor = await getVendor();
  const rows = await salesProductsRepo.list({ status: 'ACTIVE', category, limit });
  return {
    generatedAt: new Date().toISOString(),
    vendor: publicVendor(vendor),
    categories: PRODUCT_CATEGORIES,
    conditionGrades: CONDITION_GRADES,
    products: rows.map(publicProduct),
  };
}

export async function getCatalogProduct(id) {
  const product = await salesProductsRepo.findById(id);
  if (!product || product.status !== 'ACTIVE') {
    throw fail(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  }
  const vendor = await getVendor();
  return { vendor: publicVendor(vendor), product: publicProduct(product) };
}

// ─── Orders ─────────────────────────────────────────────────────────

/**
 * Stripe Checkout for a sales order — the platform pattern
 * (services/stripe.js): a payment-mode Checkout Session built with
 * stripeApi, one line item per order item at the SERVER-side price
 * snapshot, metadata purpose 'SALES_ORDER' + the order id/number so
 * the existing payments webhook can route it once its branch lands.
 * Returns null when Stripe is not configured — the caller saves the
 * order anyway and reports checkout: null honestly.
 */
export async function createSalesOrderCheckout({ order }) {
  if (!stripeConfigured()) return null;
  const session = await stripeApi('POST', '/v1/checkout/sessions', {
    mode: 'payment',
    success_url: `${STOREFRONT_BASE}/order/${encodeURIComponent(order.orderNumber)}?payment=success`,
    cancel_url: `${STOREFRONT_BASE}/order/${encodeURIComponent(order.orderNumber)}?payment=cancelled`,
    line_items: order.items.map((item) => ({
      quantity: item.qty,
      price_data: {
        currency: 'usd',
        unit_amount: item.priceCents,
        product_data: { name: item.title },
      },
    })),
    client_reference_id: order.orderNumber,
    metadata: { purpose: 'SALES_ORDER', orderId: order.id, orderNumber: order.orderNumber },
    payment_intent_data: {
      metadata: { purpose: 'SALES_ORDER', orderId: order.id, orderNumber: order.orderNumber },
    },
    ...(order.customerEmail ? { customer_email: order.customerEmail } : {}),
  });
  return session;
}

export async function createOrder(input) {
  const body = input || {};
  if (!body.customerName || !String(body.customerName).trim()) {
    throw fail(400, 'CUSTOMER_NAME_REQUIRED', 'An order needs the customer name');
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw fail(400, 'ITEMS_REQUIRED', 'An order needs at least one item');
  }
  if (body.items.length > 50) {
    throw fail(400, 'ITEMS_INVALID', 'An order carries at most 50 items');
  }
  const fulfillment = body.fulfillment || 'PICKUP';
  if (!FULFILLMENT_KINDS.includes(fulfillment)) {
    throw fail(400, 'FULFILLMENT_INVALID', `Unknown fulfillment: ${fulfillment}`);
  }

  // Resolve every line against the stored catalog: the product must
  // exist, be ACTIVE, and carry the requested stock. Prices and
  // titles are SNAPSHOT from the stored rows — anything the client
  // sent about price is ignored by construction (never read).
  const lines = [];
  const wanted = new Map();
  for (const item of body.items) {
    if (!item?.productId || typeof item.productId !== 'string') {
      throw fail(400, 'ITEM_INVALID', 'Every item needs a productId');
    }
    const qty = item.qty === undefined ? 1 : item.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      throw fail(400, 'ITEM_INVALID', 'Every item qty must be a whole number between 1 and 99');
    }
    wanted.set(item.productId, (wanted.get(item.productId) || 0) + qty);
  }
  for (const [productId, qty] of wanted) {
    const product = await salesProductsRepo.findById(productId);
    if (!product || product.status !== 'ACTIVE') {
      throw fail(422, 'PRODUCT_UNAVAILABLE', 'One of the items is not available for sale right now');
    }
    if (product.stockQty < qty) {
      throw fail(422, 'OUT_OF_STOCK', `"${product.title}" does not have ${qty} in stock`);
    }
    if (fulfillment === 'DELIVERY' && product.deliveryAvailable !== true) {
      throw fail(422, 'DELIVERY_UNAVAILABLE', `"${product.title}" is pickup only`);
    }
    if (fulfillment === 'PICKUP' && product.pickupAvailable === false) {
      throw fail(422, 'PICKUP_UNAVAILABLE', `"${product.title}" is delivery only`);
    }
    lines.push({ productId: product.id, title: product.title, priceCents: product.priceCents, qty });
  }

  const subtotalCents = lines.reduce((sum, line) => sum + line.priceCents * line.qty, 0);
  // Total = subtotal. No tax or fee is invented (see header).
  const totalCents = subtotalCents;

  let orderNumber = createSalesOrderNumber();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await salesOrdersRepo.findByOrderNumber(orderNumber))) break;
    orderNumber = createSalesOrderNumber();
  }

  const vendor = await getVendor();
  let order = await salesOrdersRepo.create(
    {
      orderNumber,
      vendorId: vendor.id,
      customerName: String(body.customerName).trim(),
      customerPhone: body.customerPhone ? String(body.customerPhone).trim() : null,
      customerEmail: body.customerEmail ? String(body.customerEmail).trim() : null,
      subtotalCents,
      totalCents,
      fulfillment,
      notes: body.notes ? String(body.notes) : null,
    },
    lines,
  );

  // Checkout through the existing Stripe pattern. A Stripe failure
  // never loses the order: it stays PENDING_PAYMENT with no checkout
  // URL and staff can follow up — the response says so honestly.
  let checkout = null;
  let checkoutError = null;
  try {
    const session = await createSalesOrderCheckout({ order });
    if (session) {
      order = await salesOrdersRepo.update(order.id, {
        stripeRef: session.id,
        checkoutUrl: session.url,
      });
      checkout = { url: session.url, provider: 'stripe' };
    }
  } catch (error) {
    checkoutError = error?.message || 'Stripe checkout could not be created';
  }

  return { order, checkout, ...(checkoutError ? { checkoutError } : {}) };
}

export async function listOrders({ status, paymentStatus, limit = 200 } = {}) {
  return salesOrdersRepo.list({ status, paymentStatus, limit });
}

export async function updateOrder(id, input) {
  const existing = await salesOrdersRepo.findById(id);
  if (!existing) throw fail(404, 'ORDER_NOT_FOUND', 'Order not found');
  const patch = {};
  if (input.status !== undefined) {
    if (!ORDER_STATUSES.includes(input.status)) {
      throw fail(400, 'STATUS_INVALID', `Unknown order status: ${input.status}`);
    }
    patch.status = input.status;
  }
  if (input.paymentStatus !== undefined) {
    if (!PAYMENT_STATUSES.includes(input.paymentStatus)) {
      throw fail(400, 'PAYMENT_STATUS_INVALID', `Unknown payment status: ${input.paymentStatus}`);
    }
    patch.paymentStatus = input.paymentStatus;
  }
  if (input.fulfillment !== undefined) {
    if (!FULFILLMENT_KINDS.includes(input.fulfillment)) {
      throw fail(400, 'FULFILLMENT_INVALID', `Unknown fulfillment: ${input.fulfillment}`);
    }
    patch.fulfillment = input.fulfillment;
  }
  for (const field of ['stripeRef', 'notes']) {
    if (input[field] !== undefined) patch[field] = input[field] === null ? null : String(input[field]);
  }
  // Keep the two status axes coherent when staff mark an order paid
  // by hand (the console reconciliation path until the webhook
  // branch lands): PAID payment on a PENDING_PAYMENT order moves
  // the order to PAID; a COMPLETED order's payment reads PAID.
  if (patch.paymentStatus === 'PAID' && !patch.status && existing.status === 'PENDING_PAYMENT') {
    patch.status = 'PAID';
  }
  if (patch.status === 'COMPLETED' && !patch.paymentStatus && existing.paymentStatus === 'PENDING') {
    patch.paymentStatus = 'PAID';
  }
  return salesOrdersRepo.update(id, patch);
}

// ─── Overview + Ads OS platforms feed ───────────────────────────────

export async function salesOverview() {
  const vendor = await getVendor();
  const [productCounts, orderCounts] = await Promise.all([
    salesProductsRepo.countsByStatus(),
    salesOrdersRepo.countsByStatus(),
  ]);
  const products = Object.fromEntries(PRODUCT_STATUSES.map((s) => [s, productCounts[s] || 0]));
  const orders = Object.fromEntries(ORDER_STATUSES.map((s) => [s, orderCounts[s] || 0]));
  return {
    generatedAt: new Date().toISOString(),
    vendor: publicVendor(vendor),
    products,
    orders,
    productsTotal: Object.values(products).reduce((a, b) => a + b, 0),
    ordersTotal: Object.values(orders).reduce((a, b) => a + b, 0),
    stripeConfigured: stripeConfigured(),
  };
}

/**
 * The Ads OS platforms-feed section metrics for Sales OS: the vendor
 * identity, how many products are ACTIVE (publicly listed), the
 * storefront domain, and an honest status — LIVE once at least one
 * real product is ACTIVE on the storefront, BUILT while the catalog
 * is still empty (the shop's structure is live; nothing is for sale
 * until staff enter a real unit and activate it).
 */
export async function salesOsMetrics() {
  const vendor = await getVendor();
  const counts = await salesProductsRepo.countsByStatus();
  const activeProducts = counts.ACTIVE || 0;
  return {
    vendor: { name: vendor.name, slug: vendor.slug, domain: vendor.domain },
    storefrontDomain: vendor.domain,
    storefrontUrl: `https://${vendor.domain}`,
    consoleUrl: 'https://topspeedserviceos.com/sales-os',
    activeProducts,
    productsByStatus: Object.fromEntries(PRODUCT_STATUSES.map((s) => [s, counts[s] || 0])),
    status: activeProducts > 0 ? 'LIVE' : 'BUILT',
    statusNote: activeProducts > 0
      ? 'The storefront catalog has ACTIVE products for sale.'
      : 'Built and wired — the catalog is empty until staff enter real units and activate them; nothing is for sale yet.',
  };
}
