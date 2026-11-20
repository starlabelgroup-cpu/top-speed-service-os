/**
 * Setter comms drills (2026-11-20, Wave 1 D1 + D2) — the two-way
 * texting/email composer in Book OS + CRM and the automated
 * appointment reminders with reply handling.
 *
 * Everything is local: the API boots against DATABASE_URL (a fresh
 * drill Postgres), Resend / Twilio are stubbed on a localhost HTTP
 * server via the providers' *_API_BASE hooks. The Twilio stub flips
 * between accepting sends and rejecting them with a toll-free-style
 * error — the blocked send must land FAILED on the thread and the
 * outbox, never SENT (the platform's honest-delivery rule).
 *
 * Proven here:
 *  - auth gates: anon 401 / customer 403 on the composer, the sweep,
 *    and the no-show mark; the cron sweep refuses a bad secret.
 *  - composer email → SENT end to end (thread row + outbox entry +
 *    the Resend stub received it, reach footer attached); composer
 *    SMS → SENT while the carrier accepts, FAILED with the carrier's
 *    error while it rejects; a missing recipient is an honest 422.
 *  - the reminder sweep picks exactly the day-before + morning-of
 *    appointments (email + SMS per the contact details on file),
 *    the reminder copy carries "Reply C to confirm or R to
 *    reschedule", and a second sweep — by staff or by cron — sends
 *    nothing twice.
 *  - an inbound customer text still forwards to the owner's phone
 *    and still earns the TwiML thank-you, AND lands on the thread;
 *    a duplicate MessageSid files nothing twice.
 *  - "C" confirms the appointment on the booking record; "R" leaves
 *    the appointment untouched and raises a RESCHEDULE_REQUESTED
 *    task in the Book OS exception queue.
 *  - the no-show mark raises a NO_SHOW exception; marking twice 409s.
 *
 * Requires DATABASE_URL (the suite seeds and cleans its own rows).
 * Run: DATABASE_URL=postgresql://… node test/setter-comms.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { hashPassword } from '../src/services/passwords.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required for the setter-comms drills');
  process.exit(2);
}

const PORT = Number(process.env.TEST_PORT || 4491);
const STUB_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'Setter-Comms-Drill-123!';
const CRON_SECRET = 'drill-cron-secret';
const IDS = {
  staff: 'c2000000-0000-4000-8000-000000000001',
  customerUser: 'c2000000-0000-4000-8000-000000000002',
  custA: 'c2000000-0000-4000-8000-000000000003',
  custB: 'c2000000-0000-4000-8000-000000000004',
  custC: 'c2000000-0000-4000-8000-000000000005',
  custD: 'c2000000-0000-4000-8000-000000000006',
  custDUser: 'c2000000-0000-4000-8000-000000000007',
  b1: 'c2000000-0000-4000-8000-000000000011',
  b2: 'c2000000-0000-4000-8000-000000000012',
  b3: 'c2000000-0000-4000-8000-000000000013',
  b4: 'c2000000-0000-4000-8000-000000000014',
  b5: 'c2000000-0000-4000-8000-000000000015',
};
const EMAILS = { staff: 'commsdrill-staff@test.local', customer: 'commsdrill-customer@test.local' };
const PHONE_A = '9545550143';
const PHONE_B = '9545550144';

const nyToday = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const addDays = (s, n) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const TOMORROW = addDays(nyToday, 1);

const prisma = new PrismaClient();
let server = null;
let stub = null;
let failures = 0;
let twilioMode = 'ok'; // 'ok' | 'reject'
const emailCaptures = [];
const smsCaptures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) {
  if (!value) failures += 1;
  console.log(`${value ? 'PASS' : 'FAIL'}  ${label}`);
}
function checkIncludes(label, haystack, needle) {
  const ok = typeof haystack === 'string' && haystack.includes(needle);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (want text containing ${JSON.stringify(needle)})`);
}

async function api(path, { token, method = 'GET', body, headers } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
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
        res.end(JSON.stringify({ id: 'resend-commsdrill' }));
        return;
      }
      if (req.method === 'GET' && req.url.includes('/2010-04-01/Accounts/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sid: 'ACcommsdrill', type: 'Full', status: 'active' }));
        return;
      }
      if (req.method === 'POST' && req.url.includes('/Messages.json')) {
        const form = new URLSearchParams(raw);
        smsCaptures.push({ to: form.get('To'), from: form.get('From'), body: form.get('Body') });
        if (twilioMode === 'reject') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 30032, message: 'Toll-free number has not been approved for messaging' }));
          return;
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sid: `SMcommsdrill${smsCaptures.length}`, status: 'queued' }));
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
  childEnv['JWT_' + 'SECRET'] = 'setter-comms-drill-secret';
  childEnv['RESEND_' + 'API_KEY'] = 'drill-resend-key';
  childEnv['RESEND_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;
  childEnv['EMAIL_' + 'FROM'] = 'Top Speed Appliance <service@topspeedappliance.net>';
  childEnv['TWILIO_' + 'ACCOUNT_SID'] = 'ACcommsdrill';
  childEnv['TWILIO_' + 'AUTH_TOKEN'] = 'drill-twilio-token';
  childEnv['TWILIO_' + 'PHONE_NUMBER'] = '+18444607038';
  childEnv['TWILIO_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;
  childEnv['CRON_' + 'SECRET'] = CRON_SECRET;
  delete childEnv['SENDGRID_' + 'API_KEY'];
  delete childEnv['VONAGE_' + 'API_KEY'];
  delete childEnv['VONAGE_' + 'API_SECRET'];
  delete childEnv['VOICE_' + 'FORWARD_TO'];
  delete childEnv['STRIPE_' + 'SECRET_KEY'];
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

const appointment = (date) => ({
  date, window: '10-12', windowLabel: '10 AM–12 PM', status: 'SET',
  setAt: new Date().toISOString(), setBy: 'Service Setters', history: [],
});

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
    create: { id: IDS.staff, companyId: PLATFORM_COMPANY_ID, email: EMAILS.staff, firstName: 'Comms', lastName: 'Staff', passwordHash, roles: ['DISPATCHER'], active: true },
  });
  await prisma.user.upsert({
    where: { id: IDS.customerUser },
    update: { passwordHash },
    create: { id: IDS.customerUser, companyId: PLATFORM_COMPANY_ID, email: EMAILS.customer, firstName: 'Comms', lastName: 'Customer', passwordHash, roles: ['CUSTOMER'], active: true },
  });
  await prisma.user.upsert({
    where: { id: IDS.custDUser },
    update: { passwordHash },
    create: { id: IDS.custDUser, companyId: PLATFORM_COMPANY_ID, email: 'drill-d@example.com', firstName: 'Drill', lastName: 'Customer D', passwordHash, roles: ['CUSTOMER'], active: true },
  });
  const customers = [
    { id: IDS.custA, name: 'Drill Customer A', phone: PHONE_A, email: 'drill-a@example.com' },
    { id: IDS.custB, name: 'Drill Customer B', phone: PHONE_B, email: null },
    { id: IDS.custC, name: 'Drill Customer C', phone: '9545550145', email: 'drill-c@example.com' },
    { id: IDS.custD, name: 'Drill Customer D', phone: '', email: 'drill-d@example.com' },
  ];
  for (const c of customers) {
    await prisma.customer.upsert({
      where: { id: c.id },
      update: {},
      create: { id: c.id, companyId: PLATFORM_COMPANY_ID, name: c.name, phone: c.phone, email: c.email, city: 'Fort Lauderdale', zip: '33301' },
    });
  }
  const bookings = [
    { id: IDS.b1, customerId: IDS.custA, ref: 'TS-COMMS01', status: 'CONFIRMED', appt: appointment(TOMORROW) },
    { id: IDS.b2, customerId: IDS.custB, ref: 'TS-COMMS02', status: 'CONFIRMED', appt: appointment(nyToday) },
    { id: IDS.b3, customerId: IDS.custA, ref: 'TS-COMMS03', status: 'CONFIRMED', appt: appointment(addDays(nyToday, 5)) },
    { id: IDS.b4, customerId: IDS.custC, ref: 'TS-COMMS04', status: 'COMPLETED', appt: appointment(TOMORROW) },
    { id: IDS.b5, customerId: IDS.custD, ref: 'TS-COMMS05', status: 'CONFIRMED', appt: appointment(addDays(nyToday, 5)) },
  ];
  for (const b of bookings) {
    await prisma.serviceRequest.upsert({
      where: { id: b.id },
      update: { appointment: b.appt, status: b.status },
      create: {
        id: b.id, companyId: PLATFORM_COMPANY_ID, customerId: b.customerId,
        city: 'Fort Lauderdale', zip: '33301', appliance: 'Refrigerator', issue: 'Not cooling',
        referenceCode: b.ref, source: 'setter-comms-drill', status: b.status,
        appointment: b.appt, history: [], completedAt: b.status === 'COMPLETED' ? new Date() : null,
      },
    });
  }
}

async function cleanup() {
  const threadIds = (await prisma.messageThread.findMany({ where: { companyId: PLATFORM_COMPANY_ID }, select: { id: true } }).catch(() => [])).map((t) => t.id);
  await prisma.threadMessage.deleteMany({ where: { threadId: { in: threadIds } } }).catch(() => {});
  await prisma.messageThread.deleteMany({ where: { companyId: PLATFORM_COMPANY_ID } }).catch(() => {});
  await prisma.bookingMessage.deleteMany({ where: { bookingId: { in: [IDS.b1, IDS.b2, IDS.b3, IDS.b4, IDS.b5] } } }).catch(() => {});
  await prisma.notificationOutbox.deleteMany({ where: { OR: [{ template: { in: ['STAFF_MESSAGE', 'APPOINTMENT_REMINDER'] } }, { eventKey: { contains: 'SMdrill' } }] } }).catch(() => {});
  await prisma.serviceRequest.deleteMany({ where: { id: { in: [IDS.b1, IDS.b2, IDS.b3, IDS.b4, IDS.b5] } } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { id: { in: [IDS.custA, IDS.custB, IDS.custC, IDS.custD] } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: [IDS.staff, IDS.customerUser, IDS.custDUser] } } }).catch(() => {});
}

async function inboundSms({ from, body, sid }) {
  const res = await fetch(`${BASE}/twilio/sms/incoming`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: from, To: '+18444607038', Body: body, MessageSid: sid }).toString(),
  });
  return { status: res.status, text: await res.text() };
}

async function threadFor(token, query) {
  const { json } = await api(`/messages/thread?${query}`, { token });
  return json?.data?.thread || null;
}

async function run() {
  await startStub();
  await seed();
  await bootServer();
  const staff = await login(EMAILS.staff);
  const customer = await login(EMAILS.customer);

  // --- Auth gates ------------------------------------------------------
  check('thread anon: status', (await api(`/messages/thread?bookingId=${IDS.b1}`)).status, 401);
  check('thread customer: status', (await api(`/messages/thread?bookingId=${IDS.b1}`, { token: customer })).status, 403);
  check('send anon: status', (await api('/messages/send', { method: 'POST', body: { bookingId: IDS.b1, channel: 'SMS', body: 'hi' } })).status, 401);
  check('send customer: status', (await api('/messages/send', { token: customer, method: 'POST', body: { bookingId: IDS.b1, channel: 'SMS', body: 'hi' } })).status, 403);
  check('sweep customer: status', (await api('/bookos/reminders/sweep', { token: customer, method: 'POST', body: {} })).status, 403);
  check('no-show customer: status', (await api(`/bookos/bookings/${IDS.b1}/no-show`, { token: customer, method: 'POST', body: {} })).status, 403);
  check('cron sweep, no secret header: status', (await api('/bookos/reminders/cron-sweep')).status, 401);
  check('cron sweep, wrong secret: status', (await api('/bookos/reminders/cron-sweep', { headers: { Authorization: 'Bearer wrong' } })).status, 401);

  // --- Composer: email --------------------------------------------------
  const sendEmail = await api('/messages/send', {
    token: staff, method: 'POST',
    body: { bookingId: IDS.b1, channel: 'EMAIL', subject: 'About your visit', body: 'Hi — confirming we have everything we need for your visit.' },
  });
  check('composer email: status', sendEmail.status, 201);
  check('composer email: delivery state', sendEmail.json?.data?.delivery?.status, 'SENT');
  const capEmail = emailCaptures.find((c) => Array.isArray(c.to) && c.to.includes('drill-a@example.com'));
  checkTrue('Resend stub received the composed email', Boolean(capEmail));
  checkIncludes('composed email carries the reach footer', capEmail?.text || '', 'Part of the Top Speed ecosystem');
  const threadRow = await prisma.messageThread.findFirst({ where: { bookingId: IDS.b1 } });
  checkTrue('thread row persisted for the booking', Boolean(threadRow));
  const msgRows = await prisma.threadMessage.findMany({ where: { threadId: threadRow.id }, orderBy: { createdAt: 'asc' } });
  check('thread holds the email message', msgRows.length, 1);
  check('thread email delivery state is SENT', msgRows[0]?.deliveryStatus, 'SENT');
  checkTrue('thread email links its outbox entry', Boolean(msgRows[0]?.outboxEntryId));

  // --- Composer: SMS accepted, then rejected ----------------------------
  const sendSms = await api('/messages/send', {
    token: staff, method: 'POST',
    body: { bookingId: IDS.b1, channel: 'SMS', body: 'Text from the office: we are set for tomorrow.' },
  });
  check('composer SMS: delivery state', sendSms.json?.data?.delivery?.status, 'SENT');

  twilioMode = 'reject';
  const sendBlocked = await api('/messages/send', {
    token: staff, method: 'POST',
    body: { bookingId: IDS.b1, channel: 'SMS', body: 'This text should be blocked by the carrier.' },
  });
  check('blocked SMS: HTTP status', sendBlocked.status, 201);
  check('blocked SMS: delivery state is FAILED, never SENT', sendBlocked.json?.data?.delivery?.status, 'FAILED');
  checkIncludes('blocked SMS: carrier error is recorded', sendBlocked.json?.data?.delivery?.error || '', 'Toll-free');
  twilioMode = 'ok';
  const threadAfterBlocked = await threadFor(staff, `bookingId=${IDS.b1}`);
  const blockedRow = (threadAfterBlocked?.messages || []).find((m) => m.body.includes('blocked by the carrier'));
  check('blocked SMS on thread: delivery state', blockedRow?.deliveryStatus, 'FAILED');

  // --- Composer: honest recipient gaps ----------------------------------
  const noPhone = await api('/messages/send', {
    token: staff, method: 'POST',
    body: { customerId: IDS.custD, channel: 'SMS', body: 'hello' },
  });
  check('SMS to a customer with no phone: status', noPhone.status, 422);
  check('SMS to a customer with no phone: code', noPhone.json?.code, 'no_recipient');
  const noEmail = await api('/messages/send', {
    token: staff, method: 'POST',
    body: { customerId: IDS.custB, channel: 'EMAIL', body: 'hello' },
  });
  check('email to a customer with no email: status', noEmail.status, 422);

  // The same thread is reachable from the customer side (CRM view).
  const threadByCustomer = await threadFor(staff, `customerId=${IDS.custA}`);
  check('thread by customer is the booking thread', threadByCustomer?.id, threadRow.id);
  check('thread message count before reminders', threadByCustomer?.messages?.length, 3);

  // --- Reminder sweep ----------------------------------------------------
  const sweep1 = await api('/bookos/reminders/sweep', { token: staff, method: 'POST', body: { today: nyToday } });
  check('sweep: status', sweep1.status, 200);
  check('sweep day-before: bookings', sweep1.json?.data?.dayBefore?.bookings, 1);
  check('sweep day-before: queued (email + SMS)', sweep1.json?.data?.dayBefore?.queued, 2);
  check('sweep morning-of: bookings', sweep1.json?.data?.morningOf?.bookings, 1);
  check('sweep morning-of: queued (SMS only — no email on file)', sweep1.json?.data?.morningOf?.queued, 1);
  const reminderSms = smsCaptures.find((c) => String(c.body || '').includes('Reply C to confirm'));
  checkTrue('reminder SMS reached the carrier stub', Boolean(reminderSms));
  checkIncludes('reminder SMS carries the reply instruction', reminderSms?.body || '', 'Reply C to confirm or R to reschedule');
  const reminderEntries = await prisma.notificationOutbox.findMany({ where: { template: 'APPOINTMENT_REMINDER' } });
  check('reminder outbox entries (2 + 1, none for the control bookings)', reminderEntries.length, 3);
  checkTrue('every reminder entry is SENT', reminderEntries.every((e) => e.status === 'SENT'));
  const threadAfterSweep = await threadFor(staff, `bookingId=${IDS.b1}`);
  check('reminders recorded on the thread', threadAfterSweep?.messages?.length, 5);
  check('reminder thread rows are kind REMINDER', (threadAfterSweep?.messages || []).filter((m) => m.kind === 'REMINDER').length, 2);

  const sweep2 = await api('/bookos/reminders/sweep', { token: staff, method: 'POST', body: { today: nyToday } });
  check('second sweep day-before: bookings', sweep2.json?.data?.dayBefore?.bookings, 0);
  check('second sweep morning-of: bookings', sweep2.json?.data?.morningOf?.bookings, 0);
  const threadAfterSweep2 = await threadFor(staff, `bookingId=${IDS.b1}`);
  check('second sweep adds no thread rows', threadAfterSweep2?.messages?.length, 5);

  // --- Inbound SMS: plain reply files + still forwards -------------------
  const inbound1 = await inboundSms({ from: `+1${PHONE_A}`, body: 'What time is the tech coming?', sid: 'SMdrill001' });
  check('inbound SMS: webhook status', inbound1.status, 200);
  checkIncludes('inbound SMS: TwiML thank-you intact', inbound1.text, 'Thanks for texting Top Speed Appliance');
  const forward = await prisma.notificationOutbox.findFirst({ where: { eventKey: 'sms-inbound:SMdrill001' } });
  checkTrue('inbound SMS still forwarded to the owner (outbox entry)', Boolean(forward));
  check('forward entry recipient is the owner line', forward?.to, '+19549317997');
  const threadAfterInbound = await threadFor(staff, `bookingId=${IDS.b1}`);
  const inboundRow = (threadAfterInbound?.messages || []).find((m) => m.direction === 'INBOUND');
  check('inbound reply filed on the thread', inboundRow?.body, 'What time is the tech coming?');

  const inboundDup = await inboundSms({ from: `+1${PHONE_A}`, body: 'What time is the tech coming?', sid: 'SMdrill001' });
  check('duplicate webhook: status', inboundDup.status, 200);
  const threadAfterDup = await threadFor(staff, `bookingId=${IDS.b1}`);
  check('duplicate MessageSid files nothing twice', (threadAfterDup?.messages || []).filter((m) => m.direction === 'INBOUND').length, 1);

  // --- Inbound "C": confirms the appointment -----------------------------
  await inboundSms({ from: `+1${PHONE_A}`, body: 'C', sid: 'SMdrill002' });
  const threadAfterC = await threadFor(staff, `bookingId=${IDS.b1}`);
  checkTrue('C reply: thread flags show the confirmation', Boolean(threadAfterC?.flags?.customerConfirmedAt));
  const confirmRow = (threadAfterC?.messages || []).find((m) => m.kind === 'CONFIRM');
  checkTrue('C reply filed as a CONFIRM message', Boolean(confirmRow));
  const b1After = await api(`/bookings/${IDS.b1}`, { token: staff });
  checkTrue('C reply: booking appointment carries customerConfirmedAt', Boolean(b1After.json?.data?.appointment?.customerConfirmedAt));
  checkTrue('C reply: booking history records it', (b1After.json?.data?.history || []).some((h) => h.type === 'APPOINTMENT_CONFIRMED_BY_CUSTOMER'));

  // --- Inbound "R": flags a reschedule task, moves nothing ---------------
  await inboundSms({ from: `+1${PHONE_B}`, body: 'R', sid: 'SMdrill003' });
  const b2After = await api(`/bookings/${IDS.b2}`, { token: staff });
  check('R reply: appointment date untouched', b2After.json?.data?.appointment?.date, nyToday);
  const exceptions1 = await api('/bookos/exceptions', { token: staff });
  const reschedRow = (exceptions1.json?.data?.items || []).find((i) => i.type === 'RESCHEDULE_REQUESTED' && i.bookingId === IDS.b2);
  checkTrue('R reply: RESCHEDULE_REQUESTED task in the exception queue', Boolean(reschedRow));

  // --- No-show ------------------------------------------------------------
  const noShow = await api(`/bookos/bookings/${IDS.b1}/no-show`, { token: staff, method: 'POST', body: { markedBy: 'Service Setters' } });
  check('no-show mark: status', noShow.status, 200);
  const exceptions2 = await api('/bookos/exceptions', { token: staff });
  const noShowRow = (exceptions2.json?.data?.items || []).find((i) => i.type === 'NO_SHOW' && i.bookingId === IDS.b1);
  checkTrue('no-show feeds the exception queue', Boolean(noShowRow));
  const noShowAgain = await api(`/bookos/bookings/${IDS.b1}/no-show`, { token: staff, method: 'POST', body: {} });
  check('second no-show mark: status', noShowAgain.status, 409);

  // --- Convergence with B2 message-the-office (BookingMessage) -----------
  // Delivered composer messages join the shared per-booking thread;
  // the blocked one does not; the B2 read shows the same conversation;
  // a customer who wrote from /app appears in the composer view.
  const bmRows = await prisma.bookingMessage.findMany({ where: { bookingId: IDS.b1 }, orderBy: { createdAt: 'asc' } });
  check('convergence: delivered composer messages mirrored to BookingMessage', bmRows.length, 2);
  checkTrue('convergence: mirror rows are STAFF side', bmRows.every((r) => r.senderKind === 'STAFF'));
  checkTrue('convergence: blocked SMS was NOT mirrored', !bmRows.some((r) => r.body.includes('blocked by the carrier')));
  checkTrue('convergence: reminders were NOT mirrored', !bmRows.some((r) => r.body.includes('Reply C to confirm')));
  const b2View = await api(`/bookings/${IDS.b1}/messages`, { token: staff });
  check('convergence: B2 thread read status', b2View.status, 200);
  check('convergence: B2 thread holds the same 2 office messages', b2View.json?.data?.messages?.length, 2);
  const threadMerged = await threadFor(staff, `bookingId=${IDS.b1}`);
  check('convergence: merged composer view shows no duplicates', threadMerged?.messages?.length, 7);

  // The customer writes from /app through the real B2 endpoint (the
  // seeded customer's own account — bookingBelongsToUser matches on
  // the email), then the composer view must show that same message.
  const custDToken = await login('drill-d@example.com');
  const appPost = await api(`/bookings/${IDS.b5}/messages`, {
    token: custDToken, method: 'POST', body: { body: 'Writing from the app — is my visit still on?' },
  });
  check('convergence: customer app post via B2 endpoint', appPost.status, 201);
  const threadB5 = await threadFor(staff, `bookingId=${IDS.b5}`);
  checkTrue('convergence: app-first thread is visible to the composer', Boolean(threadB5));
  check('convergence: app message renders INBOUND', threadB5?.messages?.[0]?.direction, 'INBOUND');
  check('convergence: app message channel is APP', threadB5?.messages?.[0]?.channel, 'APP');

  // --- Cron sweep: same machinery, still idempotent -----------------------
  const cron = await api('/bookos/reminders/cron-sweep', { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
  check('cron sweep: status', cron.status, 200);
  check('cron sweep after staff sweeps: nothing re-sent', (cron.json?.data?.dayBefore?.queued || 0) + (cron.json?.data?.morningOf?.queued || 0), 0);

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
