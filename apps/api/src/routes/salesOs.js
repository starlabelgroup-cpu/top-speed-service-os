import { Router } from 'express';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import {
  salesOrdersRepo,
  salesProductsRepo,
} from '../db/salesOsRepo.js';
import {
  PRODUCT_STATUSES,
  createOrder,
  createProduct,
  getCatalog,
  getCatalogProduct,
  listOrders,
  listProducts,
  salesOverview,
  updateOrder,
  updateProduct,
} from '../services/salesOs.js';

/**
 * Top Speed Sales OS (2026-11-23) — the sales platform's API: the
 * public storefront catalog + order placement for Top Speed
 * Appliances (topspeedappliances.com), and the staff console's
 * product / order / overview reads and writes.
 *
 * Auth discipline (the 2026-11-17 auth-trap rule): this router is
 * mounted on the shared /api/v1 prefix, so the staff gate is spread
 * PER ROUTE below — never an unscoped router.use() — and every
 * route lives under this router's own /sales-os subpath. The public
 * routes are read-only catalog reads (ACTIVE products only) plus
 * order placement, which validates every line against the stored
 * catalog and computes totals server-side.
 *
 * Money discipline: order totals come from the stored product
 * prices, never the request. Checkout is created through the
 * platform's existing Stripe pattern (services/stripe.js, via
 * services/salesOs.js createSalesOrderCheckout); when Stripe is not
 * configured the order saves as PENDING_PAYMENT and the response
 * carries checkout: null — no payment link is ever fabricated.
 */

const router = Router();

const salesOsStaff = [
  authenticate,
  requireCompany,
  requireRole(
    ROLES.COMPANY_OWNER,
    ROLES.COMPANY_ADMIN,
    ROLES.PLATFORM_ADMIN,
    ROLES.MARKETING_MANAGER,
  ),
];

function handleServiceError(error, res, next) {
  if (error?.status) {
    return res.status(error.status).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
  return next(error);
}

function parseLimit(value, fallback, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

// ─── Public: storefront catalog (ACTIVE only) ───────────────────────

router.get('/sales-os/catalog', async (req, res, next) => {
  try {
    const data = await getCatalog({
      category: req.query.category || undefined,
      limit: parseLimit(req.query.limit, 50, 200),
    });
    return res.json({ data });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

router.get('/sales-os/catalog/:id', async (req, res, next) => {
  try {
    return res.json({ data: await getCatalogProduct(req.params.id) });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

// ─── Public: order placement ────────────────────────────────────────
// The customer door (Ramone's 2026-11-21 rule): no account, no
// office approval — a shopper orders on the spot. Items are
// validated against ACTIVE products + stock and priced from the
// database by the service; the response carries the saved order and
// the Stripe checkout URL when Stripe is configured.

router.post('/sales-os/orders', async (req, res, next) => {
  try {
    const { order, checkout, checkoutError } = await createOrder(req.body || {});
    return res.status(201).json({
      data: {
        order,
        checkout,
        ...(checkoutError ? { checkoutError } : {}),
      },
    });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

// ─── Staff: overview ────────────────────────────────────────────────

router.get('/sales-os/overview', ...salesOsStaff, async (req, res, next) => {
  try {
    return res.json({ data: await salesOverview() });
  } catch (error) {
    return next(error);
  }
});

// ─── Staff: products ────────────────────────────────────────────────

router.get('/sales-os/products', ...salesOsStaff, async (req, res, next) => {
  try {
    if (req.query.status && !PRODUCT_STATUSES.includes(req.query.status)) {
      return res.status(400).json({ error: `Unknown product status: ${req.query.status}`, code: 'STATUS_INVALID' });
    }
    const rows = await listProducts({
      status: req.query.status || undefined,
      category: req.query.category || undefined,
      limit: parseLimit(req.query.limit, 200, 500),
    });
    return res.json({ data: rows });
  } catch (error) {
    return next(error);
  }
});

router.post('/sales-os/products', ...salesOsStaff, async (req, res, next) => {
  try {
    const row = await createProduct(req.body || {}, req.user.id);
    return res.status(201).json({ data: row });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

router.get('/sales-os/products/:id', ...salesOsStaff, async (req, res, next) => {
  try {
    const row = await salesProductsRepo.findById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Product not found', code: 'PRODUCT_NOT_FOUND' });
    return res.json({ data: row });
  } catch (error) {
    return next(error);
  }
});

router.patch('/sales-os/products/:id', ...salesOsStaff, async (req, res, next) => {
  try {
    const row = await updateProduct(req.params.id, req.body || {});
    return res.json({ data: row });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

// ─── Staff: orders ──────────────────────────────────────────────────

router.get('/sales-os/orders', ...salesOsStaff, async (req, res, next) => {
  try {
    const rows = await listOrders({
      status: req.query.status || undefined,
      paymentStatus: req.query.paymentStatus || undefined,
      limit: parseLimit(req.query.limit, 200, 500),
    });
    return res.json({ data: rows });
  } catch (error) {
    return next(error);
  }
});

router.get('/sales-os/orders/:id', ...salesOsStaff, async (req, res, next) => {
  try {
    const row = await salesOrdersRepo.findById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Order not found', code: 'ORDER_NOT_FOUND' });
    return res.json({ data: row });
  } catch (error) {
    return next(error);
  }
});

router.patch('/sales-os/orders/:id', ...salesOsStaff, async (req, res, next) => {
  try {
    const row = await updateOrder(req.params.id, req.body || {});
    return res.json({ data: row });
  } catch (error) {
    return handleServiceError(error, res, next);
  }
});

export default router;
