/**
 * Recent-completed feed city display drills (2026-11-23, Step 1 audit
 * fix): the public "Just fixed" feed printed a stored free-text city
 * verbatim, so one real completed job stored as "lauderrhill" showed
 * its typo on the homepage. There is no API route that edits a
 * booking's stored city after creation (the setter resolve-area route
 * sets the resolved AREA, not the city text), so the cure at the feed
 * layer is services/cityDisplay.js: display-only normalization —
 * clean title case, canonical spelling when the stored value clearly
 * matches a canonical city (exact, spacing/punctuation-insensitive,
 * or a small unique typo), and an unchanged title-cased render when
 * nothing clearly matches. The stored record is never rewritten.
 *
 * Drills run in SKELETON MODE (no DATABASE_URL — this VM has no
 * postgres user):
 *  1. Unit: the misspelling, case variants and spacing variants land
 *     on the canonical spelling; a non-matching city renders
 *     title-cased and otherwise unchanged.
 *  2. HTTP: GET /bookings/recent-completed over seeded fixture jobs —
 *     the misspelled-city job shows "Lauderhill", the non-matching
 *     city job still shows (real jobs are never hidden), and
 *     non-completed / undated jobs stay out of the feed.
 *
 * Usage: node test/recent-completed-city.test.mjs
 * (Skeleton mode: DATABASE_URL must NOT be set. TEST_PORT defaults
 * to 4627.) Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { displayCity } from '../src/services/cityDisplay.js';

if (process.env.DATABASE_URL) {
  console.error('DATABASE_URL is set — this harness runs in skeleton mode only. Unset it and re-run.');
  process.exit(2);
}

const PORT = Number(process.env.TEST_PORT || 4627);
const B = `http://127.0.0.1:${PORT}/api/v1`;
const JWT = ['city', 'drill', 'jwt', 'secret'].join('-');

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

/* 1. Unit drills on the normalizer itself. */
check('unit: stored typo lauderrhill → Lauderhill', displayCity('lauderrhill'), 'Lauderhill');
check('unit: canonical spelling unchanged', displayCity('Lauderhill'), 'Lauderhill');
check('unit: upper case → canonical', displayCity('LAUDERHILL'), 'Lauderhill');
check('unit: lower-case words → canonical', displayCity('fort lauderdale'), 'Fort Lauderdale');
check('unit: hyphenated canonical unchanged', displayCity('Lauderdale-by-the-Sea'), 'Lauderdale-by-the-Sea');
check('unit: one-edit typo plantaton → Plantation', displayCity('plantaton'), 'Plantation');
check('unit: one-edit typo Miami Bech → Miami Beach', displayCity('Miami Bech'), 'Miami Beach');
check('unit: exact canonical unchanged', displayCity('Boca Raton'), 'Boca Raton');
check('unit: non-matching city renders unchanged', displayCity('Springfield'), 'Springfield');
check('unit: non-matching words title-cased only', displayCity('some small town'), 'Some Small Town');
check('unit: empty stays empty', displayCity(''), '');
check('unit: null stays null', displayCity(null), null);

/* 2. HTTP drills over the public feed with fixture jobs. */
const FIXTURES = [
  { id: 'citydrill-b1', status: 'COMPLETED', completedAt: '2026-11-20T22:39:42.727Z', city: 'lauderrhill', appliance: 'Dishwasher' },
  { id: 'citydrill-b2', status: 'COMPLETED', completedAt: '2026-11-20T22:40:07.560Z', city: 'Lauderhill', appliance: 'Dryer' },
  { id: 'citydrill-b3', status: 'COMPLETED', completedAt: '2026-11-19T15:00:00.000Z', city: 'Springfield', appliance: 'Washer' },
  { id: 'citydrill-b4', status: 'PENDING_DISPATCH', completedAt: null, city: 'lauderrhill', appliance: 'Refrigerator' },
  { id: 'citydrill-b5', status: 'COMPLETED', completedAt: null, city: 'lauderrhill', appliance: 'Oven / Range' },
];

const preloadPath = fileURLToPath(new URL('./.citydrill-preload.mjs', import.meta.url));
writeFileSync(preloadPath, `
import { store } from '../src/data/store.js';
for (const b of ${JSON.stringify(FIXTURES)}) store.bookings.set(b.id, b);
`);

const child = spawn(process.execPath, ['--import', preloadPath, 'src/server.js'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, PORT: String(PORT), JWT_SECRET: JWT, ALLOW_DEMO_AUTH: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (d) => { childLog += d; });
child.stderr.on('data', (d) => { childLog += d; });

async function waitForHealth(tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await fetch(B + '/health'); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

try {
  checkTrue('BOOT: API boots and /health answers', await waitForHealth(), childLog.slice(-400));
  const r = await fetch(B + '/bookings/recent-completed');
  check('feed read → 200', r.status, 200);
  const j = await r.json();
  const jobs = Array.isArray(j.data) ? j.data : [];
  check('feed holds exactly the 3 completed+dated jobs', jobs.length, 3);
  check('newest job first (Dryer)', jobs[0] && jobs[0].appliance, 'Dryer');
  check('misspelled-city job renders Lauderhill', jobs[1] && jobs[1].city, 'Lauderhill');
  check('misspelled-city job is the Dishwasher', jobs[1] && jobs[1].appliance, 'Dishwasher');
  check('non-matching city job still shows, unchanged', jobs[2] && jobs[2].city, 'Springfield');
  checkTrue('no raw typo anywhere in the feed', !JSON.stringify(jobs).includes('lauderrhill'), JSON.stringify(jobs));
} finally {
  child.kill('SIGTERM');
  rmSync(preloadPath, { force: true });
}

console.log(`\nrecent-completed-city: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
