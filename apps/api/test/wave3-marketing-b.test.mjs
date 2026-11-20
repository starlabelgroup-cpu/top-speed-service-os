/**
 * Wave 3 marketing package B drill — E5 Help Center, E6 Media OS →
 * Facebook publish queue, E7 Insights calls-by-source.
 *
 * Boots the real API against a throwaway drill database (DATABASE_URL
 * from the environment) and exercises:
 *   E5 — the 126 Speedy knowledge entries are DRAFT (not public) until a
 *        staff member publishes them; published articles render publicly
 *        with Book + Call paths; search works; unpublish takes them back
 *        down; the staff gate holds (customer 403, anon 401).
 *   E6 — publishing Media OS content queues a ready-to-post Facebook
 *        package for the Repair & Installation Page (1437372132795817);
 *        the display state stays "Queued for posting" until a staff
 *        outcome records a REAL facebook.com URL ("Published — <link>")
 *        or a failure reason ("Couldn't post — <reason>"); a second
 *        outcome is a 409; with the Facebook connection unverified
 *        (FACEBOOK_CONNECTOR_DISABLED=1, second server) nothing queues
 *        and the manual queue answers an honest 503. NO real Facebook
 *        posts happen — outcomes are recorded in the drill DB only.
 *   E7 — /insights/calls counts real ContactEvents by surface and by
 *        tracked number; events on no registered number stay in the
 *        honest unattributed bucket; events outside the 28-day window
 *        are excluded.
 *
 * Static smoke: the three web surfaces carry their markers.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { hashPassword } from '../src/services/passwords.js';

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.resolve(API_DIR, '..', 'web');
const PORT = Number(process.env.TEST_PORT || 4451);
const PORT2 = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const BASE2 = `http://127.0.0.1:${PORT2}/api/v1`;
const prisma = new PrismaClient();

let passed = 0;
let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.log(`  ✗ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
function checkTrue(label, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.log(`  ✗ ${label} ${detail}`); }
}

async function req(base, method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

async function waitFor(base, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return true;
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function boot(port, extraEnv = {}) {
  const server = spawn('node', ['src/server.js'], {
    cwd: API_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      JWT_SECRET: 'wave3b-test-secret',
      DATABASE_URL: process.env.DATABASE_URL,
      NODE_ENV: 'test',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return server;
}

const IDS = {
  admin: 'b3000000-0000-4000-8000-000000000001',
  marketing: 'b3000000-0000-4000-8000-000000000002',
  customer: 'b3000000-0000-4000-8000-000000000003',
};
const EMAILS = {
  admin: 'wave3b-admin@topspeed.test',
  marketing: 'wave3b-mkt@topspeed.test',
  customer: 'wave3b-cust@topspeed.test',
};
const PASSWORD = 'Wave3b-Test-Pass-1';

async function seedUsers() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  const users = [
    { id: IDS.admin, email: EMAILS.admin, roles: ['COMPANY_ADMIN'] },
    { id: IDS.marketing, email: EMAILS.marketing, roles: ['MARKETING_MANAGER'] },
    { id: IDS.customer, email: EMAILS.customer, roles: ['CUSTOMER'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash },
      create: { id: u.id, companyId: PLATFORM_COMPANY_ID, email: u.email, passwordHash, phone: '9545550100', roles: u.roles, active: true },
    });
  }
}

async function login(base, email) {
  const r = await req(base, 'POST', '/auth/login', { body: { email, password: PASSWORD } });
  if (r.status !== 200 || !r.json?.token) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.token;
}

async function cleanup() {
  try { await prisma.mediaFacebookPost.deleteMany({ where: { contentSlug: { startsWith: 'wave3b-' } } }); } catch { /* table may not exist pre-migrate */ }
  try { await prisma.mediaContent.deleteMany({ where: { slug: { startsWith: 'wave3b-' } } }); } catch { /* ignore */ }
  try { await prisma.helpArticleState.deleteMany({}); } catch { /* ignore */ }
  try { await prisma.contactEvent.deleteMany({ where: { externalSid: { startsWith: 'wave3b-' } } }); } catch { /* ignore */ }
  try { await prisma.trackingNumber.deleteMany({ where: { seedKey: { startsWith: 'wave3b-' } } }); } catch { /* ignore */ }
  try { await prisma.user.deleteMany({ where: { id: { in: Object.values(IDS) } } }); } catch { /* ignore */ }
}

async function walkToPublished(base, token, id) {
  for (const status of ['IN_REVIEW', 'APPROVED', 'PUBLISHED']) {
    const r = await req(base, 'POST', `/media-os/admin/content/${id}/status`, { token, body: { status } });
    if (status === 'PUBLISHED') return r;
    if (r.status !== 200) throw new Error(`status walk failed at ${status}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  throw new Error('unreachable');
}

async function main() {
  await cleanup();
  await seedUsers();
  const server = boot(PORT);
  const server2 = boot(PORT2, { FACEBOOK_CONNECTOR_DISABLED: '1' });
  try {
    checkTrue('api boots', await waitFor(BASE));
    checkTrue('api (fb-disabled) boots', await waitFor(BASE2));
    const admin = await login(BASE, EMAILS.admin);
    const marketing = await login(BASE, EMAILS.marketing);
    const customer = await login(BASE, EMAILS.customer);
    const admin2 = await login(BASE2, EMAILS.admin);

    /* ── E5: Help Center ─────────────────────────────────── */
    console.log('\nE5 — Help Center');
    let r = await req(BASE, 'GET', '/help/articles');
    check('public list starts empty (nothing auto-publishes)', r.json?.data?.total, 0);
    check('public list carries the booking paths', r.json?.data?.booking?.bookUrl, '/book');
    check('public list carries the call path', r.json?.data?.booking?.callHref, 'tel:+18444607038');

    r = await req(BASE, 'GET', '/help/articles/site-pricing-diagnostic');
    check('draft article detail is 404 publicly', r.status, 404);

    r = await req(BASE, 'GET', '/help/admin/articles');
    check('admin list anon → 401', r.status, 401);
    r = await req(BASE, 'GET', '/help/admin/articles', { token: customer });
    check('admin list customer → 403', r.status, 403);
    r = await req(BASE, 'GET', '/help/admin/articles', { token: admin });
    check('admin list total = the full knowledge base', r.json?.data?.counts?.total, 126);
    check('admin list published starts at 0', r.json?.data?.counts?.published, 0);
    check('admin list draft = 126', r.json?.data?.counts?.draft, 126);

    r = await req(BASE, 'POST', '/help/admin/articles/nope-not-an-entry/status', { token: admin, body: { status: 'PUBLISHED' } });
    check('publish unknown entry → 404', r.status, 404);
    r = await req(BASE, 'POST', '/help/admin/articles/site-pricing-diagnostic/status', { token: admin, body: { status: 'LIVE' } });
    check('invalid status value → 400', r.status, 400);
    r = await req(BASE, 'POST', '/help/admin/articles/site-pricing-diagnostic/status', { token: customer, body: { status: 'PUBLISHED' } });
    check('publish as customer → 403', r.status, 403);

    r = await req(BASE, 'POST', '/help/admin/articles/site-pricing-diagnostic/status', { token: admin, body: { status: 'PUBLISHED' } });
    check('staff publishes the diagnostic article', r.status, 200);
    check('publish response state', r.json?.data?.state, 'PUBLISHED');
    r = await req(BASE, 'POST', '/help/admin/articles/ind-svc-refrigerator/status', { token: marketing, body: { status: 'PUBLISHED' } });
    check('marketing manager publishes the refrigerator guide', r.status, 200);

    r = await req(BASE, 'GET', '/help/articles');
    check('public list now has the 2 published articles', r.json?.data?.total, 2);
    const listed = (r.json?.data?.articles || []).find((a) => a.id === 'site-pricing-diagnostic');
    checkTrue('list shape carries excerpt, not the full answer', !!listed && typeof listed.excerpt === 'string' && listed.answer === undefined);
    check('site article category label', listed?.category, 'About Top Speed & the Platform');

    r = await req(BASE, 'GET', '/help/articles/site-pricing-diagnostic');
    check('published article detail → 200', r.status, 200);
    checkTrue('detail carries the full grounded answer', (r.json?.data?.article?.answer || '').length > 80);
    check('detail booking path', r.json?.data?.booking?.callDisplay, '(844) 460-7038');

    r = await req(BASE, 'GET', '/help/articles?q=refrigerator');
    check('search finds the refrigerator guide', (r.json?.data?.articles || []).map((a) => a.id), ['ind-svc-refrigerator']);
    r = await req(BASE, 'GET', '/help/articles?q=zzzz-no-match-zzzz');
    check('search with no match is an honest empty list', r.json?.data?.total, 0);

    r = await req(BASE, 'POST', '/help/admin/articles/site-pricing-diagnostic/status', { token: admin, body: { status: 'DRAFT' } });
    check('unpublish works', r.status, 200);
    r = await req(BASE, 'GET', '/help/articles/site-pricing-diagnostic');
    check('unpublished article is 404 again', r.status, 404);
    r = await req(BASE, 'GET', '/help/articles');
    check('public list back to 1', r.json?.data?.total, 1);

    /* ── E6: Media OS → Facebook queue ───────────────────── */
    console.log('\nE6 — Media OS Facebook publish queue');
    const mkContent = async (base, token, slug, title) => {
      const c = await req(base, 'POST', '/media-os/admin/content', {
        token,
        body: {
          title, slug, type: 'SOCIAL_POST', division: 'SOCIAL',
          description: 'Drill content for the Facebook queue.',
          destinationUrl: 'https://topspeedserviceos.com/book',
          tags: ['wave3b', 'drill'],
        },
      });
      if (c.status !== 201) throw new Error(`content create failed: ${c.status} ${JSON.stringify(c.json)}`);
      return c.json.data;
    };

    const c1 = await mkContent(BASE, admin, 'wave3b-fb-one', 'Wave3B Facebook Drill One');
    r = await req(BASE, 'POST', `/media-os/admin/content/${c1.id}/status`, { token: admin, body: { status: 'PUBLISHED' } });
    check('direct DRAFT → PUBLISHED stays a 422 (approval flow intact)', r.status, 422);
    r = await req(BASE, 'POST', `/media-os/admin/content/${c1.id}/facebook-queue`, { token: admin, body: {} });
    check('manual queue on a DRAFT → 422', r.status, 422);

    r = await walkToPublished(BASE, admin, c1.id);
    check('publish succeeds through the approval flow', r.status, 200);
    check('publish auto-queues the Facebook package', r.json?.data?.facebookQueue?.queued, true);
    check('facebook state after publish', r.json?.data?.facebook?.state, 'QUEUED');
    check('facebook label after publish', r.json?.data?.facebook?.label, 'Queued for posting');

    r = await req(BASE, 'GET', '/media-os/admin/facebook-queue', { token: admin });
    check('queue read → 200', r.status, 200);
    check('queue connection verified', r.json?.data?.connection?.connected, true);
    check('queue targets the Repair & Installation Page', r.json?.data?.connection?.page?.id, '1437372132795817');
    const q1 = (r.json?.data?.posts || []).find((p) => p.contentId === c1.id);
    checkTrue('queue row exists for the published content', !!q1);
    check('queue row status', q1?.status, 'QUEUED');
    checkTrue('package message carries the title', (q1?.message || '').includes('Wave3B Facebook Drill One'));
    check('package link is the content destination', q1?.linkUrl, 'https://topspeedserviceos.com/book');

    r = await req(BASE, 'GET', '/media-os/admin/content', { token: admin });
    const listedC1 = (r.json?.data || []).find((c) => c.id === c1.id);
    check('console list shows the queued state', listedC1?.facebook?.label, 'Queued for posting');

    r = await req(BASE, 'POST', `/media-os/admin/content/${c1.id}/facebook-queue`, { token: admin, body: {} });
    check('manual re-queue while one is waiting → duplicate, no second row', r.json?.data?.duplicate, true);

    r = await req(BASE, 'POST', `/media-os/admin/facebook-queue/${q1.id}/outcome`, { token: admin, body: { status: 'POSTED' } });
    check('POSTED outcome without a URL → 400', r.status, 400);
    r = await req(BASE, 'POST', `/media-os/admin/facebook-queue/${q1.id}/outcome`, { token: admin, body: { status: 'POSTED', externalUrl: 'https://example.com/not-facebook' } });
    check('POSTED outcome with a non-Facebook URL → 400', r.status, 400);
    const POST_URL = 'https://www.facebook.com/photo/?fbid=wave3bdrill1';
    r = await req(BASE, 'POST', `/media-os/admin/facebook-queue/${q1.id}/outcome`, { token: admin, body: { status: 'POSTED', externalUrl: POST_URL } });
    check('POSTED outcome with the real post URL → 200', r.status, 200);
    r = await req(BASE, 'GET', `/media-os/admin/content/${c1.id}`, { token: admin });
    check('display state becomes POSTED', r.json?.data?.facebook?.state, 'POSTED');
    check('display label carries the real link', r.json?.data?.facebook?.label, `Published — ${POST_URL}`);
    r = await req(BASE, 'POST', `/media-os/admin/facebook-queue/${q1.id}/outcome`, { token: admin, body: { status: 'FAILED', error: 'too late' } });
    check('a second outcome on a settled row → 409', r.status, 409);

    // Re-queue after a successful post → fresh package; record a failure.
    r = await req(BASE, 'POST', `/media-os/admin/content/${c1.id}/facebook-queue`, { token: admin, body: {} });
    check('re-queue after posting creates a fresh package', r.status, 201);
    const q2id = r.json?.data?.id;
    r = await req(BASE, 'POST', `/media-os/admin/facebook-queue/${q2id}/outcome`, { token: admin, body: { status: 'FAILED' } });
    check('FAILED outcome without a reason → 400', r.status, 400);
    r = await req(BASE, 'POST', `/media-os/admin/facebook-queue/${q2id}/outcome`, { token: admin, body: { status: 'FAILED', error: 'Drill failure reason' } });
    check('FAILED outcome with a reason → 200', r.status, 200);
    r = await req(BASE, 'GET', `/media-os/admin/content/${c1.id}`, { token: admin });
    check('display label carries the failure reason', r.json?.data?.facebook?.label, "Couldn't post — Drill failure reason");

    const c2 = await mkContent(BASE, marketing, 'wave3b-fb-two', 'Wave3B Facebook Drill Two');
    r = await walkToPublished(BASE, marketing, c2.id);
    check('second content publishes + auto-queues', r.json?.data?.facebookQueue?.queued, true);

    r = await req(BASE, 'GET', '/media-os/admin/facebook-queue', { token: customer });
    check('queue read as customer → 403', r.status, 403);
    r = await req(BASE, 'GET', '/media-os/admin/facebook-queue');
    check('queue read anon → 401', r.status, 401);
    r = await req(BASE, 'POST', `/media-os/admin/content/${c2.id}/facebook-queue`, { token: customer, body: {} });
    check('manual queue as customer → 403', r.status, 403);

    // Connection unverified (second server): nothing queues, honestly.
    const c3 = await mkContent(BASE2, admin2, 'wave3b-fb-three', 'Wave3B Facebook Drill Three');
    r = await walkToPublished(BASE2, admin2, c3.id);
    check('publish still works with Facebook unverified', r.status, 200);
    check('…but nothing queues', r.json?.data?.facebookQueue?.queued, false);
    check('…and the reason is stated', r.json?.data?.facebookQueue?.reason, 'not_connected');
    check('…and no facebook summary is attached', r.json?.data?.facebook ?? null, null);
    r = await req(BASE2, 'POST', `/media-os/admin/content/${c3.id}/facebook-queue`, { token: admin2, body: {} });
    check('manual queue with Facebook unverified → 503', r.status, 503);
    r = await req(BASE2, 'GET', '/media-os/admin/facebook-queue', { token: admin2 });
    check('queue read reports the connection as unverified', r.json?.data?.connection?.connected, false);

    /* ── E7: Insights calls by source ────────────────────── */
    console.log('\nE7 — Insights calls by source');
    const now = Date.now();
    const tnPlatform = await prisma.trackingNumber.create({
      data: { kind: 'PHONE', value: '+19545550101', label: 'Wave3B Platform Line', surfaceKey: 'platform', channels: ['VOICE', 'SMS'], status: 'ACTIVE', shared: true, seedKey: 'wave3b-platform' },
    });
    const tnPepper = await prisma.trackingNumber.create({
      data: { kind: 'PHONE', value: '+19545550102', label: 'Wave3B Pepper Line', surfaceKey: 'pepper-lists', channels: ['VOICE', 'SMS'], status: 'ACTIVE', shared: false, seedKey: 'wave3b-pepper' },
    });
    let seq = 0;
    const ev = (channel, trackingNumberId, surfaceKey, ageDays = 0) => prisma.contactEvent.create({
      data: {
        channel, trackingNumberId, surfaceKey,
        fromNumber: '+13055550100', toNumber: '+18444607038',
        externalSid: `wave3b-ev-${seq += 1}`,
        createdAt: new Date(now - ageDays * 86400000),
      },
    });
    await ev('VOICE', tnPlatform.id, 'platform');
    await ev('VOICE', tnPlatform.id, 'platform');
    await ev('VOICE', tnPlatform.id, 'platform');
    await ev('SMS', tnPlatform.id, 'platform');
    await ev('SMS', tnPlatform.id, 'platform');
    await ev('VOICE', tnPlatform.id, 'platform', 40); // outside the window
    await ev('VOICE', tnPepper.id, 'pepper-lists');
    await ev('SMS', tnPepper.id, 'pepper-lists');
    await ev('VOICE', null, 'platform');
    await ev('VOICE', null, 'platform');
    await ev('SMS', null, 'platform');

    r = await req(BASE, 'GET', '/insights/calls');
    check('calls board anon → 401', r.status, 401);
    r = await req(BASE, 'GET', '/insights/calls', { token: customer });
    check('calls board customer → 403', r.status, 403);
    r = await req(BASE, 'GET', '/insights/calls', { token: admin });
    check('calls board staff → 200', r.status, 200);
    const calls = r.json?.data || {};
    check('window is 28 days', calls.windowDays, 28);
    check('total calls (window, incl. unattributed)', calls.totals?.calls, 6);
    check('total texts (window, incl. unattributed)', calls.totals?.texts, 4);
    check('attributed calls', calls.totals?.attributedCalls, 4);
    check('attributed texts', calls.totals?.attributedTexts, 3);
    const surfPlatform = (calls.bySurface || []).find((s) => s.surfaceKey === 'platform');
    const surfPepper = (calls.bySurface || []).find((s) => s.surfaceKey === 'pepper-lists');
    check('platform surface calls', surfPlatform?.calls, 3);
    check('platform surface texts', surfPlatform?.texts, 2);
    check('platform surface label', surfPlatform?.surfaceLabel, 'Top Speed platform (shared)');
    check('pepper-lists surface total', surfPepper?.total, 2);
    const numPlatform = (calls.byNumber || []).find((n) => n.id === tnPlatform.id);
    const numPepper = (calls.byNumber || []).find((n) => n.id === tnPepper.id);
    check('platform number total excludes the 40-day-old event', numPlatform?.total, 5);
    check('pepper number total', numPepper?.total, 2);
    check('unattributed calls', calls.unattributed?.calls, 2);
    check('unattributed texts', calls.unattributed?.texts, 1);
    checkTrue('honesty notes ride along', Array.isArray(calls.notes) && calls.notes.length >= 2);

    /* ── Static DOM smoke ────────────────────────────────── */
    console.log('\nStatic surface smoke');
    const helpHtml = readFileSync(path.join(WEB_DIR, 'help', 'index.html'), 'utf8');
    checkTrue('help page calls the public articles API', helpHtml.includes('/help/articles'));
    checkTrue('help page carries Book + Call on the page', helpHtml.includes('Book a Repair') && helpHtml.includes('tel:+18444607038'));
    checkTrue('help page carries the staff publishing controls', helpHtml.includes('data-hstatus') && helpHtml.includes('/help/admin/articles'));
    const insightsHtml = readFileSync(path.join(WEB_DIR, 'insights', 'index.html'), 'utf8');
    checkTrue('insights page has the calls-by-source card', insightsHtml.includes('id="insCalls"') && insightsHtml.includes('/insights/calls'));
    checkTrue('insights page loads the calls board', insightsHtml.includes('insLoadCalls()'));
    const mediaHtml = readFileSync(path.join(WEB_DIR, 'media', 'index.html'), 'utf8');
    checkTrue('media console has the Facebook queue panel', mediaHtml.includes('facebook-queue') && mediaHtml.includes('Queued for posting'));
    checkTrue('media console has the outcome controls', mediaHtml.includes('data-fbposted') && mediaHtml.includes('data-fbfailed'));
  } finally {
    server.kill('SIGTERM');
    server2.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try { await cleanup(); } catch { /* ignore */ }
  await prisma.$disconnect();
  process.exit(1);
});
