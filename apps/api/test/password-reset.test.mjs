/**
 * Password reset (forgot-password) — verification harness (2026-11-18).
 *
 * Exercises the self-serve reset flow end to end over HTTP:
 * POST /auth/forgot-password is enumeration-safe (generic 200 for
 * known, unknown, and rate-limited requests alike; unknown emails
 * create no token and attempt no email), the emailed link carries a
 * raw token whose SHA-256 hash is all that is stored, and
 * POST /auth/reset-password rejects wrong / superseded / expired /
 * reused tokens with the same generic 400, replaces the password
 * (old login fails, new login succeeds through the real login
 * endpoint, no session is returned by the reset itself), and clears
 * any temporary-password state on the account. Per-account issuance
 * is capped at 5 reset emails per hour.
 *
 * Email delivery is captured through the platform's real Resend
 * sender pointed at a local stub (RESEND_API_BASE), so the captured
 * payload is exactly what Resend would receive.
 *
 * Runs against a LOCAL test database only. Usage:
 *   set DATABASE_URL to a local TEST database connection string
 *   node test/password-reset.test.mjs
 * The harness seeds its own company/users, boots the real API on
 * TEST_PORT (default 4431) — twice, because the /auth rate limiter
 * allows 10 requests per IP per 15 minutes per process — and cleans
 * up. Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

const DB_URL = process.env['DATABASE_' + 'URL'];
if (!DB_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env['DATABASE_' + 'URL_UNPOOLED'] ||= DB_URL;

const PORT = Number(process.env.TEST_PORT || 4431);
const STUB_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const GENERIC = 'If an account with that email exists, a password reset email is on its way.';
const INVALID = 'This reset link is invalid or has expired';
const OLD_PW = 'old-pass-12345';
const NEW_PW = 'new-pass-67890';
const NEW_PW2 = 'new-pass-abcde';

const IDS = {
  drill: '20000000-0000-4000-8000-0000000000e1',
  temp: '20000000-0000-4000-8000-0000000000e2',
  rate: '20000000-0000-4000-8000-0000000000e3',
};
const EMAILS = {
  drill: 'pwreset-drill@test.local',
  temp: 'pwreset-temp@test.local',
  rate: 'pwreset-rate@test.local',
  ghost: 'pwreset-ghost@test.local',
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

async function api(path, { method = 'POST', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function tokenFromCapture(capture) {
  const match = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(capture?.text || '');
  return match ? match[1] : null;
}

function capturesTo(email) {
  return captures.filter((entry) => Array.isArray(entry.to) && entry.to.includes(email));
}

async function waitForCaptureCount(email, count, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (capturesTo(email).length >= count) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return capturesTo(email).length >= count;
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
  childEnv['JWT_' + 'SECRET'] = 'pwreset-drill-secret';
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
  const passwordHash = await hashPassword(OLD_PW);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const base = { companyId: PLATFORM_COMPANY_ID, passwordHash, roles: ['CUSTOMER'], active: true };
  await prisma.user.upsert({
    where: { id: IDS.drill },
    update: { passwordHash },
    create: { ...base, id: IDS.drill, email: EMAILS.drill, firstName: 'Drill', lastName: 'Reset' },
  });
  await prisma.user.upsert({
    where: { id: IDS.temp },
    update: { passwordHash },
    create: {
      ...base,
      id: IDS.temp,
      email: EMAILS.temp,
      firstName: 'Temp',
      lastName: 'Holder',
      tempPasswordHash: await hashPassword('Temp-Word-1234!'),
      tempPasswordExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      mustChangePassword: true,
      tempFailedAttempts: 2,
      tempChangeJti: 'drill-jti',
    },
  });
  await prisma.user.upsert({
    where: { id: IDS.rate },
    update: { passwordHash },
    create: { ...base, id: IDS.rate, email: EMAILS.rate, firstName: 'Rate', lastName: 'Limited' },
  });
  await prisma.passwordResetToken.deleteMany({ where: { userId: { in: Object.values(IDS) } } });
}

async function tokensFor(userId) {
  return prisma.passwordResetToken.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
}

async function phaseOne() {
  // Unknown email: generic 200, no token row, no email attempted.
  const ghost = await api('/auth/forgot-password', { body: { email: EMAILS.ghost } });
  check('unknown email: status', ghost.status, 200);
  check('unknown email: generic message', ghost.json?.message, GENERIC);
  check('unknown email: token rows created', await prisma.passwordResetToken.count(), 0);
  await new Promise((r) => setTimeout(r, 2500));
  check('unknown email: emails attempted', captures.length, 0);

  // Known email: generic 200, one email through the real sender path,
  // and the database holds only the token's SHA-256 hash.
  const first = await api('/auth/forgot-password', { body: { email: EMAILS.drill } });
  check('known email: status', first.status, 200);
  check('known email: generic message', first.json?.message, GENERIC);
  check('known email: reset email delivered to stub', await waitForCaptureCount(EMAILS.drill, 1), true);
  const rawToken1 = tokenFromCapture(capturesTo(EMAILS.drill)[0]);
  check('known email: link carries a raw token', typeof rawToken1, 'string');
  const rows1 = await tokensFor(IDS.drill);
  check('known email: one token row', rows1.length, 1);
  check('stored value is the SHA-256 hash of the token', rows1[0]?.tokenHash, sha256(rawToken1));
  check('stored value is NOT the raw token', rows1[0]?.tokenHash !== rawToken1, true);
  check('token row starts unused', rows1[0]?.usedAt, null);

  // A wrong token gets the generic 400.
  const wrong = await api('/auth/reset-password', { body: { token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', newPassword: NEW_PW } });
  check('wrong token: status', wrong.status, 400);
  check('wrong token: generic error', wrong.json?.error, INVALID);

  // A second request supersedes the first token.
  const second = await api('/auth/forgot-password', { body: { email: EMAILS.drill } });
  check('second request: status', second.status, 200);
  check('second request: second email delivered', await waitForCaptureCount(EMAILS.drill, 2), true);
  const rawToken2 = tokenFromCapture(capturesTo(EMAILS.drill)[1]);
  const rows2 = await tokensFor(IDS.drill);
  check('second request: two token rows', rows2.length, 2);
  check('second request: first token superseded', rows2[0]?.usedAt !== null, true);
  const superseded = await api('/auth/reset-password', { body: { token: rawToken1, newPassword: NEW_PW } });
  check('superseded token: status', superseded.status, 400);
  check('superseded token: generic error', superseded.json?.error, INVALID);

  // An expired token gets the same generic 400.
  await prisma.passwordResetToken.update({
    where: { id: rows2[1].id },
    data: { expiresAt: new Date(Date.now() - 60 * 1000) },
  });
  const expired = await api('/auth/reset-password', { body: { token: rawToken2, newPassword: NEW_PW } });
  check('expired token: status', expired.status, 400);
  check('expired token: generic error', expired.json?.error, INVALID);

  // Third request: the successful exchange.
  const third = await api('/auth/forgot-password', { body: { email: EMAILS.drill } });
  check('third request: status', third.status, 200);
  check('third request: third email delivered', await waitForCaptureCount(EMAILS.drill, 3), true);
  const rawToken3 = tokenFromCapture(capturesTo(EMAILS.drill)[2]);
  const reset = await api('/auth/reset-password', { body: { token: rawToken3, newPassword: NEW_PW } });
  check('reset success: status', reset.status, 200);
  check('reset success: ok flag', reset.json?.ok, true);
  check('reset success: NO session token returned', reset.json?.token, undefined);

  // The real login endpoint now rejects the old password and accepts
  // the new one.
  const oldLogin = await api('/auth/login', { body: { email: EMAILS.drill, password: OLD_PW } });
  check('old password login: status', oldLogin.status, 401);
  const newLogin = await api('/auth/login', { body: { email: EMAILS.drill, password: NEW_PW } });
  check('new password login: status', newLogin.status, 200);
  check('new password login: session issued', typeof newLogin.json?.token, 'string');

  return rawToken3;
}

async function phaseTwo(rawToken3) {
  // Token reuse — checked after a restart on purpose: the used mark
  // lives in the database, not in process memory.
  const reuse = await api('/auth/reset-password', { body: { token: rawToken3, newPassword: NEW_PW2 } });
  check('reused token: status', reuse.status, 400);
  check('reused token: generic error', reuse.json?.error, INVALID);

  // Temporary-password state is cleared by a completed reset.
  const tempReq = await api('/auth/forgot-password', { body: { email: EMAILS.temp } });
  check('temp holder request: status', tempReq.status, 200);
  check('temp holder: reset email delivered', await waitForCaptureCount(EMAILS.temp, 1), true);
  const rawToken4 = tokenFromCapture(capturesTo(EMAILS.temp)[0]);
  const tempReset = await api('/auth/reset-password', { body: { token: rawToken4, newPassword: NEW_PW2 } });
  check('temp holder reset: status', tempReset.status, 200);
  const tempUser = await prisma.user.findUnique({ where: { id: IDS.temp } });
  check('temp state: tempPasswordHash cleared', tempUser?.tempPasswordHash, null);
  check('temp state: tempPasswordExpiresAt cleared', tempUser?.tempPasswordExpiresAt, null);
  check('temp state: mustChangePassword cleared', tempUser?.mustChangePassword, false);
  check('temp state: tempFailedAttempts cleared', tempUser?.tempFailedAttempts, 0);
  check('temp state: tempChangeJti cleared', tempUser?.tempChangeJti, null);
  const tempLogin = await api('/auth/login', { body: { email: EMAILS.temp, password: NEW_PW2 } });
  check('temp holder new password login: status', tempLogin.status, 200);

  // Per-account cap: 5 reset emails per hour; the 6th request still
  // answers generically but sends nothing and stores nothing new.
  for (let i = 0; i < 6; i += 1) {
    const res = await api('/auth/forgot-password', { body: { email: EMAILS.rate } });
    check(`rate request ${i + 1}: status`, res.status, 200);
    check(`rate request ${i + 1}: generic message`, res.json?.message, GENERIC);
  }
  check('rate cap: 5 emails delivered', await waitForCaptureCount(EMAILS.rate, 5, 4000), true);
  await new Promise((r) => setTimeout(r, 2500));
  check('rate cap: still exactly 5 emails', capturesTo(EMAILS.rate).length, 5);
  check('rate cap: exactly 5 token rows', (await tokensFor(IDS.rate)).length, 5);
}

async function cleanup() {
  await prisma.passwordResetToken.deleteMany({ where: { userId: { in: Object.values(IDS) } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(IDS) } } });
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
  try {
    await seed();
    await bootServer();
    const rawToken3 = await phaseOne();
    await stopServer();
    await bootServer();
    await phaseTwo(rawToken3);
  } finally {
    await stopServer();
    stub.close();
    await cleanup().catch(() => {});
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
