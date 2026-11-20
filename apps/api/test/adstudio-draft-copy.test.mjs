/**
 * Ad Studio "Draft with Speedy" — blank-name regression harness
 * (2026-11-20 incident).
 *
 * Ramone, signed in as Owner, picked a creative in Ad Studio and
 * clicked "Draft with Speedy" WITHOUT setting a campaign name. The
 * builder sends its raw field values, so the request carried
 * `name: ""`. The draft-copy schema declares name OPTIONAL (the
 * draft is auto-named from the topic), but a present empty string
 * still had to satisfy min(3) — the click died with a bare
 * 400 "Invalid draft request" even though the draft was legitimate.
 *
 * This harness sends the EXACT payload the page builds in that
 * state (plus the neighbouring variants) against the real API with
 * a stubbed OpenAI Responses provider, and locks the contract:
 *   - blank / whitespace / absent name + an objective → a draft is
 *     created in the owner approval queue, auto-named from the topic;
 *   - blank name AND no objective → the handler's own friendly 400
 *     ("Give the draft a campaign name or an objective first"),
 *     never the bare "Invalid draft request";
 *   - genuinely invalid payloads (bad enum, empty destination, a
 *     provided-but-too-short name, streaming without providers)
 *     still 400;
 *   - the brand rules still filter the AI's lines (review claims
 *     and non-$99 prices dropped, the $99 residential line kept).
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=postgresql://… TEST_PORT=4437 node test/adstudio-draft-copy.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4437);
const STUB_PORT = PORT + 3;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';

const IDS = {
  owner: '30000000-0000-4000-8000-0000000000f1',
  customer: '30000000-0000-4000-8000-0000000000f2',
};
const EMAILS = { owner: 'owner@draftdrill.local', customer: 'customer@draftdrill.local' };

const prisma = new PrismaClient();
const servers = [];
let failures = 0;
const createdIds = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

function checkTrue(label, value) {
  check(label, Boolean(value), true);
}

async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
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
    { id: IDS.owner, email: EMAILS.owner, roles: ['COMPANY_OWNER'] },
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

async function cleanup() {
  try {
    if (createdIds.length) await prisma.adCampaign.deleteMany({ where: { id: { in: createdIds } } });
    await prisma.adCampaign.deleteMany({ where: { sourceTag: { startsWith: 'adstudio-bookings-for-refrigerator-repair' } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(IDS) } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

/* Stub OpenAI Responses provider: for the ad-copy format it returns
 * a banner draft whose lines deliberately include brand-rule
 * violations, so the drill can watch the server filter them:
 *  - headline carries a review claim      → dropped, fallback used
 *  - copy carries a non-$99 price         → dropped, fallback used
 *  - a $99 residential diagnostic line    → kept (first fallback)
 *  - a clean description                  → kept (copy fallback)   */
function startStub() {
  const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* keep empty */ }
      const formatName = body?.text?.format?.name || '';
      const payload = formatName === 'speedy_ad_copy_draft'
        ? {
            headlines: ['$99 Diagnostic, Credited Toward the Repair', 'Refrigerator Repair Done Right'],
            descriptions: ['Same-week repair windows across Broward County.'],
            longHeadline: null,
            headline: 'Rated 5 stars by happy neighbors',
            copy: 'Repairs from $150 flat — call today',
          }
        : null;
      const out = payload
        ? { output_text: JSON.stringify(payload), model: 'gpt-4o-mini-stub' }
        : { output_text: 'Plain stub read.', model: 'gpt-4o-mini-stub' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', () => resolve(stub)));
}

async function boot() {
  const env = { ...process.env, PORT: String(PORT), JWT_SECRET: 'draft-copy-drill-secret', OPENAI_API_KEY: 'stub-key', OPENAI_API_BASE: `http://127.0.0.1:${STUB_PORT}` };
  delete env.OPENAI_API_KEY_V2;
  const child = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  servers.push(child);
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('server did not come up');
}

const TOPIC = 'Bookings for refrigerator repair from the published city pages';
const DEST = 'https://topspeedserviceos.com/book';

async function main() {
  await cleanup();
  await seed();
  const stub = await startStub();
  await boot();

  const owner = await login(EMAILS.owner);
  const customer = await login(EMAILS.customer);

  /* ── Gates ─────────────────────────────────────────────────── */
  check('draft-copy unauthenticated is 401', (await api('/ad-studio/draft-copy', { method: 'POST', body: {} })).status, 401);
  check('draft-copy as a customer is 403', (await api('/ad-studio/draft-copy', { token: customer, method: 'POST', body: { name: '', businessLine: 'TOP_SPEED', placement: 'BANNER', destinationUrl: DEST, topic: TOPIC } })).status, 403);

  /* ── THE INCIDENT: the exact payload the builder sends when a
   * creative is selected and Draft with Speedy is clicked with the
   * campaign name field left blank. bName.value.trim() is "", the
   * objective supplies the topic, the destination is the staple
   * /book page, and the picked house image rides along as imageUrl
   * (not part of the draft schema — stripped server-side). ─────── */
  const incident = await api('/ad-studio/draft-copy', {
    token: owner, method: 'POST',
    body: {
      name: '',
      businessLine: 'TOP_SPEED',
      placement: 'BANNER',
      destinationUrl: DEST,
      imageUrl: '/api/v1/app/poster-images/banner-hero-web.jpg',
      topic: TOPIC,
    },
  });
  check('INCIDENT payload (blank name) creates the draft', incident.status, 201);
  check('incident draft waits in the owner queue', incident.json?.data?.status, 'PENDING_APPROVAL');
  check('incident draft is auto-named from the topic', incident.json?.data?.name, `${TOPIC} — Speedy draft`);
  if (incident.json?.data?.id) createdIds.push(incident.json.data.id);

  /* Brand rules still enforced on the AI's lines: the review-claim
   * headline and the $150 copy are dropped; the $99 diagnostic
   * headline and the clean description take their place. */
  check('review-claim headline dropped, $99 line kept', incident.json?.data?.headline, '$99 Diagnostic, Credited Toward the Repair');
  check('non-$99 price copy dropped, clean description kept', incident.json?.data?.copy, 'Same-week repair windows across Broward County.');

  /* The draft is really in the approval queue. */
  const queue = await api('/ad-studio/campaigns?status=PENDING_APPROVAL', { token: owner });
  checkTrue('auto-named draft is listed in the approval queue', (queue.json?.data || []).some((c) => c.id === incident.json?.data?.id));

  /* ── Neighbouring blank variants behave the same ───────────── */
  const whitespace = await api('/ad-studio/draft-copy', {
    token: owner, method: 'POST',
    body: { name: '   ', businessLine: 'TOP_SPEED', placement: 'BANNER', destinationUrl: DEST, topic: TOPIC },
  });
  check('whitespace-only name also counts as not given', whitespace.status, 201);
  if (whitespace.json?.data?.id) createdIds.push(whitespace.json.data.id);

  const named = await api('/ad-studio/draft-copy', {
    token: owner, method: 'POST',
    body: { name: 'Fall Fridge Push', businessLine: 'TOP_SPEED', placement: 'BANNER', destinationUrl: DEST },
  });
  check('a given name with no objective still drafts (topic = name)', named.status, 201);
  check('given name is kept on the draft', named.json?.data?.name, 'Fall Fridge Push');
  if (named.json?.data?.id) createdIds.push(named.json.data.id);

  /* ── Nothing to draft from: the handler's own friendly refusal,
   * never the bare schema error. ──────────────────────────────── */
  const nothing = await api('/ad-studio/draft-copy', {
    token: owner, method: 'POST',
    body: { name: '', businessLine: 'TOP_SPEED', placement: 'BANNER', destinationUrl: DEST },
  });
  check('blank name AND no objective is a 400', nothing.status, 400);
  checkTrue('that 400 is the friendly guidance', /Give the draft a campaign name or an objective first/.test(nothing.json?.error || ''));
  checkTrue('that 400 is NOT the bare Invalid draft request', nothing.json?.error !== 'Invalid draft request');

  /* ── Genuinely invalid payloads still 400 ──────────────────── */
  const shortName = await api('/ad-studio/draft-copy', {
    token: owner, method: 'POST',
    body: { name: 'ab', businessLine: 'TOP_SPEED', placement: 'BANNER', destinationUrl: DEST, topic: TOPIC },
  });
  check('a provided-but-too-short name still 400s', shortName.status, 400);
  const badLine = await api('/ad-studio/draft-copy', {
    token: owner, method: 'POST',
    body: { name: '', businessLine: 'BOGUS', placement: 'BANNER', destinationUrl: DEST, topic: TOPIC },
  });
  check('an unknown business line still 400s', badLine.status, 400);
  const noDest = await api('/ad-studio/draft-copy', {
    token: owner, method: 'POST',
    body: { name: '', businessLine: 'TOP_SPEED', placement: 'BANNER', destinationUrl: '', topic: TOPIC },
  });
  check('an empty destination still 400s', noDest.status, 400);
  const badStreaming = await api('/ad-studio/draft-copy', {
    token: owner, method: 'POST',
    body: { name: '', businessLine: 'TOP_SPEED', placement: 'STREAMING', streamingFormat: 'TEXT', destinationUrl: DEST, topic: TOPIC },
  });
  check('streaming without providers still 400s', badStreaming.status, 400);

  stub.close();
  for (const s of servers) s.kill('SIGTERM');
  await cleanup();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    for (const s of servers) s.kill('SIGTERM');
    await prisma.$disconnect();
  });
