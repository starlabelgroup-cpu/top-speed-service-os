/**
 * Pepper Lists — Facebook compatibility Phase A (2026-11-20).
 *
 * Exercises routes/pepperListsFacebook.js + the Phase A touches to
 * routes/pepperListsChannels.js and routes/pepperLists.js end to end
 * over HTTP:
 *  - listing submissions now carry first-touch attribution (fbclid
 *    lands in the Connection row's columns);
 *  - the public Facebook catalog feed (format, field mapping, only
 *    live listings — a deleted record leaves the feed; non-SELL
 *    records never enter it; empty state is a valid header-only CSV);
 *  - the shareable listing view (Open Graph + Twitter meta with the
 *    real title / price / photo, canonical on pepperlists.com) and
 *    the public listing-photo bytes (SELL listings only);
 *  - the cross-post queue: owner-only create on own listings,
 *    duplicate-while-QUEUED prevention, staff outcome recording
 *    (POSTED demands a real facebook.com URL, FAILED demands a
 *    reason, outcomes are final), seller-facing status reads;
 *  - the owner channel status: with the platform Facebook
 *    attestation in place, the OWNER's FACEBOOK row presents
 *    CONNECTED (platformManaged) while another seller's row stays
 *    Phase 1 — and with FACEBOOK_CONNECTOR_DISABLED=1 the owner
 *    row shows NOT CONNECTED again (nothing invents a connection);
 *  - static smoke over the Pepper Lists site (attribution script,
 *    share dialog, cross-post UI).
 *
 * NOTHING is posted to Facebook: the queue is the deliverable, and
 * outcomes are recorded by staff exactly like the real flow.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=<local test db> node test/pepper-lists-facebook.test.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4433);
const PORT2 = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const BASE2 = `http://127.0.0.1:${PORT2}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  sellerA: '20000000-0000-4000-8000-0000000000d1',
  sellerB: '20000000-0000-4000-8000-0000000000d2',
  staff: '20000000-0000-4000-8000-0000000000d3',
  owner: '20000000-0000-4000-8000-0000000000d4',
};

// A real 1x1 JPEG (valid magic bytes — the listing route checks).
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwH/2Q==';

const prisma = new PrismaClient();
let server = null;
let server2 = null;
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

function checkTrue(label, value) {
  check(label, Boolean(value), true);
}

async function api(base, path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, {
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

async function apiText(base, path) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

async function login(base, email) {
  const { status, json } = await api(base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
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
    { id: IDS.sellerA, email: 'seller-a@test.local', roles: ['CUSTOMER'] },
    { id: IDS.sellerB, email: 'seller-b@test.local', roles: ['CUSTOMER'] },
    { id: IDS.staff, email: 'staff@test.local', roles: ['COMPANY_ADMIN'] },
    { id: IDS.owner, email: 'owner@test.local', roles: ['COMPANY_OWNER'] },
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
  try {
    const conns = await prisma.connection.findMany({ where: { email: { in: ['seller-a@test.local', 'seller-b@test.local'] } }, select: { id: true } });
    const connIds = conns.map((c) => c.id);
    await prisma.pepperListsCrossPost.deleteMany({ where: { userId: { in: Object.values(IDS) } } });
    await prisma.submissionMedia.deleteMany({ where: { connectionId: { in: connIds } } });
    await prisma.connection.deleteMany({ where: { id: { in: connIds } } });
    await prisma.sellerChannelConnection.deleteMany({ where: { userId: { in: Object.values(IDS) } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(IDS) } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

function boot(port, extraEnv = {}) {
  const child = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      JWT_SECRET: 'plfb-test-secret',
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return child;
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

async function main() {
  await cleanup();
  await seed();
  server = boot(PORT);
  await waitForServer(BASE);

  const a = await login(BASE, 'seller-a@test.local');
  const b = await login(BASE, 'seller-b@test.local');
  const staff = await login(BASE, 'staff@test.local');
  const owner = await login(BASE, 'owner@test.local');

  // ── Listings + attribution ─────────────────────────────────────
  const listing1 = await api(BASE, '/pepper-lists/listings', {
    token: a, method: 'POST',
    body: {
      title: 'Fresh ackee by the box', category: 'Produce & fruit', condition: 'New',
      priceCents: 4500, phone: '9545550100', description: 'Sweet, tree-ripened',
      media: [{ kind: 'photo', mime: 'image/jpeg', dataBase64: JPEG_B64 }],
      fbclid: 'FBCLID-TEST-123', utmSource: 'facebook',
    },
  });
  check('listing 1 created 201', listing1.status, 201);
  const ref1 = listing1.json.data.reference;
  checkTrue('listing 1 has a reference', typeof ref1 === 'string' && ref1.length > 3);
  const conn1 = await prisma.connection.findUnique({ where: { reference: ref1 } });
  check('listing 1 fbclid stored', conn1?.fbclid, 'FBCLID-TEST-123');
  check('listing 1 utmSource stored', conn1?.utmSource, 'facebook');

  const listing2 = await api(BASE, '/pepper-lists/listings', {
    token: a, method: 'POST',
    body: {
      title: 'Mango tree in pot', category: 'Trees & plants', condition: 'Used - good',
      priceCents: 2550, phone: '9545550100',
    },
  });
  check('listing 2 created 201', listing2.status, 201);
  const ref2 = listing2.json.data.reference;

  const scan = await api(BASE, '/pepper-lists/submissions', {
    token: a, method: 'POST',
    body: { lane: 'SCAN_SEND', appliance: 'Refrigerator', issue: 'Not cooling at all', phone: '9545550100' },
  });
  check('scan submission created 201', scan.status, 201);
  const scanRef = scan.json.data.reference;

  // ── Catalog feed ───────────────────────────────────────────────
  const feed1 = await apiText(BASE, '/pepper-lists/catalog.csv');
  check('catalog feed 200', feed1.status, 200);
  checkTrue('catalog content type csv', String(feed1.headers.get('content-type') || '').includes('text/csv'));
  const feedLines = feed1.text.trim().split('\n');
  check('catalog header row', feedLines[0], 'id,title,description,availability,condition,price,link,image_link,brand');
  const row1 = feedLines.find((l) => l.startsWith(`${ref1},`)) || '';
  checkTrue('catalog has listing 1', row1.length > 0);
  checkTrue('catalog row 1 condition new', row1.includes(',new,'));
  checkTrue('catalog row 1 price', row1.includes('45.00 USD'));
  checkTrue('catalog row 1 link', row1.includes(`https://pepperlists.com/listing/${ref1}`));
  checkTrue('catalog row 1 image', row1.includes(`/pepper-lists/listings/${ref1}/photo/0`));
  checkTrue('catalog row 1 quoted description', row1.includes('"Sweet, tree-ripened"'));
  const row2 = feedLines.find((l) => l.startsWith(`${ref2},`)) || '';
  checkTrue('catalog has listing 2', row2.length > 0);
  checkTrue('catalog row 2 condition mapped', row2.includes('used_good'));
  checkTrue('catalog excludes scan submission', !feed1.text.includes(scanRef));

  // A removed listing leaves the feed (the office delete path).
  const del = await api(BASE, '/admin/connections/delete', { token: owner, method: 'POST', body: { reference: ref2 } });
  check('admin delete listing 2', del.status, 200);
  const feed2 = await apiText(BASE, '/pepper-lists/catalog.csv');
  checkTrue('catalog drops removed listing', !feed2.text.includes(ref2));
  checkTrue('catalog keeps listing 1', feed2.text.includes(ref1));

  // ── Listing view (OG) + photo bytes ────────────────────────────
  const view = await apiText(BASE, `/pepper-lists/listings/${ref1}/view`);
  check('listing view 200', view.status, 200);
  checkTrue('view og:title', view.text.includes('og:title') && view.text.includes('Fresh ackee by the box'));
  checkTrue('view og:image', view.text.includes('og:image') && view.text.includes(`/photo/0`));
  checkTrue('view canonical on pepperlists.com', view.text.includes(`https://pepperlists.com/listing/${ref1}`));
  checkTrue('view twitter card', view.text.includes('twitter:card'));
  checkTrue('view price meta', view.text.includes('product:price:amount') && view.text.includes('45.00'));
  check('unknown listing view 404', (await apiText(BASE, '/pepper-lists/listings/TS-NOPE/view')).status, 404);

  const photoRes = await fetch(`${BASE}/pepper-lists/listings/${ref1}/photo/0`);
  check('listing photo 200', photoRes.status, 200);
  checkTrue('listing photo is jpeg', String(photoRes.headers.get('content-type') || '').includes('image/jpeg'));
  const photoBytes = Buffer.from(await photoRes.arrayBuffer());
  checkTrue('listing photo has JPEG magic bytes', photoBytes[0] === 0xff && photoBytes[1] === 0xd8);
  check('listing photo index 1 404', (await fetch(`${BASE}/pepper-lists/listings/${ref1}/photo/1`)).status, 404);
  check('scan media stays private (photo 404)', (await fetch(`${BASE}/pepper-lists/listings/${scanRef}/photo/0`)).status, 404);

  // ── Cross-post queue ───────────────────────────────────────────
  check('cross-post unauthenticated 401', (await api(BASE, `/pepper-lists/listings/${ref1}/cross-posts`, { method: 'POST', body: { target: 'MARKETPLACE' } })).status, 401);
  check('cross-post by non-owner 404', (await api(BASE, `/pepper-lists/listings/${ref1}/cross-posts`, { token: b, method: 'POST', body: { target: 'MARKETPLACE' } })).status, 404);
  check('cross-post bad target 400', (await api(BASE, `/pepper-lists/listings/${ref1}/cross-posts`, { token: a, method: 'POST', body: { target: 'EBAY' } })).status, 400);

  const xp1 = await api(BASE, `/pepper-lists/listings/${ref1}/cross-posts`, { token: a, method: 'POST', body: { target: 'MARKETPLACE' } });
  check('cross-post MARKETPLACE 201', xp1.status, 201);
  check('cross-post starts QUEUED', xp1.json.data.crossPost.status, 'QUEUED');
  const xp1Id = xp1.json.data.crossPost.id;

  check('duplicate QUEUED cross-post 409', (await api(BASE, `/pepper-lists/listings/${ref1}/cross-posts`, { token: a, method: 'POST', body: { target: 'MARKETPLACE' } })).status, 409);

  const xp2 = await api(BASE, `/pepper-lists/listings/${ref1}/cross-posts`, { token: a, method: 'POST', body: { target: 'PAGE', pageId: '1437372132795817' } });
  check('cross-post PAGE 201', xp2.status, 201);
  const xp2Id = xp2.json.data.crossPost.id;

  const mine = await api(BASE, `/pepper-lists/listings/${ref1}/cross-posts`, { token: a });
  check('owner lists cross-posts 200', mine.status, 200);
  check('owner sees both cross-posts', mine.json.data.crossPosts.length, 2);
  check('non-owner list 404', (await api(BASE, `/pepper-lists/listings/${ref1}/cross-posts`, { token: b })).status, 404);

  const queueAsCustomer = await api(BASE, '/pepper-lists/cross-posts/queue', { token: a });
  check('staff queue refuses customer 403', queueAsCustomer.status, 403);
  const queue = await api(BASE, '/pepper-lists/cross-posts/queue', { token: staff });
  check('staff queue 200', queue.status, 200);
  check('staff queue count', queue.json.data.count, 2);

  check('outcome by seller 403', (await api(BASE, `/pepper-lists/cross-posts/${xp1Id}/outcome`, { token: a, method: 'POST', body: { status: 'POSTED', externalUrl: 'https://www.facebook.com/marketplace/item/123' } })).status, 403);
  check('outcome POSTED with non-Facebook URL 400', (await api(BASE, `/pepper-lists/cross-posts/${xp1Id}/outcome`, { token: staff, method: 'POST', body: { status: 'POSTED', externalUrl: 'https://example.com/item/123' } })).status, 400);
  // Phase 2 (2026-11-21) — the Facebook gateway gate: a POSTED
  // outcome requires the seller's Facebook agent grant ON (grant
  // check → owner approval → post → URL → logged). The Phase 1
  // version of this suite predates the gate; the flow below grants
  // first, exactly as a real seller now must.
  const postedNoGrant = await api(BASE, `/pepper-lists/cross-posts/${xp1Id}/outcome`, { token: staff, method: 'POST', body: { status: 'POSTED', externalUrl: 'https://www.facebook.com/marketplace/item/1234567890', externalId: '1234567890' } });
  check('outcome POSTED refused while the seller grant is OFF', postedNoGrant.status, 403);
  check('gateway refusal code', postedNoGrant.json.code, 'AGENT_GRANT_REQUIRED');
  const grantFb = await api(BASE, '/pepper-lists/channels/FACEBOOK/agent-access', { token: a, method: 'PATCH', body: { granted: true } });
  check('seller grants Facebook agent access', grantFb.json.data.connection.agentAccessGranted, true);
  const posted = await api(BASE, `/pepper-lists/cross-posts/${xp1Id}/outcome`, { token: staff, method: 'POST', body: { status: 'POSTED', externalUrl: 'https://www.facebook.com/marketplace/item/1234567890', externalId: '1234567890' } });
  check('outcome POSTED 200', posted.status, 200);
  check('outcome stored POSTED', posted.json.data.crossPost.status, 'POSTED');
  check('outcome stored URL', posted.json.data.crossPost.externalUrl, 'https://www.facebook.com/marketplace/item/1234567890');
  checkTrue('outcome postedAt set', typeof posted.json.data.crossPost.postedAt === 'string');
  check('second outcome 409', (await api(BASE, `/pepper-lists/cross-posts/${xp1Id}/outcome`, { token: staff, method: 'POST', body: { status: 'FAILED', error: 'too late' } })).status, 409);

  check('outcome FAILED without reason 400', (await api(BASE, `/pepper-lists/cross-posts/${xp2Id}/outcome`, { token: staff, method: 'POST', body: { status: 'FAILED' } })).status, 400);
  const failed = await api(BASE, `/pepper-lists/cross-posts/${xp2Id}/outcome`, { token: staff, method: 'POST', body: { status: 'FAILED', error: 'Page posting was rejected by Facebook' } });
  check('outcome FAILED 200', failed.status, 200);
  check('outcome stored reason', failed.json.data.crossPost.error, 'Page posting was rejected by Facebook');
  check('outcome unknown id 404', (await api(BASE, '/pepper-lists/cross-posts/20000000-0000-4000-8000-0000000000ff/outcome', { token: staff, method: 'POST', body: { status: 'FAILED', error: 'nope' } })).status, 404);

  const finalMine = await api(BASE, `/pepper-lists/listings/${ref1}/cross-posts`, { token: a });
  const byTarget = Object.fromEntries(finalMine.json.data.crossPosts.map((x) => [x.target, x]));
  check('seller sees POSTED marketplace', byTarget.MARKETPLACE.status, 'POSTED');
  check('seller sees FAILED page with reason', byTarget.PAGE.error, 'Page posting was rejected by Facebook');

  // ── Owner channel status (platform Facebook attestation) ──────
  const ownerChannels = await api(BASE, '/pepper-lists/channels', { token: owner });
  const ownerFb = ownerChannels.json.data.channels.find((c) => c.key === 'FACEBOOK');
  check('owner FACEBOOK presents CONNECTED', ownerFb.connection.status, 'CONNECTED');
  check('owner FACEBOOK platformManaged', ownerFb.connection.platformManaged, true);
  check('owner FACEBOOK label is the verified account', ownerFb.connection.externalAccountLabel, 'Ramone Williams');
  check('platformFacebook reports connected', ownerChannels.json.data.platformFacebook.connected, true);

  const sellerChannels = await api(BASE, '/pepper-lists/channels', { token: a });
  const sellerFb = sellerChannels.json.data.channels.find((c) => c.key === 'FACEBOOK');
  check('seller FACEBOOK row stays Phase 1', sellerFb.connection.status, 'NOT_CONNECTED');
  check('seller still told platform is connected', sellerChannels.json.data.platformFacebook.connected, true);
  const ownerRowCount = await prisma.sellerChannelConnection.count({ where: { userId: IDS.owner, channel: 'FACEBOOK' } });
  check('owner presentation wrote NO channel row', ownerRowCount, 0);

  // With the attestation disabled, the owner row must NOT show
  // CONNECTED — the status is verified or it is nothing.
  server2 = boot(PORT2, { FACEBOOK_CONNECTOR_DISABLED: '1' });
  await waitForServer(BASE2);
  const ownerChannels2 = await api(BASE2, '/pepper-lists/channels', { token: owner });
  const ownerFb2 = ownerChannels2.json.data.channels.find((c) => c.key === 'FACEBOOK');
  check('disabled attestation: owner FACEBOOK not CONNECTED', ownerFb2.connection.status, 'NOT_CONNECTED');
  check('disabled attestation: platformFacebook false', ownerChannels2.json.data.platformFacebook.connected, false);

  // ── Site static smoke ──────────────────────────────────────────
  const site = readFileSync(fileURLToPath(new URL('../../web/pepper-lists-site/index.html', import.meta.url)), 'utf8');
  checkTrue('site loads attribution capture', site.includes('/shared/attribution-capture.js'));
  checkTrue('site attaches attribution to posts', site.includes('plAttachAttribution'));
  checkTrue('site has Facebook share dialog', site.includes('facebook.com/sharer/sharer.php?u='));
  checkTrue('site has cross-post queue UI', site.includes('/cross-posts') && site.includes('plxQueue'));
  checkTrue('site renders queued status', site.includes('Queued for posting'));
  checkTrue('site renders platform-managed channel state', site.includes('platformManaged'));

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
}

main()
  .catch((error) => { console.error(error); failures += 1; })
  .finally(async () => {
    if (server) server.kill();
    if (server2) server2.kill();
    await cleanup();
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });
