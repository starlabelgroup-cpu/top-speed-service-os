/**
 * Flywheel Advertiser Plans — verification harness.
 *
 * Boots the real API server against a scratch Postgres with Stripe FULLY
 * MOCKED (STRIPE_API_BASE points at a local stub that records every call —
 * no live Stripe traffic, no real amounts leave this file). Covers:
 *   - plan catalog seeding with prices UNSET (owner-configured only)
 *   - owner price-set flow (mock asserts Stripe sync used the owner's amount)
 *   - checkout for a priced plan + refusal for an unpriced plan
 *   - webhook transitions: checkout.session.completed -> ACTIVE,
 *     invoice.payment_failed -> PAST_DUE -> GRACE -> SUSPENDED (time travel),
 *     customer.subscription.deleted -> NONE
 *   - diagnostic-payment webhook behavior UNCHANGED
 *   - gating matrix: NONE advertiser blocked with an upgrade message,
 *     grandfathered advertiser unaffected, office-granted plans + campaign
 *     caps, owner/staff bypass, grant/revoke
 *
 * Run:  node test/flywheel-plans.test.mjs
 * Env:  DRILL_DATABASE_URL (default local plans cluster on :5443)
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

const DB_URL = process.env.DRILL_DATABASE_URL || 'postgresql://postgres@localhost:5443/postgres';
process.env.DATABASE_URL = DB_URL;
process.env.DATABASE_URL_UNPOOLED = DB_URL;

const PORT = 8896;
const MOCK_PORT = 8897;
const B = `http://127.0.0.1:${PORT}/api/v1`;
const WEBHOOK_SECRET = 'whsec_drill_secret';
const PASSWORD = 'DrillPass123!';

const IDS = {
  owner: 'd1111111-1111-4111-8111-111111111111',
  advNew: 'd2222222-2222-4222-8222-222222222222',
  advOld: 'd3333333-3333-4333-8333-333333333333',
  advGrant: 'd4444444-4444-4444-8444-444444444444',
  advNone: 'd5555555-5555-4555-8555-555555555555',
  custDiag: 'd6666666-6666-4666-8666-666666666666',
  diagCustomer: 'd9999999-9999-4999-8999-999999999999',
  diagRequest: 'd7777777-7777-4777-8777-777777777777',
  diagPayment: 'd8888888-8888-4888-8888-888888888888',
};
const EMAILS = Object.fromEntries(Object.entries(IDS).slice(0, 6).map(([k]) => [k, `${k.toLowerCase()}@drill.local`]));

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
    if (req.method === 'POST' && req.url === '/v1/customers') return send({ id: 'cus_mock_1', email: params.email });
    if (req.method === 'POST' && req.url === '/v1/products') return send({ id: 'prod_mock_1', name: params.name });
    if (req.method === 'POST' && req.url === '/v1/prices') return send({ id: 'price_mock_1', unit_amount: Number(params.unit_amount) });
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') return send({ id: 'cs_mock_1', url: 'https://checkout.stripe.test/pay/cs_mock_1' });
    if (req.method === 'GET' && req.url === '/v1/subscriptions/sub_mock_1') return send({ id: 'sub_mock_1', status: 'active', current_period_end: PERIOD_END, cancel_at_period_end: false });
    if (req.method === 'POST' && req.url === '/v1/subscriptions/sub_mock_1') return send({ id: 'sub_mock_1', status: 'active', current_period_end: PERIOD_END, cancel_at_period_end: params.cancel_at_period_end === 'true' });
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
function signWebhook(payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  return { payload, header: `t=${t},v1=${v1}` };
}
async function postWebhook(payloadObj, headerOverride) {
  const { payload, header } = signWebhook(payloadObj);
  const res = await fetch(`${B}/payments/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': headerOverride || header },
    body: payload,
  });
  return { status: res.status, text: await res.text() };
}
async function login(email) {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (r.status !== 200 || !r.json?.token) throw new Error(`login failed for ${email}: ${r.status} ${r.text}`);
  return r.json.token;
}
const campaignBody = (name) => ({ name, advertiserName: 'Drill Biz', offering: 'Appliance repair services', headline: `${name} headline`, copy: 'Drill campaign body copy.', ctaText: 'Book Service', destinationUrl: '/book' });

const prisma = new PrismaClient();
let server;

try {
  await new Promise((resolve) => mockStripe.listen(MOCK_PORT, '127.0.0.1', resolve));

  // ---------- Seed ----------
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
  // Plan state persists across runs by design (it is production data) —
  // reset it so the drill always starts from the shipped defaults:
  // three tiers, prices UNSET, grace 7 days, no campaigns.
  await prisma.advertiserSubscription.deleteMany({});
  await prisma.adPlan.deleteMany({});
  await prisma.adBillingSetting.deleteMany({});
  await prisma.adCampaign.deleteMany({ where: { createdById: { in: Object.values(IDS) } } });
  await prisma.company.upsert({ where: { id: PLATFORM_COMPANY_ID }, update: {}, create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'top-speed-appliance', type: 'PLATFORM_OWNER', isPlatformOwner: true } });
  const passwordHash = await hashPassword(PASSWORD);
  const mkUser = (id, email, roles, createdAt) => prisma.user.create({
    data: {
      id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, roles,
      verifyRequired: false, layer2Required: false, createdAt,
    },
  });
  const NOW = new Date();
  const LONG_AGO = new Date('2026-01-15T00:00:00.000Z'); // before the plans launch cutoff
  await mkUser(IDS.owner, EMAILS.owner, ['COMPANY_OWNER'], NOW);
  await mkUser(IDS.advNew, EMAILS.advNew, ['ADVERTISER'], NOW);
  await mkUser(IDS.advOld, EMAILS.advOld, ['ADVERTISER'], LONG_AGO);
  await mkUser(IDS.advGrant, EMAILS.advGrant, ['ADVERTISER'], NOW);
  await mkUser(IDS.advNone, EMAILS.advNone, ['ADVERTISER'], NOW);
  await mkUser(IDS.custDiag, EMAILS.custDiag, ['CUSTOMER'], NOW);
  // Diagnostic payment fixture (webhook regression check)
  await prisma.serviceRequest.deleteMany({ where: { id: IDS.diagRequest } });
  await prisma.customer.deleteMany({ where: { id: IDS.diagCustomer } });
  await prisma.customer.create({
    data: { id: IDS.diagCustomer, companyId: PLATFORM_COMPANY_ID, name: 'Drill Diagnostic', phone: '9545550199', city: 'Fort Lauderdale', zip: '33301' },
  });
  await prisma.serviceRequest.create({
    data: { id: IDS.diagRequest, companyId: PLATFORM_COMPANY_ID, customerId: IDS.diagCustomer, city: 'Fort Lauderdale', zip: '33301', appliance: 'Refrigerator', issue: 'Not cooling', referenceCode: 'TS-DRILL-DIAG' },
  });
  await prisma.payment.create({
    data: { id: IDS.diagPayment, companyId: PLATFORM_COMPANY_ID, serviceRequestId: IDS.diagRequest, amountCents: 9900, status: 'PENDING', stripeSessionId: 'cs_diag_drill' },
  });

  // ---------- Boot ----------
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env, PORT: String(PORT), JWT_SECRET: 'drill-secret-plans',
      DATABASE_URL: DB_URL, DATABASE_URL_UNPOOLED: DB_URL,
      STRIPE_SECRET_KEY: 'sk_test_mock', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
      APP_BASE: `http://127.0.0.1:${PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    try { const r = await fetch(`${B}/payments/status`); up = r.status === 200; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!up) throw new Error('API did not come up');

  console.log('\n[auth + catalog]');
  check('anon GET /advertiser/plans -> 401', (await api('/advertiser/plans')).status, 401);
  check('anon GET /ad-studio/plans -> 401', (await api('/ad-studio/plans')).status, 401);
  check('anon GET /ad-studio/subscriptions -> 401', (await api('/ad-studio/subscriptions')).status, 401);
  const owner = await login(EMAILS.owner);
  const advNew = await login(EMAILS.advNew);
  const advOld = await login(EMAILS.advOld);
  const advGrant = await login(EMAILS.advGrant);
  const advNone = await login(EMAILS.advNone);

  const adminPlans = await api('/ad-studio/plans', { token: owner });
  check('owner GET /ad-studio/plans -> 200', adminPlans.status, 200);
  check('three tiers seeded', adminPlans.json.data.plans.length, 3);
  checkTrue('all prices UNSET at seed', adminPlans.json.data.plans.every((p) => p.monthlyPriceCents === null));
  check('default grace days = 7', adminPlans.json.data.settings.graceDays, 7);
  checkTrue('tier keys starter/growth/pro', ['starter', 'growth', 'pro'].every((k) => adminPlans.json.data.plans.some((p) => p.key === k)));

  console.log('\n[effective access]');
  const newAccess = await api('/advertiser/plans', { token: advNew });
  check('new advertiser status NONE', newAccess.json.data.access.status, 'NONE');
  check('new advertiser campaigns feature off (read-only)', newAccess.json.data.access.features.campaigns, false);
  check('new advertiser streaming feature off', newAccess.json.data.access.features.streaming, false);
  checkTrue('new advertiser read-only', newAccess.json.data.access.readOnly === true);
  const oldAccess = await api('/advertiser/plans', { token: advOld });
  check('pre-launch advertiser GRANDFATHERED', oldAccess.json.data.access.status, 'GRANDFATHERED');
  checkTrue('grandfathered NOT read-only', oldAccess.json.data.access.readOnly === false);
  const ownerAccess = await api('/advertiser/plans', { token: owner });
  checkTrue('owner bypass (staff, all features)', ownerAccess.json.data.access.bypass === true && ownerAccess.json.data.access.features.streaming === true);

  console.log('\n[gating matrix]');
  const blocked = await api('/ad-studio/my-campaigns', { method: 'POST', token: advNone, body: campaignBody('Blocked') });
  check('NONE advertiser campaign create -> 403', blocked.status, 403);
  check('denial code plan_upgrade_required', blocked.json.error, 'plan_upgrade_required');
  checkTrue('denial carries a clear upgrade message', typeof blocked.json.message === 'string' && /plan/i.test(blocked.json.message), blocked.text);
  check('NONE advertiser can still VIEW own campaigns', (await api('/ad-studio/my-campaigns', { token: advNone })).status, 200);
  check('grandfathered advertiser creates campaign', (await api('/ad-studio/my-campaigns', { method: 'POST', token: advOld, body: campaignBody('Grandfathered') })).status, 201);

  console.log('\n[checkout refusal — unpriced plan]');
  const refusal = await api('/advertiser/plans/checkout', { method: 'POST', token: advNew, body: { planKey: 'starter' } });
  check('unpriced checkout -> 422', refusal.status, 422);
  check('refusal code pricing_not_set', refusal.json.error, 'pricing_not_set');
  check('no Stripe checkout session was created', callsTo('POST', '/v1/checkout/sessions').length, 0);

  console.log('\n[owner price-set — Stripe sync uses the owner amount only]');
  const priceGrowth = await api('/ad-studio/plans/growth/price', { method: 'POST', token: owner, body: { monthlyPriceCents: 4900 } });
  check('owner sets Growth price -> 200', priceGrowth.status, 200);
  check('Growth price stored', priceGrowth.json.data.monthlyPriceCents, 4900);
  check('Stripe product created once', callsTo('POST', '/v1/products').length, 1);
  const priceCall = callsTo('POST', '/v1/prices')[0];
  checkTrue('Stripe price created with the OWNER amount 4900', priceCall && priceCall.params.unit_amount === '4900', JSON.stringify(priceCall));
  check('plan carries the synced stripePriceId', priceGrowth.json.data.stripePriceId, 'price_mock_1');
  const priceStarter = await api('/ad-studio/plans/starter/price', { method: 'POST', token: owner, body: { monthlyPriceCents: 1900 } });
  check('owner sets Starter price -> 200', priceStarter.status, 200);
  check('advertiser cannot set prices -> 403', (await api('/ad-studio/plans/growth/price', { method: 'POST', token: advNew, body: { monthlyPriceCents: 100 } })).status, 403);

  console.log('\n[checkout — priced plan, mocked Stripe]');
  const checkout = await api('/advertiser/plans/checkout', { method: 'POST', token: advNew, body: { planKey: 'growth' } });
  check('priced checkout -> 201', checkout.status, 201);
  checkTrue('checkout URL returned', typeof checkout.json.data.url === 'string' && checkout.json.data.url.includes('cs_mock_1'));
  const customerCall = callsTo('POST', '/v1/customers')[0];
  checkTrue('Stripe customer created for the advertiser email', !!customerCall && customerCall.params.email === EMAILS.advNew, JSON.stringify(customerCall));
  const sessionCall = callsTo('POST', '/v1/checkout/sessions')[0];
  check('checkout mode = subscription', sessionCall.params.mode, 'subscription');
  check('checkout line item = synced price', sessionCall.params['line_items[0][price]'], 'price_mock_1');
  check('checkout metadata purpose = AD_PLAN', sessionCall.params['metadata[purpose]'], 'AD_PLAN');
  check('checkout client_reference_id = advertiser', sessionCall.params.client_reference_id, IDS.advNew);

  console.log('\n[webhook — plan activation]');
  const wh1 = await postWebhook({ id: 'evt_drill_1', type: 'checkout.session.completed', data: { object: { id: 'cs_mock_1', metadata: { purpose: 'AD_PLAN', userId: IDS.advNew, planKey: 'growth' }, customer: 'cus_mock_1', subscription: 'sub_mock_1' } } });
  check('plan webhook accepted -> 200', wh1.status, 200);
  const activeAccess = await api('/advertiser/plans', { token: advNew });
  check('advertiser now ACTIVE', activeAccess.json.data.access.status, 'ACTIVE');
  check('active plan = growth', activeAccess.json.data.access.planKey, 'growth');
  checkTrue('period end recorded from Stripe', !!activeAccess.json.data.access.currentPeriodEnd);
  check('ACTIVE advertiser creates campaign', (await api('/ad-studio/my-campaigns', { method: 'POST', token: advNew, body: campaignBody('Paid Growth') })).status, 201);

  console.log('\n[office grant + campaign caps]');
  const grant1 = await api(`/ad-studio/subscriptions/${IDS.advGrant}/grant`, { method: 'POST', token: owner, body: { planKey: 'starter' } });
  check('owner grants Starter -> 200', grant1.status, 200);
  check('grant state OFFICE_GRANTED', grant1.json.data.status, 'OFFICE_GRANTED');
  for (let i = 1; i <= 3; i += 1) {
    check(`granted Starter campaign ${i}/3 -> 201`, (await api('/ad-studio/my-campaigns', { method: 'POST', token: advGrant, body: campaignBody(`Starter ${i}`) })).status, 201);
  }
  const capped = await api('/ad-studio/my-campaigns', { method: 'POST', token: advGrant, body: campaignBody('Starter 4') });
  check('4th campaign over Starter cap -> 403', capped.status, 403);
  check('cap denial code plan_limit_reached', capped.json.error, 'plan_limit_reached');
  const grant2 = await api(`/ad-studio/subscriptions/${IDS.advGrant}/grant`, { method: 'POST', token: owner, body: { planKey: 'pro' } });
  check('owner re-grants Pro -> 200', grant2.status, 200);
  check('Pro grant lifts the cap', (await api('/ad-studio/my-campaigns', { method: 'POST', token: advGrant, body: campaignBody('Pro 4') })).status, 201);
  const subsView = await api('/ad-studio/subscriptions', { token: owner });
  const grantRow = subsView.json.data.subscriptions.find((s) => s.userId === IDS.advGrant);
  checkTrue('subscriptions view shows the grant', !!grantRow && grantRow.status === 'OFFICE_GRANTED' && grantRow.planKey === 'pro', JSON.stringify(grantRow));

  console.log('\n[grace-days setting]');
  check('owner sets graceDays 3', (await api('/ad-studio/plans/settings', { method: 'PATCH', token: owner, body: { graceDays: 3 } })).json.data.graceDays, 3);
  check('graceDays persists', (await api('/ad-studio/plans', { token: owner })).json.data.settings.graceDays, 3);
  await api('/ad-studio/plans/settings', { method: 'PATCH', token: owner, body: { graceDays: 7 } });

  console.log('\n[downgrade + cancel]');
  const downgrade = await api('/advertiser/plans/change', { method: 'POST', token: advNew, body: { planKey: 'starter' } });
  check('downgrade -> scheduled', downgrade.json.data.action, 'scheduled');
  check('pending plan recorded', (await api('/advertiser/plans', { token: advNew })).json.data.access.pendingPlanKey, 'starter');
  const cancel = await api('/advertiser/plans/cancel', { method: 'POST', token: advNew });
  check('cancel -> 200', cancel.status, 200);
  const cancelCall = callsTo('POST', '/v1/subscriptions/sub_mock_1').slice(-1)[0];
  checkTrue('Stripe cancel_at_period_end set', !!cancelCall && cancelCall.params.cancel_at_period_end === 'true', JSON.stringify(cancelCall));
  checkTrue('access shows cancelAtPeriodEnd', (await api('/advertiser/plans', { token: advNew })).json.data.access.cancelAtPeriodEnd === true);

  console.log('\n[webhook — past due, grace, suspension, deletion]');
  const wh2 = await postWebhook({ id: 'evt_drill_2', type: 'invoice.payment_failed', data: { object: { customer: 'cus_mock_1', subscription: 'sub_mock_1' } } });
  check('payment_failed webhook -> 200', wh2.status, 200);
  const graceAccess = await api('/advertiser/plans', { token: advNew });
  check('within grace window -> GRACE', graceAccess.json.data.access.effectiveStatus, 'GRACE');
  checkTrue('grace keeps create access', graceAccess.json.data.access.readOnly === false);
  await prisma.advertiserSubscription.update({ where: { userId: IDS.advNew }, data: { pastDueAt: new Date(Date.now() - 10 * 86400 * 1000) } });
  const suspAccess = await api('/advertiser/plans', { token: advNew });
  check('past grace window -> SUSPENDED', suspAccess.json.data.access.effectiveStatus, 'SUSPENDED');
  checkTrue('suspended is read-only', suspAccess.json.data.access.readOnly === true);
  check('suspended campaign create -> 403', (await api('/ad-studio/my-campaigns', { method: 'POST', token: advNew, body: campaignBody('Suspended') })).status, 403);
  const wh3 = await postWebhook({ id: 'evt_drill_3', type: 'customer.subscription.deleted', data: { object: { id: 'sub_mock_1', customer: 'cus_mock_1' } } });
  check('subscription.deleted webhook -> 200', wh3.status, 200);
  check('after deletion -> NONE', (await api('/advertiser/plans', { token: advNew })).json.data.access.status, 'NONE');

  console.log('\n[revoke]');
  const revoke = await api(`/ad-studio/subscriptions/${IDS.advGrant}/revoke`, { method: 'POST', token: owner });
  check('owner revokes grant -> 200', revoke.status, 200);
  check('revoked new advertiser -> NONE', revoke.json.data.status, 'NONE');
  check('revoked advertiser create -> 403', (await api('/ad-studio/my-campaigns', { method: 'POST', token: advGrant, body: campaignBody('Revoked') })).status, 403);

  console.log('\n[diagnostic webhook — unchanged]');
  const whDiag = await postWebhook({ id: 'evt_drill_diag', type: 'checkout.session.completed', data: { object: { id: 'cs_diag_drill', payment_status: 'paid', amount_total: 9900 } } });
  check('diagnostic webhook -> 200', whDiag.status, 200);
  const payment = await prisma.payment.findUnique({ where: { id: IDS.diagPayment } });
  check('diagnostic payment marked PAID', payment.status, 'PAID');
  checkTrue('diagnostic paidAt set', !!payment.paidAt);
  const whBad = await postWebhook({ id: 'evt_drill_bad', type: 'checkout.session.completed', data: { object: { id: 'cs_diag_drill' } } }, 't=1,v1=deadbeef');
  check('bad signature -> 400', whBad.status, 400);

  console.log(`\nflywheel-plans drill: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} finally {
  if (server) server.kill('SIGTERM');
  mockStripe.close();
  await prisma.$disconnect();
}
