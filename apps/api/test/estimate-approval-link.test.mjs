/**
 * Estimate approval link drills (2026-11-20, Wave 1 D3) — the
 * customer estimate approval page Ramone approved from the
 * recommendations list.
 *
 * Everything is local: the API boots against DATABASE_URL (a fresh
 * drill Postgres), Resend / Twilio are stubbed on a localhost HTTP
 * server (Twilio as a FULL account, so SMS sends land SENT).
 *
 * The chain under test, end to end:
 *  - the Link Center gains an ESTIMATE type (catalog, ref required);
 *    staff sends are gated (anon 401 / customer 403); a booking with
 *    no saved estimate answers an honest 409 — never a link to an
 *    empty page;
 *  - the emailed link opens GET /estimate-approval with the estimate
 *    EXACTLY as saved (line items + total, residential diagnostic
 *    credit and commercial no-$99 cases both asserted against the
 *    server money view);
 *  - APPROVE lands through the shared recorder: the ESTIMATE_APPROVED
 *    history event carries the SAME field shape as an in-person
 *    decision recorded through Book OS (key sets compared), the
 *    money view reads it, the platform feed shows it sourced
 *    ESTIMATE_LINK, and the existing invoice gate accepts it;
 *  - DECLINE records the reason as the event note;
 *  - one decision per link: a second decide answers with the
 *    recorded outcome and writes nothing new;
 *  - token discipline: SHA-256 hash at rest, a new estimate
 *    supersedes the old link (state + decide refused), re-sending
 *    supersedes at issue, an expired link shows EXPIRED and refuses
 *    the decision, wrong ref/token pairs answer one generic 404.
 *
 * Requires DATABASE_URL (the suite seeds and cleans its own rows).
 * Run: DATABASE_URL=postgresql://... node test/estimate-approval-link.test.mjs
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { hashPassword } from '../src/services/passwords.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required for the estimate approval link drills');
  process.exit(2);
}

const PORT = Number(process.env.TEST_PORT || 4491);
const STUB_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'Est-Link-Drill-123!';
const IDS = {
  staff: 'd3000000-0000-4000-8000-000000000001',
  customerUser: 'd3000000-0000-4000-8000-000000000002',
  customer: 'd3000000-0000-4000-8000-000000000003',
  bookingA: 'd3000000-0000-4000-8000-00000000000a',
  bookingB: 'd3000000-0000-4000-8000-00000000000b',
  bookingD: 'd3000000-0000-4000-8000-00000000000d',
  bookingE: 'd3000000-0000-4000-8000-00000000000e',
  bookingF: 'd3000000-0000-4000-8000-00000000000f',
};
const EMAILS = { staff: 'estlink-staff@test.local', customer: 'estlink-customer@test.local' };
const RECIPIENT = 'estlink-recipient@example.com';
const REFS = { A: 'TS-ESTA01', B: 'TS-ESTB01', D: 'TS-ESTD01', E: 'TS-ESTE01', F: 'TS-ESTF01' };

const prisma = new PrismaClient();
let server = null;
let stub = null;
let failures = 0;
const emailCaptures = [];
const smsCaptures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) {
  const ok = Boolean(value);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(value)})`);
}
function checkIncludes(label, haystack, needle) {
  const ok = typeof haystack === 'string' && haystack.includes(needle);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (want text containing ${JSON.stringify(needle)})`);
}

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
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

async function login(email) {
  const { status, json } = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

function startStub() {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/emails') {
        try { emailCaptures.push(JSON.parse(raw || '{}')); } catch { emailCaptures.push({}); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'resend-estlink' }));
        return;
      }
      if (req.method === 'GET' && req.url.includes('/2010-04-01/Accounts/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sid: 'ACestlink', type: 'Full', status: 'active' }));
        return;
      }
      if (req.method === 'POST' && req.url.includes('/Messages.json')) {
        try { smsCaptures.push(JSON.parse(raw || '{}')); } catch { smsCaptures.push({}); }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sid: 'SMestlink', status: 'queued' }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'stub: unhandled ' + req.method + ' ' + req.url }));
    });
  });
  return new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up');
}

function bootServer() {
  const childEnv = { ...process.env, PORT: String(PORT) };
  childEnv['JWT_' + 'SECRET'] = 'estlink-drill-secret';
  childEnv['RESEND_' + 'API_KEY'] = 'drill-resend-key';
  childEnv['RESEND_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;
  childEnv['EMAIL_' + 'FROM'] = 'Top Speed Appliance <service@topspeedappliance.net>';
  childEnv['TWILIO_' + 'ACCOUNT_SID'] = 'ACestlink';
  childEnv['TWILIO_' + 'AUTH_TOKEN'] = 'drill-twilio-token';
  childEnv['TWILIO_' + 'PHONE_NUMBER'] = '+18445550100';
  childEnv['TWILIO_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;
  delete childEnv['STRIPE_' + 'SECRET_KEY'];
  delete childEnv['SENDGRID_' + 'API_KEY'];
  delete childEnv['VONAGE_' + 'API_KEY'];
  delete childEnv['VONAGE_' + 'API_SECRET'];
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return waitForServer();
}

async function stopServer() {
  if (!server) return;
  const stopped = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([stopped, new Promise((r) => setTimeout(r, 5000))]);
  server = null;
}

async function seedBooking(id, ref, appliance) {
  await prisma.serviceRequest.upsert({
    where: { id },
    update: { referenceCode: ref },
    create: {
      id, companyId: PLATFORM_COMPANY_ID, customerId: IDS.customer,
      city: 'Fort Lauderdale', zip: '33301', appliance, issue: 'Not cooling',
      referenceCode: ref, source: 'estlink-drill',
    },
  });
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.user.upsert({
    where: { id: IDS.staff },
    update: { passwordHash },
    create: { id: IDS.staff, companyId: PLATFORM_COMPANY_ID, email: EMAILS.staff, firstName: 'Est', lastName: 'Staff', passwordHash, roles: ['DISPATCHER'], active: true },
  });
  await prisma.user.upsert({
    where: { id: IDS.customerUser },
    update: { passwordHash },
    create: { id: IDS.customerUser, companyId: PLATFORM_COMPANY_ID, email: EMAILS.customer, firstName: 'Maria', lastName: 'Diaz', passwordHash, roles: ['CUSTOMER'], active: true },
  });
  await prisma.customer.upsert({
    where: { id: IDS.customer },
    update: {},
    create: { id: IDS.customer, companyId: PLATFORM_COMPANY_ID, userId: IDS.customerUser, name: 'Maria Diaz', phone: '9545550123', email: EMAILS.customer, city: 'Fort Lauderdale', zip: '33301' },
  });
  await seedBooking(IDS.bookingA, REFS.A, 'Refrigerator');
  await seedBooking(IDS.bookingB, REFS.B, 'Washer');
  await seedBooking(IDS.bookingD, REFS.D, 'Dryer');
  await seedBooking(IDS.bookingE, REFS.E, 'Dishwasher');
  await seedBooking(IDS.bookingF, REFS.F, 'Oven');
}

async function cleanup() {
  const bookingIds = [IDS.bookingA, IDS.bookingB, IDS.bookingD, IDS.bookingE, IDS.bookingF];
  await prisma.estimateApprovalToken.deleteMany({ where: { bookingId: { in: bookingIds } } }).catch(() => {});
  await prisma.notificationOutbox.deleteMany({ where: { eventType: 'LINK_CENTER' } }).catch(() => {});
  await prisma.serviceRequest.deleteMany({ where: { id: { in: bookingIds } } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { id: IDS.customer } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: [IDS.staff, IDS.customerUser] } } }).catch(() => {});
}

function tokenFromUrl(url) {
  const parsed = new URL(url);
  return { ref: parsed.searchParams.get('ref'), token: parsed.searchParams.get('token') };
}

async function historyOf(bookingId) {
  const row = await prisma.serviceRequest.findUnique({ where: { id: bookingId } });
  return Array.isArray(row?.history) ? row.history : [];
}

async function run() {
  await startStub();
  await seed();
  await bootServer();
  const staff = await login(EMAILS.staff);
  const customer = await login(EMAILS.customer);

  // --- Catalog + staff gate -------------------------------------------
  const options = await api('/link-center/options', { token: staff });
  check('options: status', options.status, 200);
  const catalog = options.json.data.links || [];
  const estEntry = catalog.find((entry) => entry.type === 'ESTIMATE');
  checkTrue('catalog carries the ESTIMATE type', estEntry);
  check('ESTIMATE requires booking ref', estEntry?.requiresBookingRef, true);
  check('ESTIMATE url is minted per send (null)', estEntry?.url, null);
  check('send ESTIMATE anon: status', (await api('/link-center/send', { method: 'POST', body: { linkType: 'ESTIMATE', channel: 'EMAIL', email: RECIPIENT, bookingRef: REFS.A } })).status, 401);
  check('send ESTIMATE customer: status', (await api('/link-center/send', { token: customer, method: 'POST', body: { linkType: 'ESTIMATE', channel: 'EMAIL', email: RECIPIENT, bookingRef: REFS.A } })).status, 403);
  check('send ESTIMATE without ref: status', (await api('/link-center/send', { token: staff, method: 'POST', body: { linkType: 'ESTIMATE', channel: 'EMAIL', email: RECIPIENT } })).status, 400);
  check('send ESTIMATE unknown ref: status', (await api('/link-center/send', { token: staff, method: 'POST', body: { linkType: 'ESTIMATE', channel: 'EMAIL', email: RECIPIENT, bookingRef: 'TS-NOPE99' } })).status, 404);

  // --- No estimate yet: honest 409 ------------------------------------
  const noEst = await api('/link-center/send', { token: staff, method: 'POST', body: { linkType: 'ESTIMATE', channel: 'EMAIL', email: RECIPIENT, bookingRef: REFS.D } });
  check('send ESTIMATE with no saved estimate: status', noEst.status, 409);
  check('no-estimate error code', noEst.json.error, 'no_estimate');

  // --- Booking A: residential repair with parts + tax ------------------
  const estA = await api(`/bookos/bookings/${IDS.bookingA}/estimate`, {
    token: staff, method: 'POST',
    body: { kind: 'REPAIR', parts: [{ description: 'Compressor relay', qty: 1, unitPriceCents: 4500 }], taxRatePercent: 7 },
  });
  check('estimate A saved: status', estA.status, 201);
  check('estimate A total = 21000 + 4500 + 315 tax - 9900 credit', estA.json.data.estimate?.totalCents, 15915);
  check('estimate A diagnostic credit', estA.json.data.estimate?.diagnosticCreditCents, 9900);

  const sendA = await api('/link-center/send', {
    token: staff, method: 'POST',
    body: { linkType: 'ESTIMATE', channel: 'EMAIL', recipientName: 'Maria Diaz', email: RECIPIENT, bookingRef: REFS.A },
  });
  check('send A: status', sendA.status, 201);
  check('send A: delivery state SENT (Resend stub accepted)', sendA.json.data.status, 'SENT');
  checkIncludes('send A: url is the approval page', sendA.json.data.url || '', '/estimate?ref=TS-ESTA01&token=');
  check('send A: response carries estimateId', sendA.json.data.estimateId, estA.json.data.estimate?.id);
  const mailA = emailCaptures[emailCaptures.length - 1];
  checkIncludes('estimate email carries the total', mailA?.text || '', '$159.15');
  checkIncludes('estimate email carries the approval url', mailA?.text || '', sendA.json.data.url);
  const linkA = tokenFromUrl(sendA.json.data.url);
  check('link A ref round-trips', linkA.ref, REFS.A);

  // Token discipline: hash at rest, never the raw token.
  const rowA = await prisma.estimateApprovalToken.findFirst({ where: { bookingId: IDS.bookingA } });
  checkTrue('token row exists for booking A', rowA);
  check('stored value is the SHA-256 of the raw token', rowA?.tokenHash, createHash('sha256').update(linkA.token).digest('hex'));
  checkTrue('raw token is not what is stored', rowA?.tokenHash !== linkA.token);

  // --- The page read model ---------------------------------------------
  const viewA = await api(`/estimate-approval?ref=${linkA.ref}&token=${encodeURIComponent(linkA.token)}`);
  check('page A: status', viewA.status, 200);
  check('page A: state PENDING', viewA.json.data.state, 'PENDING');
  check('page A: total matches the saved estimate', viewA.json.data.estimate?.totalCents, 15915);
  check('page A: part line total matches', viewA.json.data.estimate?.parts?.[0]?.lineTotalCents, 4500);
  check('page A: diagnostic credit shown', viewA.json.data.estimate?.diagnosticCreditCents, 9900);
  check('page A: booking ref', viewA.json.data.booking?.referenceCode, REFS.A);
  check('page A: no decision yet', viewA.json.data.decision, null);
  check('page with wrong token: status', (await api(`/estimate-approval?ref=${REFS.A}&token=wrong-token-value`)).status, 404);
  check('page with wrong ref: status', (await api(`/estimate-approval?ref=TS-NOPE99&token=${encodeURIComponent(linkA.token)}`)).status, 404);
  check('page with token of A but ref of B: status', (await api(`/estimate-approval?ref=${REFS.B}&token=${encodeURIComponent(linkA.token)}`)).status, 404);
  check('page with no params: status', (await api('/estimate-approval')).status, 404);

  // --- Approve ----------------------------------------------------------
  const decideA = await api('/estimate-approval/decide', { method: 'POST', body: { ref: linkA.ref, token: linkA.token, decision: 'APPROVED' } });
  check('decide A approve: status', decideA.status, 200);
  check('decide A approve: decision', decideA.json.data.decision?.decision, 'APPROVED');
  check('decide A approve: not flagged already-decided', decideA.json.data.alreadyDecided, false);

  const moneyA = await api(`/bookos/bookings/${IDS.bookingA}/money`, { token: staff });
  check('money view A: decision APPROVED', moneyA.json.data.estimateDecision?.decision, 'APPROVED');
  check('money view A: decision method APPROVAL_LINK', moneyA.json.data.estimateDecision?.method, 'APPROVAL_LINK');
  check('money view A: authorization log has the approval', moneyA.json.data.authorizationLog?.length, 1);

  const feed = await api('/platform/events?type=ESTIMATE_APPROVED&source=ESTIMATE_LINK', { token: staff });
  checkTrue('platform feed shows the approval sourced ESTIMATE_LINK',
    (feed.json.data || []).some((event) => event.referenceCode === REFS.A));

  // The invoice gate (an existing reader) accepts the link approval.
  const invoiceA = await api(`/bookos/bookings/${IDS.bookingA}/invoice`, { token: staff, method: 'POST', body: {} });
  check('invoice after link approval: status', invoiceA.status, 201);

  // --- One decision per link ---------------------------------------------
  const decideAgain = await api('/estimate-approval/decide', { method: 'POST', body: { ref: linkA.ref, token: linkA.token, decision: 'DECLINED', reason: 'Changed my mind' } });
  check('second decide: status', decideAgain.status, 200);
  check('second decide: flagged already-decided', decideAgain.json.data.alreadyDecided, true);
  check('second decide: recorded outcome still APPROVED', decideAgain.json.data.decision?.decision, 'APPROVED');
  const historyA = await historyOf(IDS.bookingA);
  check('history A: exactly one ESTIMATE_APPROVED', historyA.filter((e) => e.type === 'ESTIMATE_APPROVED').length, 1);
  check('history A: no ESTIMATE_DECLINED written by the retry', historyA.filter((e) => e.type === 'ESTIMATE_DECLINED').length, 0);
  const viewDecided = await api(`/estimate-approval?ref=${linkA.ref}&token=${encodeURIComponent(linkA.token)}`);
  check('page A after decision: state DECIDED', viewDecided.json.data.state, 'DECIDED');
  check('page A after decision: outcome APPROVED', viewDecided.json.data.decision?.decision, 'APPROVED');

  // --- Shape parity with an in-person decision ---------------------------
  const estE = await api(`/bookos/bookings/${IDS.bookingE}/estimate`, {
    token: staff, method: 'POST', body: { kind: 'REPAIR', parts: [] },
  });
  check('estimate E saved: status', estE.status, 201);
  const decideE = await api(`/bookos/bookings/${IDS.bookingE}/estimate/decision`, {
    token: staff, method: 'POST',
    body: { decision: 'APPROVED', method: 'IN_PERSON_VERBAL', authorizedByName: 'Maria Diaz' },
  });
  check('in-person decision E: status', decideE.status, 201);
  const linkEvent = historyA.find((e) => e.type === 'ESTIMATE_APPROVED');
  const personEvent = (await historyOf(IDS.bookingE)).find((e) => e.type === 'ESTIMATE_APPROVED');
  const shape = (event) => Object.keys(event || {}).sort().join(',');
  check('link decision event shape == in-person event shape', shape(linkEvent), shape(personEvent));
  check('link event: actor is the customer', linkEvent?.actor, 'customer');
  check('link event: confirmedBy CUSTOMER', linkEvent?.confirmedBy, 'CUSTOMER');
  check('link event: authorizedByName is the booking customer', linkEvent?.authorizedByName, 'Maria Diaz');
  check('link event: estimateId matches the saved estimate', linkEvent?.estimateId, estA.json.data.estimate?.id);

  // --- Booking B: decline with a reason, link sent by text ----------------
  const estB = await api(`/bookos/bookings/${IDS.bookingB}/estimate`, {
    token: staff, method: 'POST', body: { kind: 'REPAIR', parts: [] },
  });
  check('estimate B total = 21000 - 9900 credit', estB.json.data.estimate?.totalCents, 11100);
  const sendB = await api('/link-center/send', {
    token: staff, method: 'POST',
    body: { linkType: 'ESTIMATE', channel: 'SMS', recipientName: 'Maria Diaz', phone: '9545550123', bookingRef: REFS.B },
  });
  check('send B by text: status', sendB.status, 201);
  check('send B by text: delivery state SENT (Full Twilio stub)', sendB.json.data.status, 'SENT');
  const linkB = tokenFromUrl(sendB.json.data.url);
  const viewB = await api(`/estimate-approval?ref=${linkB.ref}&token=${encodeURIComponent(linkB.token)}`);
  check('page B: total matches the saved estimate', viewB.json.data.estimate?.totalCents, 11100);
  const decideB = await api('/estimate-approval/decide', { method: 'POST', body: { ref: linkB.ref, token: linkB.token, decision: 'DECLINED', reason: 'Too expensive right now' } });
  check('decide B decline: status', decideB.status, 200);
  check('decide B decline: decision', decideB.json.data.decision?.decision, 'DECLINED');
  check('decide B decline: reason recorded', decideB.json.data.decision?.note, 'Too expensive right now');
  const moneyB = await api(`/bookos/bookings/${IDS.bookingB}/money`, { token: staff });
  check('money view B: decision DECLINED', moneyB.json.data.estimateDecision?.decision, 'DECLINED');
  check('money view B: decline note on the record', moneyB.json.data.estimateDecision?.note, 'Too expensive right now');

  // --- Booking F: supersede + expiry --------------------------------------
  const estF1 = await api(`/bookos/bookings/${IDS.bookingF}/estimate`, {
    token: staff, method: 'POST', body: { kind: 'REPAIR', parts: [] },
  });
  check('estimate F v1 saved: status', estF1.status, 201);
  const sendF1 = await api('/link-center/send', {
    token: staff, method: 'POST',
    body: { linkType: 'ESTIMATE', channel: 'EMAIL', email: RECIPIENT, bookingRef: REFS.F },
  });
  const linkF1 = tokenFromUrl(sendF1.json.data.url);
  const estF2 = await api(`/bookos/bookings/${IDS.bookingF}/estimate`, {
    token: staff, method: 'POST',
    body: { kind: 'REPAIR', parts: [{ description: 'Heating element', qty: 1, unitPriceCents: 8000 }] },
  });
  check('estimate F v2 saved: status', estF2.status, 201);
  const viewF1 = await api(`/estimate-approval?ref=${linkF1.ref}&token=${encodeURIComponent(linkF1.token)}`);
  check('old link after a new estimate: state SUPERSEDED', viewF1.json.data.state, 'SUPERSEDED');
  const decideF1 = await api('/estimate-approval/decide', { method: 'POST', body: { ref: linkF1.ref, token: linkF1.token, decision: 'APPROVED' } });
  check('decide on superseded link: status', decideF1.status, 400);
  check('decide on superseded link: code', decideF1.json.code, 'ESTIMATE_LINK_INACTIVE');

  const sendF2 = await api('/link-center/send', {
    token: staff, method: 'POST',
    body: { linkType: 'ESTIMATE', channel: 'EMAIL', email: RECIPIENT, bookingRef: REFS.F },
  });
  check('re-send F: status', sendF2.status, 201);
  const linkF2 = tokenFromUrl(sendF2.json.data.url);
  const viewF2 = await api(`/estimate-approval?ref=${linkF2.ref}&token=${encodeURIComponent(linkF2.token)}`);
  check('fresh link F: state PENDING', viewF2.json.data.state, 'PENDING');
  check('fresh link F: shows the v2 total', viewF2.json.data.estimate?.totalCents, estF2.json.data.estimate?.totalCents);
  const rowF1 = await prisma.estimateApprovalToken.findFirst({ where: { bookingId: IDS.bookingF, estimateId: estF1.json.data.estimate?.id } });
  checkTrue('re-send stamped the v1 token superseded', rowF1?.supersededAt);

  await prisma.estimateApprovalToken.updateMany({
    where: { bookingId: IDS.bookingF, estimateId: estF2.json.data.estimate?.id },
    data: { expiresAt: new Date(Date.now() - 60 * 1000) },
  });
  const viewExpired = await api(`/estimate-approval?ref=${linkF2.ref}&token=${encodeURIComponent(linkF2.token)}`);
  check('expired link: state EXPIRED', viewExpired.json.data.state, 'EXPIRED');
  const decideExpired = await api('/estimate-approval/decide', { method: 'POST', body: { ref: linkF2.ref, token: linkF2.token, decision: 'APPROVED' } });
  check('decide on expired link: status', decideExpired.status, 400);
  check('decide on expired link: code', decideExpired.json.code, 'ESTIMATE_LINK_INACTIVE');
  const historyF = await historyOf(IDS.bookingF);
  check('history F: no decision was ever recorded', historyF.filter((e) => e.type === 'ESTIMATE_APPROVED' || e.type === 'ESTIMATE_DECLINED').length, 0);

  // --- Commercial: no $99 anywhere -----------------------------------------
  const woComm = await api('/bookos/work-orders', {
    token: staff, method: 'POST',
    body: { customerId: IDS.customer, segment: 'COMMERCIAL', appliance: 'Refrigerator', issue: 'Walk-in cooler warm' },
  });
  check('commercial WO: status', woComm.status, 201);
  const commId = woComm.json.data.booking?.id;
  const commRef = woComm.json.data.booking?.referenceCode;
  const estComm = await api(`/bookos/bookings/${commId}/estimate`, {
    token: staff, method: 'POST',
    body: { kind: 'REPAIR', laborCents: 50000, parts: [{ description: 'Condenser fan motor', qty: 2, unitPriceCents: 12000 }], taxRatePercent: 7 },
  });
  check('commercial estimate: status', estComm.status, 201);
  check('commercial estimate: diagnostic fee 0', estComm.json.data.estimate?.diagnosticFeeCents, 0);
  check('commercial estimate: credit 0', estComm.json.data.estimate?.diagnosticCreditCents, 0);
  check('commercial estimate: total = 50000 + 24000 + 1680 tax', estComm.json.data.estimate?.totalCents, 75680);
  const sendComm = await api('/link-center/send', {
    token: staff, method: 'POST',
    body: { linkType: 'ESTIMATE', channel: 'EMAIL', email: RECIPIENT, bookingRef: commRef },
  });
  check('send commercial link: status', sendComm.status, 201);
  const linkComm = tokenFromUrl(sendComm.json.data.url);
  const viewComm = await api(`/estimate-approval?ref=${linkComm.ref}&token=${encodeURIComponent(linkComm.token)}`);
  check('page commercial: total matches the server total', viewComm.json.data.estimate?.totalCents, 75680);
  check('page commercial: segment COMMERCIAL', viewComm.json.data.estimate?.segment, 'COMMERCIAL');
  check('page commercial: no diagnostic credit line', viewComm.json.data.estimate?.diagnosticCreditCents, 0);
  const decideComm = await api('/estimate-approval/decide', { method: 'POST', body: { ref: linkComm.ref, token: linkComm.token, decision: 'APPROVED' } });
  check('decide commercial approve: status', decideComm.status, 200);
  const moneyComm = await api(`/bookos/bookings/${commId}/money`, { token: staff });
  check('money view commercial: decision APPROVED', moneyComm.json.data.estimateDecision?.decision, 'APPROVED');
  await prisma.estimateApprovalToken.deleteMany({ where: { bookingId: commId } }).catch(() => {});
  await prisma.serviceRequest.deleteMany({ where: { id: commId } }).catch(() => {});

  await stopServer();
  await cleanup();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(async (error) => {
  console.error('DRILL ERROR', error);
  await stopServer().catch(() => {});
  await cleanup().catch(() => {});
  process.exit(1);
});
