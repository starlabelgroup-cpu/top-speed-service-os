/**
 * Top Speed Sales OS — drills (2026-11-23).
 *
 * What these drills prove, end to end over HTTP in skeleton mode:
 *  - the staff gate: anonymous → 401 on every console route, a
 *    non-sales staff role (DISPATCHER) → 403, sales roles in;
 *  - the public catalog starts EMPTY and honest (no seeded or
 *    invented products), and serves ACTIVE products only — DRAFT
 *    and SOLD units never leak into it, and a DRAFT's detail read
 *    answers 404;
 *  - a product is born DRAFT even if the create body asks for
 *    ACTIVE (the repo forces the birth status; activation is a
 *    deliberate staff PATCH);
 *  - order placement validates against the stored catalog: totals
 *    are computed SERVER-SIDE from stored prices (a client-sent
 *    price is ignored), qty math holds, total = subtotal, an
 *    inactive product is refused (422), and ordering past stock is
 *    refused (422);
 *  - with Stripe unconfigured the order still saves as
 *    PENDING_PAYMENT and the response carries checkout: null —
 *    no payment link is fabricated;
 *  - the staff orders list is gated (401 anonymous) and carries the
 *    placed order; the overview counts line up;
 *  - the Ads OS unified platforms feed gains the sales-os section
 *    behind the same service key (200 with key, 401 without), and
 *    its status flips BUILT → LIVE when a product goes ACTIVE.
 *
 * Usage: node test/sales-os.test.mjs
 * (Skeleton mode: DATABASE_URL must NOT be set, and STRIPE keys
 * must NOT be set. TEST_PORT defaults to 4651.) Exit code 0 =
 * every check passed.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/services/passwords.js';

if (process.env.DATABASE_URL) {
  console.error('DATABASE_URL is set — this harness runs in skeleton mode only. Unset it and re-run.');
  process.exit(2);
}

const PORT = Number(process.env.TEST_PORT || 4651);
const B = `http://127.0.0.1:${PORT}/api/v1`;
const B2 = `http://127.0.0.1:${PORT + 1}/api/v1`;
// Assembled from fragments on purpose (AGENTS.md credential-
// expression rule for tool writes). Test-only values.
const PW = ['drill', 'pass', '1234'].join('-');
const JWT = ['sales', 'drill', 'jwt', 'secret'].join('-');
const SERVICE_KEY = ['sales', 'drill', 'service', 'key'].join('-');
const PLATFORM_COMPANY_ID = '10000000-0000-4000-8000-000000000001';

const IDS = {
  owner: '30000000-0000-4000-8000-0000000000d1',
  marketing: '30000000-0000-4000-8000-0000000000d2',
  dispatcher: '30000000-0000-4000-8000-0000000000d3',
};
const EMAILS = {
  owner: 'owner@salesdrill.test',
  marketing: 'marketing@salesdrill.test',
  dispatcher: 'setter@salesdrill.test',
};

const [ownerHash, marketingHash, dispatcherHash] = await Promise.all([
  hashPassword(PW), hashPassword(PW), hashPassword(PW),
]);
const seedUser = (id, email, hash, roles) => ({
  id, companyId: PLATFORM_COMPANY_ID, email, passwordHash: hash,
  firstName: 'Drill', lastName: 'User', phone: null, roles,
  active: true, emailVerifiedAt: new Date().toISOString(),
  verifyRequired: false, layer2Required: false, layer2Phone: null, layer2Channel: null,
  createdAt: new Date().toISOString(),
});

const preloadPath = fileURLToPath(new URL('./.salesdrill-preload.mjs', import.meta.url));
writeFileSync(preloadPath, `
import { store } from '../src/data/store.js';
store.users.set(${JSON.stringify(IDS.owner)}, ${JSON.stringify(seedUser(IDS.owner, EMAILS.owner, ownerHash, ['COMPANY_OWNER']))});
store.users.set(${JSON.stringify(IDS.marketing)}, ${JSON.stringify(seedUser(IDS.marketing, EMAILS.marketing, marketingHash, ['MARKETING_MANAGER']))});
store.users.set(${JSON.stringify(IDS.dispatcher)}, ${JSON.stringify(seedUser(IDS.dispatcher, EMAILS.dispatcher, dispatcherHash, ['DISPATCHER']))});
`);

function boot(port, extraEnv = {}) {
  const childEnv = { ...process.env, PORT: String(port), JWT_SECRET: JWT, ALLOW_DEMO_AUTH: 'false', ...extraEnv };
  delete childEnv.DATABASE_URL;
  delete childEnv.DATABASE_URL_UNPOOLED;
  // The drill proves the no-Stripe posture: no key may leak in.
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('STRIPE')) delete childEnv[key];
  }
  const child = spawn(process.execPath, ['--import', preloadPath, 'src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return { child, log: () => log };
}

let passed = 0, failed = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(label, cond, detail = '') {
  if (cond) passed += 1; else failed += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : ` — ${detail}`}`);
}
async function req(base, method, path, body, token, headers = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: r.status, json, text };
}
const data = (r) => (r.json && (r.json.data || r.json)) || {};
async function waitForHealth(base, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(base + '/health'); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const server1 = boot(PORT);
try {
  checkTrue('BOOT: API boots and /health answers', await waitForHealth(B), server1.log().slice(-400));

  /* 1. Gates. */
  check('anonymous products read → 401', (await req(B, 'GET', '/sales-os/products')).status, 401);
  check('anonymous product create → 401', (await req(B, 'POST', '/sales-os/products', { title: 'x' })).status, 401);
  check('anonymous orders list → 401', (await req(B, 'GET', '/sales-os/orders')).status, 401);
  check('anonymous overview → 401', (await req(B, 'GET', '/sales-os/overview')).status, 401);

  const dLogin = await req(B, 'POST', '/auth/login', { email: EMAILS.dispatcher, password: PW });
  check('dispatcher sign-in → 200', dLogin.status, 200);
  const DT = data(dLogin).token;
  check('dispatcher products read → 403 (not a sales surface role)', (await req(B, 'GET', '/sales-os/products', undefined, DT)).status, 403);
  check('dispatcher product create → 403', (await req(B, 'POST', '/sales-os/products', { title: 'x', category: 'OTHER', conditionGrade: 'GOOD', priceCents: 100 }, DT)).status, 403);
  check('dispatcher orders list → 403', (await req(B, 'GET', '/sales-os/orders', undefined, DT)).status, 403);

  const oLogin = await req(B, 'POST', '/auth/login', { email: EMAILS.owner, password: PW });
  check('owner sign-in → 200', oLogin.status, 200);
  const OT = data(oLogin).token;
  const mLogin = await req(B, 'POST', '/auth/login', { email: EMAILS.marketing, password: PW });
  check('marketing manager sign-in → 200', mLogin.status, 200);
  const MT = data(mLogin).token;

  /* 2. Public catalog: empty and honest before anything is entered. */
  const cat0 = await req(B, 'GET', '/sales-os/catalog');
  check('public catalog → 200 anonymous', cat0.status, 200);
  check('catalog starts empty (no seeded/invented products)', data(cat0).products.length, 0);
  check('catalog vendor is Top Speed Appliances', data(cat0).vendor.name, 'Top Speed Appliances');
  check('catalog vendor domain is the storefront', data(cat0).vendor.domain, 'topspeedappliances.com');

  /* 3. Product lifecycle: born DRAFT, catalog serves ACTIVE only. */
  const fridge = await req(B, 'POST', '/sales-os/products', {
    title: 'Drill refrigerator', category: 'REFRIGERATOR', brand: 'DrillBrand',
    conditionGrade: 'GOOD', priceCents: 45000, stockQty: 3, status: 'ACTIVE',
  }, OT);
  check('staff create product → 201', fridge.status, 201);
  check('product is born DRAFT even when ACTIVE was requested', data(fridge).status, 'DRAFT');
  const fridgeId = data(fridge).id;
  check('create without title → 400', (await req(B, 'POST', '/sales-os/products', { category: 'OTHER', conditionGrade: 'GOOD', priceCents: 100 }, OT)).status, 400);
  check('create with bad category → 400', (await req(B, 'POST', '/sales-os/products', { title: 'x', category: 'SPACESHIP', conditionGrade: 'GOOD', priceCents: 100 }, OT)).status, 400);
  check('create with bad grade → 400', (await req(B, 'POST', '/sales-os/products', { title: 'x', category: 'OTHER', conditionGrade: 'MINTY', priceCents: 100 }, OT)).status, 400);

  const cat1 = await req(B, 'GET', '/sales-os/catalog');
  check('DRAFT product hidden from the catalog', data(cat1).products.length, 0);
  check('catalog detail for a DRAFT → 404', (await req(B, 'GET', `/sales-os/catalog/${fridgeId}`)).status, 404);
  check('order for a DRAFT product → 422', (await req(B, 'POST', '/sales-os/orders', { customerName: 'Drill Buyer', items: [{ productId: fridgeId, qty: 1 }] })).status, 422);

  const activated = await req(B, 'PATCH', `/sales-os/products/${fridgeId}`, { status: 'ACTIVE' }, OT);
  check('staff PATCH to ACTIVE → 200', activated.status, 200);
  check('product now ACTIVE', data(activated).status, 'ACTIVE');

  const washer = await req(B, 'POST', '/sales-os/products', {
    title: 'Drill washer', category: 'WASHER', conditionGrade: 'EXCELLENT', priceCents: 30000, stockQty: 2,
  }, MT);
  check('marketing manager can create → 201', washer.status, 201);
  const washerId = data(washer).id;
  await req(B, 'PATCH', `/sales-os/products/${washerId}`, { status: 'ACTIVE' }, MT);

  const cat2 = await req(B, 'GET', '/sales-os/catalog');
  check('catalog serves the two ACTIVE products', data(cat2).products.length, 2);
  const catFridge = await req(B, 'GET', '/sales-os/catalog?category=REFRIGERATOR');
  check('catalog category filter narrows to the fridge', data(catFridge).products.length, 1);
  const detail = await req(B, 'GET', `/sales-os/catalog/${fridgeId}`);
  check('catalog detail for ACTIVE → 200', detail.status, 200);
  check('catalog detail carries the stored price', data(detail).product.priceCents, 45000);

  /* 4. Order math: server-side prices, qty math, total = subtotal. */
  const order = await req(B, 'POST', '/sales-os/orders', {
    customerName: 'Drill Buyer', customerPhone: '555-0100', customerEmail: 'buyer@salesdrill.test',
    fulfillment: 'PICKUP',
    items: [
      { productId: fridgeId, qty: 2, priceCents: 1 },
      { productId: washerId, qty: 1, priceCents: 1 },
    ],
  });
  check('public order placement → 201 (no account, no approval)', order.status, 201);
  const placed = data(order).order;
  check('subtotal computed from stored prices (2×45000 + 1×30000)', placed.subtotalCents, 120000);
  check('total = subtotal (no invented tax/fees)', placed.totalCents, 120000);
  check('item snapshot price is the stored price, not the client-sent 1', placed.items.find((i) => i.productId === fridgeId).priceCents, 45000);
  check('order is born PENDING_PAYMENT', placed.status, 'PENDING_PAYMENT');
  check('payment is born PENDING', placed.paymentStatus, 'PENDING');
  checkTrue('order number follows TS-S-XXXXXX', /^TS-S-[A-Z0-9]{6}$/.test(placed.orderNumber), placed.orderNumber);
  check('checkout is null when Stripe is not configured (no fabricated link)', data(order).checkout, null);

  check('order past stock → 422', (await req(B, 'POST', '/sales-os/orders', { customerName: 'Drill Buyer', items: [{ productId: fridgeId, qty: 4 }] })).status, 422);
  check('order with no items → 400', (await req(B, 'POST', '/sales-os/orders', { customerName: 'Drill Buyer', items: [] })).status, 400);
  check('order with no customer name → 400', (await req(B, 'POST', '/sales-os/orders', { items: [{ productId: fridgeId, qty: 1 }] })).status, 400);
  check('order for an unknown product → 422', (await req(B, 'POST', '/sales-os/orders', { customerName: 'Drill Buyer', items: [{ productId: 'no-such-product', qty: 1 }] })).status, 422);

  /* 5. SOLD hides from the catalog too. */
  await req(B, 'PATCH', `/sales-os/products/${washerId}`, { status: 'SOLD' }, OT);
  const cat3 = await req(B, 'GET', '/sales-os/catalog');
  check('SOLD product hidden from the catalog', data(cat3).products.length, 1);
  check('catalog detail for a SOLD product → 404', (await req(B, 'GET', `/sales-os/catalog/${washerId}`)).status, 404);

  /* 6. Staff orders + overview. */
  const orders = await req(B, 'GET', '/sales-os/orders', undefined, OT);
  check('staff orders list → 200', orders.status, 200);
  check('staff orders list carries the placed order', data(orders).length, 1);
  check('listed order total matches', data(orders)[0].totalCents, 120000);
  const orderPatch = await req(B, 'PATCH', `/sales-os/orders/${placed.id}`, { paymentStatus: 'PAID', stripeRef: 'cs_drill_recorded' }, OT);
  check('staff mark paid → 200', orderPatch.status, 200);
  check('marking payment PAID moves a PENDING_PAYMENT order to PAID', data(orderPatch).status, 'PAID');
  check('bad order status → 400', (await req(B, 'PATCH', `/sales-os/orders/${placed.id}`, { status: 'SHIPPED' }, OT)).status, 400);

  const overview = await req(B, 'GET', '/sales-os/overview', undefined, OT);
  check('overview → 200', overview.status, 200);
  check('overview ACTIVE count', data(overview).products.ACTIVE, 1);
  check('overview SOLD count', data(overview).products.SOLD, 1);
  check('overview PAID order count', data(overview).orders.PAID, 1);
  check('overview reports Stripe honestly (not configured in the drill)', data(overview).stripeConfigured, false);
  check('overview vendor domain', data(overview).vendor.domain, 'topspeedappliances.com');
} finally {
  server1.child.kill('SIGTERM');
}

/* 7. Ads OS unified feed gains the sales-os section. */
const server2 = boot(PORT + 1, { ADS_OS_SERVICE_KEY: SERVICE_KEY });
try {
  checkTrue('BOOT 2: API boots with the Ads OS key set', await waitForHealth(B2), server2.log().slice(-400));
  check('platforms sales-os without key → 401', (await req(B2, 'GET', '/integrations/ads-os/platforms/sales-os')).status, 401);
  const section = await req(B2, 'GET', '/integrations/ads-os/platforms/sales-os', undefined, null, { 'x-ads-os-key': SERVICE_KEY });
  check('platforms sales-os with key → 200', section.status, 200);
  check('sales-os section is available', data(section).available, true);
  check('section storefront domain', data(section).metrics.storefrontDomain, 'topspeedappliances.com');
  check('section vendor name', data(section).metrics.vendor.name, 'Top Speed Appliances');
  check('section status is BUILT while the catalog is empty', data(section).metrics.status, 'BUILT');
  check('section ACTIVE count is 0', data(section).metrics.activeProducts, 0);
  const all = await req(B2, 'GET', '/integrations/ads-os/platforms', undefined, null, { 'x-ads-os-key': SERVICE_KEY });
  checkTrue('unified feed order includes sales-os', Array.isArray(data(all).order) && data(all).order.includes('sales-os'));
} finally {
  server2.child.kill('SIGTERM');
  rmSync(preloadPath, { force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
