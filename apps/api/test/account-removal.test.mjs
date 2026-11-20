/**
 * Account removal drills (2026-11-20, Ramone's directive).
 *
 * The owner-only removal tool in Work Time Account Access
 * (POST /access-control/accounts/:id/remove, services/accountRemoval)
 * is the ONE account delete in the platform, built so Ramone can
 * clear test and fake accounts himself. These drills prove:
 *
 *  1. The gate: anonymous → 401; COMPANY_ADMIN / PLATFORM_ADMIN /
 *     DISPATCHER sessions → 403. Only COMPANY_OWNER can remove.
 *  2. A plain test CUSTOMER is removed: 200, the user row is gone,
 *     the account count drops by one, an ACCOUNT_REMOVED platform
 *     event names the removed email, the account's old token fails
 *     /auth/me with 401, and its sign-in is refused 401.
 *  3. A COMPANY_OWNER account can never be removed (403, intact,
 *     still signs in) — the Master lock is on the target's roles.
 *  4. The Master removing HIMSELF is refused 403 and stays intact.
 *  5. An account holding business records (CRM customer + booking)
 *     is refused 409 naming the blockers, and stays intact; once the
 *     records are deleted, removal succeeds.
 *  6. A removed account's auth artifacts (Speedy Verify code, Layer 2
 *     login challenge, passkey, device session, email-sign-in token)
 *     are gone from their tables.
 *  7. Unknown id → 404; malformed id → 400.
 *
 * Boots the real API in database mode against a local TEST database.
 * Run via the suite runner with DATABASE_URL set to a throwaway DB.
 */
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
if (!process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4721);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const JWT_SECRET = ['account-removal', 'drill', 'secret'].join('-');
const PASSWORD = 'test-pass-1234';

const IDS = {
  owner: '80000000-0000-4000-8000-0000000000a1',
  owner2: '80000000-0000-4000-8000-0000000000a2',
  admin: '80000000-0000-4000-8000-0000000000a3',
  platformAdmin: '80000000-0000-4000-8000-0000000000a4',
  dispatcher: '80000000-0000-4000-8000-0000000000a5',
  plain: '80000000-0000-4000-8000-0000000000b1',
  blocked: '80000000-0000-4000-8000-0000000000b2',
  artifacts: '80000000-0000-4000-8000-0000000000b3',
  custRecord: '80000000-0000-4000-8000-0000000000c1',
  booking: '80000000-0000-4000-8000-0000000000c2',
  ghost: '80000000-0000-4000-8000-0000000000ff',
};
const EMAILS = {
  owner: 'removal-owner@test.local',
  owner2: 'removal-owner2@test.local',
  admin: 'removal-admin@test.local',
  platformAdmin: 'removal-padmin@test.local',
  dispatcher: 'removal-dispatcher@test.local',
  plain: 'removal-plain@test.local',
  blocked: 'removal-blocked@test.local',
  artifacts: 'removal-artifacts@test.local',
};

const prisma = new PrismaClient();
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

function api(path, { token, method = 'GET', body } = {}) {
  return fetch(`${BASE}${path}`, {
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

async function login(email, password = PASSWORD) {
  const { status, json } = await api('/auth/login', { method: 'POST', body: { email, password } });
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

function remove(id, token) {
  return api(`/access-control/accounts/${id}/remove`, { token, method: 'POST', body: {} });
}

function spawnServer() {
  const env = { ...process.env, PORT: String(PORT), JWT_SECRET };
  delete env.ALLOW_DEMO_AUTH;
  const server = spawn('node', ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return server;
}

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up');
}

async function seed() {
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const passwordHash = await hashPassword(PASSWORD);
  const users = [
    { id: IDS.owner, email: EMAILS.owner, roles: ['COMPANY_OWNER'] },
    { id: IDS.owner2, email: EMAILS.owner2, roles: ['COMPANY_OWNER'] },
    { id: IDS.admin, email: EMAILS.admin, roles: ['COMPANY_ADMIN'] },
    { id: IDS.platformAdmin, email: EMAILS.platformAdmin, roles: ['PLATFORM_ADMIN'] },
    { id: IDS.dispatcher, email: EMAILS.dispatcher, roles: ['DISPATCHER'] },
    { id: IDS.plain, email: EMAILS.plain, roles: ['CUSTOMER'] },
    { id: IDS.blocked, email: EMAILS.blocked, roles: ['CUSTOMER'] },
    { id: IDS.artifacts, email: EMAILS.artifacts, roles: ['CUSTOMER'] },
  ];
  for (const u of users) {
    await prisma.user.create({
      data: {
        id: u.id, companyId: PLATFORM_COMPANY_ID, email: u.email, passwordHash,
        firstName: 'Removal', lastName: 'Drill', phone: '9545550300',
        roles: u.roles, active: true, verifyRequired: false, layer2Required: false,
      },
    });
  }
  // Blocked account: a CRM customer record linked to the account,
  // with a real booking under it.
  await prisma.customer.create({
    data: {
      id: IDS.custRecord, companyId: PLATFORM_COMPANY_ID, userId: IDS.blocked,
      name: 'Blocked Drill', phone: '9545550311', email: EMAILS.blocked,
      city: 'Lauderhill', zip: '33313',
    },
  });
  await prisma.serviceRequest.create({
    data: {
      id: IDS.booking, companyId: PLATFORM_COMPANY_ID, customerId: IDS.custRecord,
      referenceCode: 'TS-REMDR1', city: 'Lauderhill', zip: '33313',
      appliance: 'Dryer', issue: 'Drill booking — removal blocker',
    },
  });
  // Artifact account: one row in each auth-artifact table.
  const future = new Date(Date.now() + 60 * 60 * 1000);
  await prisma.speedyVerifyCode.create({ data: { userId: IDS.artifacts, codeHash: 'drill-hash' } });
  await prisma.loginChallenge.create({ data: { userId: IDS.artifacts, expiresAt: future } });
  await prisma.passkeyCredential.create({
    data: { userId: IDS.artifacts, companyId: PLATFORM_COMPANY_ID, credentialId: 'cred-removal-drill', publicKey: 'drill-key' },
  });
  await prisma.userSession.create({
    data: { userId: IDS.artifacts, companyId: PLATFORM_COMPANY_ID, fingerprint: 'removal-drill-fp' },
  });
  await prisma.emailSignInToken.create({
    data: { userId: IDS.artifacts, tokenHash: 'removal-drill-token-hash', expiresAt: future },
  });
}

async function main() {
  await seed();
  const server = spawnServer();
  try {
    await waitForServer();

    const ownerTok = await login(EMAILS.owner);
    const owner2Tok = await login(EMAILS.owner2);
    const adminTok = await login(EMAILS.admin);
    const platformAdminTok = await login(EMAILS.platformAdmin);
    const dispatcherTok = await login(EMAILS.dispatcher);
    const plainTok = await login(EMAILS.plain);

    // --- Drill 1: the gate -------------------------------------------
    check('anon remove → 401', (await remove(IDS.plain)).status, 401);
    check('COMPANY_ADMIN remove → 403', (await remove(IDS.plain, adminTok)).status, 403);
    check('PLATFORM_ADMIN remove → 403', (await remove(IDS.plain, platformAdminTok)).status, 403);
    check('DISPATCHER remove → 403', (await remove(IDS.plain, dispatcherTok)).status, 403);
    checkTrue('plain account untouched by refused attempts', await prisma.user.findUnique({ where: { id: IDS.plain } }));

    // --- Drill 7: bad ids ---------------------------------------------
    check('unknown id → 404', (await remove(IDS.ghost, ownerTok)).status, 404);
    check('malformed id → 400', (await api('/access-control/accounts/not-a-uuid/remove', { token: ownerTok, method: 'POST', body: {} })).status, 400);

    // --- Drill 3: a COMPANY_OWNER account can never be removed --------
    const d3 = await remove(IDS.owner2, ownerTok);
    check('remove another COMPANY_OWNER → 403', d3.status, 403);
    check('lock code', d3.json?.code, 'MASTER_ACCOUNT_PROTECTED');
    checkTrue('owner2 row intact', await prisma.user.findUnique({ where: { id: IDS.owner2 } }));
    check('owner2 still signs in', (await api('/auth/login', { method: 'POST', body: { email: EMAILS.owner2, password: PASSWORD } })).status, 200);
    checkTrue('owner2 token still valid', owner2Tok.length > 10);

    // --- Drill 4: the Master removing himself --------------------------
    const d4 = await remove(IDS.owner, ownerTok);
    check('master removes self → 403', d4.status, 403);
    checkTrue('master row intact', await prisma.user.findUnique({ where: { id: IDS.owner } }));
    check('master /auth/me still 200', (await api('/auth/me', { token: ownerTok })).status, 200);

    // --- Drill 5: business records block, then clear -------------------
    const d5 = await remove(IDS.blocked, ownerTok);
    check('blocked account remove → 409', d5.status, 409);
    check('blocker code', d5.json?.code, 'ACCOUNT_HAS_RECORDS');
    check('blockers.customers', d5.json?.blockers?.customers, 1);
    check('blockers.bookings', d5.json?.blockers?.bookings, 1);
    checkTrue('409 message names bookings', /booking/i.test(d5.json?.error || ''));
    checkTrue('blocked row intact after 409', await prisma.user.findUnique({ where: { id: IDS.blocked } }));
    check('blocked still signs in', (await api('/auth/login', { method: 'POST', body: { email: EMAILS.blocked, password: PASSWORD } })).status, 200);
    await prisma.serviceRequest.delete({ where: { id: IDS.booking } });
    await prisma.customer.delete({ where: { id: IDS.custRecord } });
    check('blocked remove after clearing records → 200', (await remove(IDS.blocked, ownerTok)).status, 200);
    check('blocked row gone', await prisma.user.findUnique({ where: { id: IDS.blocked } }), null);

    // --- Drill 6: auth artifacts die with the account ------------------
    check('artifacts remove → 200', (await remove(IDS.artifacts, ownerTok)).status, 200);
    check('speedyVerifyCode rows gone', await prisma.speedyVerifyCode.count({ where: { userId: IDS.artifacts } }), 0);
    check('loginChallenge rows gone', await prisma.loginChallenge.count({ where: { userId: IDS.artifacts } }), 0);
    check('passkeyCredential rows gone', await prisma.passkeyCredential.count({ where: { userId: IDS.artifacts } }), 0);
    check('userSession rows gone', await prisma.userSession.count({ where: { userId: IDS.artifacts } }), 0);
    check('emailSignInToken rows gone', await prisma.emailSignInToken.count({ where: { userId: IDS.artifacts } }), 0);

    // --- Drill 2: plain removal is complete ----------------------------
    const countBefore = await prisma.user.count({ where: { companyId: PLATFORM_COMPANY_ID } });
    const d2 = await remove(IDS.plain, ownerTok);
    check('plain remove → 200', d2.status, 200);
    check('removed email echoed', d2.json?.removed?.email, EMAILS.plain);
    check('plain row gone', await prisma.user.findUnique({ where: { id: IDS.plain } }), null);
    const countAfter = await prisma.user.count({ where: { companyId: PLATFORM_COMPANY_ID } });
    check('account count drops by one', countAfter, countBefore - 1);
    const events = await prisma.platformEvent.findMany({ where: { type: 'ACCOUNT_REMOVED' } });
    const plainEvent = events.find((e) => e.details?.removedEmail === EMAILS.plain);
    checkTrue('ACCOUNT_REMOVED event recorded for plain', plainEvent);
    check('event actor is the master', plainEvent?.actor, EMAILS.owner);
    check('old token /auth/me → 401', (await api('/auth/me', { token: plainTok })).status, 401);
    check('removed sign-in → 401', (await api('/auth/login', { method: 'POST', body: { email: EMAILS.plain, password: PASSWORD } })).status, 401);

    // Scorecard reads the same user table — its accounts number must
    // match the live count after the removals.
    const score = await api('/bookos/scorecard', { token: ownerTok });
    check('scorecard accounts = live user count', score.json?.data?.customers?.accounts, countAfter);
  } finally {
    server.kill('SIGTERM');
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
