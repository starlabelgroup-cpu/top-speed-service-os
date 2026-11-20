/**
 * Review funnel drills (2026-11-20) — recommendations F1 + A2:
 *
 * F1 — the automated review funnel. A booking reaching COMPLETED
 * queues exactly ONE review ask per customer channel (the outbox
 * eventKey makes completion replays harmless), carrying the Pepper
 * Lists review link and the private "tell the office first" feedback
 * link; the Google ask carries a link only when GOOGLE_REVIEW_URL is
 * configured (unset here, so the ask must carry NO Google URL). One
 * reminder follows after REVIEW_REMINDER_DELAY_MS (3 days) when no
 * review exists, queued by the sweep that rides POST
 * /notifications/send — exactly once, only for bookings whose ask
 * went out, never for bookings already reviewed or completed too
 * recently, and NEVER suppressed by feedback: the feedback path
 * files a NEEDS_OWNER Pepper report, creates no review, and leaves
 * both the ask and the reminder untouched.
 *
 * A2 — GET /google-reviews answers { available: false, reviews: [] }
 * while the Business Profile connection does not exist; the data
 * layer's connected path is proven in-process with a MOCKED Google
 * payload (drill only — production has no grant and serves nothing).
 *
 * Everything is local: the API boots against DATABASE_URL (a fresh
 * drill Postgres) with NO provider keys set, so outbox entries stay
 * in honest QUEUED/GATED states and nothing is ever sent.
 * Requires DATABASE_URL (the suite seeds and cleans its own rows).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { hashPassword } from '../src/services/passwords.js';
import { fetchGoogleReviews } from '../src/services/googleReviews.js';
import { sweepReviewReminders, REVIEW_REMINDER_DELAY_MS } from '../src/services/reviewFunnel.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required for the review-funnel drills');
  process.exit(2);
}

const PORT = Number(process.env.TEST_PORT || 4471);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'Funnel-Drill-Pass-123!';
const U = (n) => `c2000000-0000-4000-8000-0000000000${n}`;
const IDS = {
  staff: U('01'),
  customerUser: U('02'),
  custEmailOnly: U('03'),
  custBoth: U('04'),
  custSweep: U('05'),
  b1: U('11'),
  b2: U('12'),
  b3: U('13'),
  r1: U('21'),
  r2: U('22'),
  r3: U('23'),
  r4: U('24'),
  r5: U('25'),
  reviewR2: U('31'),
};
const EMAILS = {
  staff: 'funneldrill-staff@test.local',
  customer: 'funneldrill-customer@test.local',
  emailOnly: 'funneldrill-emailonly@test.local',
  both: 'funneldrill-both@test.local',
  sweep: 'funneldrill-sweep@test.local',
};
const REFS = { b1: 'TS-FUNB1', b2: 'TS-FUNB2', b3: 'TS-FUNB3', r1: 'TS-FUNR1', r2: 'TS-FUNR2', r3: 'TS-FUNR3', r4: 'TS-FUNR4', r5: 'TS-FUNR5' };
const DAY = 24 * 3600 * 1000;

const prisma = new PrismaClient();
let server = null;
let failures = 0;

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
function checkExcludes(label, haystack, needle) {
  const ok = typeof haystack === 'string' && !haystack.includes(needle);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (want text WITHOUT ${JSON.stringify(needle)})`);
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

async function outboxRows({ template, bookingId }) {
  const rows = await prisma.notificationOutbox.findMany({ where: { template } });
  return rows.filter((row) => row.payload?.bookingId === bookingId);
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
    create: { id: IDS.staff, companyId: PLATFORM_COMPANY_ID, email: EMAILS.staff, firstName: 'Funnel', lastName: 'Staff', passwordHash, roles: ['DISPATCHER'], active: true },
  });
  await prisma.user.upsert({
    where: { id: IDS.customerUser },
    update: { passwordHash },
    create: { id: IDS.customerUser, companyId: PLATFORM_COMPANY_ID, email: EMAILS.customer, firstName: 'Funnel', lastName: 'Customer', passwordHash, roles: ['CUSTOMER'], active: true },
  });
  // Customer.phone is a required column; an empty string is how a
  // phoneless customer record reads, and customerChannels() treats
  // it as no SMS channel — the email-only case below.
  const customers = [
    { id: IDS.custEmailOnly, name: 'Email Only', email: EMAILS.emailOnly, phone: '' },
    { id: IDS.custBoth, name: 'Both Channels', email: EMAILS.both, phone: '9545550142' },
    { id: IDS.custSweep, name: 'Sweep Customer', email: EMAILS.sweep, phone: '' },
  ];
  for (const c of customers) {
    await prisma.customer.upsert({
      where: { id: c.id },
      update: {},
      create: { id: c.id, companyId: PLATFORM_COMPANY_ID, userId: IDS.customerUser, name: c.name, email: c.email, phone: c.phone, city: 'Fort Lauderdale', zip: '33301' },
    });
  }
  const pending = [
    { id: IDS.b1, customerId: IDS.custEmailOnly, ref: REFS.b1 },
    { id: IDS.b2, customerId: IDS.custBoth, ref: REFS.b2 },
    { id: IDS.b3, customerId: IDS.custEmailOnly, ref: REFS.b3 },
  ];
  for (const b of pending) {
    await prisma.serviceRequest.upsert({
      where: { id: b.id },
      update: { referenceCode: b.ref, status: 'PENDING_DISPATCH' },
      create: {
        id: b.id, companyId: PLATFORM_COMPANY_ID, customerId: b.customerId,
        city: 'Fort Lauderdale', zip: '33301', appliance: 'Refrigerator', issue: 'Not cooling',
        referenceCode: b.ref, source: 'review-funnel-drill', status: 'PENDING_DISPATCH',
      },
    });
  }
  // Sweep fixtures: already COMPLETED before the server boots, so the
  // store hydrates them (and their seeded ask rows) from the database.
  const now = Date.now();
  const sweepBookings = [
    { id: IDS.r1, ref: REFS.r1, completedDaysAgo: 4, ask: true },
    { id: IDS.r2, ref: REFS.r2, completedDaysAgo: 4, ask: true },
    { id: IDS.r3, ref: REFS.r3, completedDaysAgo: 1, ask: true },
    { id: IDS.r4, ref: REFS.r4, completedDaysAgo: 4, ask: false },
    { id: IDS.r5, ref: REFS.r5, completedDaysAgo: 4, ask: true },
  ];
  for (const b of sweepBookings) {
    await prisma.serviceRequest.upsert({
      where: { id: b.id },
      update: { referenceCode: b.ref, status: 'COMPLETED', completedAt: new Date(now - b.completedDaysAgo * DAY) },
      create: {
        id: b.id, companyId: PLATFORM_COMPANY_ID, customerId: IDS.custSweep,
        city: 'Fort Lauderdale', zip: '33301', appliance: 'Dryer', issue: 'No heat',
        referenceCode: b.ref, source: 'review-funnel-drill', status: 'COMPLETED',
        completedAt: new Date(now - b.completedDaysAgo * DAY), completedBy: 'Service Setters',
      },
    });
    if (b.ask) {
      await prisma.notificationOutbox.upsert({
        where: { eventKey: `booking:${b.id}:review:email` },
        update: {},
        create: {
          companyId: PLATFORM_COMPANY_ID, channel: 'email', template: 'REVIEW_REQUEST',
          to: EMAILS.sweep, status: 'QUEUED', eventType: 'BOOKING',
          eventKey: `booking:${b.id}:review:email`,
          payload: { bookingId: b.id, referenceCode: b.ref, customerName: 'Sweep Customer', appliance: 'Dryer', message: 'seeded ask' },
        },
      });
    }
  }
  // R2 already has a review — its reminder must never fire.
  await prisma.review.upsert({
    where: { id: IDS.reviewR2 },
    update: {},
    create: {
      id: IDS.reviewR2, companyId: PLATFORM_COMPANY_ID, customerId: IDS.customerUser,
      bookingId: IDS.r2, rating: 5, title: 'Great work', body: 'Fixed fast and clean.',
      status: 'PUBLISHED', verifiedRepair: true,
    },
  });
}

async function cleanup() {
  const bookingIds = [IDS.b1, IDS.b2, IDS.b3, IDS.r1, IDS.r2, IDS.r3, IDS.r4, IDS.r5];
  await prisma.notificationOutbox.deleteMany({ where: { eventKey: { startsWith: 'booking:' } } }).catch(() => {});
  await prisma.review.deleteMany({ where: { bookingId: { in: bookingIds } } }).catch(() => {});
  await prisma.pepperReport.deleteMany({ where: { title: { contains: 'Customer feedback' } } }).catch(() => {});
  await prisma.serviceRequest.deleteMany({ where: { id: { in: bookingIds } } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { id: { in: [IDS.custEmailOnly, IDS.custBoth, IDS.custSweep] } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: [IDS.staff, IDS.customerUser] } } }).catch(() => {});
}

async function waitForServer() {
  // Boot on this VM takes ~17s idle and longer under load; poll for
  // up to ~90s before giving up.
  for (let i = 0; i < 180; i += 1) {
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
  childEnv['JWT_' + 'SECRET'] = 'funnel-drill-secret';
  // No provider keys: nothing can actually send; entries stay in
  // honest QUEUED/GATED states. No Google review URL: the funnel's
  // Google ask must carry prose only, never an invented link.
  delete childEnv['RESEND_' + 'API_KEY'];
  delete childEnv['SENDGRID_' + 'API_KEY'];
  delete childEnv['TWILIO_' + 'ACCOUNT_SID'];
  delete childEnv['TWILIO_' + 'AUTH_TOKEN'];
  delete childEnv['VONAGE_' + 'API_KEY'];
  delete childEnv['VONAGE_' + 'API_SECRET'];
  delete childEnv['GOOGLE_' + 'REVIEW_URL'];
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

async function run() {
  await seed();
  await bootServer();
  const staffToken = await login(EMAILS.staff);

  /* ---------------- A2: honest absence over HTTP ---------------- */
  const gr = await api('/google-reviews');
  check('A2 GET /google-reviews answers 200', gr.status, 200);
  check('A2 unavailable while GBP is not connected', gr.json?.data?.available, false);
  check('A2 serves zero reviews', gr.json?.data?.reviews?.length, 0);
  check('A2 serves no aggregate', gr.json?.data?.aggregate, null);

  /* ------------- F1: completion queues exactly one ask ---------- */
  const complete1 = await api(`/bookings/${IDS.b1}/complete`, { token: staffToken, method: 'POST', body: {} });
  check('B1 completion succeeds', complete1.status, 200);
  check('B1 completion reports one queued notification', complete1.json?.data?.notificationsQueued?.length, 1);
  let b1Asks = await outboxRows({ template: 'REVIEW_REQUEST', bookingId: IDS.b1 });
  check('B1 has exactly one REVIEW_REQUEST (email only)', b1Asks.length, 1);
  check('B1 ask channel is email', b1Asks[0]?.channel, 'email');
  checkIncludes('B1 ask carries the Pepper Lists review link', b1Asks[0]?.payload?.message, 'https://pepperlists.com/#reviews');
  checkIncludes('B1 ask carries the feedback link with its reference', b1Asks[0]?.payload?.message, `https://topspeedserviceos.com/feedback?ref=${REFS.b1}`);
  check('B1 ask payload records the Pepper Lists link', b1Asks[0]?.payload?.reviewLinks?.pepperListsReviewUrl, 'https://pepperlists.com/#reviews');
  check('B1 ask payload records NO Google link (URL unset)', b1Asks[0]?.payload?.reviewLinks?.googleReviewUrl, null);
  checkExcludes('B1 ask message carries no invented Google URL', b1Asks[0]?.payload?.message, 'g.page');
  checkIncludes('B1 ask still asks for a Google review in prose', b1Asks[0]?.payload?.message, 'search "Top Speed Appliance" on Google');

  const replay = await api(`/bookings/${IDS.b1}/complete`, { token: staffToken, method: 'POST', body: {} });
  check('B1 completion replay is refused (already completed)', replay.status, 409);
  b1Asks = await outboxRows({ template: 'REVIEW_REQUEST', bookingId: IDS.b1 });
  check('B1 still has exactly one ask after the replay', b1Asks.length, 1);

  /* ------------- F1: both channels, SMS carries one link -------- */
  const complete2 = await api(`/bookings/${IDS.b2}/complete`, { token: staffToken, method: 'POST', body: {} });
  check('B2 completion succeeds', complete2.status, 200);
  const b2Asks = await outboxRows({ template: 'REVIEW_REQUEST', bookingId: IDS.b2 });
  check('B2 has one ask per channel (email + SMS)', b2Asks.length, 2);
  const b2Sms = b2Asks.find((row) => row.channel === 'sms');
  check('B2 SMS ask exists', Boolean(b2Sms), true);
  check('B2 SMS carries exactly one link', (b2Sms?.payload?.message?.match(/https:\/\//g) || []).length, 1);
  checkIncludes('B2 SMS link is the Pepper Lists review link', b2Sms?.payload?.message, 'https://pepperlists.com/#reviews');

  /* ------------- F1: feedback never suppresses the ask ---------- */
  const fbEarly = await api('/feedback', { method: 'POST', body: { message: 'The tech was late and nobody called.', referenceCode: REFS.b3, name: 'Early Bird', email: EMAILS.emailOnly } });
  check('feedback before completion is accepted', fbEarly.status, 201);
  const complete3 = await api(`/bookings/${IDS.b3}/complete`, { token: staffToken, method: 'POST', body: {} });
  check('B3 completion succeeds after feedback', complete3.status, 200);
  const b3Asks = await outboxRows({ template: 'REVIEW_REQUEST', bookingId: IDS.b3 });
  check('B3 ask STILL queued — feedback does not suppress it', b3Asks.length, 1);

  /* ------------- F1: feedback files a report, not a review ------ */
  const reportsBefore = await prisma.pepperReport.count({ where: { title: { contains: 'Customer feedback' } } });
  const fb = await api('/feedback', { method: 'POST', body: { message: 'Fridge still warm the next day.', referenceCode: REFS.b1, name: 'Email Only', phone: '9545550100' } });
  check('feedback is accepted', fb.status, 201);
  check('feedback answers received:true', fb.json?.data?.received, true);
  const reportsAfter = await prisma.pepperReport.count({ where: { title: { contains: 'Customer feedback' } } });
  check('feedback filed exactly one more report', reportsAfter - reportsBefore, 1);
  const queue = await api('/pepper-console/reports', { token: staffToken });
  const filed = (queue.json?.data || []).find((row) => row.title === `Customer feedback — booking ${REFS.b1}`);
  check('the report is visible in the staff Pepper queue', Boolean(filed), true);
  check('the report category is NEEDS_OWNER', filed?.category, 'NEEDS_OWNER');
  checkIncludes('the report body carries the customer words', filed?.body, 'Fridge still warm the next day.');
  const b1Reviews = await prisma.review.count({ where: { bookingId: IDS.b1 } });
  check('feedback created NO review', b1Reviews, 0);

  const fbHoneypot = await api('/feedback', { method: 'POST', body: { message: 'bot spam words here', referenceCode: REFS.b1, companyWebsite: 'http://spam.example' } });
  check('honeypot feedback gets the same 201 shape', fbHoneypot.status, 201);
  const reportsAfterHoneypot = await prisma.pepperReport.count({ where: { title: { contains: 'Customer feedback' } } });
  check('honeypot filed NO report', reportsAfterHoneypot, reportsAfter);
  const fbInvalid = await api('/feedback', { method: 'POST', body: { message: '' } });
  check('empty feedback is a 400', fbInvalid.status, 400);

  /* ------------- F1: the reminder sweep -------------------------- */
  check('reminder delay constant is 3 days', REVIEW_REMINDER_DELAY_MS, 3 * DAY);
  const fbR5 = await api('/feedback', { method: 'POST', body: { message: 'Unhappy with the wait.', referenceCode: REFS.r5 } });
  check('R5 feedback accepted', fbR5.status, 201);

  const drain1 = await api('/notifications/send', { token: staffToken, method: 'POST', body: {} });
  check('first drain succeeds', drain1.status, 200);
  check('first drain sweep reminded exactly R1 + R5', drain1.json?.data?.reviewReminders?.reminded, 2);
  check('R1 reminder queued once', (await outboxRows({ template: 'REVIEW_REMINDER', bookingId: IDS.r1 })).length, 1);
  check('R5 reminder queued DESPITE its feedback', (await outboxRows({ template: 'REVIEW_REMINDER', bookingId: IDS.r5 })).length, 1);
  check('R2 (already reviewed) got no reminder', (await outboxRows({ template: 'REVIEW_REMINDER', bookingId: IDS.r2 })).length, 0);
  check('R3 (completed 1 day ago) got no reminder', (await outboxRows({ template: 'REVIEW_REMINDER', bookingId: IDS.r3 })).length, 0);
  check('R4 (ask never sent) got no reminder', (await outboxRows({ template: 'REVIEW_REMINDER', bookingId: IDS.r4 })).length, 0);
  check('B1 (just completed) got no reminder', (await outboxRows({ template: 'REVIEW_REMINDER', bookingId: IDS.b1 })).length, 0);
  const r1Reminder = (await outboxRows({ template: 'REVIEW_REMINDER', bookingId: IDS.r1 }))[0];
  checkIncludes('R1 reminder carries the Pepper Lists link', r1Reminder?.payload?.message, 'https://pepperlists.com/#reviews');
  checkIncludes('R1 reminder carries the feedback link', r1Reminder?.payload?.message, `https://topspeedserviceos.com/feedback?ref=${REFS.r1}`);

  const drain2 = await api('/notifications/send', { token: staffToken, method: 'POST', body: {} });
  check('second drain sweep reminded nobody new', drain2.json?.data?.reviewReminders?.reminded, 0);
  check('R1 reminder still exactly one after re-sweep', (await outboxRows({ template: 'REVIEW_REMINDER', bookingId: IDS.r1 })).length, 1);

  /* ------------- A2: mocked-source mapping (drill only) --------- */
  let fetchCalled = false;
  const notConnected = await fetchGoogleReviews({
    connection: { connected: false, status: 'not_connected' },
    fetchImpl: async () => { fetchCalled = true; throw new Error('must not be called'); },
  });
  check('A2 not-connected short-circuits', notConnected.available, false);
  check('A2 not-connected never calls Google', fetchCalled, false);
  check('A2 not-connected reason', notConnected.reason, 'GBP_NOT_CONNECTED');

  const noGrant = await fetchGoogleReviews({ connection: { connected: true, status: 'connected' }, grant: null });
  check('A2 connected-without-grant is unavailable', noGrant.available, false);
  check('A2 connected-without-grant reason', noGrant.reason, 'GBP_GRANT_MISSING');

  const mockPayload = {
    averageRating: 4.5,
    totalReviewCount: 12,
    reviews: [
      { reviewId: 'g1', reviewer: { displayName: 'Maria G.' }, starRating: 'FIVE', comment: 'Fixed our fridge the same day.', createTime: '2026-11-10T15:00:00Z', updateTime: '2026-11-10T15:00:00Z' },
      { reviewId: 'g2', reviewer: { displayName: 'James W.' }, starRating: 'FOUR', comment: 'Good work, fair price.', createTime: '2026-11-12T15:00:00Z', updateTime: '2026-11-12T15:00:00Z' },
    ],
  };
  const mocked = await fetchGoogleReviews({
    connection: { connected: true, status: 'connected' },
    grant: { accessToken: 'drill-token', locationName: 'accounts/1/locations/2' },
    fetchImpl: async (url, options) => {
      checkIncludes('A2 fetch targets the GBP reviews endpoint', url, 'mybusiness.googleapis.com/v4/accounts/1/locations/2/reviews');
      check('A2 fetch carries the grant token', options?.headers?.Authorization, 'Bearer drill-token');
      return { ok: true, json: async () => mockPayload };
    },
  });
  check('A2 mocked source is available', mocked.available, true);
  check('A2 mocked source maps both reviews', mocked.reviews.length, 2);
  check('A2 newest review sorts first', mocked.reviews[0]?.authorName, 'James W.');
  check('A2 star enum maps to a number', mocked.reviews[1]?.rating, 5);
  check('A2 review text maps through', mocked.reviews[1]?.text, 'Fixed our fridge the same day.');
  check('A2 aggregate uses Google count', mocked.aggregate?.count, 12);
  check('A2 aggregate uses Google average', mocked.aggregate?.average, 4.5);

  // The sweep function itself is importable and safe to call in-process.
  check('sweep export exists', typeof sweepReviewReminders, 'function');

  await stopServer();
}

run()
  .catch((error) => {
    failures += 1;
    console.error('DRILL ERROR:', error);
  })
  .finally(async () => {
    await stopServer();
    await cleanup();
    await prisma.$disconnect();
    if (failures) {
      console.log(`\n${failures} CHECK(S) FAILED`);
      process.exit(1);
    }
    console.log('\nALL REVIEW-FUNNEL CHECKS PASSED');
  });
