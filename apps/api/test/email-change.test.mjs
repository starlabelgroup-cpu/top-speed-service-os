/**
 * Username (email) change — verification harness (2026-11-20).
 *
 * Exercises the self-serve email-change flow end to end over HTTP:
 * POST /auth/email-change/request is a signed-in door guarded by the
 * current password (wrong → 401, nothing created), same-email → 400,
 * taken email → 409, and — for a Layer 2 account — the real Layer 2
 * challenge machinery (no code → code sent + NO token; wrong code →
 * 401 + no token; right code → token created). The emailed
 * confirmation link carries a raw token whose SHA-256 hash is all
 * that is stored; POST /auth/email-change/confirm swaps the email,
 * marks it verified, appends EMAIL_CHANGED, and afterwards the OLD
 * address fails login while the NEW one succeeds and the freed old
 * address can register fresh. Replay and expired tokens get the
 * generic 400; an address taken between request and confirm gets an
 * honest 409 and the token is NOT consumed. The intake shield's
 * emailChange family allows 10 attempts/hr/IP and refuses the 11th.
 *
 * Email delivery is captured through the platform's real Resend
 * sender pointed at a local stub (RESEND_API_BASE), so the captured
 * payloads are exactly what Resend would receive — including the
 * request notices to the OLD address and the completion notices to
 * both addresses.
 *
 * Runs against a LOCAL test database only. Usage:
 *   set DATABASE_URL to a local TEST database connection string
 *   node test/email-change.test.mjs
 * The harness seeds its own company/users and boots the real API on
 * TEST_PORT (default 4471) three times, because the /auth rate
 * limiter allows 10 requests per IP per 15 minutes per process.
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { consumeIntakeAttempt } from '../src/services/intakeShield.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

const DB_URL = process.env['DATABASE_' + 'URL'];
if (!DB_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env['DATABASE_' + 'URL_UNPOOLED'] ||= DB_URL;

const PORT = Number(process.env.TEST_PORT || 4471);
const STUB_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PW = 'drill-pass-12345';
const WRONG_PW = 'wrong-pass-99999';
const INVALID = 'This confirmation link is invalid or has expired';
const TERMS = {
  signatureName: 'Email Change Drill',
  documents: [
    { document: 'SERVICE_OS', version: '1.0', agreed: true },
    { document: 'APPLIANCE_CONNECT', version: '1.0', agreed: true },
  ],
};

const IDS = {
  plain: '20000000-0000-4000-8000-0000000000f1',
  holder: '20000000-0000-4000-8000-0000000000f2',
  expiry: '20000000-0000-4000-8000-0000000000f3',
  layer2: '20000000-0000-4000-8000-0000000000f4',
  raceA: '20000000-0000-4000-8000-0000000000f5',
};
const EMAILS = {
  plainOld: 'plain-old@test.local',
  plainNew: 'plain-new@test.local',
  taken: 'taken@test.local',
  expiry: 'expiry@test.local',
  expiryNew: 'expiry-new@test.local',
  layer2: 'layer2@test.local',
  layer2New: 'layer2-new@test.local',
  raceA: 'race-a@test.local',
  raceTarget: 'race-target@test.local',
};

const prisma = new PrismaClient();
let server = null;
let failures = 0;
const captures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

async function api(path, { method = 'POST', body, token } = {}) {
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

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function capturesTo(email) {
  return captures.filter((entry) => Array.isArray(entry.to) && entry.to.includes(email));
}

function capturesWithSubject(email, subjectPart) {
  return capturesTo(email).filter((entry) => String(entry.subject || '').includes(subjectPart));
}

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return predicate();
}

function tokenFromCapture(capture) {
  const match = /mode=email-change&token=([A-Za-z0-9_-]+)/.exec(capture?.text || '');
  return match ? match[1] : null;
}

function codeFromCapture(capture) {
  const match = /code is: (\d{6})/.exec(capture?.text || '');
  return match ? match[1] : null;
}

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
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
  childEnv['JWT_' + 'SECRET'] = 'email-change-drill-secret';
  childEnv['RESEND_' + 'API_KEY'] = 'drill-resend-key';
  childEnv['RESEND_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;
  childEnv['EMAIL_' + 'FROM'] = 'Top Speed Appliance <service@topspeedappliance.net>';
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
  const passwordHash = await hashPassword(PW);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const base = { companyId: PLATFORM_COMPANY_ID, passwordHash, roles: ['CUSTOMER'], active: true };
  const rows = [
    { ...base, id: IDS.plain, email: EMAILS.plainOld, firstName: 'Plain', lastName: 'Changer', layer2Required: false },
    { ...base, id: IDS.holder, email: EMAILS.taken, firstName: 'Taken', lastName: 'Holder', layer2Required: false },
    { ...base, id: IDS.expiry, email: EMAILS.expiry, firstName: 'Expiry', lastName: 'Changer', layer2Required: false },
    { ...base, id: IDS.layer2, email: EMAILS.layer2, firstName: 'Layer', lastName: 'Two', layer2Required: true, layer2Channel: 'EMAIL' },
    { ...base, id: IDS.raceA, email: EMAILS.raceA, firstName: 'Race', lastName: 'Changer', layer2Required: false },
  ];
  for (const row of rows) {
    await prisma.user.upsert({ where: { id: row.id }, update: { passwordHash, email: row.email }, create: row });
  }
  await prisma.emailChangeToken.deleteMany({ where: { userId: { in: Object.values(IDS) } } });
  await prisma.platformEvent.deleteMany({ where: { type: 'EMAIL_CHANGED' } });
}

async function tokensFor(userId) {
  return prisma.emailChangeToken.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
}

async function login(email, password = PW) {
  return api('/auth/login', { body: { email, password } });
}

// ---------------------------------------------------------------------
// Boot 1 — the plain (no Layer 2) happy path and the request guards.
// ---------------------------------------------------------------------
async function phaseOne() {
  const session = await login(EMAILS.plainOld);
  check('plain login: status', session.status, 200);
  const tok = session.json?.token;
  check('plain login: session issued', typeof tok, 'string');

  // Unauthenticated request → 401 from the authenticate middleware.
  const anon = await api('/auth/email-change/request', { body: { newEmail: EMAILS.plainNew, currentPassword: PW } });
  check('anonymous request: status', anon.status, 401);

  // Wrong current password → 401, and NO token row is created.
  const wrongPw = await api('/auth/email-change/request', { token: tok, body: { newEmail: EMAILS.plainNew, currentPassword: WRONG_PW } });
  check('wrong password: status', wrongPw.status, 401);
  check('wrong password: error', wrongPw.json?.error, 'Current password is incorrect');
  check('wrong password: no token rows', (await tokensFor(IDS.plain)).length, 0);

  // Same email → 400 SAME_EMAIL.
  const same = await api('/auth/email-change/request', { token: tok, body: { newEmail: EMAILS.plainOld, currentPassword: PW } });
  check('same email: status', same.status, 400);
  check('same email: code', same.json?.code, 'SAME_EMAIL');
  check('same email: no token rows', (await tokensFor(IDS.plain)).length, 0);

  // Taken email → 409 EMAIL_TAKEN.
  const taken = await api('/auth/email-change/request', { token: tok, body: { newEmail: EMAILS.taken, currentPassword: PW } });
  check('taken email: status', taken.status, 409);
  check('taken email: code', taken.json?.code, 'EMAIL_TAKEN');
  check('taken email: no token rows', (await tokensFor(IDS.plain)).length, 0);

  // The real request → 200, one hash-only token row, the confirmation
  // email to the NEW address and the notice to the OLD address.
  const req = await api('/auth/email-change/request', { token: tok, body: { newEmail: EMAILS.plainNew, currentPassword: PW } });
  check('request: status', req.status, 200);
  check('request: ok flag', req.json?.ok, true);
  check('request: confirm email to NEW address', await waitFor(() => capturesWithSubject(EMAILS.plainNew, 'Confirm your new Top Speed Appliance username').length >= 1), true);
  check('request: notice email to OLD address', await waitFor(() => capturesWithSubject(EMAILS.plainOld, 'username change was requested').length >= 1), true);
  const confirmCapture = capturesWithSubject(EMAILS.plainNew, 'Confirm your new Top Speed Appliance username')[0];
  check('confirm email links to pepperlists.com', String(confirmCapture?.text || '').includes('https://pepperlists.com/?mode=email-change&token='), true);
  const rawToken = tokenFromCapture(confirmCapture);
  check('confirm email carries a raw token', typeof rawToken, 'string');
  const rows = await tokensFor(IDS.plain);
  check('request: one token row', rows.length, 1);
  check('stored value is the SHA-256 hash of the token', rows[0]?.tokenHash, sha256(rawToken));
  check('stored value is NOT the raw token', rows[0]?.tokenHash !== rawToken, true);
  check('token row records the new email', rows[0]?.newEmail, EMAILS.plainNew);
  check('token row starts unused', rows[0]?.usedAt, null);

  // The exchange: email swapped + verified, event appended, notices
  // to both addresses.
  const confirm = await api('/auth/email-change/confirm', { body: { token: rawToken } });
  check('confirm: status', confirm.status, 200);
  check('confirm: ok flag', confirm.json?.ok, true);
  check('confirm: returns the new email', confirm.json?.email, EMAILS.plainNew);
  const swapped = await prisma.user.findUnique({ where: { id: IDS.plain } });
  check('confirm: account email swapped', swapped?.email, EMAILS.plainNew);
  check('confirm: new email marked verified', swapped?.emailVerifiedAt !== null, true);
  const events = await prisma.platformEvent.findMany({ where: { type: 'EMAIL_CHANGED', entityId: IDS.plain } });
  check('confirm: EMAIL_CHANGED event appended', events.length, 1);
  check('event names the old email', events[0]?.details?.oldEmail, EMAILS.plainOld);
  check('event names the new email', events[0]?.details?.newEmail, EMAILS.plainNew);
  check('completion notice to OLD address', await waitFor(() => capturesWithSubject(EMAILS.plainOld, 'username was changed').length >= 1), true);
  check('completion notice to NEW address', await waitFor(() => capturesWithSubject(EMAILS.plainNew, 'username is now this address').length >= 1), true);
  const usedRows = await tokensFor(IDS.plain);
  check('confirm: token consumed', usedRows[0]?.usedAt !== null, true);

  // Sign-in resolves by email: old fails, new succeeds, and the freed
  // old address can register as a fresh account.
  const oldLogin = await login(EMAILS.plainOld);
  check('old email login: status', oldLogin.status, 401);
  const newLogin = await login(EMAILS.plainNew);
  check('new email login: status', newLogin.status, 200);
  check('new email login: session issued', typeof newLogin.json?.token, 'string');
  const fresh = await api('/auth/register', {
    body: { email: EMAILS.plainOld, password: PW, firstName: 'Fresh', lastName: 'Start', termsAcceptance: TERMS },
  });
  check('freed old email registers fresh: status', fresh.status, 201);
  const freshUser = await prisma.user.findFirst({ where: { email: EMAILS.plainOld } });
  check('freed old email: new account is a different id', freshUser?.id !== IDS.plain, true);

  return { freshId: freshUser?.id ?? null, rawToken };
}

// ---------------------------------------------------------------------
// Boot 2 — expired token, and the Layer 2 step-up end to end.
// ---------------------------------------------------------------------
async function phaseTwo(consumedToken) {
  // Replay of boot 1's consumed token — checked after a restart on
  // purpose: the used mark lives in the database, not in memory.
  const replay = await api('/auth/email-change/confirm', { body: { token: consumedToken } });
  check('replay: status', replay.status, 400);
  check('replay: generic error', replay.json?.error, INVALID);

  const expirySession = await login(EMAILS.expiry);
  check('expiry login: status', expirySession.status, 200);
  const expiryReq = await api('/auth/email-change/request', {
    token: expirySession.json?.token,
    body: { newEmail: EMAILS.expiryNew, currentPassword: PW },
  });
  check('expiry request: status', expiryReq.status, 200);
  check('expiry confirm email delivered', await waitFor(() => capturesWithSubject(EMAILS.expiryNew, 'Confirm your new').length >= 1), true);
  const expiryToken = tokenFromCapture(capturesWithSubject(EMAILS.expiryNew, 'Confirm your new')[0]);
  const expiryRows = await tokensFor(IDS.expiry);
  await prisma.emailChangeToken.update({
    where: { id: expiryRows[expiryRows.length - 1].id },
    data: { expiresAt: new Date(Date.now() - 60 * 1000) },
  });
  const expired = await api('/auth/email-change/confirm', { body: { token: expiryToken } });
  check('expired token: status', expired.status, 400);
  check('expired token: generic error', expired.json?.error, INVALID);
  const expiryUser = await prisma.user.findUnique({ where: { id: IDS.expiry } });
  check('expired token: email unchanged', expiryUser?.email, EMAILS.expiry);

  // Layer 2 account: sign in through the real challenge pipeline.
  const l2Login = await login(EMAILS.layer2);
  check('layer2 login: status', l2Login.status, 200);
  check('layer2 login: code step required', l2Login.json?.layer2Required, true);
  const loginChallenge = l2Login.json?.challenge;
  const sendsBefore = capturesWithSubject(EMAILS.layer2, 'sign-in code').length;
  const send = await api('/auth/layer2/send', { body: { challenge: loginChallenge } });
  check('layer2 login send: status', send.status, 200);
  check('layer2 login code emailed', await waitFor(() => capturesWithSubject(EMAILS.layer2, 'sign-in code').length > sendsBefore), true);
  const loginCode = codeFromCapture(capturesWithSubject(EMAILS.layer2, 'sign-in code').at(-1));
  const verify = await api('/auth/layer2/verify', { body: { challenge: loginChallenge, code: loginCode } });
  check('layer2 login verify: status', verify.status, 200);
  const l2Tok = verify.json?.token;
  check('layer2 login verify: session issued', typeof l2Tok, 'string');

  // Step-up, step 1: request WITHOUT a code → code sent, NO token.
  const stepSendsBefore = capturesWithSubject(EMAILS.layer2, 'sign-in code').length;
  const step1 = await api('/auth/email-change/request', {
    token: l2Tok,
    body: { newEmail: EMAILS.layer2New, currentPassword: PW },
  });
  check('step-up no code: status', step1.status, 200);
  check('step-up no code: layer2Required', step1.json?.layer2Required, true);
  check('step-up no code: codeSent', step1.json?.codeSent, true);
  check('step-up no code: challenge returned', typeof step1.json?.challenge, 'string');
  check('step-up no code: code emailed to the account address', await waitFor(() => capturesWithSubject(EMAILS.layer2, 'sign-in code').length > stepSendsBefore), true);
  check('step-up no code: NO token rows', (await tokensFor(IDS.layer2)).length, 0);
  const stepCode = codeFromCapture(capturesWithSubject(EMAILS.layer2, 'sign-in code').at(-1));
  const stepChallenge = step1.json?.challenge;

  // Step-up, step 2a: WRONG code → 401, still no token.
  const wrong = await api('/auth/email-change/request', {
    token: l2Tok,
    body: { newEmail: EMAILS.layer2New, currentPassword: PW, layer2Challenge: stepChallenge, layer2Code: stepCode === '000000' ? '111111' : '000000' },
  });
  check('step-up wrong code: status', wrong.status, 401);
  check('step-up wrong code: code', wrong.json?.code, 'LAYER2_INVALID_CODE');
  check('step-up wrong code: NO token rows', (await tokensFor(IDS.layer2)).length, 0);

  // Step-up, step 2b: RIGHT code → the change token is created.
  const step2 = await api('/auth/email-change/request', {
    token: l2Tok,
    body: { newEmail: EMAILS.layer2New, currentPassword: PW, layer2Challenge: stepChallenge, layer2Code: stepCode },
  });
  check('step-up right code: status', step2.status, 200);
  check('step-up right code: ok flag', step2.json?.ok, true);
  check('step-up right code: one token row', (await tokensFor(IDS.layer2)).length, 1);
  check('step-up: confirm email to the NEW address', await waitFor(() => capturesWithSubject(EMAILS.layer2New, 'Confirm your new').length >= 1), true);
  const l2RawToken = tokenFromCapture(capturesWithSubject(EMAILS.layer2New, 'Confirm your new')[0]);
  check('step-up: raw token captured', typeof l2RawToken, 'string');
  return l2RawToken;
}

// ---------------------------------------------------------------------
// Boot 3 — Layer 2 confirm lands; the taken-mid-flight 409; the
// shield family; a bogus token.
// ---------------------------------------------------------------------
async function phaseThree(l2RawToken) {
  const confirm = await api('/auth/email-change/confirm', { body: { token: l2RawToken } });
  check('layer2 confirm: status', confirm.status, 200);
  check('layer2 confirm: new email returned', confirm.json?.email, EMAILS.layer2New);
  const l2User = await prisma.user.findUnique({ where: { id: IDS.layer2 } });
  check('layer2 confirm: account email swapped', l2User?.email, EMAILS.layer2New);

  // The account now resolves by the NEW email (the login reaches the
  // Layer 2 step, proving the password factor passed on the new name).
  const relogin = await login(EMAILS.layer2New);
  check('layer2 new email login: status', relogin.status, 200);
  check('layer2 new email login: reaches the code step', relogin.json?.layer2Required, true);
  const oldRelogin = await login(EMAILS.layer2);
  check('layer2 old email login: status', oldRelogin.status, 401);

  // Taken mid-flight: raceA requests the target while it is free,
  // someone else registers it, then raceA's confirm → honest 409 and
  // the token is NOT consumed.
  const raceSession = await login(EMAILS.raceA);
  check('race login: status', raceSession.status, 200);
  const raceReq = await api('/auth/email-change/request', {
    token: raceSession.json?.token,
    body: { newEmail: EMAILS.raceTarget, currentPassword: PW },
  });
  check('race request: status', raceReq.status, 200);
  check('race confirm email delivered', await waitFor(() => capturesWithSubject(EMAILS.raceTarget, 'Confirm your new').length >= 1), true);
  const raceToken = tokenFromCapture(capturesWithSubject(EMAILS.raceTarget, 'Confirm your new')[0]);
  const squatter = await api('/auth/register', {
    body: { email: EMAILS.raceTarget, password: PW, firstName: 'Race', lastName: 'Squatter', termsAcceptance: TERMS },
  });
  check('squatter registers the target: status', squatter.status, 201);
  const raceConfirm = await api('/auth/email-change/confirm', { body: { token: raceToken } });
  check('taken mid-flight confirm: status', raceConfirm.status, 409);
  check('taken mid-flight confirm: code', raceConfirm.json?.code, 'EMAIL_TAKEN');
  const raceRows = await tokensFor(IDS.raceA);
  check('taken mid-flight: token NOT consumed', raceRows[0]?.usedAt, null);
  const raceUser = await prisma.user.findUnique({ where: { id: IDS.raceA } });
  check('taken mid-flight: email unchanged', raceUser?.email, EMAILS.raceA);

  // A bogus token gets the same generic 400 as replay/expiry.
  const bogus = await api('/auth/email-change/confirm', { body: { token: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' } });
  check('bogus token: status', bogus.status, 400);
  check('bogus token: generic error', bogus.json?.error, INVALID);

  // The shield's emailChange family: 10 attempts/hr/IP allowed, the
  // 11th refused — checked against a fresh IP key, in-process.
  let last = null;
  for (let i = 0; i < 11; i += 1) {
    last = await consumeIntakeAttempt('emailChange', '198.51.100.23');
  }
  check('shield emailChange family: limit is 10', last?.limit, 10);
  check('shield emailChange family: 11th attempt refused', last?.allowed, false);

  const squatterUser = await prisma.user.findFirst({ where: { email: EMAILS.raceTarget } });
  return squatterUser?.id ?? null;
}

async function cleanup(extraIds) {
  const userIds = [...Object.values(IDS), ...extraIds.filter(Boolean)];
  await prisma.emailChangeToken.deleteMany({ where: { userId: { in: Object.values(IDS) } } });
  await prisma.platformEvent.deleteMany({ where: { type: 'EMAIL_CHANGED' } });
  await prisma.loginChallenge.deleteMany({ where: { userId: { in: Object.values(IDS) } } });
  await prisma.intakeRateWindow.deleteMany({ where: { family: 'emailChange', ip: '198.51.100.23' } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/emails') {
        try { captures.push(JSON.parse(raw)); } catch { /* ignore malformed */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'stub-message-id' }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
  const extraIds = [];
  try {
    await seed();
    await bootServer();
    const phaseOneResult = await phaseOne();
    extraIds.push(phaseOneResult.freshId);
    await stopServer();
    await bootServer();
    const l2RawToken = await phaseTwo(phaseOneResult.rawToken);
    await stopServer();
    await bootServer();
    extraIds.push(await phaseThree(l2RawToken));
  } finally {
    await stopServer();
    stub.close();
    await cleanup(extraIds).catch(() => {});
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await stopServer().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
