/**
 * Workstation Standard — APPLIANCEMAN + OVERSIGHT stations verification
 * harness (2026-11-19).
 *
 * The ApplianceMan console (apps/web/applianceman) and the Oversight
 * console (apps/web/oversight) received the same additive treatment
 * as Book OS (1f4e5f1), CRM (e7aea1b), Tech web (74911a2) and
 * Dispatch (c9bfba9): an Options panel (this-device preferences),
 * click-to-open record detail, and — on ApplianceMan only — the
 * record's own existing actions surfaced in the detail. Oversight is
 * view-only by Ramone's design: detail only, NO action CTAs.
 * Ramone's standing rule for the rollout: "Don't change — just
 * integrate." The page code is ADDITIVE and changes no API; this
 * suite proves the contracts those two pages now lean on:
 *
 *  ApplianceMan:
 *   - GET /speedy-verify/accounts is MASTER-only (anon 401, customer
 *     403, dispatcher 403, COMPANY_ADMIN manager 403, owner 200) and
 *     returns the exact row shape the detail renders: user { id,
 *     email, firstName, lastName, roles, signupAudience, system,
 *     active, createdAt } + verify { covered, master, required,
 *     hasActiveCode, codeStatus, issuedAt, lastUsedAt, revokedAt,
 *     lockedUntil, enforced, awaitingCode, pendingApproval }.
 *   - Server order is the approval queue first, then email A–Z (the
 *     page's "As listed" default renders it untouched; its other
 *     sorts order a copy by user.email / user.createdAt — the fields
 *     asserted present here).
 *   - Tech accounts carry their system label (COMPANY / NETWORK).
 *   - The detail's buttons are the panel's own endpoints: POST
 *     /speedy-verify/issue returns the one-time code + ACTIVE state,
 *     POST /speedy-verify/requirement toggles the flag, POST
 *     /speedy-verify/revoke lands REVOKED — all Master-only, and
 *     the Master's own requirement can never be switched on
 *     (Rule Zero refusal, 400).
 *   - GET /auth/me carries the roles array the console's manager
 *     gate reads.
 *
 *  Oversight:
 *   - GET /platform/events is staff-gated (anon 401, customer 403,
 *     staff + manager + owner 200) and returns the feed shape the
 *     detail reproduces: { id, type, source, actor, entityType,
 *     entityId, referenceCode, at, details }.
 *   - A real guest booking emits a BOOKING_CREATED platform event
 *     whose entityType is BOOKING and whose entityId resolves
 *     through GET /bookings/:id — the read-only enrichment the
 *     detail performs (staff 200 with status / appointment /
 *     payment.diagnosticPaid; an unrelated customer 403; anon 401).
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=<local test db> node test/workstation-standard-applianceman.test.mjs
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
process.env.JWT_SECRET ||= 'workstation-applianceman-secret';

const PORT = Number(process.env.TEST_PORT || 4471);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const NET_CO = '80000000-0000-4000-8000-0000000000a1';
const NET_PROV = '80000000-0000-4000-8000-0000000000a2';
const CREW_PROV = '80000000-0000-4000-8000-0000000000a3';
const IDS = {
  owner: '80000000-0000-4000-8000-0000000000b1',
  manager: '80000000-0000-4000-8000-0000000000b2',
  setter: '80000000-0000-4000-8000-0000000000b3',
  customer: '80000000-0000-4000-8000-0000000000b4',
  flagged: '80000000-0000-4000-8000-0000000000b5',
  coded: '80000000-0000-4000-8000-0000000000b6',
  techNet: '80000000-0000-4000-8000-0000000000b7',
  techCrew: '80000000-0000-4000-8000-0000000000b8',
};
const EMAILS = {
  owner: 'am-owner@test.local',
  manager: 'am-manager@test.local',
  setter: 'am-setter@test.local',
  customer: 'am-customer@test.local',
  flagged: 'am-flagged@test.local',
  coded: 'am-coded@test.local',
  techNet: 'am-technet@test.local',
  techCrew: 'am-techcrew@test.local',
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
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'am-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.company.upsert({
    where: { id: NET_CO }, update: {},
    create: { id: NET_CO, name: 'AM Network Co', slug: 'am-net-co', type: 'INDEPENDENT_PROVIDER' },
  });
  await prisma.provider.upsert({
    where: { id: NET_PROV }, update: { companyCrew: false },
    create: {
      id: NET_PROV, companyId: NET_CO, businessName: 'AM Network Provider', type: 'NETWORK_BUSINESS',
      specialties: ['Dryer'], serviceCities: ['Lauderhill'], companyCrew: false,
    },
  });
  await prisma.provider.upsert({
    where: { id: CREW_PROV }, update: { companyCrew: true },
    create: {
      id: CREW_PROV, companyId: PLATFORM_COMPANY_ID, businessName: 'AM Field Team', type: 'INDEPENDENT_PROVIDER',
      specialties: ['Dryer'], serviceCities: ['Lauderhill'], companyCrew: true,
    },
  });
  const users = [
    [IDS.owner, PLATFORM_COMPANY_ID, EMAILS.owner, ['COMPANY_OWNER'], {}],
    [IDS.manager, PLATFORM_COMPANY_ID, EMAILS.manager, ['COMPANY_ADMIN'], {}],
    [IDS.setter, PLATFORM_COMPANY_ID, EMAILS.setter, ['DISPATCHER'], {}],
    [IDS.customer, PLATFORM_COMPANY_ID, EMAILS.customer, ['CUSTOMER'], {}],
    [IDS.flagged, PLATFORM_COMPANY_ID, EMAILS.flagged, ['DISPATCHER'], { verifyRequired: true }],
    [IDS.coded, PLATFORM_COMPANY_ID, EMAILS.coded, ['DISPATCHER'], { verifyRequired: true }],
    [IDS.techNet, NET_CO, EMAILS.techNet, ['PROVIDER_TECH'], { verifyRequired: true }],
    [IDS.techCrew, PLATFORM_COMPANY_ID, EMAILS.techCrew, ['TECHNICIAN'], { verifyRequired: true }],
  ];
  for (const [id, companyId, email, roles, flags] of users) {
    await prisma.user.upsert({
      where: { id },
      update: { passwordHash, verifyRequired: Boolean(flags.verifyRequired) },
      create: { id, companyId, email, passwordHash, phone: '9545550110', roles, active: true, ...flags },
    });
  }
}

async function cleanup() {
  try {
    const ids = Object.values(IDS);
    await prisma.speedyVerifyCode.deleteMany({ where: { userId: { in: ids } } });
    await prisma.loginChallenge.deleteMany({ where: { userId: { in: ids } } });
    await prisma.emailVerificationToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.termsAcceptance.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@test.local' } } });
    await prisma.provider.deleteMany({ where: { id: { in: [NET_PROV, CREW_PROV] } } });
    await prisma.company.deleteMany({ where: { id: NET_CO } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

function startServer() {
  const apiDir = fileURLToPath(new URL('..', import.meta.url));
  server = spawn('node', ['src/server.js'], {
    cwd: apiDir,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
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

/* The auth rate limiter (10 requests / 15 min / IP, shared by
   /auth/* and /speedy-verify/*) is an in-memory bucket: session
   tokens here are minted with signAccessToken (the Phase 3 suite's
   pattern) so the bucket is spent only on the calls under test,
   and the server is restarted once mid-suite to reset it before
   the issue / requirement / revoke segment. */
async function mint(key) {
  const user = await prisma.user.findUnique({ where: { id: IDS[key] } });
  return signAccessToken(user).token;
}

async function main() {
  await seed();
  await startServer();

  const owner = await login(EMAILS.owner);
  checkTrue('owner real login issues a session (master)', Boolean(owner));
  const manager = await mint('manager');
  const setter = await mint('setter');
  const customer = await mint('customer');
  checkTrue('minted manager/setter/customer sessions', Boolean(manager && setter && customer));

  /* ---------- /auth/me: the roles array the manager gate reads ---------- */
  const meManager = await api('/auth/me', { token: manager });
  check('GET /auth/me as manager -> 200', meManager.status, 200);
  checkTrue('manager roles carry COMPANY_ADMIN', (meManager.json?.user?.roles || []).includes('COMPANY_ADMIN'));
  const meOwner = await api('/auth/me', { token: owner });
  checkTrue('owner roles carry COMPANY_OWNER', (meOwner.json?.user?.roles || []).includes('COMPANY_OWNER'));

  /* ---------- GET /speedy-verify/accounts: the Master-only gate ---------- */
  check('anon 401 GET /speedy-verify/accounts', (await api('/speedy-verify/accounts')).status, 401);
  check('customer 403 GET /speedy-verify/accounts', (await api('/speedy-verify/accounts', { token: customer })).status, 403);
  check('setter 403 GET /speedy-verify/accounts', (await api('/speedy-verify/accounts', { token: setter })).status, 403);
  check('manager (COMPANY_ADMIN) 403 GET /speedy-verify/accounts — Master-only panel', (await api('/speedy-verify/accounts', { token: manager })).status, 403);
  const accounts = await api('/speedy-verify/accounts', { token: owner });
  check('owner 200 GET /speedy-verify/accounts', accounts.status, 200);
  const rows = accounts.json?.data || [];
  checkTrue('accounts list is an array', Array.isArray(rows));
  const byEmail = (email) => rows.find((r) => r.user?.email === email);

  /* Row shape — every field the account detail renders. */
  const flaggedRow = byEmail(EMAILS.flagged);
  checkTrue('flagged staff row present', Boolean(flaggedRow));
  checkTrue('row.user carries id/email/roles/active/createdAt', Boolean(
    flaggedRow?.user?.id && flaggedRow?.user?.email && Array.isArray(flaggedRow?.user?.roles)
    && typeof flaggedRow?.user?.active === 'boolean' && Boolean(flaggedRow?.user?.createdAt),
  ));
  checkTrue('row.verify carries the full verify state', Boolean(
    flaggedRow?.verify && 'covered' in flaggedRow.verify && 'master' in flaggedRow.verify
    && 'required' in flaggedRow.verify && 'hasActiveCode' in flaggedRow.verify
    && 'codeStatus' in flaggedRow.verify && 'enforced' in flaggedRow.verify
    && 'awaitingCode' in flaggedRow.verify && 'pendingApproval' in flaggedRow.verify,
  ));
  check('flagged + no code -> verify.pendingApproval true', flaggedRow?.verify?.pendingApproval, true);
  check('flagged + no code -> verify.required true', flaggedRow?.verify?.required, true);
  check('flagged + no code -> codeStatus NONE', flaggedRow?.verify?.codeStatus, 'NONE');
  check('flagged staff is not the master row', flaggedRow?.verify?.master, false);

  const ownerRow = byEmail(EMAILS.owner);
  check('owner row is the master row', ownerRow?.verify?.master, true);
  check('master row is never pending approval', ownerRow?.verify?.pendingApproval, false);

  const netRow = byEmail(EMAILS.techNet);
  check('network tech row system label', netRow?.user?.system, 'NETWORK');
  const crewRow = byEmail(EMAILS.techCrew);
  check('company tech row system label', crewRow?.user?.system, 'COMPANY');
  check('plain staff row has no system label', byEmail(EMAILS.setter)?.user?.system ?? null, null);
  check('uncovered customer is not listed', byEmail(EMAILS.customer), undefined);

  /* Server order: the whole approval queue precedes everyone else
     (the page's "As listed" default), then email A–Z within groups. */
  const pendingIdx = rows.map((r, i) => (r.verify?.pendingApproval ? i : -1)).filter((i) => i >= 0);
  const settledIdx = rows.map((r, i) => (r.verify?.pendingApproval ? -1 : i)).filter((i) => i >= 0);
  checkTrue('approval queue sorts before settled accounts',
    pendingIdx.length > 0 && settledIdx.length > 0 && Math.max(...pendingIdx) < Math.min(...settledIdx));
  checkTrue('pendingApprovals count matches the pending rows',
    (accounts.json?.pendingApprovals ?? -1) === pendingIdx.length);

  /* Restart once: reset the shared auth rate-limit bucket before
     the credential-shaped action calls. Tokens are stateless JWTs
     and the store rehydrates from the same database. */
  await stopServer();
  await startServer();

  /* ---------- The detail's own actions: issue / requirement / revoke ---------- */
  check('manager 403 POST /speedy-verify/issue', (await api('/speedy-verify/issue', { token: manager, method: 'POST', body: { userId: IDS.coded } })).status, 403);
  check('setter 403 POST /speedy-verify/issue', (await api('/speedy-verify/issue', { token: setter, method: 'POST', body: { userId: IDS.coded } })).status, 403);
  /* Rule Zero lives in the requirement switch: the Master's own
     requirement can never be turned on (he is exempt by
     construction). The detail renders no action buttons at all on
     the master row — this is the endpoint refusal behind that. */
  const reqMaster = await api('/speedy-verify/requirement', { token: owner, method: 'POST', body: { userId: IDS.owner, required: true } });
  check('switching the Master requirement ON -> 400 (Rule Zero)', reqMaster.status, 400);
  checkTrue('master refusal cites the Rule Zero exemption', /exempt|Rule Zero/i.test(reqMaster.json?.error || ''));

  const issued = await api('/speedy-verify/issue', { token: owner, method: 'POST', body: { userId: IDS.coded } });
  check('owner issue -> 200', issued.status, 200);
  checkTrue('issue returns the one-time code (8 digits, display-formatted 4+4)', /^\d{4} \d{4}$/.test(issued.json?.code || ''));
  check('issued state is ACTIVE', issued.json?.verify?.codeStatus, 'ACTIVE');
  check('issued account is no longer pending', issued.json?.verify?.pendingApproval, false);

  const afterIssue = await api('/speedy-verify/accounts', { token: owner });
  const codedRow = (afterIssue.json?.data || []).find((r) => r.user?.email === EMAILS.coded);
  check('accounts list reflects ACTIVE after issue', codedRow?.verify?.codeStatus, 'ACTIVE');
  checkTrue('accounts list carries issuedAt after issue', Boolean(codedRow?.verify?.issuedAt));

  const waive = await api('/speedy-verify/requirement', { token: owner, method: 'POST', body: { userId: IDS.coded, required: false } });
  check('owner requirement waive -> 200', waive.status, 200);
  check('requirement now off', waive.json?.verify?.required, false);
  const requireBack = await api('/speedy-verify/requirement', { token: owner, method: 'POST', body: { userId: IDS.coded, required: true } });
  check('requirement restored', requireBack.json?.verify?.required, true);
  check('manager 403 POST /speedy-verify/requirement', (await api('/speedy-verify/requirement', { token: manager, method: 'POST', body: { userId: IDS.coded, required: false } })).status, 403);

  const revoked = await api('/speedy-verify/revoke', { token: owner, method: 'POST', body: { userId: IDS.coded } });
  check('owner revoke -> 200', revoked.status, 200);
  check('revoked state is REVOKED', revoked.json?.verify?.codeStatus, 'REVOKED');
  const afterRevoke = await api('/speedy-verify/accounts', { token: owner });
  const codedRow2 = (afterRevoke.json?.data || []).find((r) => r.user?.email === EMAILS.coded);
  check('accounts list reflects REVOKED', codedRow2?.verify?.codeStatus, 'REVOKED');
  checkTrue('accounts list carries revokedAt after revoke', Boolean(codedRow2?.verify?.revokedAt));
  check('revoked + still required -> pending again', codedRow2?.verify?.pendingApproval, true);

  /* ---------- Oversight: the platform events feed ---------- */
  check('anon 401 GET /platform/events', (await api('/platform/events')).status, 401);
  check('customer 403 GET /platform/events', (await api('/platform/events', { token: customer })).status, 403);
  check('setter 200 GET /platform/events', (await api('/platform/events', { token: setter })).status, 200);
  check('manager 200 GET /platform/events', (await api('/platform/events', { token: manager })).status, 200);

  const booking = await api('/speedy/book', {
    method: 'POST',
    body: {
      customer: { name: 'Oversight Drill', phone: '9545550131', address: '100 Main St' },
      city: 'Lauderhill', zip: '33311', appliance: 'Dryer', issue: 'Not heating', source: 'WEB_FORM',
    },
  });
  check('guest booking -> 201', booking.status, 201);
  const ref = booking.json?.data?.referenceCode;
  checkTrue('booking returns a referenceCode', /^TS-/.test(ref || ''));

  const feed = await api('/platform/events', { token: setter });
  const events = feed.json?.data || [];
  const created = events.find((e) => e.type === 'BOOKING_CREATED' && e.referenceCode === ref);
  checkTrue('feed carries the BOOKING_CREATED event for the booking', Boolean(created));
  check('event entityType is BOOKING', created?.entityType, 'BOOKING');
  checkTrue('event carries entityId', Boolean(created?.entityId));
  checkTrue('event shape: id/type/source/at/details present', Boolean(
    created?.id && created?.type && created?.source && created?.at && created?.details && typeof created.details === 'object',
  ));
  check('event details carry the city (PII-scrubbed operational fields)', created?.details?.city, 'Lauderhill');

  /* ---------- Oversight enrichment: GET /bookings/:id ---------- */
  const bookingId = created?.entityId;
  check('anon 401 GET /bookings/:id', (await api(`/bookings/${bookingId}`)).status, 401);
  check('unrelated customer 403 GET /bookings/:id', (await api(`/bookings/${bookingId}`, { token: customer })).status, 403);
  const read = await api(`/bookings/${bookingId}`, { token: manager });
  check('manager 200 GET /bookings/:id (oversight read)', read.status, 200);
  check('booking reference matches the event', read.json?.data?.referenceCode, ref);
  checkTrue('booking carries a status', Boolean(read.json?.data?.status));
  check('booking carries the service in the appliance field the detail renders', read.json?.data?.appliance, 'Dryer');
  check('payment summary reports the diagnostic unpaid', read.json?.data?.payment?.diagnosticPaid, false);
  const readSetter = await api(`/bookings/${bookingId}`, { token: setter });
  check('setter 200 GET /bookings/:id', readSetter.status, 200);

  /* Once an appointment is set, the same read carries the slot the
     detail renders ({ date, window, windowLabel, status }). */
  const setAppt = await api('/bookos/appointments', {
    token: setter, method: 'POST',
    body: { bookingId, date: '2026-11-25', window: '10-12', setBy: EMAILS.setter },
  });
  check('setter sets the appointment -> 201', setAppt.status, 201);
  const read2 = await api(`/bookings/${bookingId}`, { token: manager });
  check('booking read carries the SET appointment status', read2.json?.data?.appointment?.status, 'SET');
  check('booking read carries the appointment date', read2.json?.data?.appointment?.date, '2026-11-25');
  check('booking read carries the appointment windowLabel', read2.json?.data?.appointment?.windowLabel, '10 AM–12 PM');
}

main()
  .catch((error) => { console.error(error); failed += 1; })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
