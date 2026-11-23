/**
 * Top Speed Facebook OS Manager — drills (2026-11-23).
 *
 * What these drills prove, end to end over HTTP in skeleton mode:
 *  - the staff gate: anonymous → 401 on every console route, a
 *    non-marketing staff role (DISPATCHER) → 403, marketing roles in;
 *  - the public feed serves POSTED records only (empty queue = an
 *    honest empty feed, drafts never leak into it);
 *  - the stream lifecycle: DRAFT → PENDING_APPROVAL → SCHEDULED →
 *    POSTED, with illegal jumps refused (409), scheduling requiring
 *    a time (400), and POSTED requiring the real facebook.com URL
 *    (400 without it, 400 for a non-Facebook URL);
 *  - a POSTED record is immutable (PATCH → 409);
 *  - series ingestion (Top Speed Posts by Pepper) registers drafts
 *    and is idempotent per week;
 *  - ad drafts can never be ACTIVE here (400) — enabling is Ads
 *    Manager only; recorded spend is a plain staff-recorded field;
 *  - syndication refuses LIVE for an unposted post (409) and unknown
 *    surfaces (400);
 *  - the summary carries today's post + the 7-slot weekly cadence;
 *  - Page activity serves the recorded-posts registry (the real
 *    posted URL), and the Meta state states the writes boundary;
 *  - the Ads OS unified platforms feed gains the facebook-os
 *    section behind the same service key (200 with key, 401
 *    without).
 *
 * Usage: node test/facebook-os.test.mjs
 * (Skeleton mode: DATABASE_URL must NOT be set. TEST_PORT defaults
 * to 4631.) Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/services/passwords.js';

if (process.env.DATABASE_URL) {
  console.error('DATABASE_URL is set — this harness runs in skeleton mode only. Unset it and re-run.');
  process.exit(2);
}

const PORT = Number(process.env.TEST_PORT || 4631);
const B = `http://127.0.0.1:${PORT}/api/v1`;
const B2 = `http://127.0.0.1:${PORT + 1}/api/v1`;
// Assembled from fragments on purpose (AGENTS.md credential-
// expression rule for tool writes). Test-only values.
const PW = ['drill', 'pass', '1234'].join('-');
const JWT = ['fbos', 'drill', 'jwt', 'secret'].join('-');
const SERVICE_KEY = ['fbos', 'drill', 'service', 'key'].join('-');
const PLATFORM_COMPANY_ID = '10000000-0000-4000-8000-000000000001';

const IDS = {
  owner: '30000000-0000-4000-8000-0000000000c1',
  marketing: '30000000-0000-4000-8000-0000000000c2',
  dispatcher: '30000000-0000-4000-8000-0000000000c3',
};
const EMAILS = {
  owner: 'owner@fbosdrill.test',
  marketing: 'marketing@fbosdrill.test',
  dispatcher: 'setter@fbosdrill.test',
};
const FB_URL = 'https://www.facebook.com/1437372132795817/posts/900000000000001';

const [ownerHash, marketingHash, dispatcherHash] = await Promise.all([
  hashPassword(PW), hashPassword(PW), hashPassword(PW),
]);
const seedUser = (id, email, hash, roles) => ({
  id, companyId: PLATFORM_COMPANY_ID, email, passwordHash: hash,
  firstName: 'Drill', lastName: 'User', phone: null, roles,
  active: true, emailVerifiedAt: new Date().toISOString(),
  verifyRequired: false, layer2Required: false, layer2Phone: null, layer2Channel: null,
  createdAt: new Date().toISOString(),
});

const preloadPath = fileURLToPath(new URL('./.fbosdrill-preload.mjs', import.meta.url));
writeFileSync(preloadPath, `
import { store } from '../src/data/store.js';
store.users.set(${JSON.stringify(IDS.owner)}, ${JSON.stringify(seedUser(IDS.owner, EMAILS.owner, ownerHash, ['COMPANY_OWNER']))});
store.users.set(${JSON.stringify(IDS.marketing)}, ${JSON.stringify(seedUser(IDS.marketing, EMAILS.marketing, marketingHash, ['MARKETING_MANAGER']))});
store.users.set(${JSON.stringify(IDS.dispatcher)}, ${JSON.stringify(seedUser(IDS.dispatcher, EMAILS.dispatcher, dispatcherHash, ['DISPATCHER']))});
`);

function boot(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['--import', preloadPath, 'src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(port), JWT_SECRET: JWT, ALLOW_DEMO_AUTH: 'false', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return { child, log: () => log };
}

let passed = 0, failed = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(label, cond, detail = '') {
  if (cond) passed += 1; else failed += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : ` — ${detail}`}`);
}
async function req(base, method, path, body, token, headers = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: r.status, json, text };
}
const data = (r) => (r.json && (r.json.data || r.json)) || {};
async function waitForHealth(base, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(base + '/health'); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const server1 = boot(PORT);
try {
  checkTrue('BOOT: API boots and /health answers', await waitForHealth(B), server1.log().slice(-400));

  /* 1. Gates. */
  check('anonymous stream read → 401', (await req(B, 'GET', '/facebook-os/stream')).status, 401);
  check('anonymous summary → 401', (await req(B, 'GET', '/facebook-os/summary')).status, 401);
  check('anonymous ads read → 401', (await req(B, 'GET', '/facebook-os/ads')).status, 401);
  check('anonymous create → 401', (await req(B, 'POST', '/facebook-os/stream', { title: 'x', copy: 'y' })).status, 401);

  const dLogin = await req(B, 'POST', '/auth/login', { email: EMAILS.dispatcher, password: PW });
  check('dispatcher sign-in → 200', dLogin.status, 200);
  check('dispatcher stream read → 403 (not a marketing surface role)', (await req(B, 'GET', '/facebook-os/stream', undefined, data(dLogin).token)).status, 403);

  const mLogin = await req(B, 'POST', '/auth/login', { email: EMAILS.marketing, password: PW });
  check('marketing manager sign-in → 200', mLogin.status, 200);
  const MT = data(mLogin).token;

  /* 2. Public feed: empty and honest before anything posts. */
  const feed0 = await req(B, 'GET', '/facebook-os/feed');
  check('public feed → 200 anonymous', feed0.status, 200);
  check('public feed starts empty (no seeded/demo posts)', data(feed0).posts.length, 0);

  /* 3. Stream lifecycle. */
  const created = await req(B, 'POST', '/facebook-os/stream', {
    title: 'Drill spotlight', copy: 'Drill copy — refrigerator repair.', format: 'REPAIR_SPOTLIGHT',
  }, MT);
  check('create post → 201', created.status, 201);
  check('post is born DRAFT', data(created).status, 'DRAFT');
  const postId = data(created).id;
  check('create without title → 400', (await req(B, 'POST', '/facebook-os/stream', { copy: 'y' }, MT)).status, 400);
  check('create with bad format → 400', (await req(B, 'POST', '/facebook-os/stream', { title: 'x', copy: 'y', format: 'NOPE' }, MT)).status, 400);

  check('DRAFT → POSTED jump refused → 409', (await req(B, 'POST', `/facebook-os/stream/${postId}/transition`, { toStatus: 'POSTED', facebookUrl: FB_URL }, MT)).status, 409);
  const toPending = await req(B, 'POST', `/facebook-os/stream/${postId}/transition`, { toStatus: 'PENDING_APPROVAL' }, MT);
  check('DRAFT → PENDING_APPROVAL → 200', toPending.status, 200);
  check('schedule without a time → 400', (await req(B, 'POST', `/facebook-os/stream/${postId}/transition`, { toStatus: 'SCHEDULED' }, MT)).status, 400);
  const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const toSched = await req(B, 'POST', `/facebook-os/stream/${postId}/transition`, { toStatus: 'SCHEDULED', scheduledFor: future }, MT);
  check('PENDING_APPROVAL → SCHEDULED with time → 200', toSched.status, 200);
  check('POSTED without URL → 400', (await req(B, 'POST', `/facebook-os/stream/${postId}/transition`, { toStatus: 'POSTED' }, MT)).status, 400);
  const badUrl = await req(B, 'POST', `/facebook-os/stream/${postId}/transition`, { toStatus: 'POSTED', facebookUrl: 'https://example.com/not-facebook' }, MT);
  check('POSTED with a non-Facebook URL → 400', badUrl.status, 400);
  check('rejection carries FACEBOOK_URL_REQUIRED', data(badUrl).code || badUrl.json?.code, 'FACEBOOK_URL_REQUIRED');
  const toPosted = await req(B, 'POST', `/facebook-os/stream/${postId}/transition`, { toStatus: 'POSTED', facebookUrl: FB_URL }, MT);
  check('SCHEDULED → POSTED with the real URL → 200', toPosted.status, 200);
  checkTrue('POSTED stamps postedAt', Boolean(data(toPosted).postedAt));
  check('POSTED record is immutable → 409', (await req(B, 'PATCH', `/facebook-os/stream/${postId}`, { title: 'rewrite history' }, MT)).status, 409);

  /* 4. Feed now serves exactly the posted record. */
  const feed1 = await req(B, 'GET', '/facebook-os/feed');
  check('public feed serves the one POSTED post', data(feed1).posts.length, 1);
  check('feed link is the real Facebook post (Rule 1)', data(feed1).posts[0].url, FB_URL);

  /* 5. Series ingestion — idempotent drafts. */
  const week = {
    seriesKey: 'top-speed-posts-by-pepper',
    seriesWeek: 1,
    posts: [
      { format: 'REPAIR_SPOTLIGHT', title: 'Week 1 A — Refrigerator', copy: 'Frost taking over your freezer?' },
      { format: 'SPEEDY_TIP', title: 'Week 1 B — Fridge temps', copy: 'Set your refrigerator to 37°F.' },
      { format: 'REWARDS_SAVINGS', title: 'Week 1 C — Referral rewards', copy: 'Your word is worth money now.' },
    ],
  };
  const ingest1 = await req(B, 'POST', '/facebook-os/series/ingest', week, MT);
  check('series ingest → 201', ingest1.status, 201);
  check('ingest creates 3 drafts', data(ingest1).created.length, 3);
  checkTrue('ingested posts are DRAFTS', data(ingest1).created.every((p) => p.status === 'DRAFT'));
  const ingest2 = await req(B, 'POST', '/facebook-os/series/ingest', week, MT);
  check('re-ingest creates 0 (idempotent)', data(ingest2).created.length, 0);
  check('re-ingest reports 3 duplicates', data(ingest2).duplicates.length, 3);
  const series = await req(B, 'GET', '/facebook-os/series', undefined, MT);
  check('series view shows week 1', data(series)[0].seriesWeek, 1);
  check('series week 1 holds its 3 posts', data(series)[0].posts.length, 3);
  const feed2 = await req(B, 'GET', '/facebook-os/feed');
  check('drafts never leak into the public feed', data(feed2).posts.length, 1);

  /* 6. Ad drafts — planning records, never ACTIVE. */
  const ad = await req(B, 'POST', '/facebook-os/ads', { name: 'Drill ad', objective: 'LEADS', budgetCents: 5000 }, MT);
  check('create ad draft → 201', ad.status, 201);
  check('ad draft is born DRAFT', data(ad).status, 'DRAFT');
  check('ad draft with status ACTIVE → 400', (await req(B, 'POST', '/facebook-os/ads', { name: 'x', objective: 'LEADS', status: 'ACTIVE' }, MT)).status, 400);
  check('PATCH ad draft to ACTIVE → 400', (await req(B, 'PATCH', `/facebook-os/ads/${data(ad).id}`, { status: 'ACTIVE' }, MT)).status, 400);
  const spend = await req(B, 'PATCH', `/facebook-os/ads/${data(ad).id}`, { recordedSpendCents: 0 }, MT);
  check('recorded spend is a staff-recorded field → 200', spend.status, 200);

  /* 7. Syndication — LIVE only for POSTED posts. */
  const draftId = data(ingest1).created[0].id;
  check('syndicate LIVE for a DRAFT post → 409', (await req(B, 'POST', '/facebook-os/syndication', { postId: draftId, surface: 'flagship-home', deepLink: FB_URL, status: 'LIVE' }, MT)).status, 409);
  check('syndicate unknown surface → 400', (await req(B, 'POST', '/facebook-os/syndication', { postId: postId, surface: 'mars', deepLink: FB_URL }, MT)).status, 400);
  const syn = await req(B, 'POST', '/facebook-os/syndication', { postId, surface: 'flagship-home', deepLink: FB_URL, status: 'LIVE' }, MT);
  check('syndicate LIVE for the POSTED post → 201', syn.status, 201);
  const feed3 = await req(B, 'GET', '/facebook-os/feed');
  check('feed carries the LIVE syndication', data(feed3).posts[0].carriedOn.length, 1);
  check('carried surface is flagship-home', data(feed3).posts[0].carriedOn[0].surface, 'flagship-home');

  /* 8. Summary, today, page activity, meta boundary. */
  const summary = await req(B, 'GET', '/facebook-os/summary', undefined, MT);
  check('summary → 200', summary.status, 200);
  check('summary counts the POSTED post', data(summary).posts.POSTED, 1);
  check('summary counts the series drafts', data(summary).posts.DRAFT, 3);
  check('summary carries the 7-slot weekly cadence', data(summary).weeklySlots.length, 7);
  checkTrue('summary names today\'s slot concept', Boolean(data(summary).today && data(summary).today.date));
  const activity = await req(B, 'GET', '/facebook-os/page-activity', undefined, MT);
  check('page activity → 200', activity.status, 200);
  check('page activity source is the recorded registry', data(activity).source, 'recorded-posts-registry');
  check('page activity serves the real posted URL', data(activity).posts[0].facebookUrl, FB_URL);
  const meta = await req(B, 'GET', '/facebook-os/meta', undefined, MT);
  check('meta state names the account', data(meta).ads.adAccountId, '834084027055828');
  check('meta state states writes DISABLED_BY_META', data(meta).ads.apiWrites, 'DISABLED_BY_META');
} finally {
  server1.child.kill('SIGTERM');
}

/* 9. Ads OS unified feed gains the facebook-os section. */
const server2 = boot(PORT + 1, { ADS_OS_SERVICE_KEY: SERVICE_KEY });
try {
  checkTrue('BOOT 2: API boots with the Ads OS key set', await waitForHealth(B2), server2.log().slice(-400));
  check('platforms facebook-os without key → 401', (await req(B2, 'GET', '/integrations/ads-os/platforms/facebook-os')).status, 401);
  const section = await req(B2, 'GET', '/integrations/ads-os/platforms/facebook-os', undefined, null, { 'x-ads-os-key': SERVICE_KEY });
  check('platforms facebook-os with key → 200', section.status, 200);
  check('facebook-os section is available', data(section).available, true);
  checkTrue('section metrics carry postsByStatus', Boolean(data(section).metrics && data(section).metrics.postsByStatus));
  checkTrue('section metrics carry today', Boolean(data(section).metrics && data(section).metrics.today));
  const all = await req(B2, 'GET', '/integrations/ads-os/platforms', undefined, null, { 'x-ads-os-key': SERVICE_KEY });
  checkTrue('unified feed order includes facebook-os', Array.isArray(data(all).order) && data(all).order.includes('facebook-os'));
} finally {
  server2.child.kill('SIGTERM');
  rmSync(preloadPath, { force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
