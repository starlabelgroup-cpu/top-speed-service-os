/**
 * Link Center drills (2026-11-18) — Ramone's send-links system:
 * staff send booking / payment / account / review links by email or
 * SMS through the notification outbox.
 *
 * Everything is local: the API boots against DATABASE_URL (a fresh
 * drill Postgres), and Resend / Twilio / Stripe are stubbed on a
 * localhost HTTP server via the providers' *_API_BASE hooks. Phase 1
 * runs the Twilio stub as a TRIAL account (the account probe reports
 * "Trial" and message sends answer with the trial error 21608), so
 * the SMS send must land in an honest FAILED state, never SENT.
 * Phase 2 restarts the API against the stub flipped to a FULL
 * (upgraded) account — the state Ramone's account entered on
 * 2026-11-18 — and the same SMS send must land SENT, with the
 * options endpoint reporting trial=false from Twilio's own record.
 *
 * Checks: endpoint auth (anon 401 / customer 403 / staff 200),
 * catalog correctness (URLs match the real surfaces), EMAIL sends
 * drain to the Resend stub carrying the right link, SMS records the
 * trial failure, PAYMENT without a bookingRef is a 400, with an
 * unknown ref a 404, and with a drilled booking the URL comes from
 * the (stubbed) Stripe checkout and is REUSED on the second send.
 * The log lists the sends masked, with correct fields.
 *
 * Requires DATABASE_URL (the suite seeds and cleans its own rows).
 * Run: DATABASE_URL=... node test/link-center.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { hashPassword } from '../src/services/passwords.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required for the link-center drills');
  process.exit(2);
}

const PORT = Number(process.env.TEST_PORT || 4461);
const STUB_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'Link-Drill-Pass-123!';
const IDS = {
  staff: 'c1000000-0000-4000-8000-000000000001',
  customerUser: 'c1000000-0000-4000-8000-000000000002',
  customer: 'c1000000-0000-4000-8000-000000000003',
  booking: 'c1000000-0000-4000-8000-000000000004',
};
const EMAILS = { staff: 'linkdrill-staff@test.local', customer: 'linkdrill-customer@test.local' };
const RECIPIENT = 'linkrecipient@example.com';
const STRIPE_URL = 'https://checkout.stripe.com/c/pay/cs_test_linkdrill';
const BOOKING_REF = 'TS-LINK01';

const prisma = new PrismaClient();
let server = null;
let stub = null;
let failures = 0;
const emailCaptures = [];
let stripeSessions = 0;
let twilioAttempts = 0;
// The Twilio stub's account type: 'Trial' for phase 1, flipped to
// 'Full' for the upgraded phase 2 (the API probes it live).
let stubAccountType = 'Trial';

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
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
        res.end(JSON.stringify({ id: 'resend-linkdrill' }));
        return;
      }
      if (req.method === 'GET' && req.url.includes('/2010-04-01/Accounts/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sid: 'ACdrilltrial', type: stubAccountType, status: 'active' }));
        return;
      }
      if (req.method === 'POST' && req.url.includes('/Messages.json')) {
        twilioAttempts += 1;
        if (stubAccountType === 'Trial') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 21608, message: "The 'To' number is not a verified number for this trial account." }));
          return;
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sid: 'SMlinkdrillupgraded', status: 'queued' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
        stripeSessions += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'cs_test_linkdrill', url: STRIPE_URL, payment_intent: 'pi_linkdrill' }));
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
  childEnv['JWT_' + 'SECRET'] = 'link-drill-secret';
  childEnv['RESEND_' + 'API_KEY'] = 'drill-resend-key';
  childEnv['RESEND_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;
  childEnv['EMAIL_' + 'FROM'] = 'Top Speed Appliance <service@topspeedappliance.net>';
  childEnv['TWILIO_' + 'ACCOUNT_SID'] = 'ACdrilltrial';
  childEnv['TWILIO_' + 'AUTH_TOKEN'] = 'drill-twilio-token';
  childEnv['TWILIO_' + 'PHONE_NUMBER'] = '+18445550100';
  childEnv['TWILIO_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;
  childEnv['STRIPE_' + 'SECRET_KEY'] = 'sk_test_linkdrill';
  childEnv['STRIPE_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;
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
    create: { id: IDS.staff, companyId: PLATFORM_COMPANY_ID, email: EMAILS.staff, firstName: 'Link', lastName: 'Staff', passwordHash, roles: ['DISPATCHER'], active: true },
  });
  await prisma.user.upsert({
    where: { id: IDS.customerUser },
    update: { passwordHash },
    create: { id: IDS.customerUser, companyId: PLATFORM_COMPANY_ID, email: EMAILS.customer, firstName: 'Link', lastName: 'Customer', passwordHash, roles: ['CUSTOMER'], active: true },
  });
  await prisma.customer.upsert({
    where: { id: IDS.customer },
    update: {},
    create: { id: IDS.customer, companyId: PLATFORM_COMPANY_ID, userId: IDS.customerUser, name: 'Drill Customer', phone: '9545550123', email: EMAILS.customer, city: 'Fort Lauderdale', zip: '33301' },
  });
  await prisma.serviceRequest.upsert({
    where: { id: IDS.booking },
    update: { referenceCode: BOOKING_REF },
    create: {
      id: IDS.booking, companyId: PLATFORM_COMPANY_ID, customerId: IDS.customer,
      city: 'Fort Lauderdale', zip: '33301', appliance: 'Refrigerator', issue: 'Not cooling',
      referenceCode: BOOKING_REF, source: 'link-center-drill',
    },
  });
}

async function cleanup() {
  await prisma.notificationOutbox.deleteMany({ where: { eventType: 'LINK_CENTER' } }).catch(() => {});
  await prisma.payment.deleteMany({ where: { bookingId: IDS.booking } }).catch(() => {});
  await prisma.serviceRequest.deleteMany({ where: { id: IDS.booking } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { id: IDS.customer } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: [IDS.staff, IDS.customerUser] } } }).catch(() => {});
}

async function run() {
  await startStub();
  await seed();
  await bootServer();
  const staff = await login(EMAILS.staff);
  const customer = await login(EMAILS.customer);

  // --- Auth gates -----------------------------------------------------
  check('options anon: status', (await api('/link-center/options')).status, 401);
  check('options customer: status', (await api('/link-center/options', { token: customer })).status, 403);
  check('send anon: status', (await api('/link-center/send', { method: 'POST', body: { linkType: 'BOOKING', channel: 'EMAIL', email: RECIPIENT } })).status, 401);
  check('send customer: status', (await api('/link-center/send', { token: customer, method: 'POST', body: { linkType: 'BOOKING', channel: 'EMAIL', email: RECIPIENT } })).status, 403);
  check('log customer: status', (await api('/link-center/log', { token: customer })).status, 403);

  // --- Catalog --------------------------------------------------------
  const options = await api('/link-center/options', { token: staff });
  check('options staff: status', options.status, 200);
  const links = options.json?.data?.links || [];
  const byType = Object.fromEntries(links.map((l) => [l.type, l]));
  check('catalog has 4 link types', links.length, 4);
  check('BOOKING url', byType.BOOKING?.url, 'https://topspeedserviceos.com/book?src=linkcenter');
  check('ACCOUNT url', byType.ACCOUNT?.url, 'https://topspeedserviceos.com/app');
  check('REVIEW url (Pepper Lists wall)', byType.REVIEW?.url, 'https://pepperlists.com/#reviews');
  check('PAYMENT url is minted per booking (null)', byType.PAYMENT?.url, null);
  check('PAYMENT requires booking ref', byType.PAYMENT?.requiresBookingRef, true);
  check('SMS channel reports trial honestly', options.json?.data?.channels?.SMS?.trial, true);

  // --- EMAIL send: BOOKING --------------------------------------------
  const send1 = await api('/link-center/send', {
    token: staff, method: 'POST',
    body: { linkType: 'BOOKING', channel: 'EMAIL', recipientName: 'Maria Lopez', email: RECIPIENT },
  });
  check('email BOOKING send: status', send1.status, 201);
  check('email BOOKING send: delivery state', send1.json?.data?.status, 'SENT');
  check('email BOOKING send: url', send1.json?.data?.url, 'https://topspeedserviceos.com/book?src=linkcenter');
  const cap1 = emailCaptures.find((c) => Array.isArray(c.to) && c.to.includes(RECIPIENT) && String(c.text || '').includes('src=linkcenter'));
  check('Resend stub received the booking email', Boolean(cap1), true);
  checkIncludes('booking email greets by first name', cap1?.text || '', 'Hi Maria,');
  checkIncludes('booking email carries the business phone', cap1?.text || '', '(844) 460-7038');

  // --- EMAIL sends: ACCOUNT + REVIEW ----------------------------------
  const sendAcct = await api('/link-center/send', { token: staff, method: 'POST', body: { linkType: 'ACCOUNT', channel: 'EMAIL', email: RECIPIENT } });
  check('email ACCOUNT send: delivery state', sendAcct.json?.data?.status, 'SENT');
  check('email ACCOUNT send: url', sendAcct.json?.data?.url, 'https://topspeedserviceos.com/app');
  const sendReview = await api('/link-center/send', { token: staff, method: 'POST', body: { linkType: 'REVIEW', channel: 'EMAIL', email: RECIPIENT } });
  check('email REVIEW send: delivery state', sendReview.json?.data?.status, 'SENT');
  check('email REVIEW send: url', sendReview.json?.data?.url, 'https://pepperlists.com/#reviews');

  // --- SMS send: honest trial failure ---------------------------------
  const sendSms = await api('/link-center/send', {
    token: staff, method: 'POST',
    body: { linkType: 'BOOKING', channel: 'SMS', recipientName: 'Maria Lopez', phone: '(954) 555-0123' },
  });
  check('sms BOOKING send: status', sendSms.status, 201);
  check('sms BOOKING send: delivery state is FAILED (trial)', sendSms.json?.data?.status, 'FAILED');
  check('sms BOOKING send: provider', sendSms.json?.data?.provider, 'twilio');
  checkIncludes('sms failure carries the trial reason', sendSms.json?.data?.error || '', 'verified');
  check('twilio stub was attempted once', twilioAttempts, 1);

  // --- Validation ------------------------------------------------------
  check('email send without email: status', (await api('/link-center/send', { token: staff, method: 'POST', body: { linkType: 'BOOKING', channel: 'EMAIL' } })).status, 400);
  check('sms send with short phone: status', (await api('/link-center/send', { token: staff, method: 'POST', body: { linkType: 'BOOKING', channel: 'SMS', phone: '555' } })).status, 400);
  check('unknown link type: status', (await api('/link-center/send', { token: staff, method: 'POST', body: { linkType: 'COUPON', channel: 'EMAIL', email: RECIPIENT } })).status, 400);

  // --- PAYMENT ----------------------------------------------------------
  check('payment without bookingRef: status', (await api('/link-center/send', { token: staff, method: 'POST', body: { linkType: 'PAYMENT', channel: 'EMAIL', email: RECIPIENT } })).status, 400);
  check('payment with unknown ref: status', (await api('/link-center/send', { token: staff, method: 'POST', body: { linkType: 'PAYMENT', channel: 'EMAIL', email: RECIPIENT, bookingRef: 'TS-NOPE99' } })).status, 404);
  const sendPay = await api('/link-center/send', {
    token: staff, method: 'POST',
    body: { linkType: 'PAYMENT', channel: 'EMAIL', recipientName: 'Drill Customer', email: RECIPIENT, bookingRef: BOOKING_REF },
  });
  check('payment send: status', sendPay.status, 201);
  check('payment send: delivery state', sendPay.json?.data?.status, 'SENT');
  check('payment send: url is the Stripe checkout', sendPay.json?.data?.url, STRIPE_URL);
  check('payment send: first send mints (not reused)', sendPay.json?.data?.reused, false);
  check('stripe sessions created', stripeSessions, 1);
  const capPay = emailCaptures.find((c) => String(c.text || '').includes(STRIPE_URL));
  check('payment email carries the checkout URL', Boolean(capPay), true);
  checkIncludes('payment email states the credited diagnostic terms', capPay?.text || '', 'credited toward the repair');

  const sendPay2 = await api('/link-center/send', {
    token: staff, method: 'POST',
    body: { linkType: 'PAYMENT', channel: 'EMAIL', email: RECIPIENT, bookingRef: BOOKING_REF },
  });
  check('payment send #2: url is the same checkout', sendPay2.json?.data?.url, STRIPE_URL);
  check('payment send #2: reused flag', sendPay2.json?.data?.reused, true);
  check('stripe sessions still 1 (no duplicate checkout)', stripeSessions, 1);

  // --- Log ---------------------------------------------------------------
  const log = await api('/link-center/log', { token: staff });
  check('log staff: status', log.status, 200);
  const rows = log.json?.data || [];
  check('log lists all 6 sends', rows.length, 6);
  const smsRow = rows.find((r) => r.channel === 'SMS');
  check('log sms row: status FAILED', smsRow?.status, 'FAILED');
  check('log sms row: recipient masked to last 4', smsRow?.to, '***0123');
  check('log sms row: sentBy is the staff account', smsRow?.sentBy, EMAILS.staff);
  const emailRow = rows.find((r) => r.channel === 'EMAIL' && r.linkType === 'BOOKING');
  check('log email row: recipient masked', emailRow?.to, 'li***@example.com');
  const payRow = rows.find((r) => r.linkType === 'PAYMENT');
  check('log payment row: bookingRef recorded', payRow?.bookingRef, BOOKING_REF);
  check('log payment row: url recorded', payRow?.url, STRIPE_URL);
  check('log rows carry no full recipient email', rows.every((r) => !String(r.to).includes('linkrecipient')), true);

  // Outbox persistence: the sends are real NotificationOutbox rows.
  const outboxCount = await prisma.notificationOutbox.count({ where: { eventType: 'LINK_CENTER' } });
  check('outbox persisted the link sends', outboxCount >= 6, true);

  // --- Phase 2: UPGRADED Twilio account --------------------------------
  // The owner upgraded Twilio on 2026-11-18. Restart the API against
  // the stub flipped to a Full account (fresh process = fresh probe
  // cache): the options endpoint must now report trial=false from
  // Twilio's own record, and the same SMS send must land SENT.
  await stopServer();
  stubAccountType = 'Full';
  await bootServer();
  const staff2 = await login(EMAILS.staff);
  const options2 = await api('/link-center/options', { token: staff2 });
  check('upgraded options: status', options2.status, 200);
  check('upgraded options: SMS trial=false (Twilio reports Full)', options2.json?.data?.channels?.SMS?.trial, false);
  const sendSms2 = await api('/link-center/send', {
    token: staff2, method: 'POST',
    body: { linkType: 'BOOKING', channel: 'SMS', recipientName: 'Maria Lopez', phone: '(954) 555-0123' },
  });
  check('upgraded sms BOOKING send: status', sendSms2.status, 201);
  check('upgraded sms BOOKING send: delivery state is SENT', sendSms2.json?.data?.status, 'SENT');
  check('upgraded sms BOOKING send: provider', sendSms2.json?.data?.provider, 'twilio');
  check('twilio stub attempted both sends', twilioAttempts, 2);
  const log2 = await api('/link-center/log', { token: staff2 });
  const smsSentRow = (log2.json?.data || []).find((r) => r.channel === 'SMS' && r.status === 'SENT');
  check('upgraded log carries the SENT sms row', Boolean(smsSentRow), true);
}

try {
  await run();
} catch (error) {
  failures += 1;
  console.error('DRILL ERROR:', error);
} finally {
  await stopServer();
  if (stub) await new Promise((r) => stub.close(r));
  await cleanup().catch(() => {});
  await prisma.$disconnect();
}

console.log(failures === 0 ? '\nALL LINK-CENTER CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
