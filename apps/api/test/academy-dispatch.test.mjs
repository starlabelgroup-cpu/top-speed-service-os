/**
 * Academy certifications → dispatch matching (D12, 2026-11-20).
 *
 * Proves, against a real migrated database and the real HTTP
 * surface:
 *  - a trainee records module completions through POST
 *    /academy/completions — the module must exist in the LIVE
 *    curriculum (bogus slug 404s), recording is idempotent, and
 *    customers / anonymous callers are refused;
 *  - a track CERTIFIES only when every live-curriculum module in
 *    it is complete, and the certification surfaces on the
 *    provider profile (GET /provider/profile) and /provider/me;
 *  - the dispatch assignment suggestions WEIGH certifications:
 *    a Technician-Track-certified provider outranks an otherwise
 *    identical uncertified provider on a Refrigerator job by the
 *    track points + the sealed-system specialty points (+
 *    Foundation points), and on a Washer job by the track points
 *    alone — eligibility (base ≥ 65) is unchanged;
 *  - suggestions stay a read: no assignment is created.
 *
 * Requires DATABASE_URL (a migrated test database). Run:
 *   DATABASE_URL=postgresql://… node test/academy-dispatch.test.mjs
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID } from '../src/data/store.js';
import { persistAssignment, persistBooking, persistCustomer } from '../src/db/bookingsRepo.js';

const PORT = Number(process.env.TEST_PORT || 4721);
const JWT_SECRET = 'academy-dispatch-test-secret';
const PASSWORD = 'Academy!2345';
const prisma = new PrismaClient();

const IDS = {
  certCo: 'a1000000-0000-4000-8000-000000000001',
  plainCo: 'a1000000-0000-4000-8000-000000000002',
  provCert: 'a1000000-0000-4000-8000-000000000011',
  provPlain: 'a1000000-0000-4000-8000-000000000012',
  staff: 'a1000000-0000-4000-8000-000000000021',
  techCert: 'a1000000-0000-4000-8000-000000000022',
  techPlain: 'a1000000-0000-4000-8000-000000000023',
  custUser: 'a1000000-0000-4000-8000-000000000024',
  customer: 'a1000000-0000-4000-8000-000000000031',
};
const B = {
  fridge: 'a1000000-0000-4000-8000-000000000041',
  washer: 'a1000000-0000-4000-8000-000000000042',
};

const CUSTOMER = {
  id: IDS.customer, companyId: PLATFORM_COMPANY_ID, userId: null,
  name: 'Academy Test Customer', phone: '9545550141', email: 'academy-customer@test.local',
  address: '1 Test Way', city: 'Fort Lauderdale', zip: '33311', createdAt: new Date().toISOString(),
};

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok' : '  FAIL'} ${name}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function checkTrue(name, value, detail = '') {
  if (!value) failures += 1;
  console.log(`${value ? '  ok' : '  FAIL'} ${name}${value ? '' : ` — ${detail}`}`);
}

async function api(base, path, { method = 'GET', token, body } = {}) {
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

function mintToken(userId, companyId, email, roles) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId, companyId, email, roles,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function spawnServer(port) {
  const env = { ...process.env, PORT: String(port), JWT_SECRET };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_API_KEY_V2;
  const server = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[api:${port}] ${d}`));
  return server;
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

function mkBooking(id, referenceCode, appliance) {
  const now = new Date().toISOString();
  return {
    id, companyId: PLATFORM_COMPANY_ID, customerId: CUSTOMER.id, customer: CUSTOMER,
    referenceCode, source: 'WEB_FORM', city: 'Fort Lauderdale', area: 'Fort Lauderdale', zip: '33311',
    appliance, issue: 'Not working', preferredWindow: null,
    diagnosticFee: 99, diagnosticFeeCreditedTowardRepair: true, feeStatus: 'COLLECTED_AT_BOOKING',
    status: 'PENDING_DISPATCH', areaStatus: 'IN_AREA', history: [], appointment: null, dispatch: null,
    createdAt: now, updatedAt: now,
  };
}

async function seed() {
  const passwordHash = await hashPassword(PASSWORD);
  await prisma.company.upsert({
    where: { id: PLATFORM_COMPANY_ID },
    update: {},
    create: { id: PLATFORM_COMPANY_ID, name: 'Top Speed Appliance', slug: 'academy-test-platform', type: 'PLATFORM_OWNER', isPlatformOwner: true },
  });
  for (const [id, name, slug] of [
    [IDS.certCo, 'Certified Cooling Co', 'academy-cert-co'],
    [IDS.plainCo, 'Plain Cooling Co', 'academy-plain-co'],
  ]) {
    await prisma.company.upsert({ where: { id }, update: {}, create: { id, name, slug, type: 'INDEPENDENT_PROVIDER' } });
  }
  // Two providers identical in every ranking input — specialty,
  // area, rating (none), load (none) — so the ONLY score difference
  // can come from Academy certifications.
  for (const [id, companyId, businessName] of [
    [IDS.provCert, IDS.certCo, 'Certified Cooling LLC'],
    [IDS.provPlain, IDS.plainCo, 'Plain Cooling LLC'],
  ]) {
    await prisma.provider.upsert({
      where: { id },
      update: { active: true, rating: null },
      create: {
        id, companyId, businessName, type: 'INDEPENDENT_PROVIDER',
        specialties: ['Refrigerator', 'Washer'], serviceCities: ['Fort Lauderdale'],
        rating: null, active: true,
      },
    });
  }
  const users = [
    { id: IDS.staff, companyId: PLATFORM_COMPANY_ID, email: 'academy-staff@test.local', roles: ['DISPATCHER'] },
    { id: IDS.techCert, companyId: IDS.certCo, email: 'academy-cert@test.local', roles: ['PROVIDER_OWNER'] },
    { id: IDS.techPlain, companyId: IDS.plainCo, email: 'academy-plain@test.local', roles: ['PROVIDER_OWNER'] },
    { id: IDS.custUser, companyId: PLATFORM_COMPANY_ID, email: 'academy-customer-user@test.local', roles: ['CUSTOMER'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash },
      create: { id: u.id, companyId: u.companyId, email: u.email, passwordHash, phone: '9545550140', roles: u.roles, active: true },
    });
  }
  await persistCustomer(CUSTOMER);
  await persistBooking(mkBooking(B.fridge, 'TS-ACAD01', 'Refrigerator'));
  await persistBooking(mkBooking(B.washer, 'TS-ACAD02', 'Washer'));
}

async function cleanup() {
  try {
    await prisma.academyCompletion.deleteMany({ where: { userId: { in: [IDS.techCert, IDS.techPlain] } } });
    await prisma.dispatchAssignment.deleteMany({ where: { serviceRequestId: { in: Object.values(B) } } });
    await prisma.serviceRequest.deleteMany({ where: { id: { in: Object.values(B) } } });
    await prisma.customer.deleteMany({ where: { id: IDS.customer } });
    await prisma.user.deleteMany({ where: { id: { in: [IDS.staff, IDS.techCert, IDS.techPlain, IDS.custUser] } } });
    await prisma.provider.deleteMany({ where: { id: { in: [IDS.provCert, IDS.provPlain] } } });
    await prisma.company.deleteMany({ where: { id: { in: [IDS.certCo, IDS.plainCo] } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await cleanup();
  await seed();
  const base = `http://127.0.0.1:${PORT}/api/v1`;
  const server = spawnServer(PORT);
  try {
    await waitForServer(base);
    const staff = mintToken(IDS.staff, PLATFORM_COMPANY_ID, 'academy-staff@test.local', ['DISPATCHER']);
    const techCert = mintToken(IDS.techCert, IDS.certCo, 'academy-cert@test.local', ['PROVIDER_OWNER']);
    const techPlain = mintToken(IDS.techPlain, IDS.plainCo, 'academy-plain@test.local', ['PROVIDER_OWNER']);
    const cust = mintToken(IDS.custUser, PLATFORM_COMPANY_ID, 'academy-customer-user@test.local', ['CUSTOMER']);

    // The live curriculum (flat list): Technician Track = modules
    // 12–15, Foundation Track = modules 1–3 (data/academyTracks.js).
    const curriculum = await api(base, '/academy/curriculum', { token: techCert });
    check('curriculum readable by a provider trainee', curriculum.status, 200);
    const items = curriculum.json?.data || [];
    const slugsInRange = (lo, hi) => items
      .filter((item) => {
        const n = Number(/training-module-(\d+)-/.exec(item.slug || '')?.[1]);
        return n >= lo && n <= hi;
      })
      .map((item) => item.slug);
    const techSlugs = slugsInRange(12, 15);
    const foundationSlugs = slugsInRange(1, 3);
    check('Technician Track carries 4 live modules', techSlugs.length, 4);
    check('Foundation Track carries 3 live modules', foundationSlugs.length, 3);

    // Gates.
    check('completion anonymous 401', (await api(base, '/academy/completions', { method: 'POST', body: { moduleSlug: techSlugs[0] } })).status, 401);
    check('completion customer 403', (await api(base, '/academy/completions', { method: 'POST', token: cust, body: { moduleSlug: techSlugs[0] } })).status, 403);
    check('completion bogus module 404', (await api(base, '/academy/completions', { method: 'POST', token: techCert, body: { moduleSlug: 'training-module-99-nope' } })).status, 404);

    // Record the full Technician + Foundation tracks for the cert tech.
    let firstStatus = null;
    for (const slug of [...techSlugs, ...foundationSlugs]) {
      const res = await api(base, '/academy/completions', { method: 'POST', token: techCert, body: { moduleSlug: slug } });
      if (firstStatus === null) firstStatus = res.status;
      checkTrue(`completion recorded for ${slug}`, res.status === 201, `got ${res.status}`);
    }
    check('first completion is a 201 create', firstStatus, 201);
    const again = await api(base, '/academy/completions', { method: 'POST', token: techCert, body: { moduleSlug: techSlugs[0] } });
    check('re-recording is idempotent (200)', again.status, 200);
    check('re-recording reports alreadyRecorded', again.json?.data?.alreadyRecorded, true);

    // Progress + certification derivation.
    const progress = await api(base, '/academy/progress', { token: techCert });
    check('progress completedCount', progress.json?.data?.completedCount, 7);
    const certNames = (progress.json?.data?.certifications || []).map((c) => c.track).sort();
    check('certified tracks are Foundation + Technician', certNames, ['Foundation', 'Technician Track']);
    const techTrack = (progress.json?.data?.tracks || []).find((t) => t.track === 'Technician Track');
    check('Technician Track certified flag', techTrack?.certified, true);
    checkTrue('Technician certification carries a certifiedAt', Boolean(techTrack?.certifiedAt));

    const plainProgress = await api(base, '/academy/progress', { token: techPlain });
    check('uncertified tech has no certifications', (plainProgress.json?.data?.certifications || []).length, 0);

    // Profile surfaces.
    const profile = await api(base, '/provider/profile', { token: techCert });
    check('profile academy completedCount', profile.json?.data?.academy?.completedCount, 7);
    check('profile academy certifications', (profile.json?.data?.academy?.certifications || []).length, 2);
    const me = await api(base, '/provider/me', { token: techCert });
    check('/provider/me certifications', (me.json?.data?.certifications || []).length, 2);
    const plainProfile = await api(base, '/provider/profile', { token: techPlain });
    check('uncertified profile shows no certifications', (plainProfile.json?.data?.academy?.certifications || []).length, 0);

    // Dispatch suggestions: Refrigerator job — certified provider
    // first, by exactly track 8 + specialty 6 + Foundation 2 = 16.
    const fridge = await api(base, `/bookos/bookings/${B.fridge}/assignment-suggestions`, { token: staff });
    check('suggestions readable by staff', fridge.status, 200);
    const candidates = fridge.json?.data?.candidates || [];
    const cert = candidates.find((c) => c.providerId === IDS.provCert);
    const plain = candidates.find((c) => c.providerId === IDS.provPlain);
    checkTrue('both providers are candidates', Boolean(cert && plain), JSON.stringify(candidates.map((c) => c.providerId)));
    check('certified provider ranks first', candidates[0]?.providerId, IDS.provCert);
    check('identical base scores', cert?.baseScore, plain?.baseScore);
    check('certification lift on a Refrigerator job is +16', (cert?.score ?? 0) - (plain?.score ?? 0), 16);
    checkTrue(
      'setter-readable certification reason present',
      (cert?.reasons || []).some((r) => r.label?.startsWith('Academy certified — Technician Track')),
      JSON.stringify(cert?.reasons),
    );
    checkTrue(
      'sealed-system specialty reason present on the Refrigerator job',
      (cert?.reasons || []).some((r) => r.label?.includes('sealed-system')),
      JSON.stringify(cert?.reasons),
    );
    check('candidate carries its certifications', (cert?.certifications || []).map((c) => c.track).sort(), ['Foundation', 'Technician Track']);
    check('eligibility unchanged by certifications (both eligible)', [cert?.eligible, plain?.eligible], [true, true]);

    // Washer job: track points only (+8 +2 = +10), no specialty bonus.
    const washer = await api(base, `/bookos/bookings/${B.washer}/assignment-suggestions`, { token: staff });
    const wCandidates = washer.json?.data?.candidates || [];
    const wCert = wCandidates.find((c) => c.providerId === IDS.provCert);
    const wPlain = wCandidates.find((c) => c.providerId === IDS.provPlain);
    check('certification lift on a Washer job is +10', (wCert?.score ?? 0) - (wPlain?.score ?? 0), 10);
    checkTrue(
      'no sealed-system specialty reason on a Washer job',
      !(wCert?.reasons || []).some((r) => r.label?.includes('sealed-system')),
      JSON.stringify(wCert?.reasons),
    );

    // Suggestions are a read — nothing was assigned.
    check('suggestions created no assignments', await prisma.dispatchAssignment.count({ where: { serviceRequestId: B.fridge } }), 0);
    check('completions persisted durably', await prisma.academyCompletion.count({ where: { userId: IDS.techCert } }), 7);
  } finally {
    server.kill('SIGTERM');
    await cleanup();
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
