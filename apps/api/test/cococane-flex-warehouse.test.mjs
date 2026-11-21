/**
 * CocoCane Express — flex warehouse model (2026-11-21).
 *
 * Drills, against a LOCAL test database only:
 *  - the public catalog serves Ramone's LOCKED product set (drinks
 *    $5/$15/$30, whole coconuts $2–$4, dry $2–$3, sticks $7, meat $7),
 *    NO avocado (no locked price), NO demo/fruit products, with the
 *    three default flex locations (WAREHOUSE / SHOP / VEHICLE);
 *  - staff gating: console + stock + order-management endpoints answer
 *    401 signed out and 403 for a customer account;
 *  - reservation math: a retail order reserves transactionally at its
 *    fulfillment location, oversell is refused whole (409, nothing
 *    persists), locations are isolated, cancel RELEASES, fulfil
 *    CONSUMES, invalid transitions are refused;
 *  - transfers move AVAILABLE stock only and conserve the total;
 *    reassigning a reserved order moves its reservation atomically;
 *  - wholesale stays a quote flow: the public request reserves
 *    nothing; staff add lines + a location, and CONFIRM takes the
 *    reservation transactionally (no location → refused);
 *  - the intake shield still guards the public door (honeypot ghosts,
 *    implausible phone is a visible 400);
 *  - the classic COCOCANE_ORDER connection flow is unbroken.
 *
 * Usage:
 *   DATABASE_URL=<local test db> node test/cococane-flex-warehouse.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { hashPassword } from '../src/services/passwords.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

// Assembled from fragments so no credential-shaped literal sits in
// this file (the phase-2 harness idiom).
const JWT = ['coco', 'drill', 'jwt', 'secret'].join('-');
process.env.JWT_SECRET = JWT;
const PASSWORD = ['test', 'pass', '1234'].join('-');

const prisma = new PrismaClient();
let failures = 0;
let server = null;
let base = '';
let stderrBuf = '';

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

let staffToken = '';
let customerToken = '';
async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

function startServer(port) {
  const proc = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      JWT_SECRET: JWT,
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
      OPENAI_API_KEY: '',
      OPENAI_API_KEY_V2: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => { stderrBuf += String(d); });
  proc.stdout.on('data', (d) => { stderrBuf += String(d); });
  return proc;
}

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`server did not come up\n${stderrBuf.slice(-2000)}`);
}

const PHONE = '9545550134';
let drillProduct = null;
let drillLoc = null;
let warehouseLoc = null;
let shopLoc = null;

async function boardStock(productId, locationId) {
  const board = await api('/cococane/console', { token: staffToken });
  const product = board.json.data.products.find((p) => p.id === productId);
  return product.stock.find((s) => s.locationId === locationId);
}

try {
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'coco-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const passwordHash = await hashPassword(PASSWORD);
  const mk = (id, email, roles) => prisma.user.upsert({
    where: { id },
    update: { passwordHash, roles, active: true, verifyRequired: false, layer2Required: false },
    create: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, phone: '9545550100', roles, active: true, verifyRequired: false, layer2Required: false },
  });
  await mk('c0c00000-0000-4000-8000-000000000001', 'coco-staff@test.local', ['DISPATCHER']);
  await mk('c0c00000-0000-4000-8000-000000000002', 'coco-customer@test.local', ['CUSTOMER']);

  base = 'http://127.0.0.1:4493/api/v1';
  server = startServer(4493);
  await waitForServer();

  const staffLogin = await api('/auth/login', { method: 'POST', body: { email: 'coco-staff@test.local', password: PASSWORD } });
  staffToken = staffLogin.json?.token || '';
  checkTrue('staff login mints a session', staffToken.length > 20);
  const customerLogin = await api('/auth/login', { method: 'POST', body: { email: 'coco-customer@test.local', password: PASSWORD } });
  customerToken = customerLogin.json?.token || '';
  checkTrue('customer login mints a session', customerToken.length > 20);

  // ---------------------------------------------------------------
  // A. Catalog: locked set, default locations, honest zeros.
  // ---------------------------------------------------------------
  const catalog = await api('/cococane/catalog');
  check('catalog is public', catalog.status, 200);
  const products = catalog.json.data.products;
  check('catalog holds exactly the 10 locked products', products.length, 10);
  const bySku = new Map(products.map((p) => [p.sku, p]));
  check('coconut water 12oz is the locked $5', bySku.get('COCO-WATER-12OZ')?.priceCents, 500);
  check('coconut water gallon is the locked $30', bySku.get('COCO-WATER-GAL')?.priceCents, 3000);
  check('whole coconut low is the locked $2', bySku.get('COCONUT-WHOLE')?.priceLowCents, 200);
  check('whole coconut high is the locked $4', bySku.get('COCONUT-WHOLE')?.priceHighCents, 400);
  check('dry coconut high is the locked $3', bySku.get('COCONUT-DRY')?.priceHighCents, 300);
  check('sugarcane sticks are the locked $7', bySku.get('CANE-STICKS')?.priceCents, 700);
  check('coconut meat is the locked $7', bySku.get('COCO-MEAT')?.priceCents, 700);
  checkTrue('NO avocado in the catalog (no locked price)', ![...bySku.keys()].some((s) => s.includes('AVOCADO')));
  checkTrue('NO demo/fruit products in the catalog', ![...bySku.keys()].some((s) => s.includes('FRT') || s.includes('FRUIT')));
  const locCodes = catalog.json.data.locations.map((l) => l.code).sort();
  check('default flex locations exist', JSON.stringify(locCodes), JSON.stringify(['SHOP', 'VEHICLE', 'WAREHOUSE']));
  warehouseLoc = catalog.json.data.locations.find((l) => l.code === 'WAREHOUSE');
  shopLoc = catalog.json.data.locations.find((l) => l.code === 'SHOP');

  // ---------------------------------------------------------------
  // B. Staff gating.
  // ---------------------------------------------------------------
  check('console signed out → 401', (await api('/cococane/console')).status, 401);
  check('console as customer → 403', (await api('/cococane/console', { token: customerToken })).status, 403);
  check('orders list signed out → 401', (await api('/cococane/orders')).status, 401);
  check('stock adjust as customer → 403', (await api('/cococane/stock/adjust', { method: 'POST', token: customerToken, body: { productId: 'c0c00000-0000-4000-8000-000000000099', locationId: warehouseLoc.id, delta: 1, reason: 'drill' } })).status, 403);
  check('console as staff → 200', (await api('/cococane/console', { token: staffToken })).status, 200);

  // ---------------------------------------------------------------
  // C. Staff data: drill location + product, adjustments.
  // ---------------------------------------------------------------
  const locRes = await api('/cococane/locations', { method: 'POST', token: staffToken, body: { code: 'DRILL-LOC', name: 'Drill Location', kind: 'OTHER' } });
  check('staff can add a stock location', locRes.status, 201);
  drillLoc = locRes.json.data;
  check('duplicate location code → 409', (await api('/cococane/locations', { method: 'POST', token: staffToken, body: { code: 'DRILL-LOC', name: 'Again', kind: 'OTHER' } })).status, 409);

  const prodRes = await api('/cococane/products', { method: 'POST', token: staffToken, body: { sku: 'DRILL-COCO', name: 'Drill Coconut', category: 'Drill', priceCents: 500 } });
  check('staff can add a catalog product', prodRes.status, 201);
  drillProduct = prodRes.json.data;
  check('product with both price shapes → 400', (await api('/cococane/products', { method: 'POST', token: staffToken, body: { sku: 'DRILL-BAD', name: 'Bad', category: 'Drill', priceCents: 100, priceLowCents: 100, priceHighCents: 200 } })).status, 400);
  check('unpriced product → 400', (await api('/cococane/products', { method: 'POST', token: staffToken, body: { sku: 'DRILL-FREE', name: 'Free', category: 'Drill' } })).status, 400);

  const adj1 = await api('/cococane/stock/adjust', { method: 'POST', token: staffToken, body: { productId: drillProduct.id, locationId: drillLoc.id, delta: 100, reason: 'Drill stock-in' } });
  check('adjustment +100 lands', adj1.json.data.onHand, 100);
  check('adjustment without a reason → 400', (await api('/cococane/stock/adjust', { method: 'POST', token: staffToken, body: { productId: drillProduct.id, locationId: drillLoc.id, delta: 5 } })).status, 400);
  const adj2 = await api('/cococane/stock/adjust', { method: 'POST', token: staffToken, body: { productId: drillProduct.id, locationId: drillLoc.id, delta: -30, reason: 'Drill count correction' } });
  check('adjustment −30 lands', adj2.json.data.onHand, 70);
  check('adjustment below zero → 409', (await api('/cococane/stock/adjust', { method: 'POST', token: staffToken, body: { productId: drillProduct.id, locationId: drillLoc.id, delta: -1000, reason: 'Drill refusal' } })).status, 409);

  // ---------------------------------------------------------------
  // D. Retail reservation lifecycle.
  // ---------------------------------------------------------------
  const orderBody = (quantity, locationCode) => ({
    channel: 'RETAIL', method: 'PICKUP', name: 'Drill Buyer', phone: PHONE,
    locationCode, items: [{ productId: drillProduct.id, quantity }],
  });
  const o1 = await api('/cococane/orders', { method: 'POST', body: orderBody(25, 'DRILL-LOC') });
  check('retail order created', o1.status, 201);
  checkTrue('retail order is reserved on creation', o1.json.data.order.stockReserved);
  checkTrue('retail order carries a TS- reference', /^TS-/.test(o1.json.data.reference));
  const o1Conn = await prisma.connection.findUnique({ where: { id: o1.json.data.order.connectionId } });
  check('retail order still creates the COCOCANE_ORDER connection', o1Conn?.type, 'COCOCANE_ORDER');
  let stock = await boardStock(drillProduct.id, drillLoc.id);
  check('after reserve: onHand still 70', stock.onHand, 70);
  check('after reserve: reserved 25', stock.reserved, 25);
  check('after reserve: available 45', stock.available, 45);

  const ordersBefore = await prisma.cocoCaneOrder.count();
  const over = await api('/cococane/orders', { method: 'POST', body: orderBody(46, 'DRILL-LOC') });
  check('oversell refused → 409', over.status, 409);
  check('oversell code', over.json.code, 'INSUFFICIENT_STOCK');
  check('oversell persisted NO order', await prisma.cocoCaneOrder.count(), ordersBefore);
  stock = await boardStock(drillProduct.id, drillLoc.id);
  check('oversell moved NO stock', stock.reserved, 25);

  const isolated = await api('/cococane/orders', { method: 'POST', body: orderBody(1, 'SHOP') });
  check('per-location isolation: SHOP holds none → 409', isolated.status, 409);

  const cancel = await api(`/cococane/orders/${o1.json.data.order.id}/status`, { method: 'POST', token: staffToken, body: { status: 'CANCELLED' } });
  check('cancel succeeds', cancel.json.data.status, 'CANCELLED');
  stock = await boardStock(drillProduct.id, drillLoc.id);
  check('cancel RELEASES the reservation', stock.reserved, 0);
  check('cancel leaves onHand at 70', stock.onHand, 70);

  const o2 = await api('/cococane/orders', { method: 'POST', body: orderBody(10, 'DRILL-LOC') });
  const o2id = o2.json.data.order.id;
  check('REQUESTED → FULFILLED direct is refused', (await api(`/cococane/orders/${o2id}/status`, { method: 'POST', token: staffToken, body: { status: 'FULFILLED' } })).status, 409);
  await api(`/cococane/orders/${o2id}/status`, { method: 'POST', token: staffToken, body: { status: 'CONFIRMED' } });
  await api(`/cococane/orders/${o2id}/status`, { method: 'POST', token: staffToken, body: { status: 'READY' } });
  const fulfilled = await api(`/cococane/orders/${o2id}/status`, { method: 'POST', token: staffToken, body: { status: 'FULFILLED' } });
  check('READY → FULFILLED succeeds', fulfilled.json.data.status, 'FULFILLED');
  stock = await boardStock(drillProduct.id, drillLoc.id);
  check('fulfil CONSUMES onHand (70 → 60)', stock.onHand, 60);
  check('fulfil clears the reservation', stock.reserved, 0);
  check('FULFILLED → COMPLETED succeeds', (await api(`/cococane/orders/${o2id}/status`, { method: 'POST', token: staffToken, body: { status: 'COMPLETED' } })).json.data.status, 'COMPLETED');
  check('COMPLETED → CANCELLED is refused', (await api(`/cococane/orders/${o2id}/status`, { method: 'POST', token: staffToken, body: { status: 'CANCELLED' } })).status, 409);

  // ---------------------------------------------------------------
  // E. Transfers conserve stock and cannot move reserved units.
  // ---------------------------------------------------------------
  await api('/cococane/stock/adjust', { method: 'POST', token: staffToken, body: { productId: drillProduct.id, locationId: warehouseLoc.id, delta: 50, reason: 'Drill warehouse stock-in' } });
  const totalBefore = (await api('/cococane/console', { token: staffToken })).json.data.products
    .find((p) => p.id === drillProduct.id).stock.reduce((sum, s) => sum + s.onHand, 0);
  const tr = await api('/cococane/stock/transfer', { method: 'POST', token: staffToken, body: { productId: drillProduct.id, fromLocationId: warehouseLoc.id, toLocationId: drillLoc.id, quantity: 20, reason: 'Drill transfer' } });
  check('transfer succeeds', tr.status, 200);
  const totalAfter = (await api('/cococane/console', { token: staffToken })).json.data.products
    .find((p) => p.id === drillProduct.id).stock.reduce((sum, s) => sum + s.onHand, 0);
  check('transfer CONSERVES total onHand', totalAfter, totalBefore);
  stock = await boardStock(drillProduct.id, drillLoc.id);
  check('transfer landed at destination (60 → 80)', stock.onHand, 80);
  check('transfer beyond available → 409', (await api('/cococane/stock/transfer', { method: 'POST', token: staffToken, body: { productId: drillProduct.id, fromLocationId: warehouseLoc.id, toLocationId: drillLoc.id, quantity: 1000 } })).status, 409);
  check('transfer to the same location → 400', (await api('/cococane/stock/transfer', { method: 'POST', token: staffToken, body: { productId: drillProduct.id, fromLocationId: drillLoc.id, toLocationId: drillLoc.id, quantity: 1 } })).status, 400);

  const o3 = await api('/cococane/orders', { method: 'POST', body: orderBody(80, 'DRILL-LOC') });
  check('order reserving ALL available stock succeeds', o3.status, 201);
  check('reserved stock cannot transfer out → 409', (await api('/cococane/stock/transfer', { method: 'POST', token: staffToken, body: { productId: drillProduct.id, fromLocationId: drillLoc.id, toLocationId: warehouseLoc.id, quantity: 1 } })).status, 409);
  await api(`/cococane/orders/${o3.json.data.order.id}/status`, { method: 'POST', token: staffToken, body: { status: 'CANCELLED' } });

  // ---------------------------------------------------------------
  // F. Reassigning a reserved order moves the reservation atomically.
  // ---------------------------------------------------------------
  const o4 = await api('/cococane/orders', { method: 'POST', body: orderBody(5, 'DRILL-LOC') });
  const o4id = o4.json.data.order.id;
  const moved = await api(`/cococane/orders/${o4id}/assign`, { method: 'POST', token: staffToken, body: { locationId: warehouseLoc.id } });
  check('reassign to a stocked location succeeds', moved.json.data.fulfillmentLocationId, warehouseLoc.id);
  stock = await boardStock(drillProduct.id, warehouseLoc.id);
  check('reservation moved to the warehouse', stock.reserved, 5);
  stock = await boardStock(drillProduct.id, drillLoc.id);
  check('reservation left the drill location', stock.reserved, 0);
  const failedMove = await api(`/cococane/orders/${o4id}/assign`, { method: 'POST', token: staffToken, body: { locationId: shopLoc.id } });
  check('reassign to an unstocked location → 409', failedMove.status, 409);
  stock = await boardStock(drillProduct.id, warehouseLoc.id);
  check('failed reassign keeps the reservation in place', stock.reserved, 5);
  await api(`/cococane/orders/${o4id}/status`, { method: 'POST', token: staffToken, body: { status: 'CANCELLED' } });

  // ---------------------------------------------------------------
  // G. Wholesale: quote flow first, reservation at CONFIRM.
  // ---------------------------------------------------------------
  const ws = await api('/cococane/orders', { method: 'POST', body: { channel: 'WHOLESALE', name: 'Drill Wholesale Buyer', phone: PHONE, notes: 'CocoCane WHOLESALE request. Product: Whole coconuts (bulk). Quantity: 300', deliveryAddress: 'Fort Lauderdale' } });
  check('wholesale request created', ws.status, 201);
  const wsOrder = ws.json.data.order;
  check('wholesale request reserves NOTHING', wsOrder.stockReserved, false);
  const wsConn = await prisma.connection.findUnique({ where: { id: wsOrder.connectionId } });
  check('wholesale still creates the COCOCANE_WHOLESALE connection', wsConn?.type, 'COCOCANE_WHOLESALE');
  const linesRes = await api(`/cococane/orders/${wsOrder.id}/lines`, { method: 'POST', token: staffToken, body: { items: [{ productId: drillProduct.id, quantity: 40 }] } });
  check('staff can build lines on the wholesale request', linesRes.status, 200);
  check('confirm with lines but NO location is refused', (await api(`/cococane/orders/${wsOrder.id}/status`, { method: 'POST', token: staffToken, body: { status: 'CONFIRMED' } })).status, 400);
  await api(`/cococane/orders/${wsOrder.id}/assign`, { method: 'POST', token: staffToken, body: { locationId: drillLoc.id } });
  const wsConfirmed = await api(`/cococane/orders/${wsOrder.id}/status`, { method: 'POST', token: staffToken, body: { status: 'CONFIRMED' } });
  check('confirm with lines + location succeeds', wsConfirmed.json.data.status, 'CONFIRMED');
  checkTrue('confirm TOOK the reservation', wsConfirmed.json.data.stockReserved);
  stock = await boardStock(drillProduct.id, drillLoc.id);
  check('wholesale reservation holds 40', stock.reserved, 40);
  await api(`/cococane/orders/${wsOrder.id}/status`, { method: 'POST', token: staffToken, body: { status: 'CANCELLED' } });
  stock = await boardStock(drillProduct.id, drillLoc.id);
  check('wholesale cancel releases the 40', stock.reserved, 0);

  // Staff-created order with items reserves immediately.
  const staffOrder = await api('/cococane/orders/staff', { method: 'POST', token: staffToken, body: { channel: 'RETAIL', method: 'PICKUP', customerName: 'Walk Up', phone: PHONE, locationId: drillLoc.id, items: [{ productId: drillProduct.id, quantity: 3 }] } });
  check('staff order created', staffOrder.status, 201);
  checkTrue('staff order with items reserves immediately', staffOrder.json.data.stockReserved);
  await api(`/cococane/orders/${staffOrder.json.data.id}/status`, { method: 'POST', token: staffToken, body: { status: 'CANCELLED' } });

  // ---------------------------------------------------------------
  // H. Shield on the public door + classic flows unbroken.
  // ---------------------------------------------------------------
  const countBeforeGhost = await prisma.cocoCaneOrder.count();
  const ghost = await api('/cococane/orders', { method: 'POST', body: { ...orderBody(1, 'DRILL-LOC'), companyWebsite: 'http://spam.example' } });
  check('honeypot answers the ghost 201 shape', ghost.status, 201);
  check('honeypot persisted NO order', await prisma.cocoCaneOrder.count(), countBeforeGhost);
  const badPhone = await api('/cococane/orders', { method: 'POST', body: { ...orderBody(1, 'DRILL-LOC'), phone: '3555551234' } });
  check('implausible phone → visible 400', badPhone.status, 400);
  check('implausible phone code', badPhone.json.code, 'INVALID_PHONE');

  const classic = await api('/connections', { method: 'POST', body: { type: 'COCOCANE_ORDER', name: 'Classic Flow', phone: PHONE, source: 'cococane-site', message: 'Classic order-ahead message' } });
  check('classic COCOCANE_ORDER connection still lands', classic.status, 201);
  checkTrue('classic flow returns a reference', /^TS-/.test(classic.json.data.reference));
  const payments = await api('/payments/status');
  check('payments status untouched', payments.status, 200);
  check('health still ok', (await api('/health')).status, 200);

  // ---------------------------------------------------------------
  // I. Public page + console static contract.
  // ---------------------------------------------------------------
  const site = readFileSync(fileURLToPath(new URL('../../web/cococane-site/index.html', import.meta.url)), 'utf8');
  check('public menu wires all 10 SKUs', (site.match(/data-sku=/g) || []).length, 10);
  checkTrue('public page offers pickup/delivery choice', site.includes('id="coMethod"'));
  checkTrue('public page posts to the Express orders endpoint', site.includes("/cococane/orders") || site.includes("COCO_API + '/orders'"));
  const console_ = readFileSync(fileURLToPath(new URL('../../web/cococane-express/index.html', import.meta.url)), 'utf8');
  checkTrue('console carries the workstation footer', console_.includes('Workstation — Team Consoles'));
  checkTrue('console reads the board endpoint', console_.includes('/cococane/console'));
  for (const [name, html] of [['cococane-site', site], ['cococane-express', console_]]) {
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    let parses = true;
    for (const js of blocks) { try { new Function(js); } catch { parses = false; } }
    checkTrue(`${name} inline scripts parse`, parses);
  }
} catch (error) {
  failures += 1;
  console.error('SUITE ERROR', error);
  console.error(stderrBuf.slice(-2000));
} finally {
  if (server) server.kill('SIGKILL');
  await prisma.$disconnect();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
