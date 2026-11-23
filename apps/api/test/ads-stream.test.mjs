/**
 * Top Speed Ads — streaming system drills (2026-11-23).
 *
 * What these drills prove, end to end over HTTP in skeleton mode:
 *  - the public attraction stream GET /ads-os/stream answers 200
 *    anonymously and starts HONESTLY EMPTY (no posts) while still
 *    carrying the two standing offer cards as data — the published
 *    rate card ($99 / $210 / $150) and the referral terms
 *    ($25 / $35 / $50, $100 @ 10, $250 @ 25);
 *  - after staff walk one AD_IDEA post, one CUSTOM post (the
 *    format the console actually recorded the live ads-style posts
 *    under — verified against the production feed 2026-11-23) and
 *    one REPAIR_SPOTLIGHT post to POSTED (and leave a second
 *    AD_IDEA as a DRAFT), the stream serves EXACTLY the two posted
 *    ad-format posts with their real facebook.com URLs — the
 *    spotlight and the draft never appear;
 *  - the Facebook OS public feed still serves all POSTED posts
 *    (no regression);
 *  - syndication LIVE on a surface shows up in the stream's
 *    carriedOn, and the Ads OS unified platforms feed gains the
 *    ads-stream section behind the same service key (401 without,
 *    200 with, counts matching the seeded truth, order extended).
 *
 * Usage: node test/ads-stream.test.mjs
 * (Skeleton mode: DATABASE_URL must NOT be set. TEST_PORT defaults
 * to 4651.) Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/services/passwords.js';

if (process.env.DATABASE_URL) {
  console.error('DATABASE_URL is set — this harness runs in skeleton mode only. Unset it and re-run.');
  process.exit(2);
}

const PORT = Number(process.env.TEST_PORT || 4651);
const B = `http://127.0.0.1:${PORT}/api/v1`;
// Assembled from fragments on purpose (AGENTS.md credential-
// expression rule for tool writes). Test-only values.
const PW = ['drill', 'pass', '1234'].join('-');
const JWT = ['adsstream', 'drill', 'jwt', 'secret'].join('-');
const SERVICE_KEY = ['adsstream', 'drill', 'service', 'key'].join('-');
const PLATFORM_COMPANY_ID = '10000000-0000-4000-8000-000000000001';

const IDS = { marketing: '30000000-0000-4000-8000-0000000000d2' };
const EMAILS = { marketing: 'marketing@adsstreamdrill.test' };
const FB_URL = 'https://www.facebook.com/1437372132795817/posts/900000000000101';
const AD_FB_URL = 'https://www.facebook.com/1437372132795817/posts/900000000000102';
const CUSTOM_FB_URL = 'https://www.facebook.com/1437372132795817/posts/900000000000103';

const [marketingHash] = await Promise.all([hashPassword(PW)]);
const seedUser = (id, email, hash, roles) => ({
  id, companyId: PLATFORM_COMPANY_ID, email, passwordHash: hash,
  firstName: 'Drill', lastName: 'User', phone: null, roles,
  active: true, emailVerifiedAt: new Date().toISOString(),
  verifyRequired: false, layer2Required: false, layer2Phone: null, layer2Channel: null,
  createdAt: new Date().toISOString(),
});

const preloadPath = fileURLToPath(new URL('./.adsstream-preload.mjs', import.meta.url));
writeFileSync(preloadPath, `
import { store } from '../src/data/store.js';
store.users.set(${JSON.stringify(IDS.marketing)}, ${JSON.stringify(seedUser(IDS.marketing, EMAILS.marketing, marketingHash, ['MARKETING_MANAGER']))});
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

async function walkToPosted(id, url, token) {
  const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  await req(B, 'POST', `/facebook-os/stream/${id}/transition`, { toStatus: 'PENDING_APPROVAL' }, token);
  await req(B, 'POST', `/facebook-os/stream/${id}/transition`, { toStatus: 'SCHEDULED', scheduledFor: future }, token);
  return req(B, 'POST', `/facebook-os/stream/${id}/transition`, { toStatus: 'POSTED', facebookUrl: url }, token);
}

const server = boot(PORT, { ADS_OS_SERVICE_KEY: SERVICE_KEY });
try {
  checkTrue('BOOT: API boots and /health answers', await waitForHealth(B), server.log().slice(-400));

  /* 1. The public stream: anonymous, honestly empty, offers as data. */
  const s0 = await req(B, 'GET', '/ads-os/stream');
  check('ads stream → 200 anonymous', s0.status, 200);
  check('ads stream starts with no posts (honest empty)', data(s0).posts.length, 0);
  check('ads stream carries the 2 standing offer cards', data(s0).offers.length, 2);
  check('offer 1 is the rate card', data(s0).offers[0].key, 'rate-card');
  check('offer 2 is the referral rewards', data(s0).offers[1].key, 'referral-rewards');
  const rateLines = (data(s0).offers[0].lines || []).join(' ');
  checkTrue('rate card states $99 / $210 / $150',
    rateLines.includes('$99') && rateLines.includes('$210') && rateLines.includes('$150'), rateLines);
  const refLines = (data(s0).offers[1].lines || []).join(' ');
  checkTrue('referral terms state $25 / $35 / $50 / $100 / $250',
    ['$25', '$35', '$50', '$100', '$250'].every((v) => refLines.includes(v)), refLines);
  check('stream names the official Page', data(s0).page.id, '1437372132795817');
  check('stream page URL is the canonical profile URL', data(s0).page.url, 'https://www.facebook.com/profile.php?id=61596590488055');

  /* 2. Seed: one AD_IDEA posted, one CUSTOM posted, one spotlight
   * posted, one AD_IDEA draft. */
  const mLogin = await req(B, 'POST', '/auth/login', { email: EMAILS.marketing, password: PW });
  check('marketing manager sign-in → 200', mLogin.status, 200);
  const MT = data(mLogin).token;

  const adPost = await req(B, 'POST', '/facebook-os/stream', {
    title: 'Drill ad — flat rates', copy: 'Drill copy — the rate card ad.', format: 'AD_IDEA',
  }, MT);
  check('create AD_IDEA post → 201', adPost.status, 201);
  const adId = data(adPost).id;
  const customAd = await req(B, 'POST', '/facebook-os/stream', {
    title: 'Drill ad — recorded as CUSTOM', copy: 'Drill copy — the console-recorded ad.', format: 'CUSTOM',
  }, MT);
  check('create CUSTOM post → 201', customAd.status, 201);
  const customId = data(customAd).id;
  const spot = await req(B, 'POST', '/facebook-os/stream', {
    title: 'Drill spotlight', copy: 'Drill copy — refrigerator repair.', format: 'REPAIR_SPOTLIGHT',
  }, MT);
  const spotId = data(spot).id;
  const draftAd = await req(B, 'POST', '/facebook-os/stream', {
    title: 'Drill ad — still a draft', copy: 'Drill copy — never posted.', format: 'AD_IDEA',
  }, MT);
  check('second AD_IDEA stays a draft', data(draftAd).status, 'DRAFT');

  check('walk AD_IDEA to POSTED → 200', (await walkToPosted(adId, AD_FB_URL, MT)).status, 200);
  check('walk CUSTOM to POSTED → 200', (await walkToPosted(customId, CUSTOM_FB_URL, MT)).status, 200);
  check('walk spotlight to POSTED → 200', (await walkToPosted(spotId, FB_URL, MT)).status, 200);

  /* 3. The stream serves exactly the two posted ad-format posts. */
  const s1 = await req(B, 'GET', '/ads-os/stream');
  check('stream serves exactly 2 posts', data(s1).posts.length, 2);
  const streamIds = data(s1).posts.map((p) => p.id).sort();
  check('stream posts are the AD_IDEA + CUSTOM ones', JSON.stringify(streamIds), JSON.stringify([adId, customId].sort()));
  const streamAd = data(s1).posts.find((p) => p.id === adId);
  check('AD_IDEA post format is AD_IDEA', streamAd.format, 'AD_IDEA');
  check('stream link is the real Facebook post (Rule 1)', streamAd.url, AD_FB_URL);
  const streamCustom = data(s1).posts.find((p) => p.id === customId);
  check('CUSTOM post link is its real Facebook post', streamCustom.url, CUSTOM_FB_URL);
  checkTrue('offers still ride along', data(s1).offers.length === 2);

  /* 4. No regression: the feed serves all POSTED posts. */
  const feed = await req(B, 'GET', '/facebook-os/feed');
  check('facebook feed serves all 3 POSTED posts', data(feed).posts.length, 3);

  /* 5. Syndication shows in the stream; the platforms section counts it. */
  const syn = await req(B, 'POST', '/facebook-os/syndication', { postId: adId, surface: 'flagship-home', deepLink: AD_FB_URL, status: 'LIVE' }, MT);
  check('syndicate the ad post LIVE → 201', syn.status, 201);
  const s2 = await req(B, 'GET', '/ads-os/stream');
  const s2Ad = data(s2).posts.find((p) => p.id === adId);
  check('stream carriedOn names the LIVE surface', s2Ad.carriedOn.length, 1);
  check('carried surface is flagship-home', s2Ad.carriedOn[0].surface, 'flagship-home');

  check('platforms ads-stream without key → 401', (await req(B, 'GET', '/integrations/ads-os/platforms/ads-stream')).status, 401);
  const section = await req(B, 'GET', '/integrations/ads-os/platforms/ads-stream', undefined, null, { 'x-ads-os-key': SERVICE_KEY });
  check('platforms ads-stream with key → 200', section.status, 200);
  check('ads-stream section is available', data(section).available, true);
  check('section counts 2 posted ad posts', data(section).metrics.adPostsPosted, 2);
  check('section counts 1 LIVE ad-stream surface', data(section).metrics.adStreamSurfacesLive, 1);
  check('section counts 1 LIVE stream surface overall', data(section).metrics.streamSurfacesLive, 1);
  checkTrue('section latestAdPostedAt is stamped', Boolean(data(section).metrics.latestAdPostedAt));
  const all = await req(B, 'GET', '/integrations/ads-os/platforms', undefined, null, { 'x-ads-os-key': SERVICE_KEY });
  check('unified feed order ends with sales-os', data(all).order[data(all).order.length - 1], 'sales-os');
  check('unified feed order has 8 platforms', data(all).order.length, 8);
} finally {
  server.child.kill('SIGTERM');
  rmSync(preloadPath, { force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
