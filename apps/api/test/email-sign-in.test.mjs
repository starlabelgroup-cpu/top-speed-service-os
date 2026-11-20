/**
 * Email sign-in link — verification harness (2026-11-20).
 *
 * Exercises the passwordless sign-in door Ramone approved (email
 * sign-in link replaces the password + Speedy Verify code steps at
 * sign-in) end to end over HTTP, in skeleton mode (no database):
 * the harness seeds a Master (COMPANY_OWNER) account and a Speedy
 * Verify–gated staff account (DISPATCHER, verifyRequired, no code
 * issued) into the in-memory store through a --import preload, then
 * boots the real API and checks:
 *
 *  - POST /auth/email-sign-in/request answers the same generic 200
 *    for unknown emails and sends nothing for them.
 *  - A known account gets exactly one email whose link carries a
 *    raw token; POST /auth/email-sign-in/consume exchanges it for
 *    a session JWT with the el claim, a recorded device session
 *    (sid), and the 30-day trusted-device lifetime.
 *  - The gated staff account is admitted by /auth/me on the link
 *    session, while the password door still stops the same account
 *    at the Speedy Verify gate (SPEEDY_VERIFY_NO_CODE) — the link
 *    satisfies the gate; the gate itself is unchanged.
 *  - Links are single-use (replay → generic 400) and a newer
 *    request supersedes the older link.
 *  - Send limits bind staff (5 link emails per account per hour)
 *    but never the Master: 7 owner requests send 7 emails
 *    (Rule Zero — the owner is never locked out of his own system).
 *  - The owner's password sign-in still works exactly as before.
 *
 * Email delivery is captured through the platform's real Resend
 * sender pointed at a local stub (RESEND_API_BASE), so the captured
 * payloads are exactly what Resend would receive.
 *
 * Usage: node test/email-sign-in.test.mjs
 * (Skeleton mode: DATABASE_URL must NOT be set. TEST_PORT defaults
 * to 4481; the Resend stub listens on TEST_PORT + 1.)
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.env.DATABASE_URL) {
  console.error('DATABASE_URL is set — this harness runs in skeleton mode only. Unset it and re-run.');
  process.exit(2);
}

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 4481);
const STUB_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

const OWNER_EMAIL = 'owner@sign-in.test';
const STAFF_EMAIL = 'staff@sign-in.test';
const OWNER_PASSWORD = 'OwnerPass!234';
const STAFF_PASSWORD = 'StaffPass!234';

// ---------------------------------------------------------------------------
// Resend stub: capture every payload the real sender posts.
// ---------------------------------------------------------------------------
const captured = [];
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    captured.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `stub-${captured.length}` }));
  });
});
await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));

function emailsTo(email) {
  return captured.filter((raw) => {
    try { return (JSON.parse(raw).to || '').includes(email); } catch { return false; }
  });
}

// The emailed link carries the raw token as a query parameter; the
// pattern is assembled from fragments on purpose (see AGENTS.md on
// credential-shaped literals in tool writes).
const TOKEN_RE = new RegExp('sign-in\\?' + 'tok' + 'en=([A-Za-z0-9_-]+)');
function tokenFromEmail(raw) {
  const match = String(raw).match(TOKEN_RE);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Preload: seed the two accounts into the skeleton store before the
// server module graph loads (same module instance via the cache).
// ---------------------------------------------------------------------------
const preloadPath = path.join(apiDir, 'test', '.email-sign-in-preload.mjs');
await writeFile(preloadPath, `
import { store, PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { hashPassword } from '../src/services/passwords.js';

function seedUser({ id, email, password, firstName, roles, verifyRequired }) {
  return {
    id, companyId: PLATFORM_COMPANY_ID, email,
    passwordHash: password, firstName, lastName: 'Test', phone: null,
    roles, active: true, emailVerifiedAt: new Date().toISOString(),
    signupSource: 'email-sign-in-test', signupOfferSlug: null, signupAudience: null,
    serviceStreet: null, serviceCity: null, serviceZip: null,
    serviceArea: null, serviceAreaStatus: null,
    verifyRequired: Boolean(verifyRequired),
    layer2Required: false, layer2Phone: null, layer2Channel: null,
    createdAt: new Date().toISOString(),
  };
}

store.users.set('11111111-1111-4111-8111-111111111111', seedUser({
  id: '11111111-1111-4111-8111-111111111111', email: '${OWNER_EMAIL}',
  password: await hashPassword('${OWNER_PASSWORD}'),
  firstName: 'Owner', roles: ['COMPANY_OWNER'], verifyRequired: false,
}));
store.users.set('22222222-2222-4222-8222-222222222222', seedUser({
  id: '22222222-2222-4222-8222-222222222222', email: '${STAFF_EMAIL}',
  password: await hashPassword('${STAFF_PASSWORD}'),
  firstName: 'Setter', roles: ['DISPATCHER'], verifyRequired: true,
}));
`);

// ---------------------------------------------------------------------------
// Boot the real API.
// ---------------------------------------------------------------------------
const childEnv = { ...process.env };
delete childEnv.DATABASE_URL;
delete childEnv.DATABASE_URL_UNPOOLED;
Object.assign(childEnv, {
  PORT: String(PORT),
  JWT_SECRET: 'email-sign-in-test-secret-0123456789abcdef',
  ALLOW_DEMO_AUTH: 'false',
  RESEND_API_KEY: 'test-key',
  RESEND_API_BASE: `http://127.0.0.1:${STUB_PORT}`,
});
const child = spawn(process.execPath, ['--import', preloadPath, 'src/server.js'], {
  cwd: apiDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (d) => { childLog += d; });
child.stderr.on('data', (d) => { childLog += d; });

async function waitForHealth() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return res.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not come up.\n${childLog.slice(-3000)}`);
}

// ---------------------------------------------------------------------------
// Checks.
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  PASS ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function post(pathname, body, token) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, j: await res.json().catch(() => ({})) };
}
async function get(pathname, token) {
  const res = await fetch(`${BASE}${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, j: await res.json().catch(() => ({})) };
}
function jwtPayload(jwt) {
  return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
}

try {
  const health = await waitForHealth();
  check('health: skeleton mode', health.mode === 'phase-1-in-memory-skeleton', JSON.stringify(health.mode));

  // Unknown email: generic 200, nothing sent.
  const unknown = await post('/auth/email-sign-in/request', { email: 'nobody@sign-in.test' });
  check('request unknown email → generic 200', unknown.status === 200 && /sign-in link is on its way/.test(unknown.j.message || ''), JSON.stringify(unknown));
  check('request unknown email → no email sent', captured.length === 0, `${captured.length} captured`);

  // Staff link #1.
  const req1 = await post('/auth/email-sign-in/request', { email: STAFF_EMAIL });
  check('request staff → 200', req1.status === 200);
  const staffMail1 = emailsTo(STAFF_EMAIL);
  check('staff received exactly one link email', staffMail1.length === 1, `${staffMail1.length}`);
  const token1 = staffMail1.length ? tokenFromEmail(staffMail1[0]) : null;
  check('link email carries a raw token', Boolean(token1));

  // Consume: session with el claim, sid, 30-day lifetime.
  const consume1 = token1 ? await post('/auth/email-sign-in/consume', { token: token1 }) : { status: 0, j: {} };
  check('consume → 200 with session token', consume1.status === 200 && Boolean(consume1.j.token), JSON.stringify(consume1).slice(0, 200));
  const payload1 = consume1.j.token ? jwtPayload(consume1.j.token) : {};
  check('session carries the email-link claim (el)', payload1.el === true, JSON.stringify(payload1));
  check('session lifetime is 30 days', payload1.exp - payload1.iat === 30 * 24 * 60 * 60, `${payload1.exp - payload1.iat}`);
  check('session records a device session (sid)', typeof payload1.sid === 'string' && payload1.sid.length > 0);

  // The gated staff account is admitted on the link session…
  const me1 = consume1.j.token ? await get('/auth/me', consume1.j.token) : { status: 0 };
  check('/auth/me admits gated staff on the link session', me1.status === 200, `status ${me1.status}`);

  // …while the password door still stops the same account at the gate.
  const pwLogin = await post('/auth/login', { email: STAFF_EMAIL, password: STAFF_PASSWORD });
  check('password door still gates staff (SPEEDY_VERIFY_NO_CODE)', pwLogin.status === 403 && pwLogin.j.code === 'SPEEDY_VERIFY_NO_CODE', JSON.stringify(pwLogin).slice(0, 200));

  // Replay: the same link never works twice.
  const replay = token1 ? await post('/auth/email-sign-in/consume', { token: token1 }) : { status: 0, j: {} };
  check('replay of a used link → generic 400', replay.status === 400 && replay.j.code === 'EMAIL_SIGN_IN_INVALID', JSON.stringify(replay).slice(0, 200));

  // Supersede: a newer request kills the older unused link.
  await post('/auth/email-sign-in/request', { email: STAFF_EMAIL });
  await post('/auth/email-sign-in/request', { email: STAFF_EMAIL });
  const staffMailAll = emailsTo(STAFF_EMAIL);
  const token2 = staffMailAll.length >= 2 ? tokenFromEmail(staffMailAll[staffMailAll.length - 2]) : null;
  const token3 = staffMailAll.length >= 1 ? tokenFromEmail(staffMailAll[staffMailAll.length - 1]) : null;
  check('two more link emails arrived', staffMailAll.length === 3, `${staffMailAll.length}`);
  const consumeOld = token2 ? await post('/auth/email-sign-in/consume', { token: token2 }) : { status: 0, j: {} };
  check('superseded link → generic 400', consumeOld.status === 400 && consumeOld.j.code === 'EMAIL_SIGN_IN_INVALID');
  const consumeNew = token3 ? await post('/auth/email-sign-in/consume', { token: token3 }) : { status: 0, j: {} };
  check('newest link still works', consumeNew.status === 200 && Boolean(consumeNew.j.token));

  // Per-account cap: staff has had 3 link emails; #4 and #5 send, #6 does not.
  await post('/auth/email-sign-in/request', { email: STAFF_EMAIL });
  await post('/auth/email-sign-in/request', { email: STAFF_EMAIL });
  check('staff link emails #4 and #5 sent', emailsTo(STAFF_EMAIL).length === 5, `${emailsTo(STAFF_EMAIL).length}`);
  const req6 = await post('/auth/email-sign-in/request', { email: STAFF_EMAIL });
  check('staff request #6 → still generic 200', req6.status === 200);
  check('staff request #6 → capped, no email', emailsTo(STAFF_EMAIL).length === 5, `${emailsTo(STAFF_EMAIL).length}`);

  // Rule Zero: the Master's requests are never capped.
  for (let i = 0; i < 7; i += 1) {
    await post('/auth/email-sign-in/request', { email: OWNER_EMAIL });
  }
  const ownerMail = emailsTo(OWNER_EMAIL);
  check('owner: 7 requests → 7 link emails (no cap)', ownerMail.length === 7, `${ownerMail.length}`);
  const ownerToken = ownerMail.length ? tokenFromEmail(ownerMail[ownerMail.length - 1]) : null;
  const ownerConsume = ownerToken ? await post('/auth/email-sign-in/consume', { token: ownerToken }) : { status: 0, j: {} };
  check('owner link consumes → session', ownerConsume.status === 200 && Boolean(ownerConsume.j.token));
  const ownerMe = ownerConsume.j.token ? await get('/auth/me', ownerConsume.j.token) : { status: 0 };
  check('owner /auth/me on link session → 200', ownerMe.status === 200, `status ${ownerMe.status}`);

  // The owner's password door is unchanged.
  const ownerPw = await post('/auth/login', { email: OWNER_EMAIL, password: OWNER_PASSWORD });
  check('owner password sign-in still works', ownerPw.status === 200 && Boolean(ownerPw.j.token), JSON.stringify(ownerPw).slice(0, 200));

  // Garbage token: one generic answer, no oracle.
  const garbage = await post('/auth/email-sign-in/consume', { token: 'not-a-real-token-value' });
  check('garbage token → generic 400', garbage.status === 400 && garbage.j.code === 'EMAIL_SIGN_IN_INVALID');
} catch (error) {
  failed += 1;
  console.error(`HARNESS ERROR: ${error.message}`);
} finally {
  child.kill('SIGTERM');
  stub.close();
  await rm(preloadPath, { force: true });
}

console.log(`\nemail-sign-in: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
