/**
 * Two tech systems — verification harness (2026-11-19, Directive 5).
 *
 * ONE Service OS, two doors: Company Tech (Top Speed's own crew —
 * office-issued accounts in the platform company, classified by the
 * provider record's companyCrew flag) and Network Tech (independent
 * Service Network providers — apply-to-join, then office-issued
 * accounts in their own company). Both doors run the full sign-in
 * pipeline: scrypt password → Speedy Verify access code → Layer 2 →
 * session, plus the shared email password reset. Oversight signs in
 * at either door and stays oversight.
 *
 * Drills: classification at /provider/me for both sides + oversight;
 * cross-side job visibility (network cannot see company jobs and
 * vice versa); the Speedy Verify posture on both systems (accounts
 * start flagged verifyRequired, appear in the Master's panel as
 * awaiting a code, and the Master can issue a code — the login-time
 * code gate itself covers staff/business roles in Phase 1 and is
 * Phase 3 for provider roles per the standing rollout, so flagged
 * tech accounts sign in today); Layer 2 completion on both systems;
 * forgot/reset → new password works, old password dies, on both
 * systems; the apply-to-join intake lands a real
 * PROVIDER_APPLICATION connection.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... node test/two-tech-systems.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID, store } from '../src/data/store.js';
import { persistAssignment, persistBooking, persistCustomer } from '../src/db/bookingsRepo.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4433);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';
const NEW_PASSWORD = 'new-pass-9876';
const VERIFY_CODE = '13572468';
const LAYER2_CODE = '112233';

const GAMMA_COMPANY = '20000000-0000-4000-8000-000000000003';
const GAMMA_PROVIDER = '30000000-0000-4000-8000-000000000003';
const IDS = {
  coB: '60000000-0000-4000-8000-0000000000b1',
  provB: '60000000-0000-4000-8000-0000000000b2',
  crew: '60000000-0000-4000-8000-0000000000c1',
  net: '60000000-0000-4000-8000-0000000000c2',
  owner: '60000000-0000-4000-8000-0000000000c3',
  crewVerify: '60000000-0000-4000-8000-0000000000c4',
  netVerify: '60000000-0000-4000-8000-0000000000c5',
  crewNoCode: '60000000-0000-4000-8000-0000000000c6',
  crewL2: '60000000-0000-4000-8000-0000000000c7',
  netL2: '60000000-0000-4000-8000-0000000000c8',
  cust: '60000000-0000-4000-8000-0000000000d1',
  bkNet: '60000000-0000-4000-8000-0000000000d2',
  asNet: '60000000-0000-4000-8000-0000000000d3',
  bkCrew: '60000000-0000-4000-8000-0000000000d4',
  asCrew: '60000000-0000-4000-8000-0000000000d5',
};
const EMAILS = {
  crew: 'tts-crew@test.local',
  net: 'tts-net@test.local',
  owner: 'tts-owner@test.local',
  crewVerify: 'tts-crew-verify@test.local',
  netVerify: 'tts-net-verify@test.local',
  crewNoCode: 'tts-crew-nocode@test.local',
  crewL2: 'tts-crew-l2@test.local',
  netL2: 'tts-net-l2@test.local',
};

const prisma = new PrismaClient();
let server = null;
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function loginRaw(email, password = PASSWORD) {
  return api('/auth/login', { method: 'POST', body: { email, password } });
}
async function login(email, password = PASSWORD) {
  const { status, json } = await loginRaw(email, password);
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'tts-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.company.upsert({
    where: { id: GAMMA_COMPANY }, update: {},
    create: { id: GAMMA_COMPANY, name: 'Top Speed Field Team Co', slug: 'tts-gamma', type: 'INDEPENDENT_PROVIDER' },
  });
  await prisma.company.upsert({
    where: { id: IDS.coB }, update: {},
    create: { id: IDS.coB, name: 'TwoTech Network Co', slug: 'tts-net-co', type: 'INDEPENDENT_PROVIDER' },
  });
  await prisma.provider.upsert({
    where: { id: GAMMA_PROVIDER }, update: { companyCrew: true },
    create: {
      id: GAMMA_PROVIDER, companyId: GAMMA_COMPANY, businessName: 'Top Speed Field Team', type: 'INDEPENDENT_PROVIDER',
      specialties: ['Refrigerator', 'Washer'], serviceCities: ['Fort Lauderdale'], companyCrew: true,
    },
  });
  await prisma.provider.upsert({
    where: { id: IDS.provB }, update: { companyCrew: false },
    create: {
      id: IDS.provB, companyId: IDS.coB, businessName: 'TwoTech Network Provider', type: 'NETWORK_BUSINESS',
      specialties: ['Refrigerator'], serviceCities: ['Fort Lauderdale'], companyCrew: false,
    },
  });
  const users = [
    [IDS.crew, PLATFORM_COMPANY_ID, EMAILS.crew, ['TECHNICIAN'], {}],
    [IDS.net, IDS.coB, EMAILS.net, ['PROVIDER_TECH'], {}],
    [IDS.owner, PLATFORM_COMPANY_ID, EMAILS.owner, ['COMPANY_OWNER'], {}],
    [IDS.crewVerify, PLATFORM_COMPANY_ID, EMAILS.crewVerify, ['TECHNICIAN'], { verifyRequired: true }],
    [IDS.netVerify, IDS.coB, EMAILS.netVerify, ['PROVIDER_TECH'], { verifyRequired: true }],
    [IDS.crewNoCode, PLATFORM_COMPANY_ID, EMAILS.crewNoCode, ['TECHNICIAN'], { verifyRequired: true }],
    [IDS.crewL2, PLATFORM_COMPANY_ID, EMAILS.crewL2, ['TECHNICIAN'], { layer2Required: true }],
    [IDS.netL2, IDS.coB, EMAILS.netL2, ['PROVIDER_TECH'], { layer2Required: true }],
  ];
  for (const [id, companyId, email, roles, flags] of users) {
    await prisma.user.upsert({
      where: { id },
      update: { passwordHash, verifyRequired: Boolean(flags.verifyRequired), layer2Required: Boolean(flags.layer2Required) },
      create: { id, companyId, email, passwordHash, phone: '9545550110', roles, active: true, ...flags },
    });
  }
  const codeHash = await hashPassword(VERIFY_CODE);
  for (const userId of [IDS.crewVerify, IDS.netVerify]) {
    await prisma.speedyVerifyCode.upsert({
      where: { userId },
      update: { codeHash, status: 'ACTIVE', failedAttempts: 0, lockedUntil: null },
      create: { userId, codeHash, status: 'ACTIVE', issuedAt: new Date(), failedAttempts: 0 },
    });
  }

  const now = new Date().toISOString();
  const cust = {
    id: IDS.cust, companyId: PLATFORM_COMPANY_ID, userId: null,
    name: 'TwoTech Customer', phone: '9545550130', email: 'tts-customer@test.local',
    address: '9 TwoTech Lane', city: 'Fort Lauderdale', zip: '33311', createdAt: now,
  };
  store.customers.set(cust.id, cust);
  await persistCustomer(cust);
  const mkBooking = (id, ref) => ({
    id, companyId: PLATFORM_COMPANY_ID, customerId: cust.id, customer: cust,
    referenceCode: ref, source: 'TEST', segment: 'RESIDENTIAL',
    city: 'Fort Lauderdale', zip: '33311', area: 'Fort Lauderdale', areaStatus: 'IN_AREA',
    serviceAddress: '9 TwoTech Lane', appliance: 'Refrigerator', issue: 'Not cooling',
    preferredWindow: null, diagnosticFee: 99, diagnosticFeeCurrency: 'USD', diagnosticFeeCreditedTowardRepair: true,
    feeStatus: 'not_collected', status: 'CONFIRMED', history: [], createdAt: now, updatedAt: now,
  });
  const bkNet = { ...mkBooking(IDS.bkNet, 'TS-TTNET1'), dispatch: { mode: 'HYBRID', stage: 'APPROVED_BY_SERVICE_SETTERS', candidateProviderIds: [], assignmentIds: [IDS.asNet] } };
  const asNet = {
    id: IDS.asNet, companyId: PLATFORM_COMPANY_ID, bookingId: IDS.bkNet,
    providerId: IDS.provB, providerCompanyId: IDS.coB,
    status: 'APPROVED', dispatchMode: 'HYBRID', approvalRequired: true,
    approvedBy: 'Service Setters', approvedAt: now, createdAt: now, updatedAt: now,
  };
  const bkCrew = { ...mkBooking(IDS.bkCrew, 'TS-TTCREW'), dispatch: { mode: 'HYBRID', stage: 'ASSIGNED_TO_PROVIDER', candidateProviderIds: [], assignmentIds: [IDS.asCrew] } };
  const asCrew = {
    id: IDS.asCrew, companyId: PLATFORM_COMPANY_ID, bookingId: IDS.bkCrew,
    providerId: GAMMA_PROVIDER, providerCompanyId: GAMMA_COMPANY,
    status: 'ACCEPTED', dispatchMode: 'HYBRID', approvalRequired: true,
    approvedBy: 'Service Setters', approvedAt: now, acceptedAt: now, createdAt: now, updatedAt: now,
  };
  for (const [bk, asg] of [[bkNet, asNet], [bkCrew, asCrew]]) {
    store.bookings.set(bk.id, bk);
    store.dispatchAssignments.set(asg.id, asg);
    await persistBooking(bk);
    await persistAssignment(asg);
  }
}

async function cleanup() {
  try {
    const userIds = Object.values(IDS).filter((v) => typeof v === 'string');
    await prisma.passwordResetToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.loginChallenge.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.speedyVerifyCode.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.dispatchAssignment.deleteMany({ where: { serviceRequestId: { in: [IDS.bkNet, IDS.bkCrew] } } });
    await prisma.serviceRequest.deleteMany({ where: { id: { in: [IDS.bkNet, IDS.bkCrew] } } });
    await prisma.customer.deleteMany({ where: { id: IDS.cust } });
    await prisma.user.deleteMany({ where: { id: { in: [IDS.crew, IDS.net, IDS.owner, IDS.crewVerify, IDS.netVerify, IDS.crewNoCode, IDS.crewL2, IDS.netL2] } } });
    await prisma.provider.deleteMany({ where: { id: IDS.provB } });
    await prisma.company.deleteMany({ where: { id: IDS.coB } });
    await prisma.connection.deleteMany({ where: { phone: '9545550177' } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
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

async function completeLayer2(loginJson, label) {
  const payload = JSON.parse(Buffer.from(loginJson.challenge.split('.')[1], 'base64url').toString('utf8'));
  await prisma.loginChallenge.update({
    where: { id: payload.cid },
    data: { codeHash: await hashPassword(LAYER2_CODE), channel: 'EMAIL' },
  });
  const done = await api('/auth/layer2/verify', { method: 'POST', body: { challenge: loginJson.challenge, code: LAYER2_CODE } });
  check(`${label}: layer2 verify returns a session`, done.status, 200);
  return done.json.token;
}

async function resetPasswordFor(email, userId, label) {
  const forgot = await api('/auth/forgot-password', { method: 'POST', body: { email } });
  check(`${label}: forgot-password 200 (enumeration-safe)`, forgot.status, 200);
  const rows = await prisma.passwordResetToken.findMany({ where: { userId } });
  checkTrue(`${label}: forgot created a reset token row`, rows.length >= 1);
  // Stand in for the emailed link: a fresh token row with a known raw
  // token (the table stores only its SHA-256, exactly like production).
  const raw = `tts-reset-${userId.slice(-4)}-known-token`;
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: createHash('sha256').update(raw).digest('hex'),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });
  const reset = await api('/auth/reset-password', { method: 'POST', body: { token: raw, newPassword: NEW_PASSWORD } });
  check(`${label}: reset-password exchange 200`, reset.status, 200);
  const oldLogin = await loginRaw(email, PASSWORD);
  check(`${label}: old password no longer works`, oldLogin.status, 401);
  return login(email, NEW_PASSWORD);
}

async function startServer() {
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'two-tech-test-secret',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
      OPENAI_API_KEY: '',
      OPENAI_API_KEY_V2: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();
}

// The auth rate limiter allows 10 auth-surface calls per 15 minutes
// per IP and Speedy Verify shares it; this suite's flows need more,
// so the drill server restarts between phases (fresh buckets — all
// state is DB-persisted and rehydrates on boot).
async function restartServer() {
  if (server) {
    const done = new Promise((r) => server.once('exit', r));
    server.kill('SIGTERM');
    await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
    server = null;
  }
  await startServer();
}

async function main() {
  await cleanup();
  await seed();
  await startServer();

  // ---------- Classification: each account lands in its own system ----------
  const crew = await login(EMAILS.crew);
  const crewMe = await api('/provider/me', { token: crew });
  check('company tech: /provider/me system COMPANY', crewMe.json.data.system, 'COMPANY');
  check('company tech: provider is the Field Team', crewMe.json.data.provider?.id, GAMMA_PROVIDER);
  const net = await login(EMAILS.net);
  const netMe = await api('/provider/me', { token: net });
  check('network tech: /provider/me system NETWORK', netMe.json.data.system, 'NETWORK');
  check('network tech: provider is their own business', netMe.json.data.provider?.id, IDS.provB);
  const owner = await login(EMAILS.owner);
  const ownerMe = await api('/provider/me', { token: owner });
  check('owner: /provider/me system OVERSIGHT', ownerMe.json.data.system, 'OVERSIGHT');
  check('owner: oversight flag set', ownerMe.json.data.oversight, true);

  // ---------- Cross-side visibility ----------
  const crewOv = await api('/provider/overview', { token: crew });
  checkTrue('company board shows the crew job',
    [...(crewOv.json.data.accepted || []), ...(crewOv.json.data.offers || [])].some((a) => a.bookingId === IDS.bkCrew));
  checkTrue('company board does NOT show the network job',
    ![...(crewOv.json.data.accepted || []), ...(crewOv.json.data.offers || [])].some((a) => a.bookingId === IDS.bkNet));
  const netOv = await api('/provider/overview', { token: net });
  checkTrue('network board shows its own offer',
    (netOv.json.data.offers || []).some((a) => a.bookingId === IDS.bkNet));
  checkTrue('network board does NOT show the crew job',
    ![...(netOv.json.data.accepted || []), ...(netOv.json.data.offers || [])].some((a) => a.bookingId === IDS.bkCrew));
  const netFullCrew = await api(`/provider/assignments/${IDS.asCrew}/full`, { token: net });
  check('network tech cannot open the crew job record (404)', netFullCrew.status, 404);
  const crewFullNet = await api(`/provider/assignments/${IDS.asNet}/full`, { token: crew });
  check('company tech cannot open the network job record (404)', crewFullNet.status, 404);
  const ownerOv = await api('/provider/overview', { token: owner });
  checkTrue('oversight board shows BOTH sides',
    [...(ownerOv.json.data.accepted || []), ...(ownerOv.json.data.offers || [])].some((a) => a.bookingId === IDS.bkCrew)
    && [...(ownerOv.json.data.accepted || []), ...(ownerOv.json.data.offers || [])].some((a) => a.bookingId === IDS.bkNet));

  // ---------- Speedy Verify posture on both systems ----------
  // Phase 1 rules (standing): tech/provider accounts start FLAGGED
  // verifyRequired, wait in the Master's panel, and the Master issues
  // their codes; the login-time code gate enforces for staff/business
  // roles now and for provider roles in Phase 3. Layer 2 (next
  // section) is the login-enforced second step for techs today.
  const panel1 = await api('/speedy-verify/accounts', { token: owner });
  const rowOf = (rows, id) => (rows || []).find((r) => r.user.id === id);
  checkTrue('company flagged account waits in the Master panel with a live code',
    rowOf(panel1.json.data, IDS.crewVerify)?.verify?.hasActiveCode === true);
  checkTrue('network flagged account waits in the Master panel with a live code',
    rowOf(panel1.json.data, IDS.netVerify)?.verify?.hasActiveCode === true);
  checkTrue('unissued company account shows as awaiting a code',
    rowOf(panel1.json.data, IDS.crewNoCode)?.verify?.awaitingCode === true);
  const issued = await api('/speedy-verify/issue', { token: owner, method: 'POST', body: { userId: IDS.crewNoCode } });
  check('Master issues a code for the waiting company tech', issued.status, 200);
  checkTrue('issued code is 8 digits (shown once)',
    /^\d{8}$/.test(String(issued.json.code || '').replace(/[\s-]/g, '')));
  const panel2 = await api('/speedy-verify/accounts', { token: owner });
  checkTrue('after issue, the account holds an active code',
    rowOf(panel2.json.data, IDS.crewNoCode)?.verify?.hasActiveCode === true);
  const cvToken = await login(EMAILS.crewVerify);
  const cvMe = await api('/provider/me', { token: cvToken });
  check('company flagged account signs in (Phase 1 posture) on COMPANY', cvMe.json.data.system, 'COMPANY');
  const nvToken = await login(EMAILS.netVerify);
  const nvMe = await api('/provider/me', { token: nvToken });
  check('network flagged account signs in (Phase 1 posture) on NETWORK', nvMe.json.data.system, 'NETWORK');

  // ---------- Layer 2 on both systems ----------
  await restartServer();
  const cl2Login = await loginRaw(EMAILS.crewL2);
  check('company layer2: login asks for the 2-step code', cl2Login.json.code, 'LAYER2_REQUIRED');
  const cl2Token = await completeLayer2(cl2Login.json, 'company');
  const cl2Me = await api('/provider/me', { token: cl2Token });
  check('company layer2: session lands on COMPANY', cl2Me.json.data.system, 'COMPANY');
  const nl2Login = await loginRaw(EMAILS.netL2);
  check('network layer2: login asks for the 2-step code', nl2Login.json.code, 'LAYER2_REQUIRED');
  const nl2Token = await completeLayer2(nl2Login.json, 'network');
  const nl2Me = await api('/provider/me', { token: nl2Token });
  check('network layer2: session lands on NETWORK', nl2Me.json.data.system, 'NETWORK');

  // ---------- Password reset on both systems ----------
  await restartServer();
  const crewResetToken = await resetPasswordFor(EMAILS.crew, IDS.crew, 'company');
  const crewMeAfter = await api('/provider/me', { token: crewResetToken });
  check('company: new password signs in at the company side', crewMeAfter.json.data.system, 'COMPANY');
  const netResetToken = await resetPasswordFor(EMAILS.net, IDS.net, 'network');
  const netMeAfter = await api('/provider/me', { token: netResetToken });
  check('network: new password signs in at the network side', netMeAfter.json.data.system, 'NETWORK');

  // ---------- Apply-to-join intake ----------
  const apply = await api('/connections', {
    method: 'POST',
    body: {
      name: 'TwoTech Applicant', phone: '9545550177', email: 'applicant@test.local',
      type: 'PROVIDER_APPLICATION', source: 'tech-network',
      message: 'Business: TwoTech Applicant LLC\nCities covered: Fort Lauderdale',
    },
  });
  check('apply-to-join: anon POST /connections 201', apply.status, 201);
  checkTrue('apply-to-join: returns a reference', Boolean(apply.json.data?.reference));
  const inbox = await api('/connections', { token: owner });
  checkTrue('apply-to-join: application waits in the office intake',
    (inbox.json.data || []).some((c) => c.type === 'PROVIDER_APPLICATION' && c.phone === '9545550177'));

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  return failures;
}

main()
  .then(async (failures) => {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  })
  .catch(async (error) => {
    console.error(error);
    if (server) server.kill('SIGTERM');
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
