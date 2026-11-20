/**
 * New money rails — verification harness (2026-11-20, Wave 4).
 *
 * Boots the real API server against a scratch Postgres with Stripe
 * FULLY MOCKED (STRIPE_API_BASE points at a local stub that records
 * every call — no live Stripe traffic, no real money). Covers:
 *   C19 Pepper Lists protected payments (Stripe Connect):
 *     - feature ships OFF: buy + onboard refuse with
 *       protected_payments_coming while the owner flag is off
 *     - flag on but fee unset -> checkout refuses pricing_not_set
 *     - seller onboarding (account + account link via mock Stripe),
 *       status refresh flips the seller ACTIVE only when Stripe
 *       reports charges_enabled
 *     - buy: Connect checkout carries the owner-fee application fee
 *       + the seller transfer destination; webhook completes the
 *       order PAID; a sold listing refuses a second purchase
 *   F6 Gift cards:
 *     - no owner denominations -> purchase refuses pricing_not_set
 *     - purchase -> code shown once, card PENDING worth nothing
 *     - webhook activates: ISSUE ledger entry, exact balance
 *     - redeem partial -> capped partial -> depleted: ledger math
 *       exact at every step, balance never negative
 *     - full coverage writes the PAID diagnostic payment row
 *   Regression: the diagnostic webhook behavior is unchanged.
 *
 * Run:  node test/marketplace-payments.test.mjs
 * Env:  DATABASE_URL (a scratch DB, migrated) — see run-suite.sh.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

const PORT = 8911;
const MOCK_PORT = 8912;
const B = `http://127.0.0.1:${PORT}/api/v1`;
const WEBHOOK_SECRET = 'whsec_drill_marketplace';
const PASSWORD = 'DrillPass123!';

const IDS = {
  owner: 'e1111111-1111-4111-8111-111111111111',
  seller: 'e2222222-2222-4222-8222-222222222222',
  buyer: 'e3333333-3333-4333-8333-333333333333',
  stranger: 'e4444444-4444-4444-8444-444444444444',
  gcCustomer: 'e5555555-5555-4555-8555-555555555555',
  gcRequest: 'e6666666-6666-4666-8666-666666666666',
  diagCustomer: 'e7777777-7777-4777-8777-777777777777',
  diagRequest: 'e8888888-8888-4888-8888-888888888888',
  diagPayment: 'e9999999-9999-4999-8999-999999999999',
};
const EMAILS = {
  owner: 'owner@drill.local',
  seller: 'seller@drill.local',
  buyer: 'buyer@drill.local',
  stranger: 'stranger@drill.local',
};

// ---------- Mock Stripe ----------
const stripeCalls = [];
let mockChargesEnabled = false;
let sessionSeq = 0;
const mockStripe = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const params = Object.fromEntries(new URLSearchParams(raw));
    stripeCalls.push({ method: req.method, path: req.url, params });
    res.setHeader('content-type', 'application/json');
    const send = (obj) => res.end(JSON.stringify(obj));
    if (req.method === 'POST' && req.url === '/v1/accounts') return send({ id: 'acct_mock_seller' });
    if (req.method === 'POST' && req.url === '/v1/account_links') return send({ url: 'https://connect.stripe.test/onboard/acct_mock_seller' });
    if (req.method === 'GET' && req.url === '/v1/accounts/acct_mock_seller') {
      return send({ id: 'acct_mock_seller', charges_enabled: mockChargesEnabled, payouts_enabled: mockChargesEnabled, details_submitted: mockChargesEnabled });
    }
    if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
      sessionSeq += 1;
      const purpose = params['metadata[purpose]'] || 'UNKNOWN';
      const id = `cs_mock_${purpose.toLowerCase()}_${sessionSeq}`;
      return send({ id, url: `https://checkout.stripe.test/pay/${id}` });
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

const prisma = new PrismaClient();
let server;

try {
  await new Promise((resolve) => mockStripe.listen(MOCK_PORT, '127.0.0.1', resolve));

  // ---------- Seed ----------
  await prisma.user.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
  await prisma.company.upsert({ where: { id: PLATFORM_COMPANY_ID }, update: {}, create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'top-speed-appliance', type: 'PLATFORM_OWNER', isPlatformOwner: true } });
  const passwordHash = await hashPassword(PASSWORD);
  const mkUser = (id, email, roles) => prisma.user.create({
    data: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, roles, verifyRequired: false, layer2Required: false },
  });
  await mkUser(IDS.owner, EMAILS.owner, ['COMPANY_OWNER']);
  await mkUser(IDS.seller, EMAILS.seller, ['CUSTOMER']);
  await mkUser(IDS.buyer, EMAILS.buyer, ['CUSTOMER']);
  await mkUser(IDS.stranger, EMAILS.stranger, ['CUSTOMER']);

  // Gift-card redemption booking fixture (buyer's own booking).
  await prisma.serviceRequest.deleteMany({ where: { id: IDS.gcRequest } });
  await prisma.customer.deleteMany({ where: { id: IDS.gcCustomer } });
  await prisma.customer.create({
    data: { id: IDS.gcCustomer, companyId: PLATFORM_COMPANY_ID, name: 'Drill Buyer', phone: '9545550123', email: EMAILS.buyer, city: 'Fort Lauderdale', zip: '33301' },
  });
  await prisma.serviceRequest.create({
    data: { id: IDS.gcRequest, companyId: PLATFORM_COMPANY_ID, customerId: IDS.gcCustomer, city: 'Fort Lauderdale', zip: '33301', appliance: 'Dryer', issue: 'Not heating', referenceCode: 'TS-DRILL-GC' },
  });
  // Diagnostic webhook regression fixture.
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
      ...process.env, PORT: String(PORT), JWT_SECRET: 'drill-secret-marketplace',
      STRIPE_SECRET_KEY: 'sk_test_mock', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  let up = false;
  for (let i = 0; i < 160 && !up; i += 1) {
    try { const r = await fetch(`${B}/payments/status`); up = r.status === 200; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!up) throw new Error('API did not come up');

  const owner = await login(EMAILS.owner);
  const seller = await login(EMAILS.seller);
  const buyer = await login(EMAILS.buyer);
  const stranger = await login(EMAILS.stranger);

  // Seller creates a real listing through the real route.
  const listingRes = await api('/pepper-lists/listings', {
    method: 'POST', token: seller,
    body: { title: 'Samsung Refrigerator — stainless', category: 'Appliances', condition: 'Used - good', priceCents: 15000, phone: '9545550124', email: EMAILS.seller },
  });
  check('seller listing created -> 201', listingRes.status, 201);
  const listingRef = listingRes.json.data.reference;
  checkTrue('listing has a reference', Boolean(listingRef));

  console.log('\n[C19 — ships OFF]');
  const statusOff = await api('/pepper-lists/protected-payments/status');
  check('protected payments state COMING while off', statusOff.json.data.state, 'COMING');
  check('protected payments enabled=false while off', statusOff.json.data.enabled, false);
  const buyOff = await api(`/pepper-lists/listings/${listingRef}/buy`, { method: 'POST', token: buyer, body: {} });
  check('buy while OFF -> 503', buyOff.status, 503);
  check('buy while OFF -> protected_payments_coming', buyOff.json.error, 'protected_payments_coming');
  const onboardOff = await api('/pepper-lists/connect/onboard', { method: 'POST', token: seller, body: {} });
  check('onboard while OFF -> 503 protected_payments_coming', onboardOff.json.error, 'protected_payments_coming');
  check('no Stripe account created while OFF', callsTo('POST', '/v1/accounts').length, 0);
  check('no checkout session created while OFF', callsTo('POST', '/v1/checkout/sessions').length, 0);

  console.log('\n[F6 — sales disabled until the owner sets denominations]');
  const gcConfigOff = await api('/gift-cards/config');
  check('gift card salesEnabled=false at seed', gcConfigOff.json.data.salesEnabled, false);
  const purchaseOff = await api('/gift-cards/purchase', { method: 'POST', token: buyer, body: { denominationCents: 5000 } });
  check('gift purchase unpriced -> 422 pricing_not_set', purchaseOff.json.error, 'pricing_not_set');
  check('gift purchase unpriced -> HTTP 422', purchaseOff.status, 422);

  console.log('\n[owner settings]');
  const patchByBuyer = await api('/admin/payments/settings', { method: 'PATCH', token: buyer, body: { connectEnabled: true } });
  check('non-owner PATCH settings -> 403', patchByBuyer.status, 403);
  const anonSettings = await api('/admin/payments/settings');
  check('anon GET settings -> 401', anonSettings.status, 401);
  const setDenoms = await api('/admin/payments/settings', { method: 'PATCH', token: owner, body: { giftCardDenominationsCents: [9900, 2500, 5000, 5000] } });
  check('owner sets denominations -> 200', setDenoms.status, 200);
  check('denominations deduped + sorted', JSON.stringify(setDenoms.json.data.settings.giftCardDenominationsCents), JSON.stringify([2500, 5000, 9900]));
  const gcConfigOn = await api('/gift-cards/config');
  check('gift card salesEnabled=true after owner set', gcConfigOn.json.data.salesEnabled, true);
  const badDenom = await api('/gift-cards/purchase', { method: 'POST', token: buyer, body: { denominationCents: 1234 } });
  check('unlisted denomination -> 422 pricing_not_set', badDenom.json.error, 'pricing_not_set');

  console.log('\n[C19 — flag on, fee unset]');
  const setFlag = await api('/admin/payments/settings', { method: 'PATCH', token: owner, body: { connectEnabled: true } });
  check('owner enables Connect flag -> 200', setFlag.status, 200);
  check('fee still NULL', setFlag.json.data.settings.connectFeeBps, null);
  const buyNoFee = await api(`/pepper-lists/listings/${listingRef}/buy`, { method: 'POST', token: buyer, body: {} });
  check('buy with fee unset -> 422', buyNoFee.status, 422);
  check('buy with fee unset -> pricing_not_set', buyNoFee.json.error, 'pricing_not_set');
  check('no checkout session while fee unset', callsTo('POST', '/v1/checkout/sessions').length, 0);

  console.log('\n[C19 — seller onboarding]');
  const onboard = await api('/pepper-lists/connect/onboard', { method: 'POST', token: seller, body: {} });
  check('onboard -> 201 with hosted URL', onboard.status, 201);
  checkTrue('onboard URL is the mock account link', String(onboard.json.data.url).includes('connect.stripe.test'));
  check('Stripe account created once', callsTo('POST', '/v1/accounts').length, 1);
  check('account link created once', callsTo('POST', '/v1/account_links').length, 1);
  const statusNotActive = await api('/pepper-lists/connect/status', { token: seller });
  check('seller not ACTIVE while Stripe says charges disabled', statusNotActive.json.data.account.status, 'ONBOARDING');
  const setFee = await api('/admin/payments/settings', { method: 'PATCH', token: owner, body: { connectFeeBps: 1000 } });
  check('owner sets fee 1000 bps (10%) -> 200', setFee.status, 200);
  const buyNotReady = await api(`/pepper-lists/listings/${listingRef}/buy`, { method: 'POST', token: buyer, body: {} });
  check('buy before seller ACTIVE -> 422 seller_not_ready', buyNotReady.json.error, 'seller_not_ready');
  mockChargesEnabled = true;
  const statusActive = await api('/pepper-lists/connect/status', { token: seller });
  check('seller ACTIVE once Stripe reports charges enabled', statusActive.json.data.account.status, 'ACTIVE');
  check('seller chargesEnabled mirrored true', statusActive.json.data.account.chargesEnabled, true);

  console.log('\n[C19 — protected purchase]');
  const selfBuy = await api(`/pepper-lists/listings/${listingRef}/buy`, { method: 'POST', token: seller, body: {} });
  check('seller buying own listing -> 400', selfBuy.status, 400);
  const buy = await api(`/pepper-lists/listings/${listingRef}/buy`, { method: 'POST', token: buyer, body: {} });
  check('buy -> 201', buy.status, 201);
  const orderId = buy.json.data.orderId;
  const sessionCalls = callsTo('POST', '/v1/checkout/sessions');
  const orderSession = sessionCalls[sessionCalls.length - 1];
  check('checkout amount is the listing price', orderSession.params['line_items[0][price_data][unit_amount]'], '15000');
  check('application fee = 10% of price', orderSession.params['payment_intent_data[application_fee_amount]'], '1500');
  check('transfer destination is the seller account', orderSession.params['payment_intent_data[transfer_data][destination]'], 'acct_mock_seller');
  check('session purpose is PEPPER_LISTS_ORDER', orderSession.params['metadata[purpose]'], 'PEPPER_LISTS_ORDER');
  const orderRow = await prisma.pepperListsOrder.findUnique({ where: { id: orderId } });
  check('order PENDING before webhook', orderRow.status, 'PENDING');
  check('order feeCents = 1500', orderRow.feeCents, 1500);
  const buyAgain = await api(`/pepper-lists/listings/${listingRef}/buy`, { method: 'POST', token: buyer, body: {} });
  check('same buyer re-buy reuses the pending session', buyAgain.json.data.orderId, orderId);
  check('reuse flagged', buyAgain.json.data.reused, true);
  const whOrder = await postWebhook({ type: 'checkout.session.completed', data: { object: { id: orderRow.stripeSessionId, payment_intent: 'pi_mock_order', metadata: { purpose: 'PEPPER_LISTS_ORDER', orderId } } } });
  check('order webhook -> 200', whOrder.status, 200);
  const orderPaid = await prisma.pepperListsOrder.findUnique({ where: { id: orderId } });
  check('order PAID after webhook', orderPaid.status, 'PAID');
  checkTrue('order paidAt set', Boolean(orderPaid.paidAt));
  const buySold = await api(`/pepper-lists/listings/${listingRef}/buy`, { method: 'POST', token: stranger, body: {} });
  check('buying a sold listing -> 409 already_sold', buySold.json.error, 'already_sold');
  const mine = await api('/pepper-lists/orders/mine', { token: buyer });
  check('buyer sees 1 purchase', mine.json.data.asBuyer.length, 1);
  check('buyer purchase PAID', mine.json.data.asBuyer[0].status, 'PAID');
  const sellerMine = await api('/pepper-lists/orders/mine', { token: seller });
  check('seller sees 1 sale with fee', sellerMine.json.data.asSeller[0].feeCents, 1500);

  console.log('\n[F6 — purchase, activation, redemption ledger]');
  const purchase = await api('/gift-cards/purchase', { method: 'POST', token: buyer, body: { denominationCents: 5000, recipientEmail: EMAILS.buyer } });
  check('gift purchase -> 201', purchase.status, 201);
  checkTrue('code shape TSGC-…', /^TSGC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(purchase.json.data.code), purchase.json.data.code);
  const code1 = purchase.json.data.code;
  const card1 = await prisma.giftCard.findUnique({ where: { id: purchase.json.data.giftCardId } });
  check('card PENDING before webhook', card1.status, 'PENDING');
  check('card balance 0 before webhook', card1.balanceCents, 0);
  checkTrue('raw code is NOT stored (hash only)', !JSON.stringify(card1).includes(code1.replace(/-/g, '')) && card1.codeHash.length === 64);
  const redeemEarly = await api('/gift-cards/redeem', { method: 'POST', token: buyer, body: { code: code1, bookingReference: 'TS-DRILL-GC' } });
  check('redeem before activation -> 409 gift_card_not_active', redeemEarly.json.error, 'gift_card_not_active');
  const whGift = await postWebhook({ type: 'checkout.session.completed', data: { object: { id: card1.stripeSessionId, payment_intent: 'pi_mock_gift', metadata: { purpose: 'GIFT_CARD', giftCardId: card1.id } } } });
  check('gift webhook -> 200', whGift.status, 200);
  const card1Active = await prisma.giftCard.findUnique({ where: { id: card1.id } });
  check('card ACTIVE after webhook', card1Active.status, 'ACTIVE');
  check('card balance = 5000 after ISSUE', card1Active.balanceCents, 5000);
  let ledger = await prisma.giftCardLedgerEntry.findMany({ where: { giftCardId: card1.id }, orderBy: { createdAt: 'asc' } });
  check('ledger has exactly the ISSUE entry', ledger.length, 1);
  check('ISSUE entry +5000 -> 5000', `${ledger[0].kind}:${ledger[0].amountCents}:${ledger[0].balanceAfterCents}`, 'ISSUE:5000:5000');
  const balance1 = await api('/gift-cards/balance', { method: 'POST', token: buyer, body: { code: code1 } });
  check('balance endpoint reports 5000', balance1.json.data.balanceCents, 5000);

  const redeem1 = await api('/gift-cards/redeem', { method: 'POST', token: buyer, body: { code: code1, bookingReference: 'TS-DRILL-GC', amountCents: 3000 } });
  check('redeem 3000 -> 200', redeem1.status, 200);
  check('applied 3000', redeem1.json.data.appliedCents, 3000);
  check('remaining due 6900', redeem1.json.data.remainingDueCents, 6900);
  check('card balance 2000', redeem1.json.data.giftCard.balanceCents, 2000);
  check('diagnostic not yet paid', redeem1.json.data.diagnosticPaid, false);

  const strangerRedeem = await api('/gift-cards/redeem', { method: 'POST', token: stranger, body: { code: code1, bookingReference: 'TS-DRILL-GC', amountCents: 100 } });
  check('stranger redeeming buyer booking -> 403', strangerRedeem.status, 403);

  const redeem2 = await api('/gift-cards/redeem', { method: 'POST', token: buyer, body: { code: code1, bookingReference: 'TS-DRILL-GC', amountCents: 2500 } });
  check('redeem request 2500 capped at balance 2000', redeem2.json.data.appliedCents, 2000);
  check('card DEPLETED at zero', redeem2.json.data.giftCard.status, 'DEPLETED');
  check('remaining due 4900', redeem2.json.data.remainingDueCents, 4900);
  ledger = await prisma.giftCardLedgerEntry.findMany({ where: { giftCardId: card1.id }, orderBy: { createdAt: 'asc' } });
  check('ledger entries: ISSUE + 2 REDEEM', ledger.length, 3);
  check('ledger math exact', ledger.map((e) => e.balanceAfterCents).join(','), '5000,2000,0');
  check('ledger sum = final balance', ledger.reduce((s, e) => s + e.amountCents, 0), 0);
  const redeemDepleted = await api('/gift-cards/redeem', { method: 'POST', token: buyer, body: { code: code1, bookingReference: 'TS-DRILL-GC' } });
  check('redeem depleted card -> 409', redeemDepleted.status, 409);

  const purchase2 = await api('/gift-cards/purchase', { method: 'POST', token: buyer, body: { denominationCents: 9900 } });
  const code2 = purchase2.json.data.code;
  const card2 = await prisma.giftCard.findUnique({ where: { id: purchase2.json.data.giftCardId } });
  await postWebhook({ type: 'checkout.session.completed', data: { object: { id: card2.stripeSessionId, payment_intent: 'pi_mock_gift2', metadata: { purpose: 'GIFT_CARD', giftCardId: card2.id } } } });
  const redeem3 = await api('/gift-cards/redeem', { method: 'POST', token: buyer, body: { code: code2, bookingReference: 'TS-DRILL-GC' } });
  check('second card applies only the outstanding 4900', redeem3.json.data.appliedCents, 4900);
  check('remaining due 0', redeem3.json.data.remainingDueCents, 0);
  check('diagnosticPaid true at full coverage', redeem3.json.data.diagnosticPaid, true);
  check('card2 keeps the unspent 5000', redeem3.json.data.giftCard.balanceCents, 5000);
  const paidRows = await prisma.payment.findMany({ where: { serviceRequestId: IDS.gcRequest, status: 'PAID' } });
  check('exactly one PAID payment row for the booking', paidRows.length, 1);
  check('PAID row carries the gift-funded 9900', paidRows[0].amountCents, 9900);
  const redeemPaid = await api('/gift-cards/redeem', { method: 'POST', token: buyer, body: { code: code2, bookingReference: 'TS-DRILL-GC' } });
  check('redeem against a paid booking -> 409 already_paid', redeemPaid.json.error, 'already_paid');
  const myCards = await api('/gift-cards/mine', { token: buyer });
  check('buyer sees both cards', myCards.json.data.giftCards.length, 2);
  checkTrue('mine never exposes a full code', !JSON.stringify(myCards.json).includes('TSGC-'));

  console.log('\n[webhook expiry paths]');
  const expOrder = await prisma.pepperListsOrder.create({
    data: { companyId: PLATFORM_COMPANY_ID, listingConnectionId: orderRow.listingConnectionId, listingReference: 'TS-EXPIRY', sellerUserId: IDS.seller, buyerUserId: IDS.buyer, amountCents: 1000, feeCents: 100, stripeSessionId: 'cs_mock_expiry_order' },
  });
  await postWebhook({ type: 'checkout.session.expired', data: { object: { id: 'cs_mock_expiry_order', metadata: { purpose: 'PEPPER_LISTS_ORDER', orderId: expOrder.id } } } });
  const expOrderAfter = await prisma.pepperListsOrder.findUnique({ where: { id: expOrder.id } });
  check('expired session -> order EXPIRED', expOrderAfter.status, 'EXPIRED');
  const expCard = await prisma.giftCard.create({
    data: { companyId: PLATFORM_COMPANY_ID, codeHash: 'drill-expiry-hash', codeLast4: 'XXXX', initialAmountCents: 2500, stripeSessionId: 'cs_mock_expiry_gift' },
  });
  await postWebhook({ type: 'checkout.session.expired', data: { object: { id: 'cs_mock_expiry_gift', metadata: { purpose: 'GIFT_CARD', giftCardId: expCard.id } } } });
  const expCardAfter = await prisma.giftCard.findUnique({ where: { id: expCard.id } });
  check('expired session -> gift card VOID', expCardAfter.status, 'VOID');

  console.log('\n[diagnostic regression]');
  const whDiag = await postWebhook({ type: 'checkout.session.completed', data: { object: { id: 'cs_diag_drill', payment_intent: 'pi_diag_drill', metadata: { purpose: 'DIAGNOSTIC' } } } });
  check('diagnostic webhook -> 200', whDiag.status, 200);
  const diagPayment = await prisma.payment.findUnique({ where: { id: IDS.diagPayment } });
  check('diagnostic payment PAID (unchanged behavior)', diagPayment.status, 'PAID');
  const payStatus = await api('/payments/status');
  check('payments/status still reports the $99 diagnostic', payStatus.json.data.diagnosticAmountCents, 9900);

  console.log(`\n== marketplace-payments drill: ${passed} passed, ${failed} failed ==`);
  if (failed > 0) process.exitCode = 1;
} finally {
  if (server) server.kill('SIGTERM');
  mockStripe.close();
  await prisma.$disconnect();
}
