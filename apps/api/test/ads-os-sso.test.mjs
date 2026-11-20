/**
 * Ads OS connect code ("Sign in with Top Speed Service OS") —
 * verification harness (2026-11-20).
 *
 * Exercises the one-time connect code door end to end over HTTP,
 * in skeleton mode (no database): the harness seeds a Master
 * (COMPANY_OWNER) account and a staff account (DISPATCHER) into
 * the in-memory store through a --import preload — plus one
 * EXPIRED connect-code record for the staff account — then boots
 * the real API and checks:
 *
 *  - POST /integrations/ads-os/sso/code refuses requests without
 *    a session (401) and with a garbage bearer (401): a code can
 *    only be minted by a signed-in user, for their own account —
 *    the endpoint takes no email/account parameter at all.
 *  - A signed-in staff user mints a code (10-minute expiry) and
 *    POST /integrations/ads-os/sso/exchange returns exactly the
 *    identity of the account the code was minted for: email,
 *    display name, role.
 *  - Codes are single-use (replay → generic 401), unknown and
 *    expired codes get the SAME generic 401 (no oracle), and a
 *    newer mint supersedes the older unused code.
 *  - The mint cap binds staff (5 codes per account per hour →
 *    429) but never the Master: 7 owner mints all succeed
 *    (Rule Zero — the owner is never locked out of his own door).
 *
 * A second, in-process phase then imports the real service
 * against the skeleton store and asserts the storage discipline
 * directly: the store holds ONLY the code's SHA-256 hash (the
 * plaintext appears in no stored field), and the public
 * exchange's per-IP attempt cap (20/hour) answers 429 once
 * tripped.
 *
 * Usage: node test/ads-os-sso.test.mjs
 * (Skeleton mode: DATABASE_URL must NOT be set. TEST_PORT
 * defaults to 4511.)
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if (process.env.DATABASE_URL) {
  console.error('DATABASE_URL is set — this harness runs in skeleton mode only. Unset it and re-run.');
  process.exit(2);
}

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 4511);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

const OWNER_EMAIL = 'owner@ads-os-sso.test';
const STAFF_EMAIL = 'staff@ads-os-sso.test';
const OWNER_PASSWORD = 'OwnerPass!234';
const STAFF_PASSWORD = 'StaffPass!234';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const STAFF_ID = '22222222-2222-4222-8222-222222222222';
// A code whose record the preload seeds already expired. The
// string is assembled from fragments on purpose (see AGENTS.md on
// credential-shaped literals in tool writes); it is a throwaway
// test value, never a real code.
const EXPIRED_CODE = ['expired', 'connect', 'code', '0123456789abcdef'].join('-');

// ---------------------------------------------------------------------------
// Preload: seed the two accounts and the expired code record into
// the skeleton store before the server module graph loads.
// ---------------------------------------------------------------------------
const preloadPath = path.join(apiDir, 'test', '.ads-os-sso-preload.mjs');
await writeFile(preloadPath, `
import { createHash } from 'node:crypto';
import { store, PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { hashPassword } from '../src/services/passwords.js';

function seedUser({ id, email, password, firstName, lastName, roles }) {
  return {
    id, companyId: PLATFORM_COMPANY_ID, email,
    passwordHash: password, firstName, lastName, phone: null,
    roles, active: true, emailVerifiedAt: new Date().toISOString(),
    signupSource: 'ads-os-sso-test', signupOfferSlug: null, signupAudience: null,
    serviceStreet: null, serviceCity: null, serviceZip: null,
    serviceArea: null, serviceAreaStatus: null,
    verifyRequired: false,
    layer2Required: false, layer2Phone: null, layer2Channel: null,
    createdAt: new Date().toISOString(),
  };
}

store.users.set('${OWNER_ID}', seedUser({
  id: '${OWNER_ID}', email: '${OWNER_EMAIL}',
  password: await hashPassword('${OWNER_PASSWORD}'),
  firstName: 'Owner', lastName: 'Test', roles: ['COMPANY_OWNER'],
}));
store.users.set('${STAFF_ID}', seedUser({
  id: '${STAFF_ID}', email: '${STAFF_EMAIL}',
  password: await hashPassword('${STAFF_PASSWORD}'),
  firstName: 'Setter', lastName: 'Test', roles: ['DISPATCHER'],
}));

const expiredHash = createHash('sha256').update('${EXPIRED_CODE}').digest('hex');
store.adsOsConnectCodes.set(expiredHash, {
  id: '33333333-3333-4333-8333-333333333333',
  codeHash: expiredHash,
  userId: '${STAFF_ID}',
  expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
  usedAt: null,
  createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
});
`);

// ---------------------------------------------------------------------------
// Boot the real API.
// ---------------------------------------------------------------------------
const childEnv = { ...process.env };
delete childEnv.DATABASE_URL;
delete childEnv.DATABASE_URL_UNPOOLED;
Object.assign(childEnv, {
  PORT: String(PORT),
  JWT_SECRET: 'ads-os-sso-test-secret-0123456789abcdef',
  ALLOW_DEMO_AUTH: 'false',
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

async function post(pathname, body, bearer) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, j: await res.json().catch(() => ({})) };
}

try {
  const health = await waitForHealth();
  check('health: skeleton mode', health.mode === 'phase-1-in-memory-skeleton', JSON.stringify(health.mode));

  // Mint refuses anyone who is not signed in.
  const anonMint = await post('/integrations/ads-os/sso/code', {});
  check('mint without a session → 401', anonMint.status === 401, JSON.stringify(anonMint).slice(0, 200));
  const garbageMint = await post('/integrations/ads-os/sso/code', {}, 'not-a-session-token');
  check('mint with a garbage bearer → 401', garbageMint.status === 401, JSON.stringify(garbageMint).slice(0, 200));

  // Sessions for both seeded accounts (password door, unchanged).
  const staffLogin = await post('/auth/login', { email: STAFF_EMAIL, password: STAFF_PASSWORD });
  check('staff password sign-in → session', staffLogin.status === 200 && Boolean(staffLogin.j.token), JSON.stringify(staffLogin).slice(0, 200));
  const ownerLogin = await post('/auth/login', { email: OWNER_EMAIL, password: OWNER_PASSWORD });
  check('owner password sign-in → session', ownerLogin.status === 200 && Boolean(ownerLogin.j.token), JSON.stringify(ownerLogin).slice(0, 200));
  const staffSession = staffLogin.j.token;
  const ownerSession = ownerLogin.j.token;

  // Staff mint #1: a code with a 10-minute expiry.
  const mint1 = await post('/integrations/ads-os/sso/code', {}, staffSession);
  const code1 = mint1.j?.data?.code;
  check('staff mint → 200 with a code', mint1.status === 200 && typeof code1 === 'string' && code1.length >= 40, JSON.stringify(mint1).slice(0, 200));
  const expiresAtMs = Date.parse(mint1.j?.data?.expiresAt || '');
  check('code expiry is ~10 minutes out', Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() + 9 * 60 * 1000 && expiresAtMs < Date.now() + 11 * 60 * 1000, String(mint1.j?.data?.expiresAt));

  // Happy path: the exchange returns the minting account's identity.
  const exchange1 = code1 ? await post('/integrations/ads-os/sso/exchange', { code: code1 }) : { status: 0, j: {} };
  check('exchange → 200', exchange1.status === 200, JSON.stringify(exchange1).slice(0, 200));
  check('exchange identity: staff email', exchange1.j?.data?.email === STAFF_EMAIL, JSON.stringify(exchange1.j?.data));
  check('exchange identity: staff display name', exchange1.j?.data?.displayName === 'Setter Test', JSON.stringify(exchange1.j?.data));
  check('exchange identity: staff role', exchange1.j?.data?.role === 'DISPATCHER', JSON.stringify(exchange1.j?.data));
  check('exchange returns identity only (no session/credential fields)',
    exchange1.j?.data && !('token' in exchange1.j.data) && !('passwordHash' in exchange1.j.data) && !('id' in exchange1.j.data),
    JSON.stringify(exchange1.j?.data));

  // Single-use: the same code never works twice.
  const replay = code1 ? await post('/integrations/ads-os/sso/exchange', { code: code1 }) : { status: 0, j: {} };
  check('replay of a used code → generic 401', replay.status === 401 && replay.j.code === 'ADS_OS_SSO_INVALID', JSON.stringify(replay).slice(0, 200));

  // Unknown code: the SAME generic 401 — no oracle.
  const unknown = await post('/integrations/ads-os/sso/exchange', { code: 'unknown-connect-code-0123456789abcdef' });
  check('unknown code → generic 401', unknown.status === 401 && unknown.j.code === 'ADS_OS_SSO_INVALID', JSON.stringify(unknown).slice(0, 200));
  check('unknown and replay answers are identical', unknown.j.error === replay.j.error && unknown.j.code === replay.j.code);

  // Missing code field: same generic 401, not a schema oracle.
  const missing = await post('/integrations/ads-os/sso/exchange', {});
  check('missing code → generic 401', missing.status === 401 && missing.j.code === 'ADS_OS_SSO_INVALID', JSON.stringify(missing).slice(0, 200));

  // Expired code (seeded): same generic 401.
  const expired = await post('/integrations/ads-os/sso/exchange', { code: EXPIRED_CODE });
  check('expired code → generic 401', expired.status === 401 && expired.j.code === 'ADS_OS_SSO_INVALID' && expired.j.error === replay.j.error, JSON.stringify(expired).slice(0, 200));

  // Supersede: mint A, mint B — A dies, B works.
  const mintA = await post('/integrations/ads-os/sso/code', {}, staffSession);
  const mintB = await post('/integrations/ads-os/sso/code', {}, staffSession);
  const codeA = mintA.j?.data?.code;
  const codeB = mintB.j?.data?.code;
  check('staff mints A and B', mintA.status === 200 && mintB.status === 200 && codeA && codeB && codeA !== codeB);
  const exchangeA = codeA ? await post('/integrations/ads-os/sso/exchange', { code: codeA }) : { status: 0, j: {} };
  check('superseded code → generic 401', exchangeA.status === 401 && exchangeA.j.code === 'ADS_OS_SSO_INVALID', JSON.stringify(exchangeA).slice(0, 200));
  const exchangeB = codeB ? await post('/integrations/ads-os/sso/exchange', { code: codeB }) : { status: 0, j: {} };
  check('newest code still works', exchangeB.status === 200 && exchangeB.j?.data?.email === STAFF_EMAIL, JSON.stringify(exchangeB).slice(0, 200));

  // Mint cap: the window counts every issuance in the last hour —
  // the seeded expired record plus mints #1, A and B make 4, so
  // one more mint passes (the 5th issuance) and the next is
  // refused with 429. (Same issuance-count semantics as the email
  // door's per-account send cap.)
  const mint4 = await post('/integrations/ads-os/sso/code', {}, staffSession);
  check('staff mint at the cap edge → 200', mint4.status === 200, `${mint4.status}`);
  const mint5 = await post('/integrations/ads-os/sso/code', {}, staffSession);
  check('staff mint over the cap → 429 ADS_OS_SSO_MINT_LIMIT', mint5.status === 429 && mint5.j.code === 'ADS_OS_SSO_MINT_LIMIT', JSON.stringify(mint5).slice(0, 200));

  // Rule Zero: the Master's mints are never capped.
  let ownerMintsOk = true;
  let lastOwnerCode = null;
  for (let i = 0; i < 7; i += 1) {
    const m = await post('/integrations/ads-os/sso/code', {}, ownerSession);
    if (m.status !== 200 || !m.j?.data?.code) ownerMintsOk = false;
    else lastOwnerCode = m.j.data.code;
  }
  check('owner: 7 mints → 7 codes (no cap)', ownerMintsOk);
  const ownerExchange = lastOwnerCode ? await post('/integrations/ads-os/sso/exchange', { code: lastOwnerCode }) : { status: 0, j: {} };
  check('owner exchange → COMPANY_OWNER identity',
    ownerExchange.status === 200 && ownerExchange.j?.data?.email === OWNER_EMAIL && ownerExchange.j?.data?.role === 'COMPANY_OWNER',
    JSON.stringify(ownerExchange).slice(0, 200));
} catch (error) {
  failed += 1;
  console.error(`HARNESS ERROR: ${error.message}`);
} finally {
  child.kill('SIGTERM');
  await rm(preloadPath, { force: true });
}

// ---------------------------------------------------------------------------
// In-process phase: storage discipline + the exchange IP cap,
// against the real service and the skeleton store in THIS process
// (a separate store instance from the booted child's — the HTTP
// phase above never touches it).
// ---------------------------------------------------------------------------
try {
  const { store } = await import('../src/data/store.js');
  const sso = await import('../src/services/adsOsSso.js');

  const directUser = {
    id: '44444444-4444-4444-8444-444444444444',
    email: 'direct@ads-os-sso.test',
    firstName: 'Direct', lastName: 'Check',
    roles: ['DISPATCHER'], active: true,
  };
  store.users.set(directUser.id, directUser);

  const minted = await sso.mintAdsOsConnectCode(directUser);
  check('in-process mint returns a code', typeof minted.code === 'string' && minted.code.length >= 40);
  const records = [...store.adsOsConnectCodes.values()];
  check('exactly one code record stored', records.length === 1, `${records.length}`);
  const expectedHash = createHash('sha256').update(minted.code).digest('hex');
  check('stored record holds the SHA-256 hash of the code', records[0]?.codeHash === expectedHash);
  check('store map is keyed by the hash', [...store.adsOsConnectCodes.keys()][0] === expectedHash);
  check('plaintext code appears in NO stored field', !JSON.stringify(records[0] || {}).includes(minted.code));

  const exchanged = await sso.exchangeAdsOsConnectCode(minted.code, { ip: '198.51.100.7' });
  check('in-process exchange returns the identity',
    exchanged.identity.email === directUser.email && exchanged.identity.role === 'DISPATCHER',
    JSON.stringify(exchanged.identity));

  // Per-IP attempt cap on the public exchange: 20 failed attempts
  // answer the generic 401; the 21st answers 429.
  let lastError = null;
  let genericCount = 0;
  for (let i = 0; i < 20; i += 1) {
    try {
      await sso.exchangeAdsOsConnectCode(`junk-code-${i}-0123456789`, { ip: '198.51.100.9' });
    } catch (error) {
      lastError = error;
      if (error.status === 401 && error.code === 'ADS_OS_SSO_INVALID') genericCount += 1;
    }
  }
  check('20 junk exchanges → 20 generic 401s', genericCount === 20, `got ${genericCount}, last ${lastError?.status}/${lastError?.code}`);
  let capError = null;
  try {
    await sso.exchangeAdsOsConnectCode('junk-code-over-cap-0123456789', { ip: '198.51.100.9' });
  } catch (error) { capError = error; }
  check('21st junk exchange → 429 ADS_OS_SSO_EXCHANGE_LIMIT',
    capError?.status === 429 && capError?.code === 'ADS_OS_SSO_EXCHANGE_LIMIT',
    `${capError?.status}/${capError?.code}`);
} catch (error) {
  failed += 1;
  console.error(`IN-PROCESS ERROR: ${error.message}`);
}

console.log(`\nads-os-sso: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
