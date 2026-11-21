/**
 * PEPPER LISTS LAUNCH PACKAGE drills (2026-11-21).
 *
 * Covers the two server-side pieces the launch build depends on:
 *
 *   1. The post-signup "Confirm it's you" page's contract: a genuine
 *      CUSTOMER register returns the Layer 2 challenge envelope with
 *      BOTH channels listed when a phone is on file; POST
 *      /auth/layer2/send answers HONESTLY when no provider is
 *      configured in this environment (503 LAYER2_CHANNEL_UNAVAILABLE
 *      for EMAIL and for SMS — never a fake "sent"); completing the
 *      challenge mints the session; a wrong code is a 401 with
 *      attemptsRemaining and mints nothing.
 *
 *   2. Saved listings (the menu's Saved surface): auth walls, own
 *      saves only, idempotent save, per-user isolation on list and
 *      unsave, 404 on a listing that does not exist, and the public
 *      card shape (no seller contact leaks).
 *
 *   3. The account-settings endpoints the new PL settings blocks use:
 *      /auth/profile, /auth/email-verification/resend and the Layer 2
 *      settings trio.
 *
 * Local TEST database only:
 *   DATABASE_URL=postgresql://user@127.0.0.1:PORT/pl_launch_a \
 *     node test/pepper-lists-launch.test.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { issueFormToken } from '../src/services/intakeShield.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4491);
const B = `http://127.0.0.1:${PORT}/api/v1`;
const PW = ['drill', 'pass', '1234'].join('-');
const PLATFORM_COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const IDS = {
  seller: '30000000-0000-4000-8000-0000000000a1',
  buyer1: '30000000-0000-4000-8000-0000000000a2',
  buyer2: '30000000-0000-4000-8000-0000000000a3',
};
const EMAILS = {
  seller: 'seller@launch.local',
  buyer1: 'buyer-one@launch.local',
  buyer2: 'buyer-two@launch.local',
  fresh: 'fresh-signup@launch.local',
};

let passed = 0; let failed = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? '  ok ' : '  FAIL'} ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(label, cond, extra = '') {
  if (cond) passed += 1; else failed += 1;
  console.log(`${cond ? '  ok ' : '  FAIL'} ${label}${cond ? '' : ` ${extra}`}`);
}
async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${B}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

const prisma = new PrismaClient();
let server;

function terms(signatureName) {
  return {
    signatureName,
    documents: [
      { document: 'SERVICE_OS', version: '1.0', agreed: true },
      { document: 'APPLIANCE_CONNECT', version: '1.0', agreed: true },
    ],
  };
}
function agedToken() {
  return issueFormToken({ issuedAtMs: Date.now() - 60_000 });
}
function challengeRowId(challengeToken) {
  const payload = JSON.parse(Buffer.from(challengeToken.split('.')[1], 'base64url').toString('utf8'));
  return payload.cid;
}

try {
  // ---------- Seed ----------
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'launch-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const passwordHash = await hashPassword(PW);
  const mk = (id, email, extra = {}) => prisma.user.upsert({
    where: { id },
    update: { passwordHash, ...extra },
    create: { id, companyId: PLATFORM_COMPANY_ID, email, passwordHash, roles: ['CUSTOMER'], active: true, verifyRequired: false, layer2Required: false, ...extra },
  });
  await mk(IDS.seller, EMAILS.seller, { firstName: 'Sally', lastName: 'Seller', phone: '9545550100' });
  await mk(IDS.buyer1, EMAILS.buyer1, { firstName: 'Ben', lastName: 'Buyer', phone: '9545550111' });
  await mk(IDS.buyer2, EMAILS.buyer2, { firstName: 'Bea', lastName: 'Browser' });
  await prisma.user.deleteMany({ where: { email: EMAILS.fresh } });
  await prisma.savedListing.deleteMany({ where: { userId: { in: [IDS.seller, IDS.buyer1, IDS.buyer2] } } });

  // ---------- Boot (no mail/SMS provider keys: sends must fail honestly) ----------
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env, PORT: String(PORT),
      JWT_SECRET: ['drill', 'launch', 'secret'].join('-'),
      DATABASE_URL: process.env.DATABASE_URL, DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
      RESEND_API_KEY: '', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_PHONE_NUMBER: '',
      OPENAI_API_KEY: '', OPENAI_API_KEY_V2: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    try { const r = await fetch(`${B}/payments/status`); up = r.status === 200; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!up) throw new Error('API did not come up');

  const login = async (email) => {
    const r = await api('/auth/login', { method: 'POST', body: { email, password: PW } });
    if (r.status !== 200 || !r.json?.token) throw new Error(`login failed for ${email}: ${r.status} ${r.text}`);
    return r.json.token;
  };
  const tokSeller = await login(EMAILS.seller);
  const tokB1 = await login(EMAILS.buyer1);
  const tokB2 = await login(EMAILS.buyer2);

  console.log('\n[onboarding: register -> challenge envelope]');
  const reg = await api('/auth/register', {
    method: 'POST',
    body: {
      firstName: 'Fresh', lastName: 'Signup', email: EMAILS.fresh, phone: '(954) 555-0139',
      password: PW, termsAcceptance: terms('Fresh Signup'), formToken: agedToken(),
    },
  });
  check('register status', reg.status, 201);
  check('register is a Layer 2 challenge (no token yet)', reg.json?.layer2Required, true);
  checkTrue('register returns a challenge id', typeof reg.json?.challenge === 'string' && reg.json.challenge.length > 10);
  check('register user email', reg.json?.user?.email, EMAILS.fresh);
  const chans = reg.json?.channels || [];
  const emailChan = chans.find((c) => c.channel === 'EMAIL');
  const smsChan = chans.find((c) => c.channel === 'SMS');
  checkTrue('EMAIL channel listed + available', Boolean(emailChan?.available));
  checkTrue('SMS channel listed + available (phone on file)', Boolean(smsChan?.available));
  checkTrue('SMS destination is masked, never the raw number', Boolean(smsChan) && !String(smsChan.destination).includes('5550139'), JSON.stringify(smsChan));
  const challenge = reg.json.challenge;

  console.log('\n[onboarding: send attempts are honest with no provider configured]');
  const sendEmail = await api('/auth/layer2/send', { method: 'POST', body: { challenge, channel: 'EMAIL' } });
  check('EMAIL send status (no provider in drill env)', sendEmail.status, 503);
  check('EMAIL send code', sendEmail.json?.code, 'LAYER2_CHANNEL_UNAVAILABLE');
  const sendSms = await api('/auth/layer2/send', { method: 'POST', body: { challenge, channel: 'SMS' } });
  check('SMS send status (no provider in drill env)', sendSms.status, 503);
  check('SMS send code', sendSms.json?.code, 'LAYER2_CHANNEL_UNAVAILABLE');
  const verifyNoCode = await api('/auth/layer2/verify', { method: 'POST', body: { challenge, code: '123456' } });
  check('verify before any code was sent -> 400', verifyNoCode.status, 400);
  check('verify-before-send code', verifyNoCode.json?.code, 'LAYER2_CODE_NOT_SENT');

  console.log('\n[onboarding: wrong code, then completion mints the session]');
  const knownHash = await hashPassword('246810');
  await prisma.loginChallenge.update({ where: { id: challengeRowId(challenge) }, data: { codeHash: knownHash } });
  const wrong = await api('/auth/layer2/verify', { method: 'POST', body: { challenge, code: '999999' } });
  check('wrong code status', wrong.status, 401);
  check('wrong code error code', wrong.json?.code, 'LAYER2_INVALID_CODE');
  check('wrong code attemptsRemaining', wrong.json?.attemptsRemaining, 4);
  checkTrue('wrong code mints no token', !wrong.json?.token);
  const right = await api('/auth/layer2/verify', { method: 'POST', body: { challenge, code: '246810' } });
  check('right code status', right.status, 200);
  checkTrue('right code mints a session token', typeof right.json?.token === 'string' && right.json.token.length > 20);
  const me = await api('/auth/me', { token: right.json.token });
  check('/auth/me with the minted session', me.status, 200);
  check('me email', me.json?.user?.email ?? me.json?.email, EMAILS.fresh);
  const reuse = await api('/auth/layer2/verify', { method: 'POST', body: { challenge, code: '246810' } });
  check('challenge reuse -> 410', reuse.status, 410);

  console.log('\n[saved listings]');
  const created = await api('/pepper-lists/listings', {
    method: 'POST', token: tokSeller,
    body: { title: 'Launch drill fridge', category: 'Appliances', condition: 'Used - good', priceCents: 32500, phone: '9545550100', description: 'Drill listing for the saved-listings checks.', media: [{ kind: 'photo', mime: 'image/png', dataBase64: PNG }] },
  });
  check('seller listing created', created.status, 201);
  const mine = await api('/pepper-lists/listings/mine', { token: tokSeller });
  const listingId = (mine.json?.data || []).find((l) => l.reference === created.json?.data?.reference)?.id;
  checkTrue('listing id resolved', Boolean(listingId));

  check('anon GET saved -> 401', (await api('/pepper-lists/saved')).status, 401);
  check('anon POST save -> 401', (await api(`/pepper-lists/listings/${listingId}/save`, { method: 'POST', body: {} })).status, 401);
  check('anon DELETE save -> 401', (await api(`/pepper-lists/listings/${listingId}/save`, { method: 'DELETE' })).status, 401);
  check('save a listing that does not exist -> 404', (await api('/pepper-lists/listings/not-a-real-id/save', { method: 'POST', token: tokB1, body: {} })).status, 404);

  const save1 = await api(`/pepper-lists/listings/${listingId}/save`, { method: 'POST', token: tokB1, body: {} });
  check('buyer1 save status', save1.status, 201);
  check('buyer1 save flag', save1.json?.data?.saved, true);
  const save2 = await api(`/pepper-lists/listings/${listingId}/save`, { method: 'POST', token: tokB1, body: {} });
  check('buyer1 re-save is idempotent (same row)', save2.json?.data?.savedId, save1.json?.data?.savedId);
  const listB1 = await api('/pepper-lists/saved', { token: tokB1 });
  check('buyer1 saved list length', (listB1.json?.data || []).length, 1);
  check('saved card id', listB1.json?.data?.[0]?.id, listingId);
  check('saved card title', listB1.json?.data?.[0]?.title, 'Launch drill fridge');
  check('saved card seller name is the public name, never the email', listB1.json?.data?.[0]?.sellerName, 'Sally S.');
  checkTrue('saved card leaks no seller phone', !JSON.stringify(listB1.json).includes('9545550100'));
  checkTrue('saved card leaks no seller email', !JSON.stringify(listB1.json).includes(EMAILS.seller));
  const listB2 = await api('/pepper-lists/saved', { token: tokB2 });
  check('buyer2 saved list is empty (isolation)', (listB2.json?.data || []).length, 0);
  const unB2 = await api(`/pepper-lists/listings/${listingId}/save`, { method: 'DELETE', token: tokB2 });
  check('buyer2 unsave answers saved:false', unB2.json?.data?.saved, false);
  const listB1b = await api('/pepper-lists/saved', { token: tokB1 });
  check('buyer1 save survives buyer2 unsave', (listB1b.json?.data || []).length, 1);
  const unB1 = await api(`/pepper-lists/listings/${listingId}/save`, { method: 'DELETE', token: tokB1 });
  check('buyer1 unsave flag', unB1.json?.data?.saved, false);
  const listB1c = await api('/pepper-lists/saved', { token: tokB1 });
  check('buyer1 saved list empty after unsave', (listB1c.json?.data || []).length, 0);

  console.log('\n[account settings endpoints used by the PL settings blocks]');
  const prof = await api('/auth/profile', { method: 'POST', token: tokB2, body: { phone: '(954) 555-0177', serviceAddress: { street: '1 Drill Way', city: 'Fort Lauderdale', zip: '33301' } } });
  check('profile update status', prof.status, 200);
  check('profile phone applied', prof.json?.user?.phone, '(954) 555-0177');
  const resend = await api('/auth/email-verification/resend', { method: 'POST', token: tokB2, body: {} });
  checkTrue('email-verification resend answers 200 (delivery rides the outbox)', resend.status === 200);
  const l2s = await api('/auth/layer2/status', { token: tokB2 });
  check('layer2 status answers', l2s.status, 200);
  check('layer2 starts not required for the seeded buyer', l2s.json?.layer2?.required, false);
  const enroll = await api('/auth/layer2/enroll', { method: 'POST', token: tokB2, body: { channel: 'EMAIL' } });
  check('layer2 enroll status', enroll.status, 200);
  check('layer2 required after enroll', enroll.json?.layer2?.required, true);
  const upd = await api('/auth/layer2/update', { method: 'POST', token: tokB2, body: { channel: 'SMS' } });
  check('layer2 preferred channel -> SMS (phone now on file)', upd.json?.layer2?.preferredChannel, 'SMS');
  const dis = await api('/auth/layer2/disable', { method: 'POST', token: tokB2, body: {} });
  check('layer2 disable status', dis.status, 200);
  check('layer2 not required after disable', dis.json?.layer2?.required, false);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
  else console.log('ALL CHECKS PASSED');
} finally {
  if (server) server.kill('SIGTERM');
  await prisma.$disconnect();
}
