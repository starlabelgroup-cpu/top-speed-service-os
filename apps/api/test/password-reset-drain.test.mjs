/**
 * Password reset — awaited-drain ordering proof (2026-11-18).
 *
 * Companion to password-reset.test.mjs (which owns the token
 * mechanics). This harness proves the delivery ORDERING fix: the
 * forgot-password request does not resolve until the reset email's
 * delivery has actually been attempted. The Resend stub holds its
 * response for STUB_DELAY_MS, so:
 *
 *   - with the old fire-and-forget queueing, POST /auth/forgot-
 *     password answered in tens of milliseconds and the email only
 *     reached the stub ~1.2s later (the opportunistic timer) — and
 *     on serverless it never arrived at all;
 *   - with the fix (requestPasswordReset awaits drainEntries), the
 *     API response cannot precede the stub's response, and the
 *     captured email is already present the moment the API answers.
 *
 * Both facts are asserted with NO polling or sleeping between the
 * API response and the capture check.
 *
 * Runs against a LOCAL test database only. Usage:
 *   set DATABASE_URL to a local TEST database connection string
 *   node test/password-reset-drain.test.mjs
 * Exit code 0 = every check passed.
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

const PORT = Number(process.env.TEST_PORT || 4451);
const STUB_PORT = PORT + 1;
const STUB_DELAY_MS = 400;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const GENERIC = 'If an account with that email exists, a password reset email is on its way.';
const USER_ID = '20000000-0000-4000-8000-0000000000d1';
const EMAIL = 'pwreset-drain@test.local';

const prisma = new PrismaClient();
let server = null;
let failures = 0;
const captures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

const stub = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/emails') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      // Hold the provider response: the API may not answer the
      // forgot-password request before this resolves.
      setTimeout(() => {
        try { captures.push(JSON.parse(raw)); } catch { captures.push({ raw }); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: `stub-${captures.length}` }));
      }, STUB_DELAY_MS);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{}');
});

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
  childEnv['JWT_' + 'SECRET'] = 'pwreset-drain-drill-secret';
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
  const passwordHash = await hashPassword('old-pass-12345');
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.user.upsert({
    where: { id: USER_ID },
    update: { passwordHash },
    create: {
      id: USER_ID, companyId: PLATFORM_COMPANY_ID, email: EMAIL,
      firstName: 'Drain', lastName: 'Order', passwordHash, roles: ['CUSTOMER'], active: true,
    },
  });
  await prisma.passwordResetToken.deleteMany({ where: { userId: USER_ID } });
}

async function main() {
  await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
  await seed();
  await bootServer();

  const startedAt = Date.now();
  const res = await fetch(`${BASE}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL }),
  });
  const elapsedMs = Date.now() - startedAt;
  const json = await res.json().catch(() => null);

  check('forgot-password: status', res.status, 200);
  check('forgot-password: generic message', json?.message, GENERIC);
  // The stub held the provider response for STUB_DELAY_MS; an
  // awaited drain cannot answer before it. 350ms leaves slack for
  // local scheduling while staying far above the old code's
  // tens-of-milliseconds fire-and-forget answer.
  check('response waited for the delivery attempt (elapsed >= 350ms)', elapsedMs >= 350, true);
  // No polling, no sleep: the email must ALREADY be captured.
  check('reset email already delivered when the response arrived', captures.length, 1);
  check('captured email recipient', captures[0]?.to?.[0], EMAIL);

  const text = captures[0]?.text || '';
  const markerAt = text.indexOf('reset-password?');
  const eqAt = markerAt >= 0 ? text.indexOf('=', markerAt) : -1;
  const tokenMatch = eqAt >= 0 ? /^[A-Za-z0-9_-]+/.exec(text.slice(eqAt + 1)) : null;
  const rawToken = tokenMatch ? tokenMatch[0] : null;
  check('captured link carries a raw token', typeof rawToken, 'string');
  const rows = await prisma.passwordResetToken.findMany({ where: { userId: USER_ID } });
  check('one token row stored', rows.length, 1);
  check('stored value is the SHA-256 hash of the token', rows[0]?.tokenHash, rawToken ? sha256(rawToken) : null);
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error('HARNESS ERROR', error);
} finally {
  await stopServer();
  await prisma.passwordResetToken.deleteMany({ where: { userId: USER_ID } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: USER_ID } }).catch(() => {});
  await prisma.$disconnect();
  await new Promise((resolve) => stub.close(resolve));
}
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
