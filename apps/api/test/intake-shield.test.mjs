/**
 * Intake shield (2026-11-19) — Ramone's directive: "Stop all of them
 * fake emails." Drills the three additive layers on the public
 * intake endpoints:
 *
 *  - Honeypot discard: a filled hidden `companyWebsite` field gets
 *    the SAME success shape as a real submission on register,
 *    /connections, /commercial/bulk-requests and /speedy/book — but
 *    persists NO record and queues NO notification of any kind.
 *  - Phone gate: register + connections (+ PM bulk) reject (400
 *    INVALID_PHONE) numbers that are not plausible NANP numbers —
 *    the observed fakes' unassigned area codes 355 and 691, and a
 *    1-leading pseudo-number — while formatted real numbers pass.
 *  - Durable rate limits: IntakeRateWindow counts per IP per family
 *    in the database; bursts past 10/hour (register, connections,
 *    booking) get 429 RATE_LIMITED and persist/notify NOTHING;
 *    forgot-password (limit 5/hour) keeps its generic 200 while
 *    quietly skipping the send once over the limit.
 *  - Legitimate flows are untouched: register 201, connections 201,
 *    bulk 201, booking 201 with a real reference, forgot-password
 *    issues a real reset token — each with its notifications queued.
 *
 * HARD RULE drilled throughout: a submission stopped by ANY layer
 * produces NO record AND NO outbox entry. Snapshots of the outbox
 * count bracket every blocked attempt.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... node test/intake-shield.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4463);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';
const TERMS = {
  signatureName: 'Shield Drill Customer',
  documents: [
    { document: 'SERVICE_OS', version: '1.0', agreed: true },
    { document: 'APPLIANCE_CONNECT', version: '1.0', agreed: true },
  ],
};

const prisma = new PrismaClient();
let server = null;
let failures = 0;

function startServer() {
  const proc = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'intake-shield-test-secret',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL,
      OPENAI_API_KEY: '',
      OPENAI_API_KEY_V2: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return proc;
}

async function restartServer() {
  // A cold start wipes the per-instance in-memory limiters (the old
  // middleware buckets) — the durable IntakeRateWindow counts in the
  // database must survive it. That contrast is part of the drill.
  if (server) server.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 600));
  server = startServer();
  await waitForServer();
}

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));
const outboxCount = () => prisma.notificationOutbox.count();
const userCount = () => prisma.user.count();
const connectionCount = () => prisma.connection.count();
const bookingCount = () => prisma.serviceRequest.count();
const userByEmail = (email) => prisma.user.findFirst({ where: { email } });

function registerBody(email, extra = {}) {
  return {
    email, password: PASSWORD, firstName: 'Shield', lastName: 'Drill',
    phone: '9545550110', role: 'CUSTOMER', termsAcceptance: TERMS, ...extra,
  };
}

async function seed() {
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'shield-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
}

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('server did not come up');
}

async function main() {
  await seed();
  server = startServer();
  await waitForServer();

  // ---- Public + gated route sanity (shared-prefix trap check) ----
  check('health 200', (await api('/health')).status, 200);
  check('payments/status 200', (await api('/payments/status')).status, 200);
  const speedyStatus = await api('/speedy/status');
  check('speedy/status 200', speedyStatus.status, 200);
  checkTrue('speedy knowledge total > 0', (speedyStatus.json?.data?.knowledge?.total ?? speedyStatus.json?.knowledge?.total ?? 0) > 0);
  check('GET /connections unauthenticated 401', (await api('/connections')).status, 401);

  // ================= REGISTER (family budget: 10/hour) =================
  // attempt 1 — legitimate registration, exactly as before.
  const outbox0 = await outboxCount();
  const reg1 = await api('/auth/register', { method: 'POST', body: registerBody('shield-legit@test.local') });
  check('register legit → 201', reg1.status, 201);
  check('register legit returns the user', reg1.json?.user?.email, 'shield-legit@test.local');
  checkTrue('register legit persisted the user', await userByEmail('shield-legit@test.local'));
  await settle();
  checkTrue('register legit queued its notifications', (await outboxCount()) > outbox0);

  // attempt 2 — honeypot: success shape, NO user, NO notification.
  const outboxBeforeHoney = await outboxCount();
  const regHoney = await api('/auth/register', {
    method: 'POST',
    body: registerBody('shield-honey@test.local', { companyWebsite: 'http://spam.example/cheap' }),
  });
  check('register honeypot → 201 (success-shaped)', regHoney.status, 201);
  check('register honeypot echoes the email', regHoney.json?.user?.email, 'shield-honey@test.local');
  // Shape updated 2026-11-21 (Ramone's approval-free customer signup
  // directive): a discarded CUSTOMER submission now mirrors the real
  // customer success shape — the Layer 2 (2-step) challenge envelope —
  // never the Speedy Verify office-approval shape. Covered kinds keep
  // the pending shape (drilled in customer-signup-approval-free).
  check('register honeypot shape is the customer 2-step shape', regHoney.json?.layer2Required, true);
  check('register honeypot carries NO office-approval block', regHoney.json?.speedyVerify, undefined);
  check('register honeypot issued NO token', regHoney.json?.token, undefined);
  checkTrue('register honeypot persisted NO user', !(await userByEmail('shield-honey@test.local')));
  await settle();
  check('register honeypot queued NO notification', await outboxCount(), outboxBeforeHoney);

  // attempts 3-5 — the observed fakes' phone signatures → 400, nothing persisted.
  for (const [label, email, phone] of [
    ['area 355 (observed fake)', 'shield-bad355@test.local', '3554274997'],
    ['area 691 (observed fake)', 'shield-bad691@test.local', '6911637014'],
    ['area 555 after leading 1', 'shield-bad555@test.local', '15551234567'],
  ]) {
    const outboxBefore = await outboxCount();
    const res = await api('/auth/register', { method: 'POST', body: registerBody(email, { phone }) });
    check(`register bad phone ${label} → 400`, res.status, 400);
    check(`register bad phone ${label} code`, res.json?.code, 'INVALID_PHONE');
    checkTrue(`register bad phone ${label} persisted NO user`, !(await userByEmail(email)));
    await settle();
    check(`register bad phone ${label} queued NO notification`, await outboxCount(), outboxBefore);
  }

  // attempt 6 — a formatted real number passes the gate (normalization).
  const regFmt = await api('/auth/register', {
    method: 'POST',
    body: registerBody('shield-fmt@test.local', { phone: '+1 (954) 555-0123' }),
  });
  check('register formatted +1 (954) phone → 201', regFmt.status, 201);
  checkTrue('register formatted phone persisted', await userByEmail('shield-fmt@test.local'));

  // attempts 7-10 — normal-rate burst headroom: all fine.
  for (let i = 1; i <= 4; i += 1) {
    const res = await api('/auth/register', { method: 'POST', body: registerBody(`shield-burst${i}@test.local`) });
    check(`register burst ${i} (attempt ${6 + i}) → 201`, res.status, 201);
  }
  // Cold-start the API, THEN go past the limit. The restart wipes
  // the pre-existing per-instance auth throttle (10/15 min, memory)
  // that also guards /auth/* — if the 429 below still fires, it is
  // the shield's DURABLE counter answering, which is the point:
  // production instances cold-start constantly and the limit must
  // not forget. (The durable count entering the restart is 10.)
  await restartServer();
  // attempts 11-12 — past the limit: 429, NO user, NO notification.
  for (const email of ['shield-over1@test.local', 'shield-over2@test.local']) {
    await settle();
    const outboxBefore = await outboxCount();
    const res = await api('/auth/register', { method: 'POST', body: registerBody(email) });
    check(`register over limit (${email}) → 429`, res.status, 429);
    check('register 429 code', res.json?.code, 'RATE_LIMITED');
    checkTrue('register 429 persisted NO user', !(await userByEmail(email)));
    await settle();
    check('register 429 queued NO notification', await outboxCount(), outboxBefore);
  }
  check('register family created exactly the legitimate users', await userCount(), 6);

  // ================= FORGOT-PASSWORD (family budget: 5/hour) =================
  // attempt 1 — real account: generic 200 AND a real token is issued.
  const forgot1 = await api('/auth/forgot-password', { method: 'POST', body: { email: 'shield-legit@test.local' } });
  check('forgot-password → generic 200', forgot1.status, 200);
  check('forgot-password ok flag', forgot1.json?.ok, true);
  const legitUser = await userByEmail('shield-legit@test.local');
  check('forgot-password issued a reset token', await prisma.passwordResetToken.count({ where: { userId: legitUser.id } }), 1);
  // attempts 2-5 — unknown emails: generic 200, nothing issued.
  for (let i = 1; i <= 4; i += 1) {
    const res = await api('/auth/forgot-password', { method: 'POST', body: { email: `ghost${i}@test.local` } });
    check(`forgot-password unknown ${i} → generic 200`, res.status, 200);
  }
  // attempts 6-7 — over the shield limit: STILL generic 200, but the
  // send is quietly skipped — the real account's token set is frozen.
  for (let i = 1; i <= 2; i += 1) {
    const res = await api('/auth/forgot-password', { method: 'POST', body: { email: 'shield-legit@test.local' } });
    check(`forgot-password over limit ${i} → generic 200`, res.status, 200);
    check(`forgot-password over limit ${i} message`, res.json?.message, 'If an account with that email exists, a password reset email is on its way.');
  }
  check('forgot-password over limit issued NO new token', await prisma.passwordResetToken.count({ where: { userId: legitUser.id } }), 1);
  check('forgot-password original token NOT superseded', await prisma.passwordResetToken.count({ where: { userId: legitUser.id, usedAt: null } }), 1);

  // ================= CONNECTIONS + PM BULK (family budget: 10/hour) =================
  // attempt 1 — legitimate commercial account request (the flagship-commercial shape).
  const outboxC0 = await outboxCount();
  const conn1 = await api('/connections', {
    method: 'POST',
    body: {
      type: 'COMMERCIAL_ACCOUNT_REQUEST', name: 'Harbor Manager', email: 'harbor@test.local',
      phone: '9545550100', source: 'flagship-commercial', message: 'Commercial account request — Harbor Bites LLC (Restaurant / Food service, 1 location).',
    },
  });
  check('connections legit commercial → 201', conn1.status, 201);
  checkTrue('connections legit returns a TS- reference', /^TS-/.test(conn1.json?.data?.reference || ''));
  checkTrue('connections legit persisted', await prisma.connection.findFirst({ where: { reference: conn1.json.data.reference } }));
  await settle();
  checkTrue('connections legit queued the staff alert', (await outboxCount()) > outboxC0);

  // attempt 2 — legitimate PM walkthrough (the flagship-pm shape).
  const conn2 = await api('/connections', {
    method: 'POST',
    body: {
      type: 'PM_WALKTHROUGH_REQUEST', name: 'Pat Manager', email: 'pat@test.local',
      phone: '(954) 555-0101', source: 'flagship-pm', message: 'Portal walkthrough request — Sunrise Property Group (1 – 10 units units)',
    },
  });
  check('connections legit PM walkthrough → 201', conn2.status, 201);
  checkTrue('connections PM walkthrough persisted', await prisma.connection.findFirst({ where: { reference: conn2.json.data.reference } }));

  // attempt 3 — legitimate PM bulk batch (2 unit requests → 2 records).
  const bulk1 = await api('/commercial/bulk-requests', {
    method: 'POST',
    body: {
      manager: { name: 'Pat Manager', phone: '9545550101', company: 'Sunrise Property Group' },
      property: 'Sunrise Gardens',
      requests: [
        { unit: 'Unit 4', appliance: 'Refrigerator', issue: 'Not cooling' },
        { unit: 'Unit 9', appliance: 'Dryer', issue: 'No heat', urgency: 'urgent' },
      ],
    },
  });
  check('bulk legit → 201', bulk1.status, 201);
  check('bulk legit count', bulk1.json?.data?.count, 2);
  check('connections after legit submissions', await connectionCount(), 4);

  // attempt 4 — connections honeypot: success shape, NO record, NO notification.
  await settle(); // let the legit submissions' outbox write-throughs land first
  const outboxCHoney = await outboxCount();
  const connHoney = await api('/connections', {
    method: 'POST',
    body: {
      type: 'COMMERCIAL_ACCOUNT_REQUEST', name: 'Qptzllr Vsjvfhmov', email: 'bot@test.local',
      phone: '9545550100', source: 'flagship-commercial', message: 'spam', companyWebsite: 'http://spam.example',
    },
  });
  check('connections honeypot → 201 (success-shaped)', connHoney.status, 201);
  checkTrue('connections honeypot returns a TS- reference', /^TS-/.test(connHoney.json?.data?.reference || ''));
  check('connections honeypot persisted NOTHING', await connectionCount(), 4);
  await settle();
  check('connections honeypot queued NO notification', await outboxCount(), outboxCHoney);

  // attempt 5 — bulk honeypot: same discipline.
  const bulkHoney = await api('/commercial/bulk-requests', {
    method: 'POST',
    body: {
      manager: { name: 'Bot Manager', phone: '9545550101' },
      property: 'Nowhere',
      requests: [{ unit: 'Unit 1', appliance: 'Oven', issue: 'spam issue' }],
      companyWebsite: 'filled-by-a-bot',
    },
  });
  check('bulk honeypot → 201 (success-shaped)', bulkHoney.status, 201);
  check('bulk honeypot persisted NOTHING', await connectionCount(), 4);
  await settle();
  check('bulk honeypot queued NO notification', await outboxCount(), outboxCHoney);

  // attempts 6-8 — invalid-area-code phones → 400, nothing persisted, nothing notified.
  for (const [label, run] of [
    ['connections 355', () => api('/connections', {
      method: 'POST',
      body: { type: 'COMMERCIAL_ACCOUNT_REQUEST', name: 'Wgyk', email: 'wgyk@test.local', phone: '3554274997', source: 'flagship-commercial', message: 'spam' },
    })],
    ['bulk 691', () => api('/commercial/bulk-requests', {
      method: 'POST',
      body: {
        manager: { name: 'Qptzllr Vsjvfhmov', phone: '6911637014' },
        property: 'Khyqnlsvge LLC',
        requests: [{ unit: 'Unit 1', appliance: 'Refrigerator', issue: 'spam issue' }],
      },
    })],
    ['connections 691', () => api('/connections', {
      method: 'POST',
      body: { type: 'PM_WALKTHROUGH_REQUEST', name: 'Xlbp Dknmdszog', email: 'xlbp@test.local', phone: '6911637014', source: 'flagship-pm', message: 'spam' },
    })],
  ]) {
    const outboxBefore = await outboxCount();
    const res = await run();
    check(`${label} → 400`, res.status, 400);
    check(`${label} code`, res.json?.code, 'INVALID_PHONE');
    check(`${label} persisted NOTHING`, await connectionCount(), 4);
    await settle();
    check(`${label} queued NO notification`, await outboxCount(), outboxBefore);
  }

  // attempts 9-10 — headroom fine; attempts 11-12 — 429 with nothing persisted/notified.
  for (let i = 1; i <= 2; i += 1) {
    const res = await api('/connections', {
      method: 'POST',
      body: { type: 'PM_WALKTHROUGH_REQUEST', name: `Burst ${i}`, email: `burst${i}@test.local`, phone: '9545550142', source: 'flagship-pm', message: 'burst' },
    });
    check(`connections burst ${i} (attempt ${8 + i}) → 201`, res.status, 201);
  }
  for (let i = 1; i <= 2; i += 1) {
    await settle(); // baseline must include the burst submissions' write-throughs
    const outboxBefore = await outboxCount();
    const res = await api('/connections', {
      method: 'POST',
      body: { type: 'PM_WALKTHROUGH_REQUEST', name: `Over ${i}`, email: `over${i}@test.local`, phone: '9545550143', source: 'flagship-pm', message: 'over' },
    });
    check(`connections over limit ${i} → 429`, res.status, 429);
    check('connections 429 code', res.json?.code, 'RATE_LIMITED');
    check('connections 429 persisted NOTHING', await connectionCount(), 6);
    await settle();
    check('connections 429 queued NO notification', await outboxCount(), outboxBefore);
  }
  check('connections family persisted exactly the legitimate records', await connectionCount(), 6);

  // ================= SPEEDY/BOOK (family budget: 10/hour) =================
  const bookBody = (extra = {}) => ({
    customer: { name: 'Booking Drill', phone: '9545550130', address: '100 Main St' },
    city: 'Fort Lauderdale', zip: '33301', appliance: 'Refrigerator',
    issue: 'Not cooling at all', source: 'WEB_FORM', ...extra,
  });
  // attempt 1 — legitimate booking, exactly as before.
  const outboxB0 = await outboxCount();
  const book1 = await api('/speedy/book', { method: 'POST', body: bookBody() });
  check('booking legit → 201', book1.status, 201);
  checkTrue('booking legit returns a referenceCode', /^TS-/.test(book1.json?.data?.referenceCode || ''));
  checkTrue('booking legit persisted', await prisma.serviceRequest.findFirst({ where: { referenceCode: book1.json.data.referenceCode } }));
  await settle();
  checkTrue('booking legit queued its notifications', (await outboxCount()) > outboxB0);

  // attempt 2 — honeypot: success shape, NO booking, NO notification.
  // (ServiceRequest totals are asserted as DELTAS: lead-type
  // connections earlier in this suite also create lead bookings.)
  await settle();
  const outboxBHoney = await outboxCount();
  const bookingsBeforeHoney = await bookingCount();
  const bookHoney = await api('/speedy/book', { method: 'POST', body: bookBody({ companyWebsite: 'http://spam.example' }) });
  check('booking honeypot → 201 (success-shaped)', bookHoney.status, 201);
  checkTrue('booking honeypot returns a referenceCode', /^TS-/.test(bookHoney.json?.data?.referenceCode || ''));
  check('booking honeypot status field matches a real booking', bookHoney.json?.data?.status, 'PENDING_DISPATCH');
  check('booking honeypot persisted NOTHING', await bookingCount(), bookingsBeforeHoney);
  checkTrue('booking honeypot reference is NOT in the database',
    !(await prisma.serviceRequest.findFirst({ where: { referenceCode: bookHoney.json.data.referenceCode } })));
  await settle();
  check('booking honeypot queued NO notification', await outboxCount(), outboxBHoney);

  // attempts 3-10 — headroom fine.
  const bookingsBeforeBurst = await bookingCount();
  for (let i = 1; i <= 8; i += 1) {
    const res = await api('/speedy/book', { method: 'POST', body: bookBody() });
    check(`booking burst ${i} (attempt ${2 + i}) → 201`, res.status, 201);
  }
  check('booking burst persisted all 8', await bookingCount(), bookingsBeforeBurst + 8);
  // attempt 11 — 429, nothing persisted, nothing notified.
  await settle();
  const outboxBOver = await outboxCount();
  const bookingsBeforeOver = await bookingCount();
  const bookOver = await api('/speedy/book', { method: 'POST', body: bookBody() });
  check('booking over limit → 429', bookOver.status, 429);
  check('booking 429 persisted NOTHING', await bookingCount(), bookingsBeforeOver);
  await settle();
  check('booking 429 queued NO notification', await outboxCount(), outboxBOver);

  // ================= DURABLE COUNTERS =================
  const windows = await prisma.intakeRateWindow.findMany();
  const totals = {};
  for (const row of windows) totals[row.family] = (totals[row.family] || 0) + row.count;
  check('rate window: register counted every attempt', totals.register, 12);
  check('rate window: connections counted every attempt', totals.connections, 12);
  check('rate window: booking counted every attempt', totals.booking, 11);
  check('rate window: forgotPassword counted every attempt', totals.forgotPassword, 7);
  checkTrue('rate windows are keyed by caller IP', windows.every((row) => typeof row.ip === 'string' && row.ip.length > 0));

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  return failures;
}

main()
  .then(async (failuresCount) => {
    if (server) server.kill('SIGTERM');
    await prisma.$disconnect();
    process.exit(failuresCount === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    if (server) server.kill('SIGTERM');
    await prisma.$disconnect();
    process.exit(1);
  });
