/**
 * Pepper Lists Channel Connections — Phase 2 verification harness
 * (2026-11-21): the office-fulfillment loop, the load-bearing agent
 * grant, and the Facebook gateway gate.
 *
 * Covers:
 *  - connection request lifecycle: PENDING → (grant gate) → start →
 *    IN_PROGRESS → fulfill with the real evidence URL → ACTIVE with
 *    the URL + date visible on the seller's card; decline with the
 *    reason visible; re-request clears the stale outcome;
 *  - FACEBOOK can never be office-fulfilled (409 FACEBOOK_GATEWAY_ONLY);
 *  - grant enforcement on all three office action lanes: channel
 *    fulfill, syndication POSTED, Facebook cross-post POSTED —
 *    refused with the grant OFF, allowed ON, blocked again after
 *    revocation; FAILED bookkeeping stays ungated;
 *  - the Facebook gateway exception: the platform OWNER's own
 *    cross-posts follow his per-listing approval (no self-grant);
 *  - every office action lands in the seller's SellerChannelAudit
 *    log (OFFICE_* / AGENT_ACTION rows, read back via oversight);
 *  - staff gates: anon 401 / customer 403 on the transition endpoint
 *    and the oversight read; seller isolation.
 *
 * Runs in BOTH database modes: with DATABASE_URL only (pre-flip
 * fallback — PL repos read the main database) and with
 * PL_DATABASE_URL also set (the split — PL repos read the Pepper
 * Lists database; users still resolve from the main database).
 *
 * Usage:
 *   DATABASE_URL=postgresql://... [PL_DATABASE_URL=postgresql://...] \
 *     node test/pl-channels-phase2.test.mjs
 * Exit code 0 = every check passed.
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
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;
const SPLIT = Boolean(process.env.PL_DATABASE_URL);

const PORT = Number(process.env.TEST_PORT || 4431);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  sellerA: '20000000-0000-4000-8000-0000000000d1',
  sellerB: '20000000-0000-4000-8000-0000000000d2',
  staff: '20000000-0000-4000-8000-0000000000d3',
  owner: '20000000-0000-4000-8000-0000000000d4',
};
const CONN_ID = '30000000-0000-4000-8000-0000000000d9';

const prisma = new PrismaClient();
let plPrisma = prisma;
if (SPLIT) {
  const { PrismaClient: PlClient } = await import('../node_modules/.prisma/pl-client/index.js');
  plPrisma = new PlClient();
}
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

async function login(email) {
  const { status, json } = await api('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  if (status !== 200 || !json?.token) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    { id: IDS.sellerA, email: 'pla@test.local', roles: ['CUSTOMER'] },
    { id: IDS.sellerB, email: 'plb@test.local', roles: ['CUSTOMER'] },
    { id: IDS.staff, email: 'plstaff@test.local', roles: ['COMPANY_ADMIN'] },
    { id: IDS.owner, email: 'plowner@test.local', roles: ['COMPANY_OWNER'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash },
      create: { id: u.id, companyId: PLATFORM_COMPANY_ID, email: u.email, passwordHash, phone: '9545550100', roles: u.roles, active: true },
    });
  }
}

async function cleanup() {
  const userIds = Object.values(IDS);
  try {
    await plPrisma.sellerChannelAudit.deleteMany({ where: { userId: { in: userIds } } });
    await plPrisma.sellerChannelConnection.deleteMany({ where: { userId: { in: userIds } } });
    await plPrisma.pepperListsCrossPost.deleteMany({ where: { userId: { in: userIds } } });
    await plPrisma.pepperListsSyndication.deleteMany({ where: { userId: { in: userIds } } });
    if (SPLIT) {
      await prisma.sellerChannelAudit.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
      await prisma.sellerChannelConnection.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
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

function channelOf(listJson, key) {
  return listJson.data.channels.find((c) => c.key === key);
}

async function main() {
  console.log(`mode: ${SPLIT ? 'SPLIT (PL_DATABASE_URL set)' : 'FALLBACK (main database only)'}`);
  await cleanup();
  await seed();
  server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: 'test-secret-pl-channels-phase2',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
      ...(SPLIT ? { PL_DATABASE_URL: process.env.PL_DATABASE_URL } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForServer();

  const a = await login('pla@test.local');
  const b = await login('plb@test.local');
  const staff = await login('plstaff@test.local');
  const owner = await login('plowner@test.local');

  // ── Staff gates ───────────────────────────────────────────────
  check('transition unauthenticated', (await api('/pepper-lists/channels/x/transition', { method: 'POST', body: { action: 'start' } })).status, 401);
  check('oversight unauthenticated', (await api('/pepper-lists/channels/oversight')).status, 401);
  check('transition as customer', (await api('/pepper-lists/channels/x/transition', { token: a, method: 'POST', body: { action: 'start' } })).status, 403);
  check('oversight as customer', (await api('/pepper-lists/channels/oversight', { token: a })).status, 403);

  // ── Fulfillment lifecycle (TikTok) ────────────────────────────
  const conn = await api('/pepper-lists/channels/TIKTOK/connect', { token: a, method: 'POST', body: { accountLabel: '@selleratik' } });
  check('A connect TIKTOK 201', conn.status, 201);
  check('TIKTOK lands PENDING', conn.json.data.connection.status, 'PENDING');
  const tikId = conn.json.data.connection.id;
  checkTrue('connection id issued', Boolean(tikId));

  const oversight1 = await api('/pepper-lists/channels/oversight', { token: staff });
  check('oversight 200 for staff', oversight1.status, 200);
  const overRow = oversight1.json.data.connections.find((c) => c.id === tikId);
  checkTrue('oversight carries the request', Boolean(overRow));
  check('oversight resolves the seller email through the app layer', overRow?.user?.email, 'pla@test.local');

  const fulfillNoGrant = await api(`/pepper-lists/channels/${tikId}/transition`, { token: staff, method: 'POST', body: { action: 'fulfill', url: 'https://www.tiktok.com/@selleratik' } });
  check('fulfill refused while grant OFF', fulfillNoGrant.status, 403);
  check('refusal code is AGENT_GRANT_REQUIRED', fulfillNoGrant.json.code, 'AGENT_GRANT_REQUIRED');

  const start = await api(`/pepper-lists/channels/${tikId}/transition`, { token: staff, method: 'POST', body: { action: 'start' } });
  check('start allowed without grant (bookkeeping)', start.status, 200);
  check('status IN_PROGRESS after start', start.json.data.connection.status, 'IN_PROGRESS');

  const grant = await api('/pepper-lists/channels/TIKTOK/agent-access', { token: a, method: 'PATCH', body: { granted: true } });
  check('A grants TIKTOK', grant.json.data.connection.agentAccessGranted, true);

  const badUrl = await api(`/pepper-lists/channels/${tikId}/transition`, { token: staff, method: 'POST', body: { action: 'fulfill', url: 'http://tiktok.com/@selleratik' } });
  check('fulfill with a non-https URL refused', badUrl.status, 400);

  const fulfilled = await api(`/pepper-lists/channels/${tikId}/transition`, { token: staff, method: 'POST', body: { action: 'fulfill', url: 'https://www.tiktok.com/@selleratik' } });
  check('fulfill 200 with grant ON', fulfilled.status, 200);
  check('status ACTIVE after fulfill (never CONNECTED)', fulfilled.json.data.connection.status, 'ACTIVE');
  check('evidence URL recorded', fulfilled.json.data.connection.fulfillmentUrl, 'https://www.tiktok.com/@selleratik');

  const aList = await api('/pepper-lists/channels', { token: a });
  const tik = channelOf(aList.json, 'TIKTOK').connection;
  check('seller card shows ACTIVE', tik.status, 'ACTIVE');
  check('seller card shows the evidence URL', tik.fulfillmentUrl, 'https://www.tiktok.com/@selleratik');
  checkTrue('seller card shows the fulfilled date', Boolean(tik.fulfilledAt));

  const again = await api(`/pepper-lists/channels/${tikId}/transition`, { token: staff, method: 'POST', body: { action: 'fulfill', url: 'https://www.tiktok.com/@selleratik' } });
  check('re-fulfill of an ACTIVE row conflicts', again.status, 409);

  // ── Decline lifecycle (Bing Places, seller B) ─────────────────
  const bConn = await api('/pepper-lists/channels/BING_PLACES/connect', { token: b, method: 'POST', body: { accountLabel: 'B Seller Biz' } });
  const bingId = bConn.json.data.connection.id;
  const declineNoReason = await api(`/pepper-lists/channels/${bingId}/transition`, { token: staff, method: 'POST', body: { action: 'decline' } });
  check('decline without a reason refused', declineNoReason.status, 400);
  const declined = await api(`/pepper-lists/channels/${bingId}/transition`, { token: staff, method: 'POST', body: { action: 'decline', reason: 'Microsoft has not finished verifying this listing yet' } });
  check('decline 200', declined.status, 200);
  check('status DECLINED', declined.json.data.connection.status, 'DECLINED');
  const bList = await api('/pepper-lists/channels', { token: b });
  const bing = channelOf(bList.json, 'BING_PLACES').connection;
  check('seller card shows DECLINED', bing.status, 'DECLINED');
  check('seller card shows the reason', bing.declineReason, 'Microsoft has not finished verifying this listing yet');
  const reReq = await api('/pepper-lists/channels/BING_PLACES/connect', { token: b, method: 'POST', body: { accountLabel: 'B Seller Biz' } });
  check('re-request returns to PENDING', reReq.json.data.connection.status, 'PENDING');
  check('re-request clears the stale reason', reReq.json.data.connection.declineReason, null);

  // ── FACEBOOK: never office-fulfilled ──────────────────────────
  const fbConn = await api('/pepper-lists/channels/FACEBOOK/connect', { token: a, method: 'POST', body: { accountLabel: 'Seller A' } });
  const fbId = fbConn.json.data.connection.id;
  const fbFulfill = await api(`/pepper-lists/channels/${fbId}/transition`, { token: staff, method: 'POST', body: { action: 'fulfill', url: 'https://facebook.com/sellera' } });
  check('FACEBOOK fulfill refused', fbFulfill.status, 409);
  check('refusal code is FACEBOOK_GATEWAY_ONLY', fbFulfill.json.code, 'FACEBOOK_GATEWAY_ONLY');

  // ── Facebook gateway: cross-post POSTED gate ──────────────────
  await plPrisma.pepperListsCrossPost.create({
    data: { id: '40000000-0000-4000-8000-0000000000d1', connectionId: CONN_ID, listingReference: 'TS-PLD1', userId: IDS.sellerA, target: 'MARKETPLACE', status: 'QUEUED' },
  });
  const xpNoGrant = await api('/pepper-lists/cross-posts/40000000-0000-4000-8000-0000000000d1/outcome', { token: staff, method: 'POST', body: { status: 'POSTED', externalUrl: 'https://www.facebook.com/marketplace/item/123' } });
  check('gateway POSTED refused while Facebook grant OFF', xpNoGrant.status, 403);
  check('gateway refusal code', xpNoGrant.json.code, 'AGENT_GRANT_REQUIRED');
  await api('/pepper-lists/channels/FACEBOOK/agent-access', { token: a, method: 'PATCH', body: { granted: true } });
  const xpPosted = await api('/pepper-lists/cross-posts/40000000-0000-4000-8000-0000000000d1/outcome', { token: staff, method: 'POST', body: { status: 'POSTED', externalUrl: 'https://www.facebook.com/marketplace/item/123' } });
  check('gateway POSTED 200 with grant ON', xpPosted.status, 200);
  check('cross-post shows POSTED', xpPosted.json.data.crossPost.status, 'POSTED');
  check('cross-post carries the real URL', xpPosted.json.data.crossPost.externalUrl, 'https://www.facebook.com/marketplace/item/123');

  await plPrisma.pepperListsCrossPost.create({
    data: { id: '40000000-0000-4000-8000-0000000000d2', connectionId: CONN_ID, listingReference: 'TS-PLD2', userId: IDS.sellerA, target: 'MARKETPLACE', status: 'QUEUED' },
  });
  await api('/pepper-lists/channels/FACEBOOK/agent-access', { token: a, method: 'PATCH', body: { granted: false } });
  const xpRevoked = await api('/pepper-lists/cross-posts/40000000-0000-4000-8000-0000000000d2/outcome', { token: staff, method: 'POST', body: { status: 'POSTED', externalUrl: 'https://www.facebook.com/marketplace/item/124' } });
  check('revocation blocks the next POSTED outcome', xpRevoked.status, 403);
  const xpFailed = await api('/pepper-lists/cross-posts/40000000-0000-4000-8000-0000000000d2/outcome', { token: staff, method: 'POST', body: { status: 'FAILED', error: 'Seller revoked agent access before posting' } });
  check('FAILED bookkeeping stays ungated', xpFailed.status, 200);

  // Owner exception: the owner's own cross-post needs no self-grant.
  await plPrisma.pepperListsCrossPost.create({
    data: { id: '40000000-0000-4000-8000-0000000000d3', connectionId: CONN_ID, listingReference: 'TS-PLD3', userId: IDS.owner, target: 'PAGE', status: 'QUEUED' },
  });
  const xpOwner = await api('/pepper-lists/cross-posts/40000000-0000-4000-8000-0000000000d3/outcome', { token: staff, method: 'POST', body: { status: 'POSTED', externalUrl: 'https://www.facebook.com/topspeed/posts/9' } });
  check('owner cross-post POSTED without a self-grant', xpOwner.status, 200);

  // ── Syndication POSTED gate (eBay) ────────────────────────────
  await api('/pepper-lists/channels/EBAY/connect', { token: a, method: 'POST', body: { accountLabel: 'seller-a-ebay' } });
  await plPrisma.pepperListsSyndication.create({
    data: { id: '40000000-0000-4000-8000-0000000000d4', connectionId: CONN_ID, listingReference: 'TS-PLD1', userId: IDS.sellerA, channel: 'EBAY', status: 'QUEUED' },
  });
  const synNoGrant = await api('/pepper-lists/syndication/40000000-0000-4000-8000-0000000000d4/outcome', { token: staff, method: 'POST', body: { status: 'POSTED', externalUrl: 'https://www.ebay.com/itm/123' } });
  check('syndication POSTED refused while eBay grant OFF', synNoGrant.status, 403);
  await api('/pepper-lists/channels/EBAY/agent-access', { token: a, method: 'PATCH', body: { granted: true } });
  const synPosted = await api('/pepper-lists/syndication/40000000-0000-4000-8000-0000000000d4/outcome', { token: staff, method: 'POST', body: { status: 'POSTED', externalUrl: 'https://www.ebay.com/itm/123' } });
  check('syndication POSTED 200 with grant ON', synPosted.status, 200);

  // ── The seller-side audit log carries every office action ─────
  const oversight2 = await api('/pepper-lists/channels/oversight', { token: staff });
  const audit = oversight2.json.data.audit.filter((e) => e.userId === IDS.sellerA);
  const actions = new Set(audit.map((e) => e.action));
  checkTrue('audit has OFFICE_STARTED', actions.has('OFFICE_STARTED'));
  checkTrue('audit has OFFICE_FULFILLED', actions.has('OFFICE_FULFILLED'));
  checkTrue('audit has AGENT_ACTION (gateway + syndication outcomes)', audit.filter((e) => e.action === 'AGENT_ACTION').length >= 3);
  const bAudit = oversight2.json.data.audit.filter((e) => e.userId === IDS.sellerB);
  checkTrue('audit has OFFICE_DECLINED for seller B', bAudit.some((e) => e.action === 'OFFICE_DECLINED'));

  // ── Seller isolation ──────────────────────────────────────────
  const bChannels = await api('/pepper-lists/channels', { token: b });
  check('B TIKTOK untouched by A activity', channelOf(bChannels.json, 'TIKTOK').connection.status, 'NOT_CONNECTED');
  check('B FACEBOOK untouched by A grant', channelOf(bChannels.json, 'FACEBOOK').connection.agentAccessGranted, false);
  check('owner token is valid (sanity)', (await api('/pepper-lists/channels', { token: owner })).status, 200);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} — pl-channels-phase2 (${SPLIT ? 'split' : 'fallback'} mode)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
    if (plPrisma !== prisma) await plPrisma.$disconnect();
  });
