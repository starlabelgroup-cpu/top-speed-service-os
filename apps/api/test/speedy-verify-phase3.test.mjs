/**
 * Speedy Verify PHASE 3 — verification harness (2026-11-19).
 *
 * Ramone's order: "Switch on phase 3 now." The login-time Speedy
 * Verify access-code gate now covers provider/tech roles, mirroring
 * the staff/business enforcement exactly: a flagged tech with no
 * issued code is DENIED at sign-in; with a live code, sign-in stops
 * at the code step and only the challenge exchange issues a session
 * (carrying sv:true); 5 wrong codes lock code entry for 15 minutes
 * and the correct code is refused during the lock; Layer 2 still
 * runs AFTER the code step; unflagged providers sign in exactly as
 * before; the Master is exempt by construction (drilled with the
 * owner seeded verifyRequired=true). New provider accounts start
 * flagged on every office creation path (admin register + Work Time
 * Access), and the public register still refuses provider roles.
 * The /portal sign-in consumes the same /auth/login contract — its
 * code-step handling is asserted statically against the page.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://... node test/speedy-verify-phase3.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
process.env.JWT_SECRET = 'phase3-test-secret';

const PORT = Number(process.env.TEST_PORT || 4437);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';
const CODE = '24681357';
const WRONG = '99999999';
const LAYER2_CODE = '112233';

const NET_CO = '70000000-0000-4000-8000-0000000000b1';
const CREW_CO = '70000000-0000-4000-8000-0000000000b2';
const NET_PROV = '70000000-0000-4000-8000-0000000000b3';
const CREW_PROV = '70000000-0000-4000-8000-0000000000b4';
const IDS = {
  owner: '70000000-0000-4000-8000-0000000000c1',
  netGate: '70000000-0000-4000-8000-0000000000c2',
  netLock: '70000000-0000-4000-8000-0000000000c3',
  crewGate: '70000000-0000-4000-8000-0000000000c4',
  netBoth: '70000000-0000-4000-8000-0000000000c5',
  netPlain: '70000000-0000-4000-8000-0000000000c6',
  netNoCode: '70000000-0000-4000-8000-0000000000c7',
};
const EMAILS = {
  owner: 'p3-owner@test.local',
  netGate: 'p3-net-gate@test.local',
  netLock: 'p3-net-lock@test.local',
  crewGate: 'p3-crew-gate@test.local',
  netBoth: 'p3-net-both@test.local',
  netPlain: 'p3-net-plain@test.local',
  netNoCode: 'p3-net-nocode@test.local',
  regProv: 'p3-reg-provider@test.local',
  wtaProv: 'p3-wta-provider@test.local',
};
const createdUserIds = [];

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
function decode(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID }, update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'p3-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.company.upsert({
    where: { id: NET_CO }, update: {},
    create: { id: NET_CO, name: 'Phase3 Network Co', slug: 'p3-net-co', type: 'INDEPENDENT_PROVIDER' },
  });
  await prisma.company.upsert({
    where: { id: CREW_CO }, update: {},
    create: { id: CREW_CO, name: 'Phase3 Crew Co', slug: 'p3-crew-co', type: 'INDEPENDENT_PROVIDER' },
  });
  await prisma.provider.upsert({
    where: { id: NET_PROV }, update: { companyCrew: false },
    create: {
      id: NET_PROV, companyId: NET_CO, businessName: 'Phase3 Network Provider', type: 'NETWORK_BUSINESS',
      specialties: ['Refrigerator'], serviceCities: ['Fort Lauderdale'], companyCrew: false,
    },
  });
  await prisma.provider.upsert({
    where: { id: CREW_PROV }, update: { companyCrew: true },
    create: {
      id: CREW_PROV, companyId: CREW_CO, businessName: 'Phase3 Field Team', type: 'INDEPENDENT_PROVIDER',
      specialties: ['Refrigerator'], serviceCities: ['Fort Lauderdale'], companyCrew: true,
    },
  });
  const users = [
    // The owner is seeded verifyRequired=TRUE on purpose: Rule Zero
    // says the Master is exempt BY CONSTRUCTION — the flag must not
    // gate him.
    [IDS.owner, PLATFORM_COMPANY_ID, EMAILS.owner, ['COMPANY_OWNER'], { verifyRequired: true }],
    [IDS.netGate, NET_CO, EMAILS.netGate, ['PROVIDER_TECH'], { verifyRequired: true }],
    [IDS.netLock, NET_CO, EMAILS.netLock, ['PROVIDER_TECH'], { verifyRequired: true }],
    [IDS.crewGate, PLATFORM_COMPANY_ID, EMAILS.crewGate, ['TECHNICIAN'], { verifyRequired: true }],
    [IDS.netBoth, NET_CO, EMAILS.netBoth, ['PROVIDER_TECH'], { verifyRequired: true, layer2Required: true }],
    [IDS.netPlain, NET_CO, EMAILS.netPlain, ['PROVIDER_TECH'], {}],
    [IDS.netNoCode, NET_CO, EMAILS.netNoCode, ['PROVIDER_OWNER'], { verifyRequired: true }],
  ];
  for (const [id, companyId, email, roles, flags] of users) {
    await prisma.user.upsert({
      where: { id },
      update: { passwordHash, verifyRequired: Boolean(flags.verifyRequired), layer2Required: Boolean(flags.layer2Required) },
      create: { id, companyId, email, passwordHash, phone: '9545550110', roles, active: true, ...flags },
    });
  }
  const codeHash = await hashPassword(CODE);
  for (const userId of [IDS.netGate, IDS.netLock, IDS.crewGate, IDS.netBoth]) {
    await prisma.speedyVerifyCode.upsert({
      where: { userId },
      update: { codeHash, status: 'ACTIVE', failedAttempts: 0, lockedUntil: null },
      create: { userId, codeHash, status: 'ACTIVE', issuedAt: new Date(), failedAttempts: 0 },
    });
  }
}

async function cleanup() {
  try {
    const ids = [...Object.values(IDS), ...createdUserIds];
    await prisma.emailVerificationToken.deleteMany({ where: { userId: { in: ids } } });
    await prisma.loginChallenge.deleteMany({ where: { userId: { in: ids } } });
    await prisma.speedyVerifyCode.deleteMany({ where: { userId: { in: ids } } });
    await prisma.termsAcceptance.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { in: [EMAILS.regProv, EMAILS.wtaProv] } } });
    await prisma.provider.deleteMany({ where: { id: { in: [NET_PROV, CREW_PROV] } } });
    await prisma.company.deleteMany({ where: { id: { in: [NET_CO, CREW_CO] } } });
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

async function startServer() {
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: process.env.JWT_SECRET,
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

// The auth rate limiter (10 calls / 15 min / IP) is shared by /auth,
// /speedy-verify and /access-control; restart between phases for
// fresh buckets — all state is DB-persisted and rehydrates on boot.
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

  // ---------- Run 1: the lock (network) + a clean exchange ----------
  const lockLogin = await loginRaw(EMAILS.netLock);
  check('lock case: login stops at the code step', lockLogin.json.code, 'SPEEDY_VERIFY_REQUIRED');
  const lockChallenge = lockLogin.json.challenge;
  for (let i = 1; i <= 4; i += 1) {
    const wrong = await api('/speedy-verify/verify', { method: 'POST', body: { challenge: lockChallenge, code: WRONG } });
    check(`wrong code #${i}: refused as invalid`, wrong.json.code, 'SPEEDY_VERIFY_INVALID_CODE');
    check(`wrong code #${i}: attempts remaining`, wrong.json.attemptsRemaining, 5 - i);
  }
  const fifth = await api('/speedy-verify/verify', { method: 'POST', body: { challenge: lockChallenge, code: WRONG } });
  check('wrong code #5: code entry locks', fifth.json.code, 'SPEEDY_VERIFY_LOCKED');
  check('wrong code #5: status 403', fifth.status, 403);
  const duringLock = await api('/speedy-verify/verify', { method: 'POST', body: { challenge: lockChallenge, code: CODE } });
  check('correct code DURING the lock is still refused', duringLock.json.code, 'SPEEDY_VERIFY_LOCKED');

  // ---------- Run 2: sv sessions, /auth/me, owner exemption, unflagged ----------
  await restartServer();
  const crewLogin = await loginRaw(EMAILS.crewGate);
  check('company flagged: login stops at the code step', crewLogin.json.code, 'SPEEDY_VERIFY_REQUIRED');
  const crewDone = await api('/speedy-verify/verify', { method: 'POST', body: { challenge: crewLogin.json.challenge, code: CODE } });
  check('company flagged: exchange issues the session', crewDone.status, 200);
  check('company flagged: session carries sv:true', decode(crewDone.json.token).sv, true);
  const crewMe = await api('/auth/me', { token: crewDone.json.token });
  check('company flagged: /auth/me accepts the sv session', crewMe.status, 200);
  const crewBoard = await api('/provider/me', { token: crewDone.json.token });
  check('company flagged: board system COMPANY', crewBoard.json.data.system, 'COMPANY');

  // A session token minted WITHOUT the code step (the pre-verification
  // shape) must be refused by /auth/me for a flagged tech.
  const preVerifyUser = await prisma.user.findUnique({ where: { id: IDS.crewGate } });
  const preVerifyToken = signAccessToken(preVerifyUser).token;
  const preMe = await api('/auth/me', { token: preVerifyToken });
  check('pre-verification token: /auth/me refuses', preMe.status, 403);
  check('pre-verification token: refusal code', preMe.json.code, 'SPEEDY_VERIFY_REQUIRED');
  // A challenge token is not a session at all.
  const challengeAsSession = await api('/auth/me', { token: crewLogin.json.challenge });
  check('challenge token as a session: refused 401', challengeAsSession.status, 401);

  const ownerToken = await login(EMAILS.owner);
  checkTrue('owner (seeded verifyRequired=true): signs straight in — Rule Zero exemption', Boolean(ownerToken));
  const ownerMe = await api('/auth/me', { token: ownerToken });
  check('owner: /auth/me 200', ownerMe.status, 200);
  const ownerBoard = await api('/provider/me', { token: ownerToken });
  check('owner: board system OVERSIGHT', ownerBoard.json.data.system, 'OVERSIGHT');

  const plainLogin = await loginRaw(EMAILS.netPlain);
  check('unflagged provider: login returns a session directly', plainLogin.status, 200);
  checkTrue('unflagged provider: no code step demanded', Boolean(plainLogin.json.token) && !plainLogin.json.challenge);
  const plainMe = await api('/auth/me', { token: plainLogin.json.token });
  check('unflagged provider: /auth/me 200 (no sv needed)', plainMe.status, 200);

  // ---------- Run 3: creation paths + the Master's queue ----------
  await restartServer();
  const owner2 = await login(EMAILS.owner);
  const reg = await api('/auth/register', {
    token: owner2, method: 'POST',
    body: { email: EMAILS.regProv, password: PASSWORD, role: 'PROVIDER_TECH', firstName: 'Reg', lastName: 'Provider' },
  });
  check('admin register (provider role): created', reg.status, 201);
  check('admin register (provider role): Speedy Verify PENDING, no session', reg.json.speedyVerify?.status, 'PENDING');
  checkTrue('admin register (provider role): no token in the response', !reg.json.token);
  if (reg.json.user?.id) createdUserIds.push(reg.json.user.id);
  const regRow = await prisma.user.findUnique({ where: { id: reg.json.user.id } });
  check('admin register (provider role): DB row starts flagged', regRow.verifyRequired, true);
  const regLogin = await loginRaw(EMAILS.regProv);
  check('new provider from register: first sign-in denied (no code yet)', regLogin.status, 403);
  check('new provider from register: denial code', regLogin.json.code, 'SPEEDY_VERIFY_NO_CODE');

  const wta = await api('/access-control/accounts', {
    token: owner2, method: 'POST',
    body: { surface: 'provider', email: EMAILS.wtaProv, password: PASSWORD, firstName: 'Wta', lastName: 'Provider' },
  });
  check('Work Time Access (provider surface): created', wta.status, 201);
  check('Work Time Access (provider surface): starts pending approval', wta.json.user?.verify?.pendingApproval, true);
  if (wta.json.user?.id) createdUserIds.push(wta.json.user.id);
  const wtaLogin = await loginRaw(EMAILS.wtaProv);
  check('new provider from Work Time Access: first sign-in denied (no code yet)', wtaLogin.json.code, 'SPEEDY_VERIFY_NO_CODE');

  const pub = await api('/auth/register', {
    method: 'POST',
    body: { email: 'p3-public-provider@test.local', password: PASSWORD, role: 'PROVIDER_TECH' },
  });
  check('public register still refuses provider roles', pub.status, 403);

  const panel = await api('/speedy-verify/accounts', { token: owner2 });
  const rowOf = (rows, id) => (rows || []).find((r) => r.user.id === id);
  checkTrue('panel: flagged network tech is pending approval',
    rowOf(panel.json.data, IDS.netNoCode)?.verify?.pendingApproval === true);
  checkTrue('panel: flagged network tech shows the gate enforced',
    rowOf(panel.json.data, IDS.netNoCode)?.verify?.enforced === true);
  checkTrue('panel: network tech labeled NETWORK',
    rowOf(panel.json.data, IDS.netNoCode)?.user?.system === 'NETWORK');
  checkTrue('panel: company tech labeled COMPANY',
    rowOf(panel.json.data, IDS.crewGate)?.user?.system === 'COMPANY');
  checkTrue('panel: pendingApprovals count includes waiting techs', panel.json.pendingApprovals >= 1);

  // ---------- Run 4: Verify BEFORE Layer 2 (network, both gates on) ----------
  await restartServer();
  const bothLogin = await loginRaw(EMAILS.netBoth);
  check('both gates: the FIRST step is Speedy Verify, not Layer 2', bothLogin.json.code, 'SPEEDY_VERIFY_REQUIRED');
  const bothVerify = await api('/speedy-verify/verify', { method: 'POST', body: { challenge: bothLogin.json.challenge, code: CODE } });
  check('both gates: code exchange returns the Layer 2 step', bothVerify.json.code, 'LAYER2_REQUIRED');
  const payload = decode(bothVerify.json.challenge);
  await prisma.loginChallenge.update({
    where: { id: payload.cid },
    data: { codeHash: await hashPassword(LAYER2_CODE), channel: 'EMAIL' },
  });
  const bothDone = await api('/auth/layer2/verify', { method: 'POST', body: { challenge: bothVerify.json.challenge, code: LAYER2_CODE } });
  check('both gates: Layer 2 completion issues the session', bothDone.status, 200);
  check('both gates: final session carries sv:true', decode(bothDone.json.token).sv, true);
  const bothBoard = await api('/provider/me', { token: bothDone.json.token });
  check('both gates: board system NETWORK', bothBoard.json.data.system, 'NETWORK');

  // ---------- /portal parity (static): the portal consumes the same
  // /auth/login contract and already carries the code step ----------
  const portalHtml = await readFile(fileURLToPath(new URL('../../web/portal/index.html', import.meta.url)), 'utf8');
  checkTrue('portal page handles the verifyRequired challenge', portalHtml.includes('verifyRequired'));
  checkTrue('portal page exchanges at /speedy-verify/verify', portalHtml.includes('/speedy-verify/verify'));

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
