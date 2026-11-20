/**
 * Recurring commercial revenue — verification harness (2026-11-20).
 *
 * Boots the real API server against a scratch Postgres with Stripe
 * FULLY MOCKED (STRIPE_API_BASE points at a local stub that records
 * every call — no live Stripe traffic). Covers the three approved
 * builds:
 *   B4 Care Plan — catalog seeds UNPRICED; unpriced checkout refuses
 *      422 pricing_not_set with ZERO Stripe calls; owner price-set
 *      syncs an ANNUAL Stripe price; checkout -> webhook activation;
 *      member bookings carry the priority flag in the setter queue;
 *      the included check-up books once per period at $0; cancel at
 *      period end; payment_failed -> PAST_DUE -> GRACE -> SUSPENDED
 *      (time travel) and priority stops; office grant + revoke.
 *   B7 Maintenance agreements — cadence generates commercial work
 *      orders for every due period (time travel), PAUSED generates
 *      none, generation is idempotent.
 *   B8 Commercial quotes — totals computed server-side (a wrong
 *      client-sent total is ignored); approve-by-link converts to a
 *      work order with identical totals + line items; single
 *      decision; decline path; bogus token 400; staff gates.
 *
 * Run:  node test/care-commercial.test.mjs
 * Env:  DRILL_DATABASE_URL (a migrated scratch database)
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

const DB_URL = process.env.DRILL_DATABASE_URL;
if (!DB_URL) throw new Error('DRILL_DATABASE_URL is required (point it at a migrated scratch database)');
process.env.DATABASE_URL = DB_URL;
process.env.DATABASE_URL_UNPOOLED = DB_URL;

const PORT = 8906;
const MOCK_PORT = 8907;
const B = `http://127.0.0.1:${PORT}/api/v1`;
const WEBHOOK_SECRET = 'whsec_drill_care';
const PASSWORD = 'DrillPass123!';

const IDS = {
  owner: 'e1111111-1111-4111-8111-111111111111',
  staff: 'e2222222-2222-4222-8222-222222222222',
  member: 'e3333333-3333-4333-8333-333333333333',
  member2: 'e4444444-4444-4444-8444-444444444444',
  plain: 'e5555555-5555-4555-8555-555555555555',
};
const EMAILS = Object.fromEntries(Object.entries(IDS).map(([k]) => [k, `${k}@drill.local`]));

// ---------- Mock Stripe ----------
const stripeCalls = [];
const PERIOD_START = Math.floor(Date.now() / 1000) - 86400;
const PERIOD_END = Math.floor(Date.now() / 1000) + 364 * 86400;
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
    if (req.method === 'GET' && req.url === '/v1/subscriptions/sub_mock_1') return send({ id: 'sub_mock_1', status: 'active', current_period_start: PERIOD_START, current_period_end: PERIOD_END, cancel_at_period_end: false });
    if (req.method === 'POST' && req.url === '/v1/subscriptions/sub_mock_1') return send({ id: 'sub_mock_1', status: 'active', current_period_start: PERIOD_START, current_period_end: PERIOD_END, cancel_at_period_end: params.cancel_at_period_end === 'true' });
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
async function postWebhook(payloadObj) {
  const { payload, header } = signWebhook(payloadObj);
  const res = await fetch(`${B}/payments/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
    body: payload,
  });
  return { status: res.status, text: await res.text() };
}
async function login(email) {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (r.status !== 200 || !r.json?.token) throw new Error(`login failed for ${email}: ${r.status} ${r.text}`);
  return r.json.token;
}
async function queueEntry(token, referenceCode) {
  const r = await api('/bookos/setter-queue', { token });
  const queue = r.json?.data?.queue || [];
  return queue.find((q) => q.referenceCode === referenceCode) || null;
}

const prisma = new PrismaClient();
let server;

try {
  await new Promise((resolve) => mockStripe.listen(MOCK_PORT, '127.0.0.1', resolve));

  // ---------- Seed ----------
  await prisma.careSubscription.deleteMany({});
  await prisma.carePlan.deleteMany({});
  await prisma.careBillingSetting.deleteMany({});
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
  await prisma.company.upsert({ where: { id: PLATFORM_COMPANY_ID }, update: {}, create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'top-speed-appliance', type: 'PLATFORM_OWNER', isPlatformOwner: true } });
  const passwordHash = await hashPassword(PASSWORD);
  const mkUser = (id, email, roles) => prisma.user.create({
    data: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, roles, verifyRequired: false, layer2Required: false },
  });
  await mkUser(IDS.owner, EMAILS.owner, ['COMPANY_OWNER']);
  await mkUser(IDS.staff, EMAILS.staff, ['DISPATCHER']);
  await mkUser(IDS.member, EMAILS.member, ['CUSTOMER']);
  await mkUser(IDS.member2, EMAILS.member2, ['CUSTOMER']);
  await mkUser(IDS.plain, EMAILS.plain, ['CUSTOMER']);

  // ---------- Boot ----------
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env, PORT: String(PORT), JWT_SECRET: 'drill-secret-care',
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

  const owner = await login(EMAILS.owner);
  const staff = await login(EMAILS.staff);
  const member = await login(EMAILS.member);
  const member2 = await login(EMAILS.member2);

  // =====================================================================
  console.log('\n[B4 catalog + unpriced checkout]');
  check('anon GET /care/plans -> 401', (await api('/care/plans')).status, 401);
  const catalog = await api('/care/plans', { token: member });
  check('member GET /care/plans -> 200', catalog.status, 200);
  check('one care plan tier seeded', catalog.json.data.plans.length, 1);
  check('seeded price is NULL (owner-set only)', catalog.json.data.plans[0].annualPriceCents, null);
  check('non-member access status NONE', catalog.json.data.access.effectiveStatus, 'NONE');

  const unpriced = await api('/care/plans/checkout', { method: 'POST', token: member, body: { planKey: 'care-plan' } });
  check('unpriced checkout -> 422', unpriced.status, 422);
  check('unpriced checkout error is pricing_not_set', unpriced.json.error, 'pricing_not_set');
  check('ZERO Stripe calls of any kind for unpriced checkout', stripeCalls.length, 0);

  // =====================================================================
  console.log('\n[B4 owner price-set + Stripe sync]');
  const staffPrice = await api('/admin/care-plans/care-plan/price', { method: 'POST', token: staff, body: { annualPriceCents: 25000 } });
  check('staff (non-owner) price-set -> 403', staffPrice.status, 403);
  const priced = await api('/admin/care-plans/care-plan/price', { method: 'POST', token: owner, body: { annualPriceCents: 25000 } });
  check('owner price-set -> 200', priced.status, 200);
  check('price stored from the owner amount', priced.json.data.annualPriceCents, 25000);
  const priceCalls = callsTo('POST', '/v1/prices');
  check('exactly one Stripe price created', priceCalls.length, 1);
  check('Stripe price unit_amount is the owner amount', priceCalls[0]?.params.unit_amount, '25000');
  check('Stripe price bills ANNUALLY', priceCalls[0]?.params['recurring[interval]'], 'year');
  const productCalls = callsTo('POST', '/v1/products');
  check('Stripe product purpose is CARE_PLAN', productCalls[0]?.params['metadata[purpose]'], 'CARE_PLAN');

  // =====================================================================
  console.log('\n[B4 checkout + webhook activation]');
  const checkout = await api('/care/plans/checkout', { method: 'POST', token: member, body: { planKey: 'care-plan' } });
  check('priced checkout -> 201', checkout.status, 201);
  checkTrue('checkout returns a Stripe URL', String(checkout.json.data.url || '').includes('checkout.stripe.test'));
  const sessionCalls = callsTo('POST', '/v1/checkout/sessions');
  check('checkout session mode is subscription', sessionCalls[0]?.params.mode, 'subscription');
  check('checkout session purpose is CARE_PLAN', sessionCalls[0]?.params['metadata[purpose]'], 'CARE_PLAN');

  const wh = await postWebhook({
    id: 'evt_care_checkout', type: 'checkout.session.completed',
    data: { object: { id: 'cs_mock_1', mode: 'subscription', subscription: 'sub_mock_1', customer: 'cus_mock_1', metadata: { purpose: 'CARE_PLAN', userId: IDS.member, planKey: 'care-plan' } } },
  });
  check('care checkout webhook -> 200', wh.status, 200);
  const active = await api('/care/plans', { token: member });
  check('member status ACTIVE after webhook', active.json.data.access.status, 'ACTIVE');
  check('member effectiveStatus ACTIVE', active.json.data.access.effectiveStatus, 'ACTIVE');
  checkTrue('period end recorded from Stripe', Boolean(active.json.data.access.currentPeriodEnd));
  check('check-up available for the period', active.json.data.access.checkupAvailable, true);

  // =====================================================================
  console.log('\n[B4 priority booking flag]');
  const memberBooking = await api('/speedy/book', {
    method: 'POST',
    body: { customer: { name: 'Care Member', phone: '9545550111', email: EMAILS.member }, city: 'Fort Lauderdale', zip: '33301', appliance: 'Refrigerator', issue: 'Not cooling' },
  });
  checkTrue('member web-form booking accepted', memberBooking.status === 200 || memberBooking.status === 201, `status ${memberBooking.status}: ${memberBooking.text}`);
  const memberRef = memberBooking.json?.data?.referenceCode;
  const memberEntry = await queueEntry(staff, memberRef);
  checkTrue('member booking is in the setter queue', Boolean(memberEntry));
  check('member booking carries priority=true (setters see it)', memberEntry?.priority, true);

  const plainBooking = await api('/speedy/book', {
    method: 'POST',
    body: { customer: { name: 'Plain Customer', phone: '9545550121', email: EMAILS.plain }, city: 'Fort Lauderdale', zip: '33301', appliance: 'Washer', issue: 'Leaking' },
  });
  const plainRef = plainBooking.json?.data?.referenceCode;
  const plainEntry = await queueEntry(staff, plainRef);
  checkTrue('non-member booking is in the setter queue', Boolean(plainEntry));
  check('non-member booking has NO priority flag', plainEntry?.priority || false, false);

  // =====================================================================
  console.log('\n[B4 included check-up]');
  const checkup = await api('/care/checkup/book', { method: 'POST', token: member, body: { city: 'Fort Lauderdale', zip: '33301', address: '1200 NE 1st Ave' } });
  check('check-up booking -> 201', checkup.status, 201);
  check('check-up diagnostic fee is 0 (included)', checkup.json.data.diagnosticFee, 0);
  checkTrue('check-up returns a booking reference', Boolean(checkup.json.data.referenceCode));
  const checkup2 = await api('/care/checkup/book', { method: 'POST', token: member, body: { city: 'Fort Lauderdale', zip: '33301', address: '1200 NE 1st Ave' } });
  check('second check-up in the same period -> 422', checkup2.status, 422);
  check('second check-up error', checkup2.json.error, 'checkup_already_booked');
  const afterCheckup = await api('/care/plans', { token: member });
  check('check-up no longer available this period', afterCheckup.json.data.access.checkupAvailable, false);
  check('check-up booking ref recorded on the membership', afterCheckup.json.data.access.checkupBookingRef, checkup.json.data.referenceCode);

  // =====================================================================
  console.log('\n[B4 cancel at period end]');
  const cancel = await api('/care/plans/cancel', { method: 'POST', token: member, body: {} });
  check('cancel -> 200', cancel.status, 200);
  check('cancel action is cancel_at_period_end', cancel.json.data.action, 'cancel_at_period_end');
  const subUpdates = callsTo('POST', '/v1/subscriptions/sub_mock_1');
  check('Stripe subscription set to cancel at period end', subUpdates[subUpdates.length - 1]?.params.cancel_at_period_end, 'true');
  const afterCancel = await api('/care/plans', { token: member });
  check('membership records cancelAtPeriodEnd', afterCancel.json.data.access.cancelAtPeriodEnd, true);

  // =====================================================================
  console.log('\n[B4 payment failure -> grace -> suspended]');
  const failWh = await postWebhook({
    id: 'evt_care_fail', type: 'invoice.payment_failed',
    data: { object: { id: 'in_mock_1', subscription: 'sub_mock_1', customer: 'cus_mock_1' } },
  });
  check('payment_failed webhook -> 200', failWh.status, 200);
  const pastDue = await api('/care/plans', { token: member });
  check('status PAST_DUE after failed payment', pastDue.json.data.access.status, 'PAST_DUE');
  check('effective status GRACE inside the window', pastDue.json.data.access.effectiveStatus, 'GRACE');
  await prisma.careSubscription.update({ where: { userId: IDS.member }, data: { pastDueAt: new Date(Date.now() - 30 * 86400000) } });
  const suspended = await api('/care/plans', { token: member });
  check('effective status SUSPENDED after grace (time travel)', suspended.json.data.access.effectiveStatus, 'SUSPENDED');
  const suspBooking = await api('/speedy/book', {
    method: 'POST',
    body: { customer: { name: 'Care Member', phone: '9545550111', email: EMAILS.member }, city: 'Fort Lauderdale', zip: '33301', appliance: 'Dryer', issue: 'Not heating' },
  });
  const suspEntry = await queueEntry(staff, suspBooking.json?.data?.referenceCode);
  check('suspended member booking has NO priority flag', suspEntry?.priority || false, false);

  // =====================================================================
  console.log('\n[B4 office grant]');
  const grant = await api(`/admin/care-plans/subscriptions/${IDS.member2}/grant`, { method: 'POST', token: owner, body: { planKey: 'care-plan' } });
  check('owner grant -> 200', grant.status, 200);
  const granted = await api('/care/plans', { token: member2 });
  check('granted member status OFFICE_GRANTED', granted.json.data.access.status, 'OFFICE_GRANTED');
  check('granted member check-up available', granted.json.data.access.checkupAvailable, true);
  const grantCheckup = await api('/care/checkup/book', { method: 'POST', token: member2, body: { city: 'Fort Lauderdale', zip: '33301', address: '55 Grant Way' } });
  check('granted member check-up books -> 201', grantCheckup.status, 201);
  const revoke = await api(`/admin/care-plans/subscriptions/${IDS.member2}/revoke`, { method: 'POST', token: owner, body: {} });
  check('owner revoke grant -> 200', revoke.status, 200);
  const afterRevoke = await api('/care/plans', { token: member2 });
  check('after revoke the membership is NONE', afterRevoke.json.data.access.effectiveStatus, 'NONE');

  // =====================================================================
  console.log('\n[B7 maintenance agreements]');
  const account = await api('/commercial/accounts', {
    method: 'POST', token: staff,
    body: { companyName: 'Drill Hotel Group', contactName: 'Pat Manager', email: 'pm@drillhotel.local', phone: '9545550130', accountType: 'HOTEL', priorityTier: 'STANDARD' },
  });
  check('commercial account created -> 201', account.status, 201);
  const accountId = account.json.data.id;
  const facility = await api(`/commercial/accounts/${accountId}/facilities`, {
    method: 'POST', token: staff,
    body: { accountId, name: 'Main Hotel', address: '900 Ocean Dr', city: 'Fort Lauderdale', zip: '33301' },
  });
  check('facility created -> 201', facility.status, 201);
  const facilityId = facility.json.data.id;

  const custAgreement = await api('/commercial/agreements', { method: 'POST', token: member, body: { accountId, facilityId, cadence: 'MONTHLY' } });
  check('customer token cannot create agreements -> 403', custAgreement.status, 403);

  const seventyFiveDaysAgo = new Date(Date.now() - 75 * 86400000).toISOString();
  const agreement = await api('/commercial/agreements', {
    method: 'POST', token: staff,
    body: { accountId, facilityId, cadence: 'MONTHLY', firstVisitAt: seventyFiveDaysAgo, scopeNotes: 'Lobby HVAC filters + kitchen line', termsNotes: 'Net 30 per signed contract on file' },
  });
  check('agreement created -> 201', agreement.status, 201);
  checkTrue('agreement reference is TS-MA', String(agreement.json.data.referenceCode || '').startsWith('TS-MA'));
  check('agreement terms stored as office data', agreement.json.data.termsNotes, 'Net 30 per signed contract on file');
  const agreementId = agreement.json.data.id;

  const list1 = await api('/commercial/agreements', { token: staff });
  const mine = (list1.json.data || []).find((a) => a.id === agreementId);
  check('reading agreements generated the 3 due visits', mine?.visitsGenerated, 3);
  checkTrue('next visit advanced into the future', new Date(mine.nextVisitAt).getTime() > Date.now());
  const wos1 = await api(`/commercial/work-orders?accountId=${accountId}`, { token: staff });
  const agreementWos = (wos1.json.data || []).filter((w) => w.agreementId === agreementId);
  check('3 agreement work orders exist', agreementWos.length, 3);
  checkTrue('agreement work orders link bookings', agreementWos.every((w) => Boolean(w.bookingReferenceCode)));

  const genRun = await api('/commercial/agreements/generate-due', { method: 'POST', token: staff, body: {} });
  check('second generation run creates nothing new (idempotent)', genRun.json.data.workOrdersCreated, 0);

  const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString();
  const paused = await api('/commercial/agreements', {
    method: 'POST', token: staff,
    body: { accountId, facilityId, cadence: 'MONTHLY', firstVisitAt: fortyDaysAgo },
  });
  const pausedId = paused.json.data.id;
  const pausePatch = await api(`/commercial/agreements/${pausedId}`, { method: 'PATCH', token: staff, body: { status: 'PAUSED' } });
  check('agreement pause -> 200', pausePatch.status, 200);
  const list2 = await api('/commercial/agreements', { token: staff });
  const pausedRow = (list2.json.data || []).find((a) => a.id === pausedId);
  check('PAUSED agreement generated no visits', pausedRow?.visitsGenerated, 0);

  // =====================================================================
  console.log('\n[B8 commercial quotes + approve-by-link]');
  const custQuote = await api('/commercial/quotes', { method: 'POST', token: member, body: { accountId, facilityId, title: 'Nope', lineItems: [{ description: 'X part', quantity: 1, unitPriceCents: 100 }] } });
  check('customer token cannot create quotes -> 403', custQuote.status, 403);

  const validUntil = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const quote = await api('/commercial/quotes', {
    method: 'POST', token: staff,
    body: {
      accountId, facilityId, title: 'Walk-in cooler compressor replacement',
      lineItems: [
        { description: 'Compressor, supplied + installed', quantity: 1, unitPriceCents: 145000 },
        { description: 'Refrigerant recharge', quantity: 2, unitPriceCents: 11000 },
      ],
      totalCents: 1, // wrong on purpose — the server must ignore it
      termsNotes: 'Payment due on completion per signed agreement.',
      validUntil,
    },
  });
  check('quote created -> 201', quote.status, 201);
  check('quote total is the SERVER sum, not the client total', quote.json.data.totalCents, 167000);
  check('line total computed server-side', quote.json.data.lineItems[1].totalCents, 22000);
  check('quote starts DRAFT', quote.json.data.status, 'DRAFT');
  const quoteId = quote.json.data.id;

  const send = await api(`/commercial/quotes/${quoteId}/send`, { method: 'POST', token: staff, body: {} });
  check('quote send -> 200', send.status, 200);
  const approvalUrl = send.json.data.approvalUrl || '';
  checkTrue('send returns an approval URL with a token', approvalUrl.includes('/quote/?token='));
  const quoteToken = new URL(approvalUrl).searchParams.get('token');

  const view = await api(`/commercial/quotes/approval/${quoteToken}`);
  check('public approval view -> 200 (no auth)', view.status, 200);
  check('public view total matches', view.json.data.totalCents, 167000);
  check('public view shows the company', view.json.data.companyName, 'Drill Hotel Group');
  check('public view status SENT', view.json.data.status, 'SENT');
  check('bogus token view -> 400', (await api('/commercial/quotes/approval/definitely-not-a-token')).status, 400);
  check('bogus token decide -> 400', (await api('/commercial/quotes/approval/definitely-not-a-token/decide', { method: 'POST', body: { decision: 'APPROVED' } })).status, 400);

  const woCountBefore = (await api(`/commercial/work-orders?accountId=${accountId}`, { token: staff })).json.data.length;
  const decide = await api(`/commercial/quotes/approval/${quoteToken}/decide`, { method: 'POST', body: { decision: 'APPROVED', name: 'Pat Manager' } });
  check('approve by link -> 200', decide.status, 200);
  check('quote status APPROVED', decide.json.data.status, 'APPROVED');
  checkTrue('approval returns the work order reference', String(decide.json.data.workOrder?.referenceCode || '').startsWith('TS-W'));
  const wos2 = await api(`/commercial/work-orders?accountId=${accountId}`, { token: staff });
  check('approval created exactly one work order', wos2.json.data.length, woCountBefore + 1);
  const quoteWo = (wos2.json.data || []).find((w) => w.quoteId === quoteId);
  checkTrue('quote work order found', Boolean(quoteWo));
  check('work order total is IDENTICAL to the quote total', quoteWo?.quoteTotalCents, 167000);
  check('work order line items are IDENTICAL to the quote', JSON.stringify(quoteWo?.quoteLineItems), JSON.stringify(quote.json.data.lineItems));
  const decideAgain = await api(`/commercial/quotes/approval/${quoteToken}/decide`, { method: 'POST', body: { decision: 'DECLINED' } });
  check('second decision -> 409 already decided', decideAgain.status, 409);

  const quote2 = await api('/commercial/quotes', {
    method: 'POST', token: staff,
    body: { accountId, facilityId, title: 'Ice machine descaling', lineItems: [{ description: 'Descale + sanitize', quantity: 1, unitPriceCents: 18000 }] },
  });
  const send2 = await api(`/commercial/quotes/${quote2.json.data.id}/send`, { method: 'POST', token: staff, body: {} });
  const token2 = new URL(send2.json.data.approvalUrl).searchParams.get('token');
  const decline = await api(`/commercial/quotes/approval/${token2}/decide`, { method: 'POST', body: { decision: 'DECLINED' } });
  check('decline by link -> 200', decline.status, 200);
  check('quote 2 status DECLINED', decline.json.data.status, 'DECLINED');
  const wos3 = await api(`/commercial/work-orders?accountId=${accountId}`, { token: staff });
  check('decline created NO work order', wos3.json.data.length, woCountBefore + 1);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
} finally {
  if (server) server.kill('SIGTERM');
  mockStripe.close();
  await prisma.$disconnect();
}
