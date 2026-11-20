/**
 * Pepper Lists Trust & Growth — verification harness (2026-11-20).
 *
 * Exercises the trust layer built over PEPPER_LISTS_SELL listings
 * (routes/pepperListsTrust.js + routes/sellerPlans.js) end to end:
 *  - public feed + trust-first detail: seller badges appear IFF the
 *    underlying account fact is true (email verified / Layer 2 on /
 *    member since / completed sales), view counting (never the
 *    seller's own views), honest zero-review state (count 0,
 *    average null — no aggregate invented);
 *  - comments: sign-in required, seller reply marking, owner hide,
 *    staff remove, other users refused, visible-count accuracy,
 *    per-account rate limit (31st action in the hour -> 429);
 *  - reports: filed into the staff queue (ListingReport + the
 *    Pepper Reports log), duplicate guard, staff review lane;
 *  - completed sales -> seller reviews: review opens ONLY for the
 *    buyer named on a SellerSale, one per sale, low ratings held
 *    PENDING for the office, aggregate math from published only;
 *  - seller plans (advertiser-plan mirror): unpriced checkout ->
 *    422 pricing_not_set with ZERO Stripe calls; owner price set
 *    syncs a Stripe product+price; priced checkout (mocked Stripe)
 *    + signed webhook -> ACTIVE subscription; feature gates
 *    (featured / bump / analytics / storefront), plan photo caps
 *    (free 4, featured 8), grandfathered sellers unaffected;
 *    owner grant/revoke; webhook regressions (no-purpose and
 *    AD_PLAN events still answer 200 and change nothing here).
 *
 * Runs against a LOCAL test database only, Stripe fully mocked via
 * STRIPE_API_BASE. Usage:
 *   DATABASE_URL=postgresql://... TEST_PORT=4431 node test/pepper-lists-trust.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4431);
const MOCK_PORT = PORT + 1;
const B = `http://127.0.0.1:${PORT}/api/v1`;
const WEBHOOK_SECRET = 'whsec_pltrust_drill';
const PASSWORD = 'test-pass-1234';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const IDS = {
  sellerA: '20000000-0000-4000-8000-0000000000d1',
  sellerB: '20000000-0000-4000-8000-0000000000d2',
  buyerC: '20000000-0000-4000-8000-0000000000d3',
  otherD: '20000000-0000-4000-8000-0000000000d4',
  grandG: '20000000-0000-4000-8000-0000000000d5',
  rateR: '20000000-0000-4000-8000-0000000000d6',
  staff: '20000000-0000-4000-8000-0000000000d7',
  owner: '20000000-0000-4000-8000-0000000000d8',
};
const EMAILS = {
  sellerA: 'seller-a@trust.local', sellerB: 'seller-b@trust.local', buyerC: 'buyer-c@trust.local',
  otherD: 'other-d@trust.local', grandG: 'grand-g@trust.local', rateR: 'rate-r@trust.local',
  staff: 'staff@trust.local', owner: 'owner@trust.local',
};

// ---------- Mock Stripe ----------
const stripeCalls = [];
const PERIOD_END = Math.floor(Date.now() / 1000) + 30 * 86400;
const mockStripe = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const params = Object.fromEntries(new URLSearchParams(raw));
    stripeCalls.push({ method: req.method, path: req.url, params });
    res.setHeader('content-type', 'application/json');
    const send = (obj) => res.end(JSON.stringify(obj));
    if (req.method === 'POST' && req.url === '/v1/customers') return send({ id: 'cus_seller_1', email: params.email });
    if (req.method === 'POST' && req.url === '/v1/products') return send({ id: 'prod_seller_1', name: params.name });
    if (req.method === 'POST' && req.url === '/v1/prices') return send({ id: 'price_seller_1', unit_amount: Number(params.unit_amount) });
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') return send({ id: 'cs_seller_1', url: 'https://checkout.stripe.test/pay/cs_seller_1' });
    if (req.method === 'GET' && req.url === '/v1/subscriptions/sub_seller_1') {
      return send({ id: 'sub_seller_1', status: 'active', current_period_end: PERIOD_END, cancel_at_period_end: false, items: { data: [{ id: 'si_seller_1', price: { id: 'price_seller_1' } }] } });
    }
    if (req.method === 'POST' && req.url === '/v1/subscriptions/sub_seller_1') {
      return send({ id: 'sub_seller_1', status: 'active', current_period_end: PERIOD_END, cancel_at_period_end: params.cancel_at_period_end === 'true', items: { data: [{ id: 'si_seller_1', price: { id: 'price_seller_1' } }] } });
    }
    return send({ id: 'mock' });
  });
});
const callsTo = (method, path) => stripeCalls.filter((c) => c.method === method && c.path === path);

// ---------- Harness ----------
let passed = 0; let failed = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? '  ok ' : '  FAIL'} ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(label, cond, extra = '') {
  if (cond) passed += 1; else failed += 1;
  console.log(`${cond ? '  ok ' : '  FAIL'} ${label}${cond ? '' : ` ${extra}`}`);
}
async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${B}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
async function login(email) {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (r.status !== 200 || !r.json?.token) throw new Error(`login failed for ${email}: ${r.status} ${r.text}`);
  return r.json.token;
}
function signWebhook(payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { payload, header: `t=${t},v1=${v1}` };
}
async function postWebhook(payloadObj) {
  const { payload, header } = signWebhook(payloadObj);
  const res = await fetch(`${B}/payments/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
    body: payload,
  });
  return { status: res.status, text: await res.text() };
}

const prisma = new PrismaClient();
let server;

async function createListing(token, { title, priceCents = 45000, photos = 1 }) {
  const media = Array.from({ length: photos }, () => ({ kind: 'photo', mime: 'image/png', dataBase64: PNG }));
  const r = await api('/pepper-lists/listings', {
    method: 'POST', token,
    body: { title, category: 'Appliances', condition: 'Used - good', priceCents, phone: '9545550100', description: 'Drill listing — works as it should.', media },
  });
  return r;
}
async function mineId(token, reference) {
  const r = await api('/pepper-lists/listings/mine', { token });
  const row = (r.json?.data || []).find((l) => l.reference === reference);
  return row?.id || null;
}

try {
  await new Promise((resolve) => mockStripe.listen(MOCK_PORT, '127.0.0.1', resolve));

  // ---------- Seed ----------
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const passwordHash = await hashPassword(PASSWORD);
  const mk = (id, email, roles, extra = {}) => prisma.user.upsert({
    where: { id },
    update: { passwordHash, ...extra },
    create: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, phone: '9545550100', roles, active: true, verifyRequired: false, layer2Required: false, ...extra },
  });
  await mk(IDS.sellerA, EMAILS.sellerA, ['CUSTOMER'], { firstName: 'Maria', lastName: 'Gonzalez', createdAt: new Date('2025-01-15T00:00:00Z') });
  await mk(IDS.sellerB, EMAILS.sellerB, ['CUSTOMER'], { firstName: 'Bob', lastName: 'Seller', createdAt: new Date('2026-11-20T06:00:00Z') });
  await mk(IDS.buyerC, EMAILS.buyerC, ['CUSTOMER'], { firstName: 'Carol', lastName: 'Buyer' });
  await mk(IDS.otherD, EMAILS.otherD, ['CUSTOMER'], { firstName: 'Dan', lastName: 'Other' });
  await mk(IDS.grandG, EMAILS.grandG, ['CUSTOMER'], { firstName: 'Gail', lastName: 'Grand', createdAt: new Date('2026-11-01T00:00:00Z') });
  await mk(IDS.rateR, EMAILS.rateR, ['CUSTOMER'], { firstName: 'Rita', lastName: 'Rapid' });
  await mk(IDS.staff, EMAILS.staff, ['COMPANY_ADMIN'], { firstName: 'Sue', lastName: 'Staff' });
  await mk(IDS.owner, EMAILS.owner, ['COMPANY_OWNER'], { firstName: 'Owen', lastName: 'Owner' });

  // ---------- Boot ----------
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env, PORT: String(PORT), JWT_SECRET: 'drill-secret-pltrust',
      DATABASE_URL: process.env.DATABASE_URL, DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
      STRIPE_SECRET_KEY: 'sk_test_mock', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    try { const r = await fetch(`${B}/payments/status`); up = r.status === 200; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!up) throw new Error('API did not come up');

  const tokA = await login(EMAILS.sellerA);
  const tokB = await login(EMAILS.sellerB);
  const tokC = await login(EMAILS.buyerC);
  const tokD = await login(EMAILS.otherD);
  const tokG = await login(EMAILS.grandG);
  const tokR = await login(EMAILS.rateR);
  const tokStaff = await login(EMAILS.staff);
  const tokOwner = await login(EMAILS.owner);

  // Seller A's trust facts are turned on AFTER login (Layer 2 is a
  // login-time gate; the badges read the live account facts).
  await prisma.user.update({ where: { id: IDS.sellerA }, data: { emailVerifiedAt: new Date('2025-02-01T00:00:00Z'), layer2Required: true } });

  console.log('\n[listings + trust badges]');
  const l1 = await createListing(tokA, { title: 'Washer — works great' });
  check('seller A listing created', l1.status, 201);
  const listingA = await mineId(tokA, l1.json.data.reference);
  checkTrue('listing A id resolved from /mine', Boolean(listingA));
  const l2 = await createListing(tokB, { title: 'Dryer — sold as-is' });
  check('seller B listing created', l2.status, 201);
  const listingB = await mineId(tokB, l2.json.data.reference);
  checkTrue('listing B id resolved', Boolean(listingB));

  const feed = await api('/pepper-lists/listings/public');
  check('feed status', feed.status, 200);
  const cardA = (feed.json.data || []).find((c) => c.id === listingA);
  checkTrue('feed contains listing A', Boolean(cardA));
  check('feed card price parsed from the record', cardA?.priceCents, 45000);
  check('feed card comment count starts at 0', cardA?.commentCount, 0);
  check('feed card not featured', cardA?.featured, false);

  const detailA1 = await api(`/pepper-lists/listings/public/${listingA}`);
  check('detail A: email verified badge fact', detailA1.json.data.seller.badges.emailVerified, true);
  check('detail A: 2-step badge fact', detailA1.json.data.seller.badges.twoStepOn, true);
  checkTrue('detail A: member since present', String(detailA1.json.data.seller.badges.memberSince || '').startsWith('2025-01-15'));
  check('detail A: sales count 0', detailA1.json.data.seller.salesCount, 0);
  check('detail A: zero reviews -> count 0', detailA1.json.data.sellerReviews.count, 0);
  check('detail A: zero reviews -> average null (no invented aggregate)', detailA1.json.data.sellerReviews.average, null);
  check('detail A: first public view counted', detailA1.json.data.viewCount, 1);
  const detailAown = await api(`/pepper-lists/listings/public/${listingA}`, { token: tokA });
  check('detail A: seller own view NOT counted', detailAown.json.data.viewCount, 1);
  const detailA2 = await api(`/pepper-lists/listings/public/${listingA}`);
  check('detail A: second public view counted', detailA2.json.data.viewCount, 2);

  const detailB = await api(`/pepper-lists/listings/public/${listingB}`);
  check('detail B: email verified badge absent (fact false)', detailB.json.data.seller.badges.emailVerified, false);
  check('detail B: 2-step badge absent (fact false)', detailB.json.data.seller.badges.twoStepOn, false);
  checkTrue('detail B: member since still real', String(detailB.json.data.seller.badges.memberSince || '').startsWith('2026-11-20'));
  checkTrue('detail never leaks seller email', !JSON.stringify(detailB.json).includes(EMAILS.sellerB));
  checkTrue('detail never leaks seller phone', !JSON.stringify(detailB.json).includes('9545550100'));

  console.log('\n[comments]');
  check('anon comment -> 401', (await api(`/pepper-lists/listings/${listingA}/comments`, { method: 'POST', body: { body: 'hi' } })).status, 401);
  const c1 = await api(`/pepper-lists/listings/${listingA}/comments`, { method: 'POST', token: tokC, body: { body: 'Is this still available?' } });
  check('buyer comment posted', c1.status, 201);
  check('buyer comment kind USER', c1.json.data.authorKind, 'USER');
  const c2 = await api(`/pepper-lists/listings/${listingA}/comments`, { method: 'POST', token: tokA, body: { body: 'Yes — pickup in Fort Lauderdale.' } });
  check('seller reply posted', c2.status, 201);
  check('seller reply kind SELLER', c2.json.data.authorKind, 'SELLER');
  const feed2 = await api('/pepper-lists/listings/public');
  check('feed comment count = 2', (feed2.json.data || []).find((c) => c.id === listingA)?.commentCount, 2);
  check('other user hide -> 403', (await api(`/pepper-lists/listings/${listingA}/comments/${c1.json.data.id}/hide`, { method: 'POST', token: tokD, body: {} })).status, 403);
  check('comment author (not owner) hide -> 403', (await api(`/pepper-lists/listings/${listingA}/comments/${c1.json.data.id}/hide`, { method: 'POST', token: tokC, body: {} })).status, 403);
  check('owner hide -> 200', (await api(`/pepper-lists/listings/${listingA}/comments/${c1.json.data.id}/hide`, { method: 'POST', token: tokA, body: {} })).status, 200);
  const afterHide = await api(`/pepper-lists/listings/public/${listingA}/comments`);
  check('visible comments after hide = 1', afterHide.json.data.length, 1);
  check('customer remove -> 403', (await api(`/pepper-lists/listings/${listingA}/comments/${c2.json.data.id}/remove`, { method: 'POST', token: tokC, body: {} })).status, 403);
  check('staff remove -> 200', (await api(`/pepper-lists/listings/${listingA}/comments/${c2.json.data.id}/remove`, { method: 'POST', token: tokStaff, body: {} })).status, 200);
  const afterRemove = await api(`/pepper-lists/listings/public/${listingA}/comments`);
  check('visible comments after staff remove = 0', afterRemove.json.data.length, 0);
  const feed3 = await api('/pepper-lists/listings/public');
  check('feed comment count back to 0', (feed3.json.data || []).find((c) => c.id === listingA)?.commentCount, 0);

  console.log('\n[reports]');
  check('anon report -> 401', (await api(`/pepper-lists/listings/${listingA}/report`, { method: 'POST', body: { reason: 'SCAM_OR_FRAUD' } })).status, 401);
  check('bad reason -> 400', (await api(`/pepper-lists/listings/${listingA}/report`, { method: 'POST', token: tokC, body: { reason: 'MEAN' } })).status, 400);
  const rep1 = await api(`/pepper-lists/listings/${listingA}/report`, { method: 'POST', token: tokC, body: { reason: 'SCAM_OR_FRAUD', details: 'Asked for a wire transfer.' } });
  check('report filed', rep1.status, 201);
  check('duplicate report -> 409', (await api(`/pepper-lists/listings/${listingA}/report`, { method: 'POST', token: tokC, body: { reason: 'OTHER' } })).status, 409);
  check('second reporter files', (await api(`/pepper-lists/listings/${listingA}/report`, { method: 'POST', token: tokD, body: { reason: 'INACCURATE_LISTING' } })).status, 201);
  check('customer staff-queue read -> 403', (await api('/pepper-lists/admin/listing-reports', { token: tokC })).status, 403);
  const queue = await api('/pepper-lists/admin/listing-reports?status=NEW', { token: tokStaff });
  check('staff queue has both reports', (queue.json.data || []).filter((r) => r.listingId === listingA).length, 2);
  checkTrue('queue rows carry the listing reference', (queue.json.data || []).every((r) => r.listingReference));
  const pepperLog = await prisma.pepperReport.count({ where: { title: { contains: l1.json.data.reference } } });
  check('report also landed in the Pepper Reports log', pepperLog, 2);
  const repRow = (queue.json.data || [])[0];
  check('staff marks report reviewed', (await api(`/pepper-lists/admin/listing-reports/${repRow.id}`, { method: 'PATCH', token: tokStaff, body: { status: 'REVIEWED' } })).status, 200);

  console.log('\n[sales -> seller reviews]');
  check('review before any sale -> 403', (await api(`/pepper-lists/sellers/${IDS.sellerA}/reviews`, { method: 'POST', token: tokC, body: { saleId: 'nope', rating: 5, title: 'Great', body: 'Great seller.' } })).status, 403);
  check('non-owner mark sold -> 403', (await api(`/pepper-lists/listings/${listingA}/sold`, { method: 'POST', token: tokD, body: {} })).status, 403);
  const sold = await api(`/pepper-lists/listings/${listingA}/sold`, { method: 'POST', token: tokA, body: { buyerEmail: EMAILS.buyerC } });
  check('owner marks sold', sold.status, 201);
  check('buyer matched to the sale', sold.json.data.buyerMatched, true);
  check('double-sold -> 409', (await api(`/pepper-lists/listings/${listingA}/sold`, { method: 'POST', token: tokA, body: {} })).status, 409);
  const feedSold = await api('/pepper-lists/listings/public');
  checkTrue('sold listing leaves the public feed', !(feedSold.json.data || []).some((c) => c.id === listingA));
  const reviewable = await api('/pepper-lists/sales/reviewable', { token: tokC });
  check('buyer sees 1 reviewable sale', (reviewable.json.data || []).length, 1);
  const saleId = reviewable.json.data[0].saleId;
  check('non-buyer review -> 403', (await api(`/pepper-lists/sellers/${IDS.sellerA}/reviews`, { method: 'POST', token: tokD, body: { saleId, rating: 5, title: 'Great', body: 'Great seller.' } })).status, 403);
  const rev1 = await api(`/pepper-lists/sellers/${IDS.sellerA}/reviews`, { method: 'POST', token: tokC, body: { saleId, rating: 5, title: 'Smooth deal', body: 'Washer exactly as described, easy pickup.' } });
  check('buyer review posted', rev1.status, 201);
  check('5-star review publishes immediately', rev1.json.data.status, 'PUBLISHED');
  check('second review of same sale -> 409', (await api(`/pepper-lists/sellers/${IDS.sellerA}/reviews`, { method: 'POST', token: tokC, body: { saleId, rating: 4, title: 'Again', body: 'Trying twice.' } })).status, 409);
  const sellerReviews1 = await api(`/pepper-lists/sellers/${IDS.sellerA}/reviews`);
  check('public seller reviews count = 1', sellerReviews1.json.aggregate.count, 1);
  check('public seller reviews average = 5', sellerReviews1.json.aggregate.average, 5);
  const detailSold = await api(`/pepper-lists/listings/public/${listingA}`);
  check('sold detail: sales count now 1', detailSold.json.data.seller.salesCount, 1);
  check('sold detail: seller reviews count 1', detailSold.json.data.sellerReviews.count, 1);

  const l3 = await createListing(tokA, { title: 'Fridge — cold and clean' });
  const listingA2 = await mineId(tokA, l3.json.data.reference);
  await api(`/pepper-lists/listings/${listingA2}/sold`, { method: 'POST', token: tokA, body: { buyerEmail: EMAILS.buyerC } });
  const reviewable2 = await api('/pepper-lists/sales/reviewable', { token: tokC });
  const sale2 = (reviewable2.json.data || [])[0];
  const rev2 = await api(`/pepper-lists/sellers/${IDS.sellerA}/reviews`, { method: 'POST', token: tokC, body: { saleId: sale2.saleId, rating: 2, title: 'Rough pickup', body: 'Item was fine but pickup was chaos.' } });
  check('low review held for the office', rev2.json.data.status, 'PENDING');
  const sellerReviews2 = await api(`/pepper-lists/sellers/${IDS.sellerA}/reviews`);
  check('pending review not public yet', sellerReviews2.json.aggregate.count, 1);
  const pendingQueue = await api('/pepper-lists/admin/seller-reviews?status=PENDING', { token: tokStaff });
  check('staff pending queue has the held review', (pendingQueue.json.data || []).length, 1);
  check('staff publishes held review', (await api(`/pepper-lists/admin/seller-reviews/${rev2.json.data.id}`, { method: 'PATCH', token: tokStaff, body: { status: 'PUBLISHED' } })).status, 200);
  const sellerReviews3 = await api(`/pepper-lists/sellers/${IDS.sellerA}/reviews`);
  check('aggregate count after publish = 2', sellerReviews3.json.aggregate.count, 2);
  check('aggregate average = (5+2)/2 = 3.5', sellerReviews3.json.aggregate.average, 3.5);

  console.log('\n[seller plans]');
  const plansAnon = await api('/pepper-lists/plans');
  check('anon plans -> 401', plansAnon.status, 401);
  const plansB = await api('/pepper-lists/plans', { token: tokB });
  check('catalog has 3 tiers', (plansB.json.data.plans || []).length, 3);
  check('new seller starts on free', plansB.json.data.access.planKey, 'free');
  check('new seller not grandfathered', plansB.json.data.access.grandfathered, false);
  checkTrue('unpriced plan shows no price', (plansB.json.data.plans || []).find((p) => p.key === 'featured')?.price === null);
  const plansG = await api('/pepper-lists/plans', { token: tokG });
  check('pre-launch seller is grandfathered', plansG.json.data.access.grandfathered, true);
  check('grandfathered seller keeps the free baseline plan', plansG.json.data.access.planKey, 'free');
  check('grandfathered baseline has no paid features (today\u2019s behavior)', plansG.json.data.access.features.featured, false);

  const callsBefore = stripeCalls.length;
  const unpriced = await api('/pepper-lists/plans/checkout', { method: 'POST', token: tokB, body: { planKey: 'featured' } });
  check('unpriced checkout -> 422', unpriced.status, 422);
  check('unpriced checkout code', unpriced.json.error, 'pricing_not_set');
  check('unpriced checkout made ZERO Stripe calls', stripeCalls.length, callsBefore);

  check('staff (non-owner) price set -> 403', (await api('/pepper-lists/admin/plans/featured/price', { method: 'POST', token: tokStaff, body: { amountCents: 1500, interval: 'month' } })).status, 403);
  const priced = await api('/pepper-lists/admin/plans/featured/price', { method: 'POST', token: tokOwner, body: { amountCents: 1500, interval: 'month' } });
  check('owner sets price', priced.status, 200);
  check('price stored on the plan', priced.json.data.price.amountCents, 1500);
  check('Stripe product created for the price', callsTo('POST', '/v1/products').length, 1);
  check('Stripe price created for the price', callsTo('POST', '/v1/prices').length, 1);

  const checkout = await api('/pepper-lists/plans/checkout', { method: 'POST', token: tokB, body: { planKey: 'featured' } });
  check('priced checkout -> 201', checkout.status, 201);
  checkTrue('checkout returns a Stripe URL', String(checkout.json.data.checkoutUrl || '').includes('checkout.stripe.test'));
  const sessionCall = callsTo('POST', '/v1/checkout/sessions')[0];
  check('checkout session carries SELLER_PLAN purpose', sessionCall?.params['metadata[purpose]'], 'SELLER_PLAN');

  const wh1 = await postWebhook({
    id: 'evt_seller_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_seller_1', customer: 'cus_seller_1', subscription: 'sub_seller_1', client_reference_id: IDS.sellerB, metadata: { purpose: 'SELLER_PLAN', userId: IDS.sellerB, planKey: 'featured' } } },
  });
  check('seller checkout webhook -> 200', wh1.status, 200);
  const plansB2 = await api('/pepper-lists/plans', { token: tokB });
  check('webhook activated the featured plan', plansB2.json.data.access.planKey, 'featured');
  check('subscription marked active', plansB2.json.data.access.hasActiveSubscription, true);

  console.log('\n[webhook regressions]');
  const whNoPurpose = await postWebhook({ id: 'evt_none', type: 'checkout.session.completed', data: { object: { id: 'cs_other', customer: 'cus_x', subscription: null, metadata: {} } } });
  check('no-purpose webhook still 200', whNoPurpose.status, 200);
  const whAdPlan = await postWebhook({ id: 'evt_ad', type: 'invoice.payment_failed', data: { object: { id: 'in_x', subscription: 'sub_unknown', metadata: { purpose: 'AD_PLAN' } } } });
  check('AD_PLAN webhook still 200', whAdPlan.status, 200);
  const plansB3 = await api('/pepper-lists/plans', { token: tokB });
  check('foreign webhooks changed nothing for the seller', plansB3.json.data.access.planKey, 'featured');

  console.log('\n[feature gates + photo caps]');
  check('free seller feature attempt -> 403', (await api(`/pepper-lists/listings/${listingB}/featured`, { method: 'POST', token: tokC, body: {} })).status, 403);
  check('free seller analytics -> 403', (await api('/pepper-lists/seller-analytics', { token: tokC })).status, 403);
  check('free seller bump -> 403 plan gate or ownership', [403, 404].includes((await api(`/pepper-lists/listings/${listingB}/bump`, { method: 'POST', token: tokC, body: {} })).status), true);
  // seller B owns listingB but is now on the featured plan — feature it for real:
  const featB = await api(`/pepper-lists/listings/${listingB}/featured`, { method: 'POST', token: tokB, body: {} });
  check('paid seller features own listing', featB.status, 200);
  const feedFeat = await api('/pepper-lists/listings/public');
  check('featured listing leads the feed', (feedFeat.json.data || [])[0]?.id, listingB);
  check('featured flag on the card', (feedFeat.json.data || [])[0]?.featured, true);
  const analyticsB = await api('/pepper-lists/seller-analytics', { token: tokB });
  check('featured tier has NO analytics (pro-only feature) -> 403', analyticsB.status, 403);
  check('analytics denial is the plan gate', analyticsB.json.error, 'plan_upgrade_required');
  const bumpB = await api(`/pepper-lists/listings/${listingB}/bump`, { method: 'POST', token: tokB, body: {} });
  check('paid seller bump -> 200', bumpB.status, 200);
  check('bump counted for the month', bumpB.json.data.bumpsUsedThisMonth, 1);

  const fiveFree = await createListing(tokC, { title: 'Couch — five photos', photos: 5 });
  check('free seller 5-photo listing refused', fiveFree.status, 400);
  check('photo refusal names the limit', fiveFree.json.error, 'photo_limit');
  check('photo refusal states the free cap', fiveFree.json.photoLimit, 4);
  const fivePaid = await createListing(tokB, { title: 'Patio set — five photos', photos: 5 });
  check('featured seller 5-photo listing accepted (cap 8)', fivePaid.status, 201);
  const listingB2 = await mineId(tokB, fivePaid.json.data.reference);

  const storeB = await api(`/pepper-lists/sellers/${IDS.sellerB}/public`);
  check('paid seller storefront -> 200', storeB.status, 200);
  checkTrue('storefront lists the seller listings', (storeB.json.data.listings || []).length >= 2);
  check('free seller storefront -> 403', (await api(`/pepper-lists/sellers/${IDS.buyerC}/public`)).status, 403);

  console.log('\n[grandfather + grant/revoke]');
  const lG = await createListing(tokG, { title: 'Grandfathered grill' });
  const listingG = await mineId(tokG, lG.json.data.reference);
  checkTrue('grandfathered listing created fine (baseline unchanged)', Boolean(listingG));
  check('grandfathered seller is NOT handed paid features', (await api(`/pepper-lists/listings/${listingG}/featured`, { method: 'POST', token: tokG, body: {} })).status, 403);
  check('grandfathered analytics stays gated', (await api('/pepper-lists/seller-analytics', { token: tokG })).status, 403);
  const gFive = await createListing(tokG, { title: 'Grandfathered five photos', photos: 5 });
  check('grandfathered photo cap is still today\u2019s 4', gFive.json.photoLimit, 4);
  const grant = await api('/pepper-lists/admin/seller-subscriptions/grant', { method: 'POST', token: tokOwner, body: { userId: IDS.otherD, planKey: 'pro' } });
  check('owner grants pro', grant.status, 201);
  const plansD = await api('/pepper-lists/plans', { token: tokD });
  check('granted seller resolves to pro', plansD.json.data.access.planKey, 'pro');
  const analyticsD = await api('/pepper-lists/seller-analytics', { token: tokD });
  check('pro seller analytics -> 200', analyticsD.status, 200);
  checkTrue('analytics totals are numbers', typeof analyticsD.json.data.totals.views === 'number');
  check('owner revokes', (await api('/pepper-lists/admin/seller-subscriptions/revoke', { method: 'POST', token: tokOwner, body: { userId: IDS.otherD } })).status, 200);
  const plansD2 = await api('/pepper-lists/plans', { token: tokD });
  check('revoked seller back on free', plansD2.json.data.access.planKey, 'free');

  console.log('\n[cancel at period end]');
  const cancel = await api('/pepper-lists/plans/cancel', { method: 'POST', token: tokB, body: {} });
  check('cancel -> 200', cancel.status, 200);
  check('Stripe cancel_at_period_end sent', callsTo('POST', '/v1/subscriptions/sub_seller_1').some((c) => c.params.cancel_at_period_end === 'true'), true);
  const whCancel = await postWebhook({
    id: 'evt_seller_2', type: 'customer.subscription.updated',
    data: { object: { id: 'sub_seller_1', status: 'active', cancel_at_period_end: true, current_period_end: PERIOD_END, metadata: { purpose: 'SELLER_PLAN', userId: IDS.sellerB, planKey: 'featured' }, items: { data: [{ price: { id: 'price_seller_1' } }] } } },
  });
  check('subscription.updated webhook -> 200', whCancel.status, 200);
  const plansB4 = await api('/pepper-lists/plans', { token: tokB });
  check('cancel-at-period-end recorded', plansB4.json.data.access.cancelAtPeriodEnd, true);
  check('features stay on until period end', plansB4.json.data.access.planKey, 'featured');

  console.log('\n[rate limit]');
  let lastStatus = 0;
  for (let i = 0; i < 31; i += 1) {
    const r = await api(`/pepper-lists/listings/${listingB2}/comments`, { method: 'POST', token: tokR, body: { body: `Question ${i + 1} about the patio set?` } });
    lastStatus = r.status;
    if (i < 30 && r.status !== 201) { check(`comment ${i + 1} within limit`, r.status, 201); break; }
  }
  check('31st comment in the hour -> 429', lastStatus, 429);
  const feedFinal = await api('/pepper-lists/listings/public');
  check('rate-limited listing shows exactly 30 comments', (feedFinal.json.data || []).find((c) => c.id === listingB2)?.commentCount, 30);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} finally {
  try { server?.kill('SIGTERM'); } catch { /* already down */ }
  mockStripe.close();
  await prisma.$disconnect();
}
