/**
 * Pepper Lists — Phase 2 growth (2026-11-20, recommendations
 * program C16 + C17 + C18). Exercises routes/pepperListsGrowth.js
 * end to end over HTTP:
 *  - C16 syndication: queueing for eBay / Google Shopping is gated
 *    on the seller's Phase 1 channel request (409 CHANNEL_NOT_
 *    REQUESTED before it, 201 after), owner-only, duplicate-while-
 *    QUEUED 409, staff outcome recording with per-channel proof
 *    rules (eBay needs a real ebay.com URL, Google needs a real
 *    product id or google.com link, FAILED needs a reason, outcomes
 *    are final), the staff queue, the eBay File Exchange export,
 *    and the per-seller Google Shopping feed (token shown once,
 *    hash-only at rest, rotation invalidates, only that seller's
 *    live listings inside);
 *  - C17 storefronts: public JSON + shareable page with the
 *    seller's live listings and the TRUE empty reviews state — no
 *    email anywhere in the payload, no invented rating;
 *  - C18 messaging: buyer starts a thread on a listing, only the
 *    two parties can read or post (everyone else 404), unread
 *    counts flip on read, the other party is emailed through the
 *    outbox (throttled), a party's report flags the thread and
 *    lands a PepperReport in the staff queue, staff can read
 *    reported threads and close them, posting after close is 409,
 *    and the per-account hourly cap answers 429.
 *
 * NOTHING leaves the box: outcomes are staff-recorded exactly like
 * the real flow, and the feeds are read back from the local server.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=<local test db> node test/pepper-lists-growth.test.mjs
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

const PORT = Number(process.env.TEST_PORT || 4441);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  sellerA: '20000000-0000-4000-8000-0000000000d1',
  sellerB: '20000000-0000-4000-8000-0000000000d2',
  staff: '20000000-0000-4000-8000-0000000000d3',
  owner: '20000000-0000-4000-8000-0000000000d4',
  buyer: '20000000-0000-4000-8000-0000000000d5',
  buyer2: '20000000-0000-4000-8000-0000000000d6',
};
const USER_EMAILS = ['seller-a@test.local', 'seller-b@test.local', 'buyer@test.local', 'buyer2@test.local'];

// A real 1x1 JPEG (valid magic bytes — the listing route checks).
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwH/2Q==';

const prisma = new PrismaClient();
let server = null;
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

async function apiText(base, path, token) {
  const res = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
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
    { id: IDS.sellerA, email: 'seller-a@test.local', roles: ['CUSTOMER'], firstName: 'Maria', lastName: 'Garcia' },
    { id: IDS.sellerB, email: 'seller-b@test.local', roles: ['CUSTOMER'], firstName: 'Tom', lastName: 'Reed' },
    { id: IDS.staff, email: 'staff@test.local', roles: ['COMPANY_ADMIN'], firstName: 'Olivia', lastName: 'Office' },
    { id: IDS.owner, email: 'owner@test.local', roles: ['COMPANY_OWNER'], firstName: 'Boss', lastName: 'Owner' },
    { id: IDS.buyer, email: 'buyer@test.local', roles: ['CUSTOMER'], firstName: 'James', lastName: 'Wick' },
    { id: IDS.buyer2, email: 'buyer2@test.local', roles: ['CUSTOMER'], firstName: 'Pat', lastName: 'Nguyen' },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash, firstName: u.firstName, lastName: u.lastName },
      create: {
        id: u.id, companyId: PLATFORM_COMPANY_ID, email: u.email, passwordHash,
        phone: '9545550100', roles: u.roles, active: true, firstName: u.firstName, lastName: u.lastName,
      },
    });
  }
}

async function cleanup() {
  try {
    const idList = Object.values(IDS);
    const threads = await prisma.pepperListsThread.findMany({
      where: { OR: [{ buyerUserId: { in: idList } }, { sellerUserId: { in: idList } }] },
      select: { id: true },
    });
    await prisma.pepperListsMessage.deleteMany({ where: { threadId: { in: threads.map((t) => t.id) } } });
    await prisma.pepperListsThread.deleteMany({ where: { id: { in: threads.map((t) => t.id) } } });
    await prisma.pepperListsSyndication.deleteMany({ where: { userId: { in: idList } } });
    await prisma.pepperReport.deleteMany({ where: { createdByUserId: { in: idList } } });
    await prisma.notificationOutbox.deleteMany({ where: { eventKey: { contains: 'plmsg:' } } });
    const conns = await prisma.connection.findMany({ where: { email: { in: USER_EMAILS } }, select: { id: true } });
    const connIds = conns.map((c) => c.id);
    await prisma.submissionMedia.deleteMany({ where: { connectionId: { in: connIds } } });
    await prisma.connection.deleteMany({ where: { id: { in: connIds } } });
    await prisma.sellerChannelConnection.deleteMany({ where: { userId: { in: idList } } });
    await prisma.user.deleteMany({ where: { id: { in: idList } } });
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
      JWT_SECRET: 'plgrowth-test-secret',
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

async function waitForOutbox(predicate, label) {
  for (let i = 0; i < 20; i += 1) {
    const rows = await prisma.notificationOutbox.findMany({ where: { eventKey: { contains: 'plmsg:' } } });
    if (predicate(rows)) return rows;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`outbox expectation never landed: ${label}`);
}

async function main() {
  await cleanup();
  await seed();
  server = boot(PORT);
  await waitForServer(BASE);

  const a = await login(BASE, 'seller-a@test.local');
  const b = await login(BASE, 'seller-b@test.local');
  const staff = await login(BASE, 'staff@test.local');
  const buyer = await login(BASE, 'buyer@test.local');
  const buyer2 = await login(BASE, 'buyer2@test.local');

  // ── Listings ───────────────────────────────────────────────────
  const listing1 = await api(BASE, '/pepper-lists/listings', {
    token: a, method: 'POST',
    body: {
      title: 'Fresh ackee by the box', category: 'Produce & fruit', condition: 'New',
      priceCents: 4500, phone: '9545550100', description: 'Sweet, tree-ripened',
      media: [{ kind: 'photo', mime: 'image/jpeg', dataBase64: JPEG_B64 }],
    },
  });
  check('listing 1 created 201', listing1.status, 201);
  const ref1 = listing1.json.data.reference;

  const listing2 = await api(BASE, '/pepper-lists/listings', {
    token: a, method: 'POST',
    body: {
      title: 'Mango tree in pot', category: 'Trees & plants', condition: 'Used - good',
      priceCents: 2550, phone: '9545550100',
    },
  });
  check('listing 2 created 201', listing2.status, 201);
  const ref2 = listing2.json.data.reference;

  const listingB = await api(BASE, '/pepper-lists/listings', {
    token: b, method: 'POST',
    body: {
      title: 'Soursop seedlings', category: 'Trees & plants', condition: 'New',
      priceCents: 1200, phone: '9545550100',
    },
  });
  check('listing B created 201', listingB.status, 201);
  const refB = listingB.json.data.reference;

  // ── C16: the Phase 1 gate ──────────────────────────────────────
  const gated = await api(BASE, `/pepper-lists/listings/${ref1}/syndication`, {
    token: a, method: 'POST', body: { channel: 'EBAY' },
  });
  check('syndication before channel request 409', gated.status, 409);
  check('gate code names the missing step', gated.json?.code, 'CHANNEL_NOT_REQUESTED');

  const notOwner = await api(BASE, `/pepper-lists/listings/${ref1}/syndication`, {
    token: b, method: 'POST', body: { channel: 'EBAY' },
  });
  check('syndication on someone else\u2019s listing 404', notOwner.status, 404);

  const ebayConnect = await api(BASE, '/pepper-lists/channels/EBAY/connect', {
    token: a, method: 'POST', body: { accountLabel: 'maria-sells' },
  });
  check('eBay connect request 201', ebayConnect.status, 201);
  check('eBay connection is PENDING (Phase 1 truth)', ebayConnect.json?.data?.connection?.status, 'PENDING');

  const queuedEbay = await api(BASE, `/pepper-lists/listings/${ref1}/syndication`, {
    token: a, method: 'POST', body: { channel: 'EBAY' },
  });
  check('eBay syndication queued 201', queuedEbay.status, 201);
  check('eBay syndication status QUEUED', queuedEbay.json?.data?.syndication?.status, 'QUEUED');
  const ebayRowId = queuedEbay.json?.data?.syndication?.id;

  const dup = await api(BASE, `/pepper-lists/listings/${ref1}/syndication`, {
    token: a, method: 'POST', body: { channel: 'EBAY' },
  });
  check('duplicate QUEUED syndication 409', dup.status, 409);

  const gatedGoogle = await api(BASE, `/pepper-lists/listings/${ref1}/syndication`, {
    token: a, method: 'POST', body: { channel: 'GOOGLE_SHOPPING' },
  });
  check('Google syndication before its request 409', gatedGoogle.status, 409);

  const googleConnect = await api(BASE, '/pepper-lists/channels/GOOGLE_SHOPPING/connect', {
    token: a, method: 'POST', body: { accountLabel: 'MC-8841' },
  });
  check('Google connect request 201', googleConnect.status, 201);

  const queuedGoogle = await api(BASE, `/pepper-lists/listings/${ref1}/syndication`, {
    token: a, method: 'POST', body: { channel: 'GOOGLE_SHOPPING' },
  });
  check('Google syndication queued 201', queuedGoogle.status, 201);
  const googleRowId = queuedGoogle.json?.data?.syndication?.id;

  const mine = await api(BASE, `/pepper-lists/listings/${ref1}/syndication`, { token: a });
  check('owner reads own syndication rows', mine.json?.data?.syndication?.length, 2);

  // ── C16: staff queue + outcomes ────────────────────────────────
  const sellerQueue = await api(BASE, '/pepper-lists/syndication/queue', { token: a });
  check('seller cannot read the staff queue', sellerQueue.status, 403);
  const queue = await api(BASE, '/pepper-lists/syndication/queue', { token: staff });
  check('staff queue 200', queue.status, 200);
  const queueIds = (queue.json?.data?.syndication || []).map((r) => r.id);
  checkTrue('staff queue holds both rows', queueIds.includes(ebayRowId) && queueIds.includes(googleRowId));

  const wrongHost = await api(BASE, `/pepper-lists/syndication/${ebayRowId}/outcome`, {
    token: staff, method: 'POST',
    body: { status: 'POSTED', externalUrl: 'https://www.facebook.com/marketplace/item/123' },
  });
  check('eBay outcome with a Facebook URL 400', wrongHost.status, 400);

  const postedEbay = await api(BASE, `/pepper-lists/syndication/${ebayRowId}/outcome`, {
    token: staff, method: 'POST',
    body: { status: 'POSTED', externalUrl: 'https://www.ebay.com/itm/155512345678' },
  });
  check('eBay outcome POSTED 200', postedEbay.status, 200);
  check('eBay outcome status POSTED', postedEbay.json?.data?.syndication?.status, 'POSTED');
  checkTrue('eBay outcome stamps postedAt', Boolean(postedEbay.json?.data?.syndication?.postedAt));

  const secondOutcome = await api(BASE, `/pepper-lists/syndication/${ebayRowId}/outcome`, {
    token: staff, method: 'POST',
    body: { status: 'POSTED', externalUrl: 'https://www.ebay.com/itm/155512345678' },
  });
  check('second outcome on a decided row 409', secondOutcome.status, 409);

  const postedGoogle = await api(BASE, `/pepper-lists/syndication/${googleRowId}/outcome`, {
    token: staff, method: 'POST',
    body: { status: 'POSTED', externalId: 'pepperlists-' + ref1 },
  });
  check('Google outcome with product id only 200', postedGoogle.status, 200);
  check('Google outcome status POSTED', postedGoogle.json?.data?.syndication?.status, 'POSTED');

  // FAILED needs a reason; after a failure the seller can queue again.
  const queued2 = await api(BASE, `/pepper-lists/listings/${ref2}/syndication`, {
    token: a, method: 'POST', body: { channel: 'EBAY' },
  });
  check('listing 2 eBay queued 201', queued2.status, 201);
  const row2Id = queued2.json?.data?.syndication?.id;
  const failNoReason = await api(BASE, `/pepper-lists/syndication/${row2Id}/outcome`, {
    token: staff, method: 'POST', body: { status: 'FAILED' },
  });
  check('FAILED without a reason 400', failNoReason.status, 400);
  const failed = await api(BASE, `/pepper-lists/syndication/${row2Id}/outcome`, {
    token: staff, method: 'POST', body: { status: 'FAILED', error: 'Live plants need a different eBay category' },
  });
  check('FAILED with a reason 200', failed.status, 200);
  const requeue = await api(BASE, `/pepper-lists/listings/${ref2}/syndication`, {
    token: a, method: 'POST', body: { channel: 'EBAY' },
  });
  check('re-queue after FAILED 201', requeue.status, 201);

  // ── C16: eBay File Exchange export ─────────────────────────────
  const exportSeller = await apiText(BASE, '/pepper-lists/syndication/ebay-export.csv', a);
  check('seller cannot read the eBay export', exportSeller.status, 403);
  const exp = await apiText(BASE, '/pepper-lists/syndication/ebay-export.csv', staff);
  check('eBay export 200', exp.status, 200);
  checkTrue('eBay export header', exp.text.startsWith('Action(SiteID=US|Country=US|Currency=USD|Version=1193),CustomLabel,'));
  checkTrue('eBay export holds the queued listing 2', exp.text.includes(ref2));
  checkTrue('eBay export excludes the posted listing 1', !exp.text.includes(ref1));
  checkTrue('eBay export carries the price', exp.text.includes('25.50'));

  // ── C16: Google Shopping feed token + feed ─────────────────────
  const tokenB = await api(BASE, '/pepper-lists/channels/GOOGLE_SHOPPING/feed-token', { token: b, method: 'POST', body: {} });
  check('feed token before connect 409', tokenB.status, 409);

  const issued = await api(BASE, '/pepper-lists/channels/GOOGLE_SHOPPING/feed-token', { token: a, method: 'POST', body: {} });
  check('feed token issued 201', issued.status, 201);
  const feedUrl = issued.json?.data?.feedUrl || '';
  checkTrue('feed URL points at the API feed', feedUrl.includes('/pepper-lists/feeds/google/') && feedUrl.endsWith('.xml'));
  const token1 = feedUrl.split('/feeds/google/')[1].replace(/\.xml$/, '');

  const feed = await apiText(BASE, `/pepper-lists/feeds/google/${token1}.xml`);
  check('seller feed 200', feed.status, 200);
  checkTrue('feed is RSS+Google namespace', feed.text.includes('<rss version="2.0"') && feed.text.includes('xmlns:g="http://base.google.com/ns/1.0"'));
  checkTrue('feed holds listing 1 id', feed.text.includes(`<g:id>${ref1}</g:id>`));
  checkTrue('feed holds listing 2 id', feed.text.includes(`<g:id>${ref2}</g:id>`));
  checkTrue('feed excludes seller B listing', !feed.text.includes(refB));
  checkTrue('feed price format', feed.text.includes('<g:price>45.00 USD</g:price>'));
  checkTrue('feed condition new', feed.text.includes('<g:condition>new</g:condition>'));
  checkTrue('feed condition used', feed.text.includes('<g:condition>used</g:condition>'));
  checkTrue('feed image link', feed.text.includes(`<g:image_link>`) && feed.text.includes(`/photo/0`));
  checkTrue('feed link to listing page', feed.text.includes(`https://pepperlists.com/listing/${ref1}`));

  const badFeed = await apiText(BASE, '/pepper-lists/feeds/google/definitely-not-a-token.xml');
  check('unknown feed token 404', badFeed.status, 404);

  const rotated = await api(BASE, '/pepper-lists/channels/GOOGLE_SHOPPING/feed-token', { token: a, method: 'POST', body: {} });
  const token2 = (rotated.json?.data?.feedUrl || '').split('/feeds/google/')[1].replace(/\.xml$/, '');
  checkTrue('rotation issues a new token', token2 && token2 !== token1);
  check('old token dies on rotation', (await apiText(BASE, `/pepper-lists/feeds/google/${token1}.xml`)).status, 404);
  check('new token serves the feed', (await apiText(BASE, `/pepper-lists/feeds/google/${token2}.xml`)).status, 200);

  // The raw token is never what the database holds.
  const connRow = await prisma.sellerChannelConnection.findFirst({
    where: { userId: IDS.sellerA, channel: 'GOOGLE_SHOPPING' },
  });
  checkTrue('only the token hash is stored', Boolean(connRow?.meta?.googleFeedTokenHash) && connRow.meta.googleFeedTokenHash !== token2 && !JSON.stringify(connRow.meta).includes(token2));

  // ── C17: storefronts ───────────────────────────────────────────
  const storefront = await api(BASE, `/pepper-lists/sellers/${IDS.sellerA}/storefront`);
  check('storefront 200 (public)', storefront.status, 200);
  check('storefront seller name is public form', storefront.json?.data?.seller?.name, 'Maria G.');
  check('storefront listings count', storefront.json?.data?.seller?.listingsCount, 2);
  checkTrue('storefront memberSince present', Boolean(storefront.json?.data?.seller?.memberSince));
  const sfRefs = (storefront.json?.data?.listings || []).map((l) => l.reference);
  checkTrue('storefront lists both listings', sfRefs.includes(ref1) && sfRefs.includes(ref2));
  check('storefront reviews count is the true zero', storefront.json?.data?.reviews?.count, 0);
  check('storefront reviews average is null (never invented)', storefront.json?.data?.reviews?.average, null);
  checkTrue('storefront payload carries no email', !JSON.stringify(storefront.json).includes('seller-a@test.local'));
  check('unknown seller storefront 404', (await api(BASE, '/pepper-lists/sellers/20000000-0000-4000-8000-000000000099/storefront')).status, 404);

  const sfView = await apiText(BASE, `/pepper-lists/sellers/${IDS.sellerA}/view`);
  check('storefront view 200', sfView.status, 200);
  checkTrue('storefront view og:title', sfView.text.includes('og:title') && sfView.text.includes('Maria G.'));
  checkTrue('storefront view honest reviews line', sfView.text.includes('No seller reviews yet'));
  checkTrue('storefront view links the listing page', sfView.text.includes(`https://pepperlists.com/listing/${ref1}`));
  checkTrue('storefront view canonical is the seller URL', sfView.text.includes(`https://pepperlists.com/seller/${IDS.sellerA}`));
  checkTrue('storefront view carries no email', !sfView.text.includes('seller-a@test.local'));

  const listingView = await apiText(BASE, `/pepper-lists/listings/${ref1}/view`);
  checkTrue('listing view offers Message the seller', listingView.text.includes('Message the seller') && listingView.text.includes(`?message=${ref1}`));

  // ── C18: messaging ─────────────────────────────────────────────
  const anon = await api(BASE, `/pepper-lists/listings/${ref1}/messages`, { method: 'POST', body: { body: 'hi' } });
  check('anonymous message 401', anon.status, 401);

  const ownListing = await api(BASE, `/pepper-lists/listings/${ref1}/messages`, {
    token: a, method: 'POST', body: { body: 'note to self' },
  });
  check('messaging your own listing 400', ownListing.status, 400);

  const started = await api(BASE, `/pepper-lists/listings/${ref1}/messages`, {
    token: buyer, method: 'POST', body: { body: 'Hi — is the ackee still available?' },
  });
  check('buyer starts a thread 201', started.status, 201);
  const thread1 = started.json?.data?.thread?.id;
  checkTrue('thread id returned', typeof thread1 === 'string' && thread1.length > 10);
  check('thread opens with the first message', started.json?.data?.messages?.length, 1);
  check('buyer sees the seller\u2019s public name', started.json?.data?.thread?.otherParty?.name, 'Maria G.');

  // The seller is emailed through the outbox.
  const sellerMail = await waitForOutbox(
    (rows) => rows.some((r) => r.eventKey.startsWith(`plmsg:${thread1}:`) && r.to === 'seller-a@test.local'),
    'seller new-message email',
  );
  const sellerRow = sellerMail.find((r) => r.eventKey.startsWith(`plmsg:${thread1}:`));
  check('seller email template', sellerRow?.template, 'PEPPER_LISTS_MESSAGE');

  const sellerInbox = await api(BASE, '/pepper-lists/threads', { token: a });
  check('seller inbox holds the thread', sellerInbox.json?.data?.threads?.length, 1);
  check('seller unread count 1', sellerInbox.json?.data?.threads?.[0]?.unreadCount, 1);
  check('seller sees role SELLER', sellerInbox.json?.data?.threads?.[0]?.role, 'SELLER');
  check('seller sees the buyer\u2019s public name', sellerInbox.json?.data?.threads?.[0]?.otherParty?.name, 'James W.');

  const sellerRead = await api(BASE, `/pepper-lists/threads/${thread1}`, { token: a });
  check('seller opens the thread 200', sellerRead.status, 200);
  checkTrue('opening marks the buyer\u2019s message read', Boolean(sellerRead.json?.data?.messages?.[0]?.readAt));
  const sellerInbox2 = await api(BASE, '/pepper-lists/threads', { token: a });
  check('seller unread clears after read', sellerInbox2.json?.data?.threads?.[0]?.unreadCount, 0);

  const reply = await api(BASE, `/pepper-lists/threads/${thread1}/messages`, {
    token: a, method: 'POST', body: { body: 'Yes — picked this week. When would you like to come by?' },
  });
  check('seller reply 200', reply.status, 200);
  check('thread now holds two messages', reply.json?.data?.messages?.length, 2);
  const buyerInbox = await api(BASE, '/pepper-lists/threads', { token: buyer });
  check('buyer unread count 1 after reply', buyerInbox.json?.data?.threads?.[0]?.unreadCount, 1);

  // Privacy: a third signed-in user gets the same 404 as a missing thread.
  check('third user read 404', (await api(BASE, `/pepper-lists/threads/${thread1}`, { token: b })).status, 404);
  check('third user post 404', (await api(BASE, `/pepper-lists/threads/${thread1}/messages`, { token: b, method: 'POST', body: { body: 'sneaking in' } })).status, 404);
  check('third user report 404', (await api(BASE, `/pepper-lists/threads/${thread1}/report`, { token: b, method: 'POST', body: {} })).status, 404);
  check('unknown listing message 404', (await api(BASE, '/pepper-lists/listings/TS-NOPE/messages', { token: buyer, method: 'POST', body: { body: 'hi' } })).status, 404);

  // Throttle: the buyer's second message inside 15 minutes sends no
  // second email to the seller.
  const buyerAgain = await api(BASE, `/pepper-lists/threads/${thread1}/messages`, {
    token: buyer, method: 'POST', body: { body: 'Saturday morning works for me.' },
  });
  check('buyer follow-up 200', buyerAgain.status, 200);
  await new Promise((r) => setTimeout(r, 1500));
  const outboxRows = await prisma.notificationOutbox.findMany({ where: { eventKey: { contains: 'plmsg:' } } });
  check('seller got exactly one email (throttle)', outboxRows.filter((r) => r.to === 'seller-a@test.local').length, 1);
  checkTrue('buyer got the reply email', outboxRows.some((r) => r.to === 'buyer@test.local'));

  // Report → staff queue.
  const reported = await api(BASE, `/pepper-lists/threads/${thread1}/report`, {
    token: buyer, method: 'POST', body: { reason: 'Asked me to pay by gift card' },
  });
  check('report 200', reported.status, 200);
  check('thread flagged REPORTED', reported.json?.data?.thread?.status, 'REPORTED');
  const reportRow = await prisma.pepperReport.findFirst({ where: { createdByUserId: IDS.buyer } });
  checkTrue('report landed in the staff queue', Boolean(reportRow));
  check('report category INCIDENT', reportRow?.category, 'INCIDENT');
  checkTrue('report names the listing', String(reportRow?.title || '').includes(ref1));
  const reportedAgain = await api(BASE, `/pepper-lists/threads/${thread1}/report`, {
    token: buyer, method: 'POST', body: { reason: 'again' },
  });
  check('second report still 200', reportedAgain.status, 200);
  check('no duplicate staff report', await prisma.pepperReport.count({ where: { createdByUserId: IDS.buyer } }), 1);

  const staffList = await api(BASE, '/pepper-lists/threads/reported', { token: staff });
  check('staff reported list 200', staffList.status, 200);
  checkTrue('reported list holds the thread', (staffList.json?.data?.threads || []).some((t) => t.id === thread1));
  check('seller cannot read the reported list', (await api(BASE, '/pepper-lists/threads/reported', { token: a })).status, 403);
  const staffRead = await api(BASE, `/pepper-lists/threads/${thread1}/staff`, { token: staff });
  check('staff reads the reported thread', staffRead.status, 200);
  check('staff sees all three messages', staffRead.json?.data?.messages?.length, 3);
  check('staff sees the seller email (moderation only)', staffRead.json?.data?.thread?.seller?.email, 'seller-a@test.local');

  const closed = await api(BASE, `/pepper-lists/threads/${thread1}/close`, { token: staff, method: 'POST', body: {} });
  check('staff close 200', closed.status, 200);
  check('thread CLOSED', closed.json?.data?.thread?.status, 'CLOSED');
  check('posting after close 409', (await api(BASE, `/pepper-lists/threads/${thread1}/messages`, { token: buyer, method: 'POST', body: { body: 'hello?' } })).status, 409);

  // The hourly per-account cap: buyer2's 31st send is refused.
  const spamStart = await api(BASE, `/pepper-lists/listings/${refB}/messages`, {
    token: buyer2, method: 'POST', body: { body: 'Interested in the seedlings' },
  });
  check('buyer2 thread starts 201', spamStart.status, 201);
  const thread2 = spamStart.json?.data?.thread?.id;
  let lastStatus = 0;
  for (let i = 0; i < 29; i += 1) {
    const r = await api(BASE, `/pepper-lists/threads/${thread2}/messages`, {
      token: buyer2, method: 'POST', body: { body: `follow-up ${i}` },
    });
    lastStatus = r.status;
  }
  check('30th send inside the cap still 200', lastStatus, 200);
  const overCap = await api(BASE, `/pepper-lists/threads/${thread2}/messages`, {
    token: buyer2, method: 'POST', body: { body: 'one too many' },
  });
  check('31st send in the hour 429', overCap.status, 429);

  // ── Static smoke: the site carries the growth UI ───────────────
  const site = readFileSync(fileURLToPath(new URL('../../web/pepper-lists-site/index.html', import.meta.url)), 'utf8');
  checkTrue('site has the messages section', site.includes('id="plMessages"'));
  checkTrue('site wires plmEnter into the app entry', site.includes('plmEnter(u)'));
  checkTrue('site has the syndication block', site.includes('plgBlockHtml'));
  checkTrue('site wires the syndication block into listing confirm', site.includes('plgLoadStatus()'));
  checkTrue('site has the feed-token action', site.includes('GOOGLE_SHOPPING/feed-token'));
  checkTrue('site has the storefront link row', site.includes('plgStoreLink'));
  const vercel = readFileSync(fileURLToPath(new URL('../../web/vercel.json', import.meta.url)), 'utf8');
  checkTrue('vercel rewrites the seller storefront URL', vercel.includes('/seller/:userId'));

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
}

main()
  .catch((error) => {
    console.error('SUITE ERROR:', error);
    failures += 1;
  })
  .finally(async () => {
    if (server) server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  });
