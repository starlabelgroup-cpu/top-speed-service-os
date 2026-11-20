// A5 + A6 drills (2026-11-20): Spanish-language Speedy + widened
// booking auto-match. A5: Speedy answers in Spanish when the customer
// writes Spanish — governance boundary replies, the knowledge
// fallback's own framing, and the AI system prompt all carry the
// language — WITHOUT breaking the summary-confirm gate (extraction
// over a Spanish transcript still yields the structured fields the
// client's confirm card renders) or the English paths. A6: every one
// of the 65 PUBLISHED cities auto-matches (IN_AREA) instead of
// landing in the setter AREA_REVIEW queue; AREA_REVIEW stays the
// fallback for ambiguous core ZIPs and out-of-area cities.
//
// LOCAL ONLY: throwaway database on the drill cluster (run-suite.sh),
// a stub OpenAI Responses server — never the real provider, never
// production data.
//
//   bash ~/workspace/wave3-sites/run-suite.sh tsos_spanish_areas speedy-spanish-areas.test.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import {
  PUBLISHED_CITIES,
  PUBLISHED_CITY_NAMES,
  effectiveArea,
  effectiveAreaStatus,
  normalizePublishedCityName,
  resolveArea,
  SERVICE_AREAS,
} from '../src/config/serviceAreas.js';
import {
  augmentSpanishQuery,
  detectSpanish,
  resolveChatLanguage,
} from '../src/services/speedyLanguage.js';
import { classifySpeedyMessage, governanceGate } from '../src/services/speedyPolicy.js';
import { composeFallbackAnswer } from '../src/knowledge/index.js';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';

const PORT_A = 5691; // provider NOT configured → knowledge fallback
const PORT_B = 5692; // stub provider configured → AI path
const STUB_PORT = 5694;
const PASSWORD = 'SpanishAreas!Drill1';
const STAFF_ID = '5a1e5a00-0000-4000-8000-0000000000a5';
const STAFF_EMAIL = 'spanish-areas-staff@test.local';
const prisma = new PrismaClient();
const servers = [];

let passed = 0;
let failed = 0;
const failures = [];
function check(name, actual, expected) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function checkTrue(name, value) {
  if (value) { passed += 1; return; }
  failed += 1;
  failures.push(`${name}: expected truthy, got ${JSON.stringify(value)}`);
}
async function api(base, path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}

/* ── Part 1: the matcher (A6) ─────────────────────────────────── */
function unitMatcher() {
  check('published list has exactly 65 cities', PUBLISHED_CITIES.length, 65);
  check('Broward publishes 31', PUBLISHED_CITIES.filter((c) => c.county === 'Broward').length, 31);
  check('Palm Beach publishes 16', PUBLISHED_CITIES.filter((c) => c.county === 'Palm Beach').length, 16);
  check('Miami-Dade publishes 18', PUBLISHED_CITIES.filter((c) => c.county === 'Miami-Dade').length, 18);
  check('the original 12 core areas are untouched', SERVICE_AREAS.length, 12);

  // EVERY published city auto-matches by name — the core A6 drill.
  let allInArea = 0;
  for (const city of PUBLISHED_CITY_NAMES) {
    const r = resolveArea({ city, zip: '00000' });
    if (r.areaStatus === 'IN_AREA' && r.area === city) allInArea += 1;
    else failures.push(`city ${city}: expected IN_AREA/${city}, got ${r.areaStatus}/${r.area}`);
  }
  check('all 65 published cities auto-match IN_AREA', allInArea, 65);

  // Case/whitespace variants canonicalize to the published name.
  check('lowercase city canonicalizes', resolveArea({ city: 'hollywood' }).area, 'Hollywood');
  check('uppercase multiword canonicalizes', resolveArea({ city: 'WEST PALM BEACH' }).area, 'West Palm Beach');
  check('normalize trims', normalizePublishedCityName('  Miami  '), 'Miami');
  check('normalize rejects non-published', normalizePublishedCityName('Orlando'), null);

  // Core-12 behavior unchanged.
  const core = resolveArea({ city: 'Fort Lauderdale', zip: '33301' });
  check('core city + its own ZIP stays IN_AREA', core.areaStatus, 'IN_AREA');
  check('core city + its own ZIP has no mismatch', core.zipMismatch, false);
  const zipOnly = resolveArea({ zip: '33301' });
  check('unique core ZIP still resolves by ZIP', zipOnly.area, 'Fort Lauderdale');
  check('unique core ZIP source stays ZIP', zipOnly.areaSource, 'ZIP');
  const ambiguous = resolveArea({ zip: '33313' });
  check('shared core ZIP with no city stays AREA_REVIEW', ambiguous.areaStatus, 'AREA_REVIEW');

  // The fallbacks A6 must keep.
  check('non-covered city + no ZIP is OUT_OF_AREA', resolveArea({ city: 'Orlando', zip: '32801' }).areaStatus, 'OUT_OF_AREA');
  check('non-covered city + ambiguous core ZIP still AREA_REVIEWs', resolveArea({ city: 'Orlando', zip: '33313' }).areaStatus, 'AREA_REVIEW');
  check('published city outside the core keeps zipMismatch signal', resolveArea({ city: 'Hollywood', zip: '33301' }).zipMismatch, true);
  check('published city + neutral ZIP has no mismatch', resolveArea({ city: 'Miami', zip: '33101' }).zipMismatch, false);

  // Stored-record read path widens with the matcher.
  check('effectiveArea reads a published city', effectiveArea({ city: 'Boca Raton' }), 'Boca Raton');
  check('effectiveAreaStatus for a published city', effectiveAreaStatus({ city: 'Boca Raton' }), 'IN_AREA');
  check('stored area still wins over city', effectiveArea({ area: 'Davie', city: 'Hollywood' }), 'Davie');
  check('effectiveAreaStatus for a non-covered city', effectiveAreaStatus({ city: 'Orlando' }), 'OUT_OF_AREA');
}

/* ── Part 2: language detection + governance + fallback (A5) ──── */
function unitLanguage() {
  checkTrue('detects Spanish (diacritic)', detectSpanish('Hola, mi refrigerador no enfría'));
  checkTrue('detects Spanish (function words)', detectSpanish('Quiero reservar una cita para mi lavadora'));
  checkTrue('detects Spanish (symptom report)', detectSpanish('Mi nevera no enfría y hace un ruido raro'));
  check('English is not Spanish', detectSpanish('Hello, my refrigerator is not cooling'), false);
  check('a bare ZIP is not Spanish', detectSpanish('33313'), false);
  check('an English booking line is not Spanish', detectSpanish('I need my washer fixed in Hollywood'), false);

  check('explicit hint wins', resolveChatLanguage({ message: 'Hello', language: 'es' }), 'es');
  check('Spanish message resolves es', resolveChatLanguage({ message: 'Necesito ayuda con mi horno' }), 'es');
  check('English message resolves en', resolveChatLanguage({ message: 'I need help with my oven' }), 'en');
  check('short continuation inherits Spanish', resolveChatLanguage({
    message: '33019',
    history: [{ role: 'user', content: 'Hola, vivo en Hollywood y mi lavadora no funciona' }],
  }), 'es');
  check('clear English switches back', resolveChatLanguage({
    message: 'Actually, please switch to English for the details',
    history: [{ role: 'user', content: 'Hola, necesito ayuda con mi lavadora' }],
  }), 'en');

  const augmented = augmentSpanishQuery('¿Cuánto cuesta el diagnóstico?');
  checkTrue('augmentation adds retrieval terms', augmented.includes('diagnostic') && augmented.includes('how much'));
  check('augmentation leaves English alone', augmentSpanishQuery('How much is the diagnostic?'), 'How much is the diagnostic?');

  // Governance pre-screen speaks Spanish back.
  check('Spanish gas smell classifies SAFETY_CRITICAL', classifySpeedyMessage('Mi cocina huele a gas'), 'SAFETY_CRITICAL');
  check('Spanish refund classifies REFUND_REQUEST', classifySpeedyMessage('Quiero un reembolso por el servicio'), 'REFUND_REQUEST');
  check('English gas smell still classifies', classifySpeedyMessage('I smell gas in the kitchen'), 'SAFETY_CRITICAL');
  check('English refund still classifies', classifySpeedyMessage('I want a refund'), 'REFUND_REQUEST');
  check('plain Spanish service ask is not a boundary case', classifySpeedyMessage('Mi refrigerador no enfría'), null);
  const gate = governanceGate('Mi cocina huele a gas');
  check('Spanish safety gate category', gate?.governance, 'SAFETY_CRITICAL');
  checkTrue('Spanish safety reply is in Spanish', String(gate?.reply || '').includes('Eso suena peligroso'));
  const refundGate = governanceGate('Quiero un reembolso');
  checkTrue('Spanish refund reply is in Spanish', String(refundGate?.reply || '').includes('los reembolsos los decide una persona'));

  // Knowledge fallback: Spanish framing, English behavior unchanged.
  const greetEs = composeFallbackAnswer('Hola');
  checkTrue('fallback greets in Spanish', greetEs.reply.startsWith('Hola, soy Speedy'));
  const thanksEs = composeFallbackAnswer('Muchas gracias');
  checkTrue('fallback thanks in Spanish', thanksEs.reply.startsWith('De nada'));
  const greetEn = composeFallbackAnswer('Hello');
  checkTrue('fallback still greets in English', greetEn.reply.startsWith('Hi, I\'m Speedy'));
  const priceEs = composeFallbackAnswer('¿Cuánto cuesta el diagnóstico?');
  check('Spanish pricing question still grounds a match', priceEs.kind, 'match');
  checkTrue('Spanish match is framed in Spanish', priceEs.reply.includes('Esto es lo que puedo confirmarte'));
  checkTrue('Spanish match carries the grounded $99 fact', priceEs.reply.includes('$99'));
  checkTrue('Spanish match ends with the Spanish next step', priceEs.reply.includes('Si quieres seguir adelante'));
  const priceEn = composeFallbackAnswer('How much is the diagnostic?');
  check('English pricing question still matches', priceEn.kind, 'match');
  checkTrue('English match framing unchanged', priceEn.reply.includes('If you\'d like to move forward'));
  const generalEs = composeFallbackAnswer('¿Tienen servicio de plomería para casas?');
  check('unmatched Spanish question stays a general answer', generalEs.kind, 'general');
  checkTrue('Spanish general answer is in Spanish', generalEs.reply.includes('Buena pregunta'));
  checkTrue('Spanish general answer keeps the book/call path', generalEs.reply.includes('(844) 460-7038'));
}

/* ── HTTP harness ─────────────────────────────────────────────── */
async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'test-spanish-areas', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  await prisma.user.upsert({
    where: { id: STAFF_ID },
    update: { passwordHash },
    create: {
      id: STAFF_ID, companyId: PLATFORM_COMPANY_ID, email: STAFF_EMAIL, passwordHash,
      phone: '9545550198', roles: ['COMPANY_ADMIN'], active: true,
    },
  });
}

async function boot(port, extraEnv) {
  const env = { ...process.env, PORT: String(port), JWT_SECRET: 'spanish-areas-test-secret', ...extraEnv };
  if (!extraEnv || !('OPENAI_API_KEY' in extraEnv)) delete env.OPENAI_API_KEY;
  if (!extraEnv || !('OPENAI_API_KEY_V2' in extraEnv)) delete env.OPENAI_API_KEY_V2;
  if (!extraEnv || !('OPENAI_API_BASE' in extraEnv)) delete env.OPENAI_API_BASE;
  const child = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[api:${port}] ${d}`));
  servers.push(child);
  const base = `http://127.0.0.1:${port}/api/v1`;
  for (let i = 0; i < 240; i += 1) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return base;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server on ${port} did not come up`);
}

const stubRequests = [];
function startStub() {
  const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* keep empty */ }
      stubRequests.push(body);
      const formatName = body?.text?.format?.name || '';
      let out;
      if (formatName === 'speedy_booking_extract') {
        out = {
          output_text: JSON.stringify({
            name: 'María González',
            phone: '9545550147',
            city: 'Hollywood',
            zip: '33019',
            appliance: 'Refrigerator',
            issue: 'Refrigerator not cooling',
            preferred_window: null,
            ready: true,
            missing: [],
          }),
          model: 'gpt-4o-mini-stub',
        };
      } else {
        out = { output_text: 'Claro — con gusto te ayudo con eso.', model: 'gpt-4o-mini-stub' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', () => resolve(stub)));
}

const BOOKING = {
  customer: { name: 'Drill Customer', phone: '9545550147' },
  appliance: 'Refrigerator',
  issue: 'Not cooling',
  preferredWindow: '08-10',
  source: 'WEB_FORM',
};

async function main() {
  // Seed first: the governance unit checks escalate into the
  // notification outbox, which needs the platform company row.
  await seed();
  unitMatcher();
  unitLanguage();
  const stub = await startStub();

  /* Server A: no provider → fallback + governance over HTTP */
  const baseA = await boot(PORT_A, {});

  const status = await api(baseA, '/speedy/status');
  check('status is ok', status.status, 200);
  checkTrue('status advertises Spanish', Array.isArray(status.json?.data?.languages) && status.json.data.languages.includes('es'));
  check('knowledge base size unchanged', status.json?.data?.knowledge?.total, 126);

  const fbEs = await api(baseA, '/speedy/chat', { method: 'POST', body: { message: '¿Cuánto cuesta el diagnóstico?' } });
  check('fallback chat answers', fbEs.status, 200);
  check('fallback chat is the knowledge fallback', fbEs.json?.data?.answeredBy, 'knowledge-fallback');
  checkTrue('fallback chat reply is framed in Spanish', String(fbEs.json?.data?.reply || '').includes('Esto es lo que puedo confirmarte'));

  const fbEn = await api(baseA, '/speedy/chat', { method: 'POST', body: { message: 'How much is the diagnostic?' } });
  checkTrue('fallback English reply unchanged', String(fbEn.json?.data?.reply || '').includes('If you\'d like to move forward'));

  const govEs = await api(baseA, '/speedy/chat', { method: 'POST', body: { message: 'Mi cocina huele a gas, ¿qué hago?' } });
  check('Spanish safety chat is gated', govEs.json?.data?.governance, 'SAFETY_CRITICAL');
  checkTrue('Spanish safety reply over HTTP is Spanish', String(govEs.json?.data?.reply || '').includes('Eso suena peligroso'));

  /* A6 over HTTP: one booking per county + the fallbacks */
  const hollywood = await api(baseA, '/speedy/book', { method: 'POST', body: { ...BOOKING, city: 'Hollywood', zip: '33019' } });
  check('Hollywood booking created', hollywood.status, 201);
  check('Hollywood auto-matches IN_AREA', hollywood.json?.data?.areaStatus, 'IN_AREA');
  check('Hollywood area is the city', hollywood.json?.data?.area, 'Hollywood');
  check('Hollywood booking carries no review message', hollywood.json?.data?.areaMessage ?? null, null);

  const boca = await api(baseA, '/speedy/book', { method: 'POST', body: { ...BOOKING, city: 'Boca Raton', zip: '33431' } });
  check('Boca Raton auto-matches IN_AREA', boca.json?.data?.areaStatus, 'IN_AREA');
  const miami = await api(baseA, '/speedy/book', { method: 'POST', body: { ...BOOKING, city: 'Miami', zip: '33132' } });
  check('Miami auto-matches IN_AREA', miami.json?.data?.areaStatus, 'IN_AREA');

  const orlando = await api(baseA, '/speedy/book', { method: 'POST', body: { ...BOOKING, city: 'Orlando', zip: '32801' } });
  check('Orlando stays OUT_OF_AREA', orlando.json?.data?.areaStatus, 'OUT_OF_AREA');
  checkTrue('Orlando carries the out-of-area message', String(orlando.json?.data?.areaMessage || '').includes('outside our current service area'));

  const review = await api(baseA, '/speedy/book', { method: 'POST', body: { ...BOOKING, city: 'Orlando', zip: '33313' } });
  check('non-covered city + shared core ZIP stays AREA_REVIEW', review.json?.data?.areaStatus, 'AREA_REVIEW');
  checkTrue('AREA_REVIEW carries the setter-confirm message', String(review.json?.data?.areaMessage || '').includes('confirm the exact service area'));

  /* Book OS: the widened gates */
  const loginRes = await api(baseA, '/auth/login', { method: 'POST', body: { email: STAFF_EMAIL, password: PASSWORD } });
  check('staff login works', loginRes.status, 200);
  const staffToken = loginRes.json?.token;

  const areaDay = await api(baseA, '/bookos/area-day?date=2026-11-21&area=Hollywood', { token: staffToken });
  check('Book OS area-day accepts a published city', areaDay.status, 200);
  check('area-day lists the Hollywood booking as unappointed', areaDay.json?.data?.unappointed?.length, 1);
  check('area-day unappointed row is the Hollywood booking', areaDay.json?.data?.unappointed?.[0]?.referenceCode, hollywood.json?.data?.referenceCode);
  const areaDayBad = await api(baseA, '/bookos/area-day?date=2026-11-21&area=Orlando', { token: staffToken });
  check('Book OS area-day still rejects a non-covered city', areaDayBad.status, 422);

  const reviewRow = await prisma.serviceRequest.findFirst({ where: { referenceCode: review.json?.data?.referenceCode } });
  checkTrue('AREA_REVIEW booking persisted', Boolean(reviewRow));
  const resolved = await api(baseA, `/bookos/bookings/${reviewRow.id}/resolve-area`, {
    token: staffToken, method: 'POST', body: { area: 'Weston', resolvedBy: 'Setter Drill' },
  });
  check('setter can resolve review booking to a published city', resolved.status, 200);
  check('resolved booking area is Weston', resolved.json?.data?.area, 'Weston');
  check('resolved booking is IN_AREA', resolved.json?.data?.areaStatus, 'IN_AREA');
  const resolveBad = await api(baseA, `/bookos/bookings/${reviewRow.id}/resolve-area`, {
    token: staffToken, method: 'POST', body: { area: 'Orlando', resolvedBy: 'Setter Drill' },
  });
  check('resolve-area still rejects a non-covered city', resolveBad.status, 422);

  /* Server B: stub provider → AI path + the summary gate */
  const baseB = await boot(PORT_B, { OPENAI_API_KEY: 'stub-key', OPENAI_API_BASE: `http://127.0.0.1:${STUB_PORT}` });

  const before = stubRequests.length;
  const chatEs = await api(baseB, '/speedy/chat', { method: 'POST', body: { message: 'Hola, mi refrigerador no enfría y quiero reservar una cita' } });
  check('AI chat answers', chatEs.status, 200);
  check('AI chat is provider-answered', chatEs.json?.data?.answeredBy, 'ai');
  check('AI Spanish reply passes through', chatEs.json?.data?.reply, 'Claro — con gusto te ayudo con eso.');
  const esRequest = stubRequests.slice(before).find((r) => typeof r.instructions === 'string');
  checkTrue('AI request carries the Spanish directive', String(esRequest?.instructions || '').includes('LANGUAGE — SPANISH'));
  checkTrue('Spanish directive preserves the summary gate', String(esRequest?.instructions || '').includes('confirms the summary before anything is sent to the office'));

  const beforeEn = stubRequests.length;
  const chatEn = await api(baseB, '/speedy/chat', { method: 'POST', body: { message: 'Hello, my refrigerator is not cooling and I want to book a visit' } });
  check('AI English chat answers', chatEn.status, 200);
  const enRequest = stubRequests.slice(beforeEn).find((r) => typeof r.instructions === 'string');
  checkTrue('English request carries NO Spanish directive', !String(enRequest?.instructions || '').includes('LANGUAGE — SPANISH'));

  const beforeHint = stubRequests.length;
  await api(baseB, '/speedy/chat', { method: 'POST', body: { message: 'Hello, I need help', language: 'es' } });
  const hintRequest = stubRequests.slice(beforeHint).find((r) => typeof r.instructions === 'string');
  checkTrue('explicit es hint applies the directive', String(hintRequest?.instructions || '').includes('LANGUAGE — SPANISH'));

  // The summary gate over a Spanish transcript: extraction yields the
  // structured fields; the confirm-step booking then lands IN_AREA.
  const transcript =
    'Cliente: Hola, soy María González, mi número es 954-555-0147. Vivo en Hollywood, código postal 33019. Mi refrigerador no enfría desde ayer. Asistente: Perfecto, te muestro el resumen para confirmar.';
  const extract = await api(baseB, '/speedy/extract-booking', { method: 'POST', body: { text: transcript } });
  check('Spanish transcript extraction answers', extract.status, 200);
  check('extraction is ready', extract.json?.data?.ready, true);
  check('extraction kept the name exactly', extract.json?.data?.name, 'María González');
  check('extraction normalized the appliance', extract.json?.data?.appliance, 'Refrigerator');
  const extractRequest = stubRequests.find((r) => r?.text?.format?.name === 'speedy_booking_extract');
  checkTrue('extraction instructions cover Spanish transcripts', String(extractRequest?.instructions || '').includes('may be in Spanish'));

  const gated = await api(baseB, '/speedy/book', {
    method: 'POST',
    body: { ...BOOKING, customer: { name: 'María González', phone: '9545550147' }, city: 'Hollywood', zip: '33019', source: 'SPEEDY_CHAT' },
  });
  check('post-confirm booking is created', gated.status, 201);
  check('post-confirm booking auto-matches IN_AREA', gated.json?.data?.areaStatus, 'IN_AREA');

  stub.close();
}

main()
  .catch((error) => {
    failed += 1;
    failures.push(`suite crashed: ${error.stack || error.message}`);
  })
  .finally(async () => {
    for (const child of servers) child.kill('SIGTERM');
    await prisma.$disconnect();
    console.log(`\nspanish-areas drills: ${passed} passed, ${failed} failed`);
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exit(failed ? 1 : 0);
  });
