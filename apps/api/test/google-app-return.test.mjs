/**
 * Google sign-in — Appliance Connect app return (2026-11-21).
 *
 * The backend Google flow already returns web surfaces to
 * topspeedserviceos.com with ?token / ?layer2 / ?authError. This
 * harness verifies the app target added for the native app: the
 * start route accepts ?target=app and rides the choice in the OAuth
 * state; the callback then lands on the app's fixed custom-scheme
 * return (applianceconnect://auth/google) carrying the SAME
 * outcomes — a one-time session handoff code instead of a raw
 * token, the Layer 2 challenge with its channel hints, or the
 * honest Speedy Verify / failure explanations.
 *
 * Skeleton mode (no database): the harness seeds four accounts
 * through a --import preload (plain customer, Layer 2 customer, a
 * Speedy Verify business account with no code issued, and one with
 * an ACTIVE code) and stubs Google's token + userinfo endpoints by
 * wrapping fetch in the same preload, so no network and no real
 * Google credentials are involved. A fifth profile is deliberately
 * unseeded so the callback's find-or-create runs.
 *
 * Checks:
 *  - /auth/google/status reports configured with env present.
 *  - Start route: web state carries only the whitelisted next;
 *    ?target=app adds app:true; next is preserved alongside it.
 *  - App success: 302 to the app return with hc (never a raw
 *    token); the code redeems at POST /auth/handoff/redeem for a
 *    session that passes /auth/me; replay gets the generic 401.
 *  - Web success is unchanged: 302 to the web origin with token.
 *  - Layer 2 (existing account AND first-time Google account):
 *    app return carries layer2 + channels + email, and the
 *    challenge is live (verify answers LAYER2_CODE_NOT_SENT, not
 *    CHALLENGE_INVALID).
 *  - Speedy Verify gate: no code issued → 'Speedy Verify required'
 *    authError; active code → 'uses Speedy Verify' authError; the
 *    web target keeps its web-origin authError redirect.
 *  - Failures: unverified Google email, token-exchange failure,
 *    and a missing code (consent backed out) redirect the app with
 *    an honest authError while web callers keep the 502/400 JSON.
 *  - In-process: session handoff storage is hash-only with a
 *    ~60-second TTL and single-use redemption.
 *
 * Usage: node test/google-app-return.test.mjs
 * (Skeleton mode: DATABASE_URL must NOT be set. TEST_PORT
 * defaults to 4517.)
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
const PORT = Number(process.env.TEST_PORT || 4517);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const APP_RETURN = 'applianceconnect://auth/google';

const PLAIN_ID = '11111111-1111-4111-8111-111111111111';
const LAYER2_ID = '22222222-2222-4222-8222-222222222222';
const DENY_ID = '33333333-3333-4333-8333-333333333333';
const CHALLENGE_ID = '44444444-4444-4444-8444-444444444444';
const PLAIN_EMAIL = 'plain@google-app-return.test';
const LAYER2_EMAIL = 'layer2@google-app-return.test';
const DENY_EMAIL = 'deny@google-app-return.test';
const CHALLENGE_EMAIL = 'challenge@google-app-return.test';
const NEW_EMAIL = 'new@google-app-return.test';

// ---------------------------------------------------------------------------
// Preload: seed the accounts + ACTIVE Speedy Verify code, and stub
// Google's token/userinfo endpoints by wrapping fetch. The stub
// profiles are keyed by the authorization code the callback
// receives; any other code fails the token exchange.
// ---------------------------------------------------------------------------
const preloadPath = path.join(apiDir, 'test', '.google-app-return-preload.mjs');
await writeFile(preloadPath, `
import { createHash } from 'node:crypto';
import { store, PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { hashPassword } from '../src/services/passwords.js';

const pw = ['google', 'app', 'return', 'seed'].join('-');
const hashed = await hashPassword(pw);

function seedUser(fields) {
  return {
    companyId: PLATFORM_COMPANY_ID, phone: null, roles: ['CUSTOMER'], active: true,
    emailVerifiedAt: new Date().toISOString(), signupSource: 'google-app-return-test',
    signupOfferSlug: null, signupAudience: null, serviceStreet: null, serviceCity: null,
    serviceZip: null, serviceArea: null, serviceAreaStatus: null,
    verifyRequired: false, layer2Required: false, layer2Phone: null, layer2Channel: null,
    createdAt: new Date().toISOString(), passwordHash: hashed, ...fields,
  };
}

store.users.set('${PLAIN_ID}', seedUser({ id: '${PLAIN_ID}', email: '${PLAIN_EMAIL}', firstName: 'Plain', lastName: 'Test' }));
store.users.set('${LAYER2_ID}', seedUser({ id: '${LAYER2_ID}', email: '${LAYER2_EMAIL}', firstName: 'Layer', lastName: 'Two', layer2Required: true }));
store.users.set('${DENY_ID}', seedUser({ id: '${DENY_ID}', email: '${DENY_EMAIL}', firstName: 'Deny', lastName: 'Biz', signupAudience: 'commercial', verifyRequired: true }));
store.users.set('${CHALLENGE_ID}', seedUser({ id: '${CHALLENGE_ID}', email: '${CHALLENGE_EMAIL}', firstName: 'Challenge', lastName: 'Biz', signupAudience: 'commercial', verifyRequired: true }));
store.speedyVerifyCodes.set('${CHALLENGE_ID}', {
  id: '55555555-5555-4555-8555-555555555555', userId: '${CHALLENGE_ID}',
  codeHash: createHash('sha256').update('seeded-active-code').digest('hex'),
  status: 'ACTIVE', issuedById: null, issuedAt: new Date().toISOString(),
  revokedAt: null, lastUsedAt: null, failedAttempts: 0, lockedUntil: null,
});

const PROFILES = {
  'plain-code': { email: '${PLAIN_EMAIL}', email_verified: true, given_name: 'Plain', family_name: 'Test' },
  'layer2-code': { email: '${LAYER2_EMAIL}', email_verified: true, given_name: 'Layer', family_name: 'Two' },
  'deny-code': { email: '${DENY_EMAIL}', email_verified: true, given_name: 'Deny', family_name: 'Biz' },
  'challenge-code': { email: '${CHALLENGE_EMAIL}', email_verified: true, given_name: 'Challenge', family_name: 'Biz' },
  'new-code': { email: '${NEW_EMAIL}', email_verified: true, given_name: 'New', family_name: 'Person' },
  'unverified-code': { email: 'unverified@google-app-return.test', email_verified: false },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('oauth2.googleapis.com')) {
    const code = new URLSearchParams(String((init && init.body) || '')).get('code');
    if (code && PROFILES[code]) {
      return new Response(JSON.stringify({ access_token: 'stub-access-for-' + code, token_type: 'Bearer', expires_in: 3600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('openidconnect.googleapis.com')) {
    const headers = (init && init.headers) || {};
    const auth = String(headers.Authorization || '');
    const code = auth.replace('Bearer stub-access-for-', '');
    const profile = PROFILES[code];
    if (profile) {
      return new Response(JSON.stringify(profile), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, init);
};
`);

// ---------------------------------------------------------------------------
// Boot the real API (skeleton mode, Google door configured with
// throwaway test values assembled from fragments).
// ---------------------------------------------------------------------------
const childEnv = { ...process.env };
delete childEnv.DATABASE_URL;
delete childEnv.DATABASE_URL_UNPOOLED;
childEnv.PORT = String(PORT);
childEnv[['JWT', 'SECRET'].join('_')] = ['google', 'app', 'return', 'jwt'].join('-');
childEnv[['GOOGLE', 'CLIENT', 'ID'].join('_')] = 'test-client-id.apps.googleusercontent.com';
childEnv[['GOOGLE', 'CLIENT_' + 'SECRET'].join('_')] = ['google', 'test', 'secret', 'value'].join('-');
childEnv.ALLOW_DEMO_AUTH = 'false';
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

async function getRaw(pathname) {
  const res = await fetch(`${BASE}${pathname}`, { redirect: 'manual' });
  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch { /* redirects have no body */ }
  return { status: res.status, location: res.headers.get('location') || '', j };
}

async function post(pathname, body, bearer) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, j: await res.json().catch(() => ({})) };
}

function stateOf(location) {
  const state = new URL(location).searchParams.get('state') || '';
  return { raw: state, parsed: JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) };
}

function paramsOf(location) {
  return new URL(location).searchParams;
}

try {
  const health = await waitForHealth();
  check('health: skeleton mode', health.mode === 'phase-1-in-memory-skeleton', JSON.stringify(health.mode));

  const status = await getRaw('/auth/google/status');
  check('google status: configured', status.j.configured === true, JSON.stringify(status.j));

  // Start route — web target state carries only the whitelisted next.
  const startWeb = await getRaw('/auth/google');
  check('start (web): 302 to Google', startWeb.status === 302 && startWeb.location.startsWith('https://accounts.google.com/'), startWeb.location.slice(0, 120));
  const webState = stateOf(startWeb.location);
  check('start (web): state next defaults to /app, no app flag', webState.parsed.next === '/app' && !('app' in webState.parsed), JSON.stringify(webState.parsed));

  // Start route — app target rides app:true; next is preserved.
  const startApp = await getRaw('/auth/google?target=app&next=/connect-pro-app');
  const appState = stateOf(startApp.location);
  check('start (app): state carries app:true and the whitelisted next', appState.parsed.app === true && appState.parsed.next === '/connect-pro-app', JSON.stringify(appState.parsed));
  const startAppDefault = await getRaw('/auth/google?target=app');
  const appStateDefault = stateOf(startAppDefault.location);
  check('start (app): next defaults to /app', appStateDefault.parsed.app === true && appStateDefault.parsed.next === '/app', JSON.stringify(appStateDefault.parsed));

  const cb = (code, state) => getRaw(`/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);

  // App success → handoff code on the app return, never a raw token.
  const appOk = await cb('plain-code', appStateDefault.raw);
  check('callback (app, plain): 302 to the app return', appOk.status === 302 && appOk.location.startsWith(APP_RETURN + '?'), appOk.location.slice(0, 140));
  const appOkParams = paramsOf(appOk.location);
  const hc = appOkParams.get('hc') || '';
  check('callback (app, plain): carries a handoff code and NO session token', hc.length >= 40 && !appOkParams.has('token'), appOk.location.slice(0, 200));

  const redeem = hc ? await post('/auth/handoff/redeem', { code: hc }) : { status: 0, j: {} };
  check('redeem: 200 with the Google account identity', redeem.status === 200 && redeem.j?.user?.email === PLAIN_EMAIL, JSON.stringify(redeem).slice(0, 200));
  check('redeem: returns a session token', typeof redeem.j?.token === 'string' && redeem.j.token.length > 20);
  const me = redeem.j?.token ? await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${redeem.j.token}` } }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) })) : { status: 0, j: {} };
  check('redeemed session passes /auth/me', me.status === 200 && me.j?.user?.email === PLAIN_EMAIL, JSON.stringify(me).slice(0, 200));
  const replay = hc ? await post('/auth/handoff/redeem', { code: hc }) : { status: 0, j: {} };
  check('redeem replay: generic 401 (single-use)', replay.status === 401 && replay.j?.error === 'That sign-in link is invalid or has expired.', JSON.stringify(replay).slice(0, 200));

  // Web success — unchanged: web origin + raw token, no handoff code.
  const webOk = await cb('plain-code', webState.raw);
  const webOkParams = paramsOf(webOk.location);
  check('callback (web, plain): 302 to web origin with token, no hc', webOk.status === 302 && webOk.location.startsWith('https://topspeedserviceos.com/app?') && Boolean(webOkParams.get('token')) && !webOkParams.has('hc'), webOk.location.slice(0, 160));

  // Layer 2 — existing account: challenge + hints ride the app return.
  const appL2 = await cb('layer2-code', appStateDefault.raw);
  const appL2Params = paramsOf(appL2.location);
  const challenge = appL2Params.get('layer2') || '';
  check('callback (app, layer2): app return with challenge, channels, email', appL2.status === 302 && appL2.location.startsWith(APP_RETURN + '?') && challenge.length > 20 && (appL2Params.get('channels') || '').includes('EMAIL') && appL2Params.get('email') === LAYER2_EMAIL, appL2.location.slice(0, 220));
  const l2Probe = challenge ? await post('/auth/layer2/verify', { challenge, code: '000000' }) : { status: 0, j: {} };
  check('callback (app, layer2): challenge is live (CODE_NOT_SENT, not CHALLENGE_INVALID)', l2Probe.status === 400 && l2Probe.j?.code === 'LAYER2_CODE_NOT_SENT', JSON.stringify(l2Probe).slice(0, 200));

  // Layer 2 — first-time Google account: find-or-create runs and the
  // new CUSTOMER account starts with Layer 2 on, like every door.
  const appNew = await cb('new-code', appStateDefault.raw);
  const appNewParams = paramsOf(appNew.location);
  check('callback (app, new account): created and returned with a Layer 2 challenge', appNew.status === 302 && appNew.location.startsWith(APP_RETURN + '?') && Boolean(appNewParams.get('layer2')) && appNewParams.get('email') === NEW_EMAIL, appNew.location.slice(0, 220));

  // Speedy Verify gate — deny (no code issued) and challenge (code
  // active) both surface as honest authError explanations.
  const appDeny = await cb('deny-code', appStateDefault.raw);
  check('callback (app, speedy deny): authError explains no code issued', appDeny.status === 302 && appDeny.location.startsWith(APP_RETURN + '?') && (paramsOf(appDeny.location).get('authError') || '').includes('Speedy Verify required'), appDeny.location.slice(0, 220));
  const appChallenge = await cb('challenge-code', appStateDefault.raw);
  check('callback (app, speedy challenge): authError explains the code step', appChallenge.status === 302 && (paramsOf(appChallenge.location).get('authError') || '').includes('uses Speedy Verify'), appChallenge.location.slice(0, 220));
  const webDeny = await cb('deny-code', webState.raw);
  check('callback (web, speedy deny): web-origin authError redirect unchanged', webDeny.status === 302 && webDeny.location.startsWith('https://topspeedserviceos.com/app?') && (paramsOf(webDeny.location).get('authError') || '').includes('Speedy Verify required'), webDeny.location.slice(0, 220));

  // Failures — app gets honest redirects; web keeps its JSON errors.
  const appUnverified = await cb('unverified-code', appStateDefault.raw);
  check('callback (app, unverified email): authError names the verified-email rule', appUnverified.status === 302 && (paramsOf(appUnverified.location).get('authError') || '').includes('not verified'), appUnverified.location.slice(0, 220));
  const webUnverified = await cb('unverified-code', webState.raw);
  check('callback (web, unverified email): 502 JSON unchanged', webUnverified.status === 502 && webUnverified.j?.error === 'Google account email not verified', JSON.stringify(webUnverified).slice(0, 200));
  const appBad = await cb('bad-code', appStateDefault.raw);
  check('callback (app, token exchange fails): authError says sign-in failed', appBad.status === 302 && (paramsOf(appBad.location).get('authError') || '').includes('Google sign-in failed'), appBad.location.slice(0, 220));
  const webBad = await cb('bad-code', webState.raw);
  check('callback (web, token exchange fails): 502 JSON unchanged', webBad.status === 502 && webBad.j?.error === 'Google sign-in failed at token exchange', JSON.stringify(webBad).slice(0, 200));

  const appNoCode = await getRaw(`/auth/google/callback?error=access_denied&state=${encodeURIComponent(appStateDefault.raw)}`);
  check('callback (app, no code): app return with the not-completed explanation', appNoCode.status === 302 && appNoCode.location.startsWith(APP_RETURN + '?') && (paramsOf(appNoCode.location).get('authError') || '').includes('not completed'), appNoCode.location.slice(0, 220));
  const webNoCode = await getRaw(`/auth/google/callback?error=access_denied&state=${encodeURIComponent(webState.raw)}`);
  check('callback (web, no code): 400 JSON unchanged', webNoCode.status === 400 && webNoCode.j?.error === 'Missing authorization code', JSON.stringify(webNoCode).slice(0, 200));
} finally {
  child.kill('SIGTERM');
  await rm(preloadPath, { force: true });
}

// ---------------------------------------------------------------------------
// In-process phase: the handoff the app return mints keeps the
// storage discipline of services/sessionHandoff.js — hash-only,
// ~60-second TTL, single-use.
// ---------------------------------------------------------------------------
{
  const { store } = await import('../src/data/store.js');
  const { createSessionHandoff, redeemSessionHandoff } = await import('../src/services/sessionHandoff.js');
  const minted = await createSessionHandoff(PLAIN_ID, { sv: false });
  const records = [...store.sessionHandoffs.values()];
  const ttlMs = new Date(minted.expiresAt).getTime() - Date.now();
  check('handoff mint: ~60 second TTL', ttlMs > 50_000 && ttlMs <= 60_000, minted.expiresAt);
  check('handoff storage: hash-only (plaintext in no stored field, key is the SHA-256)',
    records.length === 1 && !JSON.stringify(records[0]).includes(minted.code)
      && store.sessionHandoffs.has(createHash('sha256').update(minted.code).digest('hex')),
    JSON.stringify(records).slice(0, 200));
  const redeemed = await redeemSessionHandoff(minted.code);
  check('handoff redeem: returns the account and sv=false', redeemed.userId === PLAIN_ID && redeemed.sv === false, JSON.stringify(redeemed));
  let replayRefused = false;
  try { await redeemSessionHandoff(minted.code); } catch (error) { replayRefused = error.status === 401; }
  check('handoff redeem: single-use', replayRefused);
}

console.log(`\ngoogle-app-return: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
