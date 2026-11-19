/**
 * Service OS Portal — login + sign-up drills (2026-11-18).
 *
 * The rebuilt flagship portal page (apps/web/portal) is a pure client
 * of the existing auth pipeline; these drills prove the exact
 * contracts that page is built against, end to end over HTTP:
 *  - register zod failure → 400 with details.fieldErrors;
 *  - register without a signed terms acceptance → 422
 *    TERMS_ACCEPTANCE_REQUIRED;
 *  - register asking for a staff role (DISPATCHER) → 403 — team
 *    accounts are never self-registered;
 *  - duplicate email → 409;
 *  - customer register with terms + accountType 'business' → 201 in
 *    the Speedy Verify PENDING state (a commercial-audience account
 *    starts unverified, waiting for the Owner's access code — no
 *    token, no Layer 2 challenge), with signupAudience 'commercial'
 *    persisted on the register response AND the DB row;
 *  - customer register with terms + accountType 'homeowner' → 201
 *    with the Layer 2 challenge shape (layer2Required, challenge, no
 *    token) and signupAudience 'homeowner'; completing Layer 2 (the
 *    drill writes the code hash onto the challenge row directly,
 *    standing in for the emailed code) returns a session, and
 *    /auth/me with that session shows the persisted signupAudience;
 *  - login with a wrong password → 401;
 *  - a plain seeded customer login → 200 session, /auth/me → 200;
 *  - a verifyRequired staff account (DISPATCHER, live access code
 *    seeded): login → SPEEDY_VERIFY_REQUIRED + challenge and no
 *    token; a wrong code → 401 SPEEDY_VERIFY_INVALID_CODE; the right
 *    code → a session (its Layer 2 flag is off), and /auth/me with
 *    that session → 200 (the sv claim carries through);
 *  - mounting nothing new leaves the public routes alone:
 *    payments/status still answers.
 *
 * Two server phases (same pattern as password-reset.test.mjs): the
 * /auth rate limiter allows 10 calls per IP per 15 minutes, so the
 * register phase and the login phase each boot a fresh server (fresh
 * in-memory limiter buckets) and stay under the limit.
 *
 * Run: DATABASE_URL=<local drill postgres url>
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
if (!process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL_UNPOOLED = process.env['DATABASE' + '_URL'];

const PORT = Number(process.env.TEST_PORT || 4491);
const PORT_B = PORT + 1;
const JWT_SECRET = 'portal-drill-jwt-secret';
const PASSWORD = 'test-pass-1234';
const VERIFY_CODE = '12345678';
const LAYER2_CODE = '246810';

const IDS = {
  plain: '40000000-0000-4000-8000-0000000000f1',
  setter: '40000000-0000-4000-8000-0000000000f2',
};
const EMAILS = {
  plain: 'portal-plain@test.local',
  setter: 'portal-setter@test.local',
  homeowner: 'portal-homeowner@test.local',
  business: 'portal-business@test.local',
  staffAttempt: 'portal-staff-attempt@test.local',
  noTerms: 'portal-noterms@test.local',
};
const TERMS = {
  signatureName: 'Portal Drill Customer',
  documents: [
    { document: 'SERVICE_OS', version: '1.0', agreed: true },
    { document: 'APPLIANCE_CONNECT', version: '1.0', agreed: true },
  ],
};

const prisma = new PrismaClient();
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

function checkTrue(label, value) {
  check(label, Boolean(value), true);
}

function api(base, path, { token, method = 'GET', body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => {
    let json = null;
    try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  });
}

function spawnServer(port) {
  const env = {
    ...process.env, PORT: String(port), JWT_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
  };
  const server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api:${port}] ${d}`));
  return server;
}

async function waitForServer(base) {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('server did not come up');
}

async function cleanupDb() {
  try {
    const users = await prisma.user.findMany({
      where: { OR: [{ id: { in: Object.values(IDS) } }, { email: { in: Object.values(EMAILS) } }] },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    if (ids.length) {
      // Child rows (terms, verify codes, login challenges, email
      // tokens) cascade from the user delete; delete users last.
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.user.upsert({
    where: { id: IDS.plain },
    update: { passwordHash, verifyRequired: false, layer2Required: false },
    create: {
      id: IDS.plain, companyId: PLATFORM_COMPANY_ID, email: EMAILS.plain, passwordHash,
      firstName: 'Portal', lastName: 'Plain', phone: '9545550211', roles: ['CUSTOMER'], active: true,
      verifyRequired: false, layer2Required: false,
    },
  });
  await prisma.user.upsert({
    where: { id: IDS.setter },
    update: { passwordHash, verifyRequired: true, layer2Required: false },
    create: {
      id: IDS.setter, companyId: PLATFORM_COMPANY_ID, email: EMAILS.setter, passwordHash,
      firstName: 'Portal', lastName: 'Setter', phone: '9545550212', roles: ['DISPATCHER'], active: true,
      verifyRequired: true, layer2Required: false,
    },
  });
  // The setter's live Speedy Verify access code (hash only, as in prod).
  const codeHash = await hashPassword(VERIFY_CODE);
  await prisma.speedyVerifyCode.upsert({
    where: { userId: IDS.setter },
    update: { codeHash, status: 'ACTIVE', failedAttempts: 0, lockedUntil: null },
    create: { userId: IDS.setter, codeHash, status: 'ACTIVE', issuedAt: new Date(), failedAttempts: 0 },
  });
}

async function main() {
  await cleanupDb();
  await seed();
  const base = `http://127.0.0.1:${PORT}/api/v1`;
  const server = spawnServer(PORT);
  await waitForServer(base);

  // ── Register: zod failure → 400 ────────────────────────────────
  const zod = await api(base, '/auth/register', { method: 'POST', body: { email: 'not-an-email', password: 'short' } });
  check('register zod failure 400', zod.status, 400);
  check('register zod error label', zod.json.error, 'Invalid registration');
  checkTrue('register zod fieldErrors present', Boolean(zod.json.details && zod.json.details.fieldErrors));
  checkTrue('register zod flags password or email', Boolean(zod.json.details.fieldErrors.password || zod.json.details.fieldErrors.email));

  // ── Register: no terms → 422 TERMS_ACCEPTANCE_REQUIRED ─────────
  const noTerms = await api(base, '/auth/register', {
    method: 'POST',
    body: { email: EMAILS.noTerms, password: PASSWORD, firstName: 'No', lastName: 'Terms', phone: '9545550213', role: 'CUSTOMER', accountType: 'homeowner' },
  });
  check('register without terms 422', noTerms.status, 422);
  check('register without terms code', noTerms.json.code, 'TERMS_ACCEPTANCE_REQUIRED');

  // ── Register: staff role self-register → 403 ───────────────────
  const staffAttempt = await api(base, '/auth/register', {
    method: 'POST',
    body: { email: EMAILS.staffAttempt, password: PASSWORD, firstName: 'Staff', lastName: 'Attempt', phone: '9545550214', role: 'DISPATCHER', termsAcceptance: TERMS, accountType: 'homeowner' },
  });
  check('register DISPATCHER role 403', staffAttempt.status, 403);
  const staffRow = await prisma.user.findFirst({ where: { email: EMAILS.staffAttempt } });
  check('staff attempt created no account', staffRow, null);

  // ── Register: duplicate email → 409 ────────────────────────────
  const dup = await api(base, '/auth/register', {
    method: 'POST',
    body: { email: EMAILS.plain, password: PASSWORD, firstName: 'Dupe', phone: '9545550215', role: 'CUSTOMER', termsAcceptance: TERMS, accountType: 'homeowner' },
  });
  check('register duplicate email 409', dup.status, 409);

  // ── Register: business customer → Speedy Verify pending ────────
  const biz = await api(base, '/auth/register', {
    method: 'POST',
    body: { email: EMAILS.business, password: PASSWORD, firstName: 'Biz', lastName: 'Owner', phone: '9545550216', role: 'CUSTOMER', termsAcceptance: TERMS, accountType: 'business' },
  });
  check('business register 201', biz.status, 201);
  check('business signupAudience on response', biz.json.user.signupAudience, 'commercial');
  check('business speedyVerify pending', biz.json.speedyVerify && biz.json.speedyVerify.status, 'PENDING');
  check('business register issues no token', biz.json.token, undefined);
  check('business emailVerification pending', biz.json.emailVerification, 'pending');
  const bizRow = await prisma.user.findFirst({ where: { email: EMAILS.business } });
  checkTrue('business row persisted', Boolean(bizRow));
  check('business signupAudience persisted (DB row)', bizRow.signupAudience, 'commercial');
  check('business verifyRequired persisted (DB row)', bizRow.verifyRequired, true);

  // ── Register: homeowner customer → Layer 2 challenge ───────────
  const home = await api(base, '/auth/register', {
    method: 'POST',
    body: { email: EMAILS.homeowner, password: PASSWORD, firstName: 'Home', lastName: 'Owner', phone: '9545550217', role: 'CUSTOMER', termsAcceptance: TERMS, accountType: 'homeowner' },
  });
  check('homeowner register 201', home.status, 201);
  check('homeowner layer2Required', home.json.layer2Required, true);
  check('homeowner layer2 code', home.json.code, 'LAYER2_REQUIRED');
  checkTrue('homeowner challenge is a string', typeof home.json.challenge === 'string' && home.json.challenge.length > 20);
  check('homeowner register issues no token', home.json.token, undefined);
  check('homeowner signupAudience on response', home.json.user.signupAudience, 'homeowner');
  check('homeowner emailVerification pending', home.json.emailVerification, 'pending');
  check('homeowner terms complete on response', home.json.terms && home.json.terms.complete, true);

  // Complete Layer 2: the drill stands in for the emailed code by
  // writing its hash onto the challenge row (the send path needs a
  // live mail provider; the verify path is exercised for real).
  const payload = JSON.parse(Buffer.from(home.json.challenge.split('.')[1], 'base64url').toString('utf8'));
  checkTrue('layer2 challenge carries a challenge id', typeof payload.cid === 'string');
  await prisma.loginChallenge.update({
    where: { id: payload.cid },
    data: { codeHash: await hashPassword(LAYER2_CODE), channel: 'EMAIL' },
  });
  const l2 = await api(base, '/auth/layer2/verify', { method: 'POST', body: { challenge: home.json.challenge, code: LAYER2_CODE } });
  check('layer2 verify 200', l2.status, 200);
  checkTrue('layer2 verify returns a session token', typeof l2.json.token === 'string' && l2.json.token.length > 20);
  check('layer2 session user email', l2.json.user.email, EMAILS.homeowner);
  const homeMe = await api(base, '/auth/me', { token: l2.json.token });
  check('/auth/me after layer2 200', homeMe.status, 200);
  check('signupAudience persisted via /auth/me', homeMe.json.user.signupAudience, 'homeowner');

  server.kill();
  await new Promise((r) => setTimeout(r, 500));

  // ── Phase B: login + Speedy Verify (fresh rate-limiter buckets) ─
  const baseB = `http://127.0.0.1:${PORT_B}/api/v1`;
  const serverB = spawnServer(PORT_B);
  await waitForServer(baseB);

  // ── Login: wrong password → 401, right password → session ──────
  const wrong = await api(baseB, '/auth/login', { method: 'POST', body: { email: EMAILS.plain, password: 'wrong-password-99' } });
  check('login wrong password 401', wrong.status, 401);
  const plainLogin = await api(baseB, '/auth/login', { method: 'POST', body: { email: EMAILS.plain, password: PASSWORD } });
  check('plain login 200', plainLogin.status, 200);
  checkTrue('plain login returns a session token', typeof plainLogin.json.token === 'string');
  const plainMe = await api(baseB, '/auth/me', { token: plainLogin.json.token });
  check('/auth/me with session token 200', plainMe.status, 200);
  check('/auth/me user email', plainMe.json.user.email, EMAILS.plain);
  check('/auth/me unauthenticated 401', (await api(baseB, '/auth/me')).status, 401);

  // ── Speedy Verify staff login ──────────────────────────────────
  const setterLogin = await api(baseB, '/auth/login', { method: 'POST', body: { email: EMAILS.setter, password: PASSWORD } });
  check('setter login 200 (challenge state)', setterLogin.status, 200);
  check('setter login verifyRequired', setterLogin.json.verifyRequired, true);
  check('setter login code SPEEDY_VERIFY_REQUIRED', setterLogin.json.code, 'SPEEDY_VERIFY_REQUIRED');
  checkTrue('setter login challenge is a string', typeof setterLogin.json.challenge === 'string' && setterLogin.json.challenge.length > 20);
  check('setter login issues no token', setterLogin.json.token, undefined);

  const wrongCode = await api(baseB, '/speedy-verify/verify', { method: 'POST', body: { challenge: setterLogin.json.challenge, code: '87654321' } });
  check('speedy verify wrong code 401', wrongCode.status, 401);
  check('speedy verify wrong code code', wrongCode.json.code, 'SPEEDY_VERIFY_INVALID_CODE');

  const rightCode = await api(baseB, '/speedy-verify/verify', { method: 'POST', body: { challenge: setterLogin.json.challenge, code: VERIFY_CODE } });
  check('speedy verify right code 200', rightCode.status, 200);
  checkTrue('speedy verify right code returns a session', typeof rightCode.json.token === 'string' && rightCode.json.token.length > 20);
  checkTrue('speedy verify session user is the setter', (rightCode.json.user.roles || []).includes('DISPATCHER'));
  const setterMe = await api(baseB, '/auth/me', { token: rightCode.json.token });
  check('/auth/me with speedy-verified session 200', setterMe.status, 200);
  check('/auth/me setter email', setterMe.json.user.email, EMAILS.setter);

  // ── Public routes unaffected ───────────────────────────────────
  const payments = await api(baseB, '/payments/status');
  check('public payments/status 200', payments.status, 200);
  check('public payments diagnostic cents', payments.json.data.diagnosticAmountCents, 9900);

  serverB.kill();
  await new Promise((r) => setTimeout(r, 500));

  await cleanupDb();
  await prisma.$disconnect();
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('drill crashed:', error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
