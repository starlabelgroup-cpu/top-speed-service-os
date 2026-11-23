/**
 * City Posts engine — drills (2026-11-23).
 *
 * What these drills prove, end to end over HTTP in skeleton mode:
 *  - the loader gate: anonymous → 401, a non-marketing staff role
 *    (DISPATCHER) → 403 on POST /facebook-os/city-posts/ingest;
 *  - the loader creates exactly N drafts, where N = the verified
 *    published-page count baked into data/citySpotlightPages.js
 *    (124 at build time — Ramone directed 131; the published store
 *    holds 124 and every one live-probed 200, so 124 is the honest
 *    count and the generator never pads);
 *  - every draft is born DRAFT, format CITY_SPOTLIGHT, and its link
 *    is in the verified page list (Rule 1);
 *  - re-running the loader adds 0 (idempotent per page);
 *  - the API rows match the pure generator's output exactly (what
 *    is drilled is what loads), and neighbouring city posts never
 *    repeat a service+angle pair;
 *  - the copy sweep: no $ amount other than the rate card
 *    (99/210/150), no review/star/rating language, no "guarantee",
 *    no vent mention, no superlatives or invented-claim words,
 *    every copy inside the 1,024-char Facebook limit, every copy
 *    carrying its own page link and the business phone, and
 *    commercial posts carrying NO residential prices;
 *  - every record carries its visual spec in statusNote (icon,
 *    number element, shield, symbols, lockup), with the kit
 *    actually rotating (≥10 icons, ≥3 number elements);
 *  - drafts never leak into the public feed.
 *
 * Usage: node test/facebook-os-city-posts.test.mjs
 * (Skeleton mode: DATABASE_URL must NOT be set. TEST_PORT defaults
 * to 4641.) Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/services/passwords.js';
import { CITY_SPOTLIGHT_PAGES } from '../src/data/citySpotlightPages.js';
import { buildCityPosts } from '../src/services/cityPostGenerator.js';

if (process.env.DATABASE_URL) {
  console.error('DATABASE_URL is set — this harness runs in skeleton mode only. Unset it and re-run.');
  process.exit(2);
}

const PORT = Number(process.env.TEST_PORT || 4641);
const B = `http://127.0.0.1:${PORT}/api/v1`;
// Assembled from fragments on purpose (AGENTS.md credential-
// expression rule for tool writes). Test-only values.
const PW = ['drill', 'pass', '1234'].join('-');
const JWT = ['cityposts', 'drill', 'jwt', 'secret'].join('-');
const PLATFORM_COMPANY_ID = '10000000-0000-4000-8000-000000000001';

const IDS = {
  marketing: '30000000-0000-4000-8000-0000000000d2',
  dispatcher: '30000000-0000-4000-8000-0000000000d3',
};
const EMAILS = {
  marketing: 'marketing@citypostsdrill.test',
  dispatcher: 'setter@citypostsdrill.test',
};

const [marketingHash, dispatcherHash] = await Promise.all([hashPassword(PW), hashPassword(PW)]);
const seedUser = (id, email, hash, roles) => ({
  id, companyId: PLATFORM_COMPANY_ID, email, passwordHash: hash,
  firstName: 'Drill', lastName: 'User', phone: null, roles,
  active: true, emailVerifiedAt: new Date().toISOString(),
  verifyRequired: false, layer2Required: false, layer2Phone: null, layer2Channel: null,
  createdAt: new Date().toISOString(),
});

const preloadPath = fileURLToPath(new URL('./.cityposts-drill-preload.mjs', import.meta.url));
writeFileSync(preloadPath, `
import { store } from '../src/data/store.js';
store.users.set(${JSON.stringify(IDS.marketing)}, ${JSON.stringify(seedUser(IDS.marketing, EMAILS.marketing, marketingHash, ['MARKETING_MANAGER']))});
store.users.set(${JSON.stringify(IDS.dispatcher)}, ${JSON.stringify(seedUser(IDS.dispatcher, EMAILS.dispatcher, dispatcherHash, ['DISPATCHER']))});
`);

function boot(port) {
  const child = spawn(process.execPath, ['--import', preloadPath, 'src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(port), JWT_SECRET: JWT, ALLOW_DEMO_AUTH: 'false' },
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
async function req(base, method, path, body, token) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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

const N = CITY_SPOTLIGHT_PAGES.length;
const verifiedUrls = new Set(CITY_SPOTLIGHT_PAGES.map((p) => p.url));
const expected = buildCityPosts();
const expectedByUrl = new Map(expected.map((p) => [p.linkUrl, p]));

const server = boot(PORT);
try {
  checkTrue('BOOT: API boots and /health answers', await waitForHealth(B), server.log().slice(-400));
  check('verified page count baked = generator set size', expected.length, N);

  /* 1. Gates. */
  check('anonymous city-posts ingest → 401', (await req(B, 'POST', '/facebook-os/city-posts/ingest', {})).status, 401);
  const dLogin = await req(B, 'POST', '/auth/login', { email: EMAILS.dispatcher, password: PW });
  check('dispatcher sign-in → 200', dLogin.status, 200);
  check('dispatcher city-posts ingest → 403', (await req(B, 'POST', '/facebook-os/city-posts/ingest', {}, data(dLogin).token)).status, 403);
  const mLogin = await req(B, 'POST', '/auth/login', { email: EMAILS.marketing, password: PW });
  check('marketing manager sign-in → 200', mLogin.status, 200);
  const MT = data(mLogin).token;

  /* 2. The load. */
  const load1 = await req(B, 'POST', '/facebook-os/city-posts/ingest', {}, MT);
  check('city-posts ingest → 201', load1.status, 201);
  check('ingest total = verified page count', data(load1).total, N);
  check('ingest creates exactly N drafts', data(load1).created.length, N);
  check('first ingest reports 0 duplicates', data(load1).duplicates.length, 0);
  const created = data(load1).created;
  checkTrue('every created post is born DRAFT', created.every((r) => r.status === 'DRAFT'));
  checkTrue('every created post is CITY_SPOTLIGHT in the city-spotlight series',
    created.every((r) => r.format === 'CITY_SPOTLIGHT' && r.seriesKey === 'city-spotlight'));
  checkTrue('every link is in the verified page list', created.every((r) => verifiedUrls.has(r.linkUrl)));

  /* 3. Idempotency. */
  const load2 = await req(B, 'POST', '/facebook-os/city-posts/ingest', {}, MT);
  check('re-ingest → 201', load2.status, 201);
  check('re-ingest creates 0', data(load2).created.length, 0);
  check('re-ingest reports N duplicates', data(load2).duplicates.length, N);
  const queue = await req(B, 'GET', '/facebook-os/stream?seriesKey=city-spotlight&limit=500', undefined, MT);
  check('queue holds exactly N city posts', data(queue).length, N);

  /* 4. API rows == the pure generator's output. */
  let mismatches = 0;
  for (const row of created) {
    const exp = expectedByUrl.get(row.linkUrl);
    if (!exp || exp.title !== row.title || exp.copy !== row.copy || exp.statusNote !== row.statusNote) mismatches += 1;
  }
  check('API rows matching generator output (title+copy+visual spec)', N - mismatches, N);

  /* 5. Rotation: neighbouring city posts never repeat service+angle. */
  const cityPairs = expected
    .filter((p) => p.manifest.city !== 'Broward County')
    .map((p) => `${p.manifest.service}|${p.manifest.hook}`);
  let repeats = 0;
  for (let i = 1; i < cityPairs.length; i += 1) if (cityPairs[i] === cityPairs[i - 1]) repeats += 1;
  check('adjacent city posts repeating a service+angle pair', repeats, 0);
  const hookSet = new Set(expected.map((p) => p.manifest.hook));
  checkTrue('all 5 hook angles are used', hookSet.size === 5, [...hookSet].join(','));

  /* 6. Copy sweep. */
  const banned = [
    [/review/i, 'review language'], [/\bstars?\b/i, 'star language'], [/rating/i, 'rating language'],
    [/\brated\b/i, 'rated language'], [/guarantee/i, 'guarantee claim'], [/\bvent/i, 'vent mention'],
    [/\bfree\b/i, 'free claim'], [/certified/i, 'certification claim'], [/warrant/i, 'warranty claim'],
    [/same-day/i, 'same-day promise'], [/24\/7/, '24/7 claim'], [/%/, 'percentage claim'],
    [/#1/, '#1 claim'], [/\bbest\b/i, 'superlative'], [/\bcheapest\b/i, 'superlative'],
  ];
  let sweepFailures = [];
  for (const row of created) {
    if (row.copy.length > 1024) sweepFailures.push(`${row.linkUrl}: copy ${row.copy.length} chars > 1024`);
    for (const m of row.copy.matchAll(/\$(\d+(?:,\d{3})*)/g)) {
      if (!['99', '210', '150'].includes(m[1].replace(/,/g, ''))) sweepFailures.push(`${row.linkUrl}: non-rate-card amount $${m[1]}`);
    }
    for (const [re, label] of banned) {
      if (re.test(row.copy)) sweepFailures.push(`${row.linkUrl}: banned ${label}`);
    }
    if (!row.copy.includes(row.linkUrl)) sweepFailures.push(`${row.linkUrl}: copy missing its own page link`);
    if (!row.copy.includes('(844) 460-7038')) sweepFailures.push(`${row.linkUrl}: copy missing the phone`);
    if (row.linkUrl.includes('commercial') && (row.copy.includes('$99') || row.copy.includes('$210') || row.copy.includes('$150'))) {
      sweepFailures.push(`${row.linkUrl}: commercial post carrying residential prices`);
    }
  }
  check('copy sweep failures', sweepFailures.length, 0);
  if (sweepFailures.length) console.log(sweepFailures.slice(0, 10).join('\n'));

  /* 7. Visual spec on every record, and the kit rotates. */
  let specMissing = 0;
  const icons = new Set();
  const numbers = new Set();
  const shields = new Set();
  for (const row of created) {
    const note = row.statusNote || '';
    if (!note.startsWith('Visual spec:') || !note.includes('written-quote guarantee')) specMissing += 1;
    const icon = /^Visual spec: icon (icon-[a-z-]+)/.exec(note);
    const num = /· number (num-[a-z0-9-]+)/.exec(note);
    const shield = /· shield ([a-z-]+) \(/.exec(note);
    if (icon) icons.add(icon[1]);
    if (num) numbers.add(num[1]);
    if (shield) shields.add(shield[1]);
  }
  check('records missing a full visual spec', specMissing, 0);
  checkTrue('visual kit rotates ≥10 service icons', icons.size >= 10, [...icons].join(','));
  checkTrue('visual kit rotates ≥3 number elements', numbers.size >= 3, [...numbers].join(','));
  checkTrue('shield placement rotates (3 placements)', shields.size === 3, [...shields].join(','));

  /* 8. Drafts never leak; summary still answers. */
  const feed = await req(B, 'GET', '/facebook-os/feed');
  check('public feed → 200', feed.status, 200);
  check('public feed serves 0 (all city posts are drafts)', data(feed).posts.length, 0);
  const summary = await req(B, 'GET', '/facebook-os/summary', undefined, MT);
  check('summary → 200', summary.status, 200);
  checkTrue('summary draft count covers the city set', (data(summary).posts?.DRAFT || 0) >= N,
    JSON.stringify(data(summary).posts));
} finally {
  server.child.kill('SIGTERM');
  rmSync(preloadPath, { force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
