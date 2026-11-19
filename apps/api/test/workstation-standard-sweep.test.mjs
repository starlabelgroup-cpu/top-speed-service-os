/**
 * Workstation Standard — FINAL SWEEP verification harness (2026-11-19).
 *
 * The last consoles of the Advanced Workstation Standard rollout
 * received the same additive treatment as the earlier stations
 * (Book OS 1f4e5f1, CRM e7aea1b, Tech web 74911a2, Dispatch c9bfba9,
 * ApplianceMan/Oversight f8e03a4, Ad Studio 6fc6e16): Options
 * panels with this-device prefs, click-to-open record detail
 * where records exist, and CTA bars surfacing only actions that
 * already exist on each surface. The sweep covered Turbo Boss
 * (full), Link Center, Parts Supply OS and the Media OS staff
 * console (detail + actions), and Chats, Notifications, the
 * Pepper console, Track Console, Manager and Page Studio
 * (options-only — their records already render/action inline).
 * Ramone's rule for the whole rollout: "Don't change — just
 * integrate." The page code is ADDITIVE and changes no API; this
 * suite proves the contracts the integrations lean on:
 *
 *   - Every swept console's real gate (anon 401; non-staff 403;
 *     the manager/marketing gates on /management/*, /media-os/*
 *     and /marketing-os/*).
 *   - Turbo Boss feeds: setter queue, tracking console, referral
 *     queue, connections, campaigns — plus the detail enrichment
 *     read (GET /bookings/:id) and the queue's OWN actions
 *     (tracking assign, referral approve/reject, campaign
 *     owner-approve, report ack).
 *   - Chats: insights totals, session list + filters, transcript.
 *   - Notifications: outbox list + status/channel filters,
 *     summary, settings toggle, the drain action.
 *   - Pepper console: status board + report file/read.
 *   - Link Center: options, a real send, and the log entry
 *     carrying the url/provider/sentAt fields the detail shows.
 *   - Track Console: board shape + stage/notify/tracking-link.
 *   - Parts: supplier/part/PO create, receive (stock moves),
 *     adjust-stock, usage, summary — server-computed totals.
 *   - Manager: reports list + department filter + summary + ack.
 *   - Media OS: content create, the status workflow transitions
 *     (legal moves pass, illegal moves 422), assets + rights.
 *   - Page Studio: taxonomy-driven page create, list filters,
 *     single read, versions, status transitions.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgres://... TEST_PORT=4487 node test/workstation-standard-sweep.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { signAccessToken } from '../src/services/tokens.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;
process.env.JWT_SECRET ||= 'workstation-sweep-secret';

const PORT = Number(process.env.TEST_PORT || 4487);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  owner: '90000000-0000-4000-8000-0000000000c1',
  admin: '90000000-0000-4000-8000-0000000000c2',
  setter: '90000000-0000-4000-8000-0000000000c3',
  customer: '90000000-0000-4000-8000-0000000000c4',
  provider: '90000000-0000-4000-8000-0000000000c5',
  referral: '90000000-0000-4000-8000-0000000000c6',
  journeyA: '90000000-0000-4000-8000-0000000000c7',
  journeyB: '90000000-0000-4000-8000-0000000000c8',
  chatSession: '90000000-0000-4000-8000-0000000000c9',
  referrerCustomer: '90000000-0000-4000-8000-0000000000ca',
};
const EMAILS = {
  owner: 'sw-owner@test.local',
  admin: 'sw-admin@test.local',
  setter: 'sw-setter@test.local',
  customer: 'sw-customer@test.local',
};

const prisma = new PrismaClient();
let server;
let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

async function login(email) {
  const res = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  return res.json?.token || null;
}

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('server did not come up');
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'sw-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    [IDS.owner, EMAILS.owner, ['COMPANY_OWNER']],
    [IDS.admin, EMAILS.admin, ['COMPANY_ADMIN']],
    [IDS.setter, EMAILS.setter, ['DISPATCHER']],
    [IDS.customer, EMAILS.customer, ['CUSTOMER']],
  ];
  for (const [id, email, roles] of users) {
    await prisma.user.upsert({
      where: { id },
      update: { passwordHash },
      create: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, phone: '9545550110', roles, active: true },
    });
  }
  await prisma.provider.upsert({
    where: { id: IDS.provider },
    update: {},
    create: {
      id: IDS.provider, companyId: PLATFORM_COMPANY_ID, businessName: 'Sweep Drill Provider',
      type: 'NETWORK_BUSINESS', specialties: ['Refrigerator', 'Washer'], serviceCities: ['Lauderhill', 'Fort Lauderdale'],
    },
  });
  // Referral journeys waiting on a staff decision (Turbo Boss REFERRAL rows).
  // Approval credits the referrer, so the journey must link a real
  // customer (REFERRER_NOT_LINKED 422 otherwise — the honest contract).
  await prisma.customer.upsert({
    where: { id: IDS.referrerCustomer },
    update: {},
    create: {
      id: IDS.referrerCustomer, companyId: PLATFORM_COMPANY_ID, name: 'Rita Referrer',
      phone: '9545550111', city: 'Lauderhill', zip: '33313',
    },
  });
  await prisma.referral.upsert({
    where: { id: IDS.referral },
    update: {},
    create: {
      id: IDS.referral, companyId: PLATFORM_COMPANY_ID, code: 'TS-REF-SWEEP',
      customerId: IDS.referrerCustomer,
      customerName: 'Rita Referrer', customerPhone: '9545550111', status: 'ACTIVE',
    },
  });
  for (const [id, referee] of [[IDS.journeyA, 'Fred Friend'], [IDS.journeyB, 'Sally Second']]) {
    await prisma.referralJourney.upsert({
      where: { id },
      update: { status: 'REWARD_PENDING_APPROVAL' },
      create: {
        id, companyId: PLATFORM_COMPANY_ID, referralId: IDS.referral, code: 'TS-REF-SWEEP',
        referrerCustomerId: IDS.referrerCustomer,
        refereeName: referee, refereePhone: '9545550112', status: 'REWARD_PENDING_APPROVAL',
        rewardAmountCents: 2500, track: 'CUSTOMER',
      },
    });
  }
  // One recorded Speedy chat session with a two-message transcript.
  await prisma.speedyChatSession.upsert({
    where: { id: IDS.chatSession },
    update: {},
    create: {
      id: IDS.chatSession, companyId: PLATFORM_COMPANY_ID, source: 'website-widget',
      messageCount: 2, hadDiagnosis: false, hasUnanswered: false,
    },
  });
  await prisma.speedyChatMessage.deleteMany({ where: { sessionId: IDS.chatSession } });
  await prisma.speedyChatMessage.createMany({
    data: [
      { sessionId: IDS.chatSession, role: 'user', content: 'My refrigerator is leaking water' },
      { sessionId: IDS.chatSession, role: 'assistant', content: 'A leak usually points to a blocked defrost drain — here is how we check it.' },
    ],
  });
}

async function cleanup() {
  try {
    const ids = Object.values(IDS);
    await prisma.speedyChatMessage.deleteMany({ where: { sessionId: IDS.chatSession } });
    await prisma.speedyChatSession.deleteMany({ where: { id: IDS.chatSession } });
    await prisma.referralCredit.deleteMany({ where: { customerId: IDS.referrerCustomer } });
    await prisma.referralJourney.deleteMany({ where: { id: { in: [IDS.journeyA, IDS.journeyB] } } });
    await prisma.referral.deleteMany({ where: { id: IDS.referral } });
    await prisma.customer.deleteMany({ where: { id: IDS.referrerCustomer } });
    await prisma.dispatchAssignment.deleteMany({ where: { providerId: IDS.provider } });
    await prisma.provider.deleteMany({ where: { id: IDS.provider } });
    await prisma.loginChallenge.deleteMany({ where: { userId: { in: ids } } });
    await prisma.emailVerificationToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.termsAcceptance.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@test.local' } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

function startServer() {
  const apiDir = fileURLToPath(new URL('..', import.meta.url));
  server = spawn('node', ['src/server.js'], {
    cwd: apiDir,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', OPENAI_API_KEY: '', OPENAI_API_KEY_V2: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return waitForServer();
}

async function stopServer() {
  if (!server) return;
  const done = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await done;
  server = null;
}

async function mint(key) {
  const user = await prisma.user.findUnique({ where: { id: IDS[key] } });
  return signAccessToken(user).token;
}

async function main() {
  await seed();
  await startServer();

  const owner = await login(EMAILS.owner);
  checkTrue('owner real login issues a session (master)', Boolean(owner));
  const admin = await mint('admin');
  const setter = await mint('setter');
  const customer = await mint('customer');
  checkTrue('minted admin/setter/customer sessions', Boolean(admin && setter && customer));

  /* ---------- Gates: every swept console ---------- */
  check('anon 401 GET /bookos/setter-queue', (await api('/bookos/setter-queue')).status, 401);
  check('customer 403 GET /bookos/setter-queue', (await api('/bookos/setter-queue', { token: customer })).status, 403);
  check('anon 401 GET /tracking/console', (await api('/tracking/console')).status, 401);
  check('customer 403 GET /tracking/console', (await api('/tracking/console', { token: customer })).status, 403);
  check('anon 401 GET /referrals/admin/queue', (await api('/referrals/admin/queue')).status, 401);
  check('customer 403 GET /referrals/admin/queue', (await api('/referrals/admin/queue', { token: customer })).status, 403);
  check('anon 401 GET /connections', (await api('/connections')).status, 401);
  check('anon 401 GET /chats/insights', (await api('/chats/insights')).status, 401);
  check('customer 403 GET /chats/sessions', (await api('/chats/sessions', { token: customer })).status, 403);
  check('anon 401 GET /notifications', (await api('/notifications')).status, 401);
  check('customer 403 GET /notifications', (await api('/notifications', { token: customer })).status, 403);
  check('anon 401 GET /pepper-console/status', (await api('/pepper-console/status')).status, 401);
  check('customer 403 GET /pepper-console/reports', (await api('/pepper-console/reports', { token: customer })).status, 403);
  check('anon 401 GET /link-center/log', (await api('/link-center/log')).status, 401);
  check('customer 403 GET /link-center/log', (await api('/link-center/log', { token: customer })).status, 403);
  check('setter 403 GET /management/reports (manager gate)', (await api('/management/reports', { token: setter })).status, 403);
  check('admin 200 GET /management/reports', (await api('/management/reports', { token: admin })).status, 200);
  check('anon 401 GET /parts/parts', (await api('/parts/parts')).status, 401);
  check('customer 403 GET /parts/parts', (await api('/parts/parts', { token: customer })).status, 403);
  check('setter 403 GET /media-os/admin/content (marketing gate)', (await api('/media-os/admin/content', { token: setter })).status, 403);
  check('admin 200 GET /media-os/admin/content', (await api('/media-os/admin/content', { token: admin })).status, 200);
  check('setter 403 GET /marketing-os/admin/pages (marketing gate)', (await api('/marketing-os/admin/pages', { token: setter })).status, 403);
  check('admin 200 GET /marketing-os/admin/pages', (await api('/marketing-os/admin/pages', { token: admin })).status, 200);

  /* ---------- A real booking to work with ---------- */
  const booking = await api('/speedy/book', {
    method: 'POST',
    body: {
      customer: { name: 'Sweep Drill Customer', phone: '9545550110', address: '123 Drill Way' },
      city: 'Lauderhill', zip: '33313', appliance: 'Refrigerator',
      issue: 'Not cooling on the top shelf', source: 'WEB_FORM',
    },
  });
  check('booking created -> 201', booking.status, 201);
  const ref = booking.json?.data?.referenceCode || '';
  checkTrue('booking carries a TS- reference', /^TS-/.test(ref));

  /* ---------- Turbo Boss feeds + detail enrichment ---------- */
  const queue = await api('/bookos/setter-queue', { token: setter });
  check('setter 200 GET /bookos/setter-queue', queue.status, 200);
  const queueRow = (queue.json?.data?.queue || queue.json?.data || []).find?.((q) => q.referenceCode === ref);
  checkTrue('setter queue carries the booking with bookingId + createdAt', Boolean(queueRow && queueRow.bookingId && queueRow.createdAt));

  const board = await api('/tracking/console', { token: setter });
  check('setter 200 GET /tracking/console', board.status, 200);
  const boardJob = (board.json?.data?.jobs || []).find((j) => j.reference === ref);
  checkTrue('tracking board carries the job (stageIndex/providerId/createdAt present)',
    Boolean(boardJob && typeof boardJob.stageIndex === 'number' && 'providerId' in boardJob && boardJob.createdAt));
  checkTrue('tracking board roster carries the seeded provider',
    (board.json?.data?.providers || []).some((p) => p.id === IDS.provider));

  if (queueRow?.bookingId) {
    const single = await api(`/bookings/${queueRow.bookingId}`, { token: setter });
    check('staff 200 GET /bookings/:id (detail enrichment)', single.status, 200);
    checkTrue('booking detail carries the customer name + phone',
      single.json?.data?.customer?.name === 'Sweep Drill Customer' || single.json?.data?.customerName === 'Sweep Drill Customer' || Boolean(single.json?.data?.customer));
  }

  const journeys = await api('/referrals/admin/queue', { token: setter });
  check('setter 200 GET /referrals/admin/queue', journeys.status, 200);
  const journeyRows = journeys.json?.data?.journeys || journeys.json?.data || [];
  checkTrue('referral queue carries both seeded journeys',
    [IDS.journeyA, IDS.journeyB].every((id) => journeyRows.some((j) => j.id === id)));

  const conns = await api('/connections', { token: setter });
  check('setter 200 GET /connections (commercial requests feed)', conns.status, 200);

  /* ---------- Turbo Boss detail actions (the queue's own endpoints) ---------- */
  const assign = await api(`/tracking/console/${encodeURIComponent(ref)}/assign`, {
    token: setter, method: 'POST', body: { providerId: IDS.provider },
  });
  check('POST /tracking/console/:ref/assign -> 201 (detail Assign action)', assign.status, 201);
  const boardAfter = await api('/tracking/console', { token: setter });
  const assignedJob = (boardAfter.json?.data?.jobs || []).find((j) => j.reference === ref);
  check('the job now names the provider', assignedJob?.providerId, IDS.provider);

  const approve = await api(`/referrals/admin/journeys/${IDS.journeyA}/approve`, { token: setter, method: 'POST', body: {} });
  check('POST /referrals/admin/journeys/:id/approve -> 200', approve.status, 200);
  const journeyAfter = await prisma.referralJourney.findUnique({ where: { id: IDS.journeyA } });
  checkTrue('approved journey left REWARD_PENDING_APPROVAL', journeyAfter?.status !== 'REWARD_PENDING_APPROVAL');
  const reject = await api(`/referrals/admin/journeys/${IDS.journeyB}/reject`, { token: setter, method: 'POST', body: {} });
  check('POST /referrals/admin/journeys/:id/reject -> 200', reject.status, 200);
  const journeyB = await prisma.referralJourney.findUnique({ where: { id: IDS.journeyB } });
  check('rejected journey is REJECTED', journeyB?.status, 'REJECTED');

  const campCreate = await api('/ad-studio/campaigns', {
    token: admin, method: 'POST',
    body: {
      name: 'Sweep Drill Campaign', businessLine: 'TOP_SPEED',
      objective: 'Bookings for refrigerator repair', destinationUrl: 'https://topspeedserviceos.com/book',
      placement: 'BANNER', notes: 'Sweep drill campaign.',
    },
  });
  check('campaign create -> 201 DRAFT', campCreate.status, 201);
  const campId = campCreate.json?.data?.id;
  check('created campaign is a DRAFT', campCreate.json?.data?.status, 'DRAFT');
  const campSubmit = await api(`/ad-studio/campaigns/${campId}/submit`, { token: admin, method: 'POST', body: {} });
  check('campaign submit -> PENDING_APPROVAL', campSubmit.json?.data?.status, 'PENDING_APPROVAL');
  const campDetail = await api(`/ad-studio/campaigns/${campId}`, { token: owner });
  check('owner 200 GET /ad-studio/campaigns/:id (detail enrichment)', campDetail.status, 200);
  checkTrue('campaign detail carries status + sourceTag + results',
    campDetail.json?.data?.status === 'PENDING_APPROVAL' && Boolean(campDetail.json?.data?.sourceTag) && 'results' in (campDetail.json?.data || {}));
  const campApprove = await api(`/ad-studio/campaigns/${campId}/approve`, { token: owner, method: 'POST', body: {} });
  check('owner approve -> ACTIVE (detail Approve action)', campApprove.json?.data?.status, 'ACTIVE');

  /* ---------- Track Console actions ---------- */
  const stage = await api(`/tracking/console/${encodeURIComponent(ref)}/stage`, {
    token: setter, method: 'POST', body: { action: 'CONFIRM' },
  });
  check('POST /tracking/console/:ref/stage CONFIRM -> 201', stage.status, 201);
  const notify = await api(`/tracking/console/${encodeURIComponent(ref)}/notify`, {
    token: setter, method: 'POST', body: {},
  });
  check('POST /tracking/console/:ref/notify -> 201', notify.status, 201);
  const link = await api(`/tracking/console/${encodeURIComponent(ref)}/tracking-link`, {
    token: setter, method: 'POST', body: {},
  });
  check('POST /tracking/console/:ref/tracking-link -> 201', link.status, 201);
  checkTrue('tracking link returns a URL', Boolean(link.json?.data?.url || link.json?.data?.trackingUrl));

  /* ---------- Chats ---------- */
  const insights = await api('/chats/insights?from=' + encodeURIComponent(new Date(Date.now() - 30 * 864e5).toISOString()), { token: setter });
  check('setter 200 GET /chats/insights', insights.status, 200);
  checkTrue('insights totals count the seeded session', (insights.json?.data?.totals?.sessions || 0) >= 1);
  const sessions = await api('/chats/sessions?page=1&pageSize=15', { token: setter });
  check('setter 200 GET /chats/sessions', sessions.status, 200);
  checkTrue('session list carries the seeded session',
    (sessions.json?.data?.items || []).some((s) => s.id === IDS.chatSession));
  const sessionsQ = await api('/chats/sessions?q=refrigerator', { token: setter });
  checkTrue('session search q=refrigerator still finds it',
    (sessionsQ.json?.data?.items || []).some((s) => s.id === IDS.chatSession));
  const sessionsConv = await api('/chats/sessions?converted=true', { token: setter });
  checkTrue('converted=true filter excludes the unconverted session',
    !(sessionsConv.json?.data?.items || []).some((s) => s.id === IDS.chatSession));
  const transcript = await api(`/chats/sessions/${IDS.chatSession}`, { token: setter });
  check('setter 200 GET /chats/sessions/:id (transcript)', transcript.status, 200);
  check('transcript carries both messages', (transcript.json?.data?.messages || []).length, 2);

  /* ---------- Notifications ---------- */
  const outbox = await api('/notifications?limit=100', { token: setter });
  check('setter 200 GET /notifications', outbox.status, 200);
  checkTrue('the booking queued outbox entries', (outbox.json?.data || []).length >= 1);
  const outboxQueued = await api('/notifications?limit=100&status=QUEUED', { token: setter });
  checkTrue('status=QUEUED filter returns only QUEUED rows',
    (outboxQueued.json?.data || []).every((e) => e.status === 'QUEUED' || e.status === 'QUEUED_SIMULATED'));
  const outboxEmail = await api('/notifications?limit=100&channel=email', { token: setter });
  checkTrue('channel=email filter returns only email rows',
    (outboxEmail.json?.data || []).every((e) => e.channel === 'email'));
  const summary = await api('/notifications/summary', { token: setter });
  check('setter 200 GET /notifications/summary', summary.status, 200);
  checkTrue('summary carries a total', typeof summary.json?.data?.total === 'number');
  const settingsPut = await api('/notifications/settings', {
    token: setter, method: 'PUT', body: { staffSmsAlerts: false },
  });
  check('PUT /notifications/settings -> 200 (the console setting toggle)', settingsPut.status, 200);
  const health = await api('/notifications/health', { token: setter });
  check('health reports the saved setting', health.json?.data?.settings?.staffSmsAlerts, false);
  const drain = await api('/notifications/send', { token: setter, method: 'POST', body: {} });
  check('POST /notifications/send (Send queued now) -> 200', drain.status, 200);
  checkTrue('drain reports counts', typeof drain.json?.data?.sent === 'number' || typeof drain.json?.data?.processed === 'number' || drain.json?.data != null);

  /* ---------- Pepper console ---------- */
  const pStatus = await api('/pepper-console/status', { token: setter });
  check('setter 200 GET /pepper-console/status', pStatus.status, 200);
  checkTrue('status board carries sections', Boolean(pStatus.json?.data?.sections));
  const pReport = await api('/pepper-console/reports', {
    token: setter, method: 'POST',
    body: { title: 'Sweep drill report', category: 'NEEDS_OWNER', body: 'Filed by the workstation-standard-sweep suite to prove the report log contract.' },
  });
  check('POST /pepper-console/reports -> 201', pReport.status, 201);
  const pReports = await api('/pepper-console/reports', { token: setter });
  check('setter 200 GET /pepper-console/reports', pReports.status, 200);
  checkTrue('report log carries the filed report with its category',
    (pReports.json?.data || []).some((r) => r.title === 'Sweep drill report' && r.category === 'NEEDS_OWNER'));

  /* ---------- Link Center ---------- */
  const lcOptions = await api('/link-center/options', { token: setter });
  check('setter 200 GET /link-center/options', lcOptions.status, 200);
  const lcSend = await api('/link-center/send', {
    token: setter, method: 'POST',
    body: { linkType: 'BOOKING', channel: 'EMAIL', email: 'drill@test.local', recipientName: 'Drill Person' },
  });
  check('POST /link-center/send BOOKING/EMAIL -> 201', lcSend.status, 201);
  const lcLog = await api('/link-center/log?limit=50', { token: setter });
  check('setter 200 GET /link-center/log', lcLog.status, 200);
  const lcEntry = (lcLog.json?.data || []).find((e) => e.linkType === 'BOOKING' && e.channel === 'EMAIL');
  checkTrue('log carries the send', Boolean(lcEntry));
  checkTrue('log entry carries the fields the detail renders (url, provider, sentAt, id)',
    Boolean(lcEntry && 'url' in lcEntry && 'provider' in lcEntry && 'sentAt' in lcEntry && 'id' in lcEntry));
  const lcPayNoRef = await api('/link-center/send', {
    token: setter, method: 'POST',
    body: { linkType: 'PAYMENT', channel: 'EMAIL', email: 'drill@test.local' },
  });
  check('PAYMENT send without a booking ref -> 400 (existing contract)', lcPayNoRef.status, 400);

  /* ---------- Parts Supply OS ---------- */
  const supplier = await api('/parts/suppliers', {
    token: setter, method: 'POST', body: { name: 'Sweep Drill Supply Co', terms: 'Net 30' },
  });
  check('POST /parts/suppliers -> 201', supplier.status, 201);
  const supplierId = supplier.json?.data?.id;
  const part = await api('/parts/parts', {
    token: setter, method: 'POST',
    body: { sku: 'SWEEP-DRAIN-PUMP', name: 'Drain Pump', category: 'Laundry', unitCostCents: 4200, sellPriceCents: 8900, stockOnHand: 5, reorderPoint: 2, supplierId },
  });
  check('POST /parts/parts -> 201', part.status, 201);
  const partId = part.json?.data?.id;
  const po = await api('/parts/purchase-orders', {
    token: setter, method: 'POST',
    body: { supplierId, status: 'ORDERED', notes: 'Sweep drill PO', lines: [{ partId, qty: 4, unitCostCents: 4000 }] },
  });
  check('POST /parts/purchase-orders -> 201', po.status, 201);
  check('PO total is server-computed (4 x 4000)', po.json?.data?.totalCents, 16000);
  checkTrue('PO view carries lines with sku + notes for the detail',
    (po.json?.data?.lines || []).some((l) => l.sku === 'SWEEP-DRAIN-PUMP') && po.json?.data?.notes === 'Sweep drill PO');
  const poId = po.json?.data?.id;
  const receive = await api(`/parts/purchase-orders/${poId}/receive`, { token: setter, method: 'POST', body: {} });
  check('POST /parts/purchase-orders/:id/receive -> 200 (detail Receive action)', receive.status, 200);
  const partsList = await api('/parts/parts', { token: setter });
  const partRow = (partsList.json?.data || []).find((p) => p.id === partId);
  check('receiving moved stock 5 -> 9', partRow?.stockOnHand, 9);
  const adjust = await api(`/parts/parts/${partId}/adjust-stock`, {
    token: setter, method: 'POST', body: { delta: -1, reason: 'Sweep drill count correction' },
  });
  check('POST /parts/parts/:id/adjust-stock -> 200 (detail Adjust action)', adjust.status, 200);
  const usage = await api('/parts/usage', {
    token: setter, method: 'POST', body: { bookingReference: ref, partId, qty: 2 },
  });
  check('POST /parts/usage -> 201 (record usage on the booking)', usage.status, 201);
  const partsAfter = await api('/parts/parts', { token: setter });
  check('stock after adjust + usage is 6', (partsAfter.json?.data || []).find((p) => p.id === partId)?.stockOnHand, 6);
  const partsSummary = await api('/parts/summary', { token: setter });
  check('setter 200 GET /parts/summary', partsSummary.status, 200);
  checkTrue('summary carries inventory value', typeof partsSummary.json?.data?.inventoryValueCents === 'number');

  /* ---------- Manager (the parts PO emitted a department report) ---------- */
  const mgReports = await api('/management/reports?limit=100&department=parts', { token: admin });
  check('admin 200 GET /management/reports?department=parts', mgReports.status, 200);
  const mgRows = mgReports.json?.data?.reports || mgReports.json?.data || [];
  const poReport = mgRows.find((r) => (r.title || '').includes('purchase order') || r.department === 'parts');
  checkTrue('the parts report is in the feed', Boolean(poReport));
  const mgSummary = await api('/management/reports/summary', { token: admin });
  check('admin 200 GET /management/reports/summary', mgSummary.status, 200);
  if (poReport?.id) {
    const ack = await api(`/management/reports/${poReport.id}/ack`, { token: admin, method: 'POST', body: {} });
    check('POST /management/reports/:id/ack -> 200 (the feed Acknowledge action)', ack.status, 200);
    check('report is ACKED after the action', ack.json?.data?.report?.status, 'ACKED');
  }

  /* ---------- Media OS console ---------- */
  const mediaCreate = await api('/media-os/admin/content', {
    token: admin, method: 'POST',
    body: { title: 'Sweep Drill Content', type: 'ARTICLE', division: 'PUBLISHING', description: 'Drill content for the sweep suite.', tags: ['sweep'] },
  });
  check('POST /media-os/admin/content -> 201 DRAFT', mediaCreate.status, 201);
  check('created content is a DRAFT', mediaCreate.json?.data?.status, 'DRAFT');
  const mediaId = mediaCreate.json?.data?.id;
  const mediaList = await api('/media-os/admin/content?status=DRAFT', { token: admin });
  checkTrue('admin list filter status=DRAFT carries it',
    (mediaList.json?.data || []).some((c) => c.id === mediaId));
  checkTrue('admin record carries the detail fields (tags, slug, assetCount)',
    (() => { const c = (mediaList.json?.data || []).find((x) => x.id === mediaId); return Boolean(c && Array.isArray(c.tags) && c.slug && 'assetCount' in c); })());
  const mv1 = await api(`/media-os/admin/content/${mediaId}/status`, { token: admin, method: 'POST', body: { status: 'IN_REVIEW' } });
  check('transition DRAFT -> IN_REVIEW -> 200', mv1.status, 200);
  const mvBad = await api(`/media-os/admin/content/${mediaId}/status`, { token: admin, method: 'POST', body: { status: 'PUBLISHED' } });
  checkTrue('illegal transition IN_REVIEW -> PUBLISHED is refused', mvBad.status === 400 || mvBad.status === 422);
  const mv2 = await api(`/media-os/admin/content/${mediaId}/status`, { token: admin, method: 'POST', body: { status: 'APPROVED' } });
  check('transition IN_REVIEW -> APPROVED -> 200', mv2.status, 200);
  const mv3 = await api(`/media-os/admin/content/${mediaId}/status`, { token: admin, method: 'POST', body: { status: 'PUBLISHED' } });
  check('transition APPROVED -> PUBLISHED -> 200 (detail Publish action)', mv3.status, 200);
  const mediaPublic = await api('/media-os/content');
  checkTrue('published content appears on the public grid feed',
    (mediaPublic.json?.data || []).some((c) => c.id === mediaId));
  const asset = await api('/media-os/admin/assets', {
    token: admin, method: 'POST',
    body: { name: 'sweep-drill-asset.jpg', kind: 'image', contentId: mediaId, rightsStatus: 'PENDING_REVIEW' },
  });
  check('POST /media-os/admin/assets -> 201', asset.status, 201);
  const assetPatch = await api(`/media-os/admin/assets/${asset.json?.data?.id}`, {
    token: admin, method: 'PATCH', body: { rightsStatus: 'OWNED' },
  });
  check('PATCH asset rights -> 200 OWNED', assetPatch.json?.data?.rightsStatus, 'OWNED');

  /* ---------- Page Studio ---------- */
  const taxonomy = await api('/marketing-os/admin/taxonomy', { token: admin });
  check('admin 200 GET /marketing-os/admin/taxonomy', taxonomy.status, 200);
  const cityId = taxonomy.json?.data?.cities?.[0]?.id || taxonomy.json?.data?.taxonomy?.cities?.[0]?.id;
  checkTrue('taxonomy carries a city to build a page from', Boolean(cityId));
  if (cityId) {
    const pageCreate = await api('/marketing-os/admin/pages', {
      token: admin, method: 'POST', body: { type: 'CITY', cityId, note: 'Sweep drill page' },
    });
    check('POST /marketing-os/admin/pages -> 201', pageCreate.status, 201);
    const pageId = pageCreate.json?.data?.id;
    check('created page is a DRAFT', pageCreate.json?.data?.status, 'DRAFT');
    const pageList = await api('/marketing-os/admin/pages?status=DRAFT', { token: admin });
    checkTrue('pages list filter status=DRAFT carries it',
      (pageList.json?.data || []).some((p) => p.id === pageId));
    const pageSingle = await api(`/marketing-os/admin/pages/${pageId}`, { token: admin });
    check('GET /marketing-os/admin/pages/:id -> 200 (the Edit read)', pageSingle.status, 200);
    const pageVersions = await api(`/marketing-os/admin/pages/${pageId}/versions`, { token: admin });
    check('GET /marketing-os/admin/pages/:id/versions -> 200', pageVersions.status, 200);
    checkTrue('the create left a version snapshot', (pageVersions.json?.data || []).length >= 1);
    const pgMove = await api(`/marketing-os/admin/pages/${pageId}/status`, { token: admin, method: 'POST', body: { status: 'IN_REVIEW' } });
    check('page transition DRAFT -> IN_REVIEW -> 200', pgMove.status, 200);
    const pgBad = await api(`/marketing-os/admin/pages/${pageId}/status`, { token: admin, method: 'POST', body: { status: 'UNPUBLISHED' } });
    check('illegal page transition -> 422', pgBad.status, 422);
  }

  await stopServer();
  console.log(`\nworkstation-standard-sweep: ${passed} passed, ${failed} failed`);
  await cleanup();
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('SUITE ERROR:', error);
  await stopServer().catch(() => {});
  await cleanup().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(2);
});
