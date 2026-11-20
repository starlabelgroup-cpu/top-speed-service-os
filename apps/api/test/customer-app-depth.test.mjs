/**
 * Customer app depth — verification harness (2026-11-20, B2+B3+B9).
 *
 * B2 Message the office: per-booking thread — the customer posts and
 * reads on their OWN booking only, staff see the thread inbox and
 * reply, unread counts move correctly on both sides, read marks
 * persist, the platform event carries NO message text, and the
 * thread survives a server restart (BookingMessage hydration).
 * B3 Garage care: purchase/warranty dates round-trip, the warranty
 * status math (ACTIVE / EXPIRING_SOON / EXPIRED / UNKNOWN) is right,
 * care edits are owner-only, the recall notice is staff-curated only
 * (a customer cannot set one), the staff recall-check returns the
 * CPSC feed contract (available flag + candidate shape) and writes
 * NOTHING to any customer record.
 * B9 Referral hub: the dashboard progress block is computed from the
 * owner-set program settings with the locked economics seeded
 * ($25 / tier2 $35 @5 / tier3 $50 @10 / milestones $100@10, $250@25 /
 * 365-day expiry) — next-reward rate, next-tier distance, milestone
 * reached flags, and the available-credit totals from real records.
 *
 * Runs against a LOCAL test database only. Usage:
 *   DATABASE_URL=... DATABASE_URL_UNPOOLED=... \
 *   node test/customer-app-depth.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/passwords.js';
import { PLATFORM_COMPANY_ID, store } from '../src/data/store.js';
import { persistBooking, persistCustomer } from '../src/db/bookingsRepo.js';
import { persistProgramSettings, persistReferralCredit, persistReferralJourney } from '../src/db/referralsRepo.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4491);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = 'test-pass-1234';
const JWT = ['wave2', 'drill', 'secret'].join('-');

const IDS = {
  staff: '30000000-0000-4000-8000-0000000000a1',
  custA: '30000000-0000-4000-8000-0000000000a2',
  custB: '30000000-0000-4000-8000-0000000000a3',
  custRecA: '30000000-0000-4000-8000-0000000000c1',
  custRecB: '30000000-0000-4000-8000-0000000000c2',
  bookingA: '30000000-0000-4000-8000-0000000000d1',
  bookingB: '30000000-0000-4000-8000-0000000000d2',
  referralA: '30000000-0000-4000-8000-0000000000e1',
  referralB: '30000000-0000-4000-8000-0000000000e2',
};

const prisma = new PrismaClient();
let server = null;
let failures = 0;
let passes = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) passes += 1; else failures += 1;
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
    { id: IDS.staff, companyId: PLATFORM_COMPANY_ID, email: 'staff@test.local', phone: '9545550100', roles: ['DISPATCHER'] },
    { id: IDS.custA, companyId: PLATFORM_COMPANY_ID, email: 'cust-a@test.local', phone: '9545550101', roles: ['CUSTOMER'] },
    { id: IDS.custB, companyId: PLATFORM_COMPANY_ID, email: 'cust-b@test.local', phone: '9545550102', roles: ['CUSTOMER'] },
  ];
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: { passwordHash, phone: u.phone, roles: u.roles },
      create: { ...u, passwordHash, active: true },
    });
  }

  const now = new Date().toISOString();
  const mkCustomer = (id, userId, name, phone, email) => ({
    id, companyId: PLATFORM_COMPANY_ID, userId, name, phone, email,
    city: 'Fort Lauderdale', zip: '33311', createdAt: now,
  });
  const custA = mkCustomer(IDS.custRecA, IDS.custA, 'Customer A', '9545550101', 'cust-a@test.local');
  const custB = mkCustomer(IDS.custRecB, IDS.custB, 'Customer B', '9545550102', 'cust-b@test.local');
  const mkBooking = (id, customer, ref, appliance) => ({
    id, companyId: PLATFORM_COMPANY_ID, customerId: customer.id, customer,
    referenceCode: ref, source: 'API', city: 'Fort Lauderdale', zip: '33311',
    appliance, issue: 'Not cooling', preferredWindow: null, diagnosticFee: 99,
    diagnosticFeeCurrency: 'USD', diagnosticFeeCreditedTowardRepair: true,
    feeStatus: 'collected_at_booking', status: 'CONFIRMED',
    dispatch: { mode: 'HYBRID', stage: 'QUEUED', candidateProviderIds: [], assignmentIds: [] },
    history: [], createdAt: now, updatedAt: now,
  });
  const bookingA = mkBooking(IDS.bookingA, custA, 'TS-W2A001', 'Refrigerator');
  const bookingB = mkBooking(IDS.bookingB, custB, 'TS-W2B001', 'Washer');
  for (const c of [custA, custB]) { store.customers.set(c.id, c); await persistCustomer(c); }
  for (const b of [bookingA, bookingB]) { store.bookings.set(b.id, b); await persistBooking(b); }

  // B9: locked program economics, as the owner set them.
  await persistProgramSettings({
    companyId: PLATFORM_COMPANY_ID,
    enabled: true,
    rewardAmountCents: 2500,
    tier2Threshold: 5,
    tier2AmountCents: 3500,
    tier3Threshold: 10,
    tier3AmountCents: 5000,
    milestoneBonuses: [
      { at: 10, amountCents: 10000 },
      { at: 25, amountCents: 25000 },
    ],
    monthlyCapPerReferrer: null,
    rewardExpiryDays: 365,
    updatedBy: 'drill',
  });

  const mkReferral = (id, code, customer) => prisma.referral.upsert({
    where: { id },
    update: {},
    create: {
      id, companyId: PLATFORM_COMPANY_ID, code, track: 'CUSTOMER',
      customerId: customer.id, customerName: customer.name, customerPhone: customer.phone,
      status: 'ACTIVE', redemptions: [], clickCount: 3,
    },
  });
  await mkReferral(IDS.referralA, 'W2TESTA', custA);
  await mkReferral(IDS.referralB, 'W2TESTB', custB);

  const future = new Date(Date.now() + 300 * 24 * 3600 * 1000).toISOString();
  const mkJourney = (n, referralId, code, referrerCustomerId, status) => persistReferralJourney({
    id: `30000000-0000-4000-8000-00000000f${referralId === IDS.referralA ? 'a' : 'b'}${String(n).padStart(2, '0')}`,
    companyId: PLATFORM_COMPANY_ID, referralId, code, referrerCustomerId,
    refereeName: `Friend ${n}`, refereePhone: null, refereeEmail: null,
    bookingId: null, bookingReference: null, track: 'CUSTOMER', status,
    rewardAmountCents: null, tierSnapshot: null,
    createdAt: now, updatedAt: now,
  });
  // Referrer A: 4 completed (credit-issued) + 1 invited.
  for (let n = 1; n <= 4; n += 1) await mkJourney(n, IDS.referralA, 'W2TESTA', IDS.custRecA, 'CREDIT_ISSUED');
  await mkJourney(9, IDS.referralA, 'W2TESTA', IDS.custRecA, 'INVITED');
  // Referrer B: 10 completed — top tier + first milestone reached.
  for (let n = 1; n <= 10; n += 1) await mkJourney(n, IDS.referralB, 'W2TESTB', IDS.custRecB, 'COMPLETED');

  const journeyIdA = (n) => `30000000-0000-4000-8000-00000000fa${String(n).padStart(2, '0')}`;
  await persistReferralCredit({
    id: '30000000-0000-4000-8000-00000000ca01', companyId: PLATFORM_COMPANY_ID,
    customerId: IDS.custRecA, journeyId: journeyIdA(1), amountCents: 2500, status: 'AVAILABLE',
    issuedBy: 'drill', expiresAt: future,
  });
  await persistReferralCredit({
    id: '30000000-0000-4000-8000-00000000ca02', companyId: PLATFORM_COMPANY_ID,
    customerId: IDS.custRecA, journeyId: journeyIdA(2), amountCents: 3500, status: 'AVAILABLE',
    issuedBy: 'drill', expiresAt: future,
  });
  await persistReferralCredit({
    id: '30000000-0000-4000-8000-00000000ca03', companyId: PLATFORM_COMPANY_ID,
    customerId: IDS.custRecA, journeyId: journeyIdA(3), amountCents: 2500, status: 'REDEEMED',
    issuedBy: 'drill', expiresAt: future,
  });
}

async function cleanup() {
  try {
    await prisma.bookingMessage.deleteMany({ where: { companyId: PLATFORM_COMPANY_ID } });
    await prisma.platformEvent.deleteMany({ where: { type: 'BOOKING_MESSAGE_POSTED' } });
    await prisma.referralCredit.deleteMany({ where: { companyId: PLATFORM_COMPANY_ID } });
    await prisma.referralJourney.deleteMany({ where: { companyId: PLATFORM_COMPANY_ID } });
    await prisma.referral.deleteMany({ where: { companyId: PLATFORM_COMPANY_ID } });
    await prisma.referralProgramSetting.deleteMany({ where: { companyId: PLATFORM_COMPANY_ID } });
    await prisma.customerAppliance.deleteMany({ where: { userId: { in: [IDS.custA, IDS.custB] } } });
    await prisma.serviceRequest.deleteMany({ where: { companyId: PLATFORM_COMPANY_ID } });
    await prisma.customer.deleteMany({ where: { companyId: PLATFORM_COMPANY_ID } });
    await prisma.user.deleteMany({ where: { id: { in: [IDS.staff, IDS.custA, IDS.custB] } } });
  } catch (error) {
    console.error('cleanup warning:', error.message);
  }
}

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('server did not come up');
}

function startServer() {
  const proc = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(PORT),
      JWT_SECRET: JWT,
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return proc;
}

async function main() {
  await seed();
  server = startServer();
  await waitForServer();

  const staffTok = await login('staff@test.local');
  const aTok = await login('cust-a@test.local');
  const bTok = await login('cust-b@test.local');

  /* ------------------------------ B2 ------------------------------ */
  const anon = await api(`/bookings/${IDS.bookingA}/messages`);
  check('B2 anon thread read is 401', anon.status, 401);

  const foreign = await api(`/bookings/${IDS.bookingA}/messages`, { token: bTok });
  check('B2 other customer thread read is 404', foreign.status, 404);

  const posted = await api(`/bookings/${IDS.bookingA}/messages`, {
    token: aTok, method: 'POST',
    body: { body: 'Hi — the fridge is on the porch side, gate code is in my booking notes. Thanks!' },
  });
  check('B2 customer posts to own thread', posted.status, 201);
  check('B2 posted senderKind is CUSTOMER', posted.json?.data?.senderKind, 'CUSTOMER');

  const emptyPost = await api(`/bookings/${IDS.bookingA}/messages`, { token: aTok, method: 'POST', body: { body: '   ' } });
  check('B2 empty message refused 400', emptyPost.status, 400);

  const foreignPost = await api(`/bookings/${IDS.bookingA}/messages`, { token: bTok, method: 'POST', body: { body: 'not my booking' } });
  check('B2 other customer post is 404', foreignPost.status, 404);

  let thread = await api(`/bookings/${IDS.bookingA}/messages`, { token: aTok });
  check('B2 customer reads own thread', thread.status, 200);
  check('B2 thread has 1 message', thread.json?.data?.messages?.length, 1);
  check('B2 own messages are not unread for me', thread.json?.data?.unreadForMe, 0);

  const inbox = await api('/office-messages/threads', { token: staffTok });
  check('B2 staff thread inbox 200', inbox.status, 200);
  const myThread = (inbox.json?.data?.threads || []).find((t) => t.bookingId === IDS.bookingA);
  checkTrue('B2 inbox lists the booking thread', myThread);
  check('B2 inbox unreadForStaff is 1', myThread?.unreadForStaff, 1);
  check('B2 inbox total unread >= 1', (inbox.json?.data?.unreadTotal || 0) >= 1, true);
  checkTrue('B2 inbox preview carries the customer text (staff-side only)', String(myThread?.lastMessage?.preview || '').includes('porch'));

  const custInbox = await api('/office-messages/threads', { token: aTok });
  check('B2 customer cannot read the staff inbox (403)', custInbox.status, 403);

  const reply = await api(`/bookings/${IDS.bookingA}/messages`, {
    token: staffTok, method: 'POST',
    body: { body: 'Thanks! The technician will use the side gate.' },
  });
  check('B2 staff reply posts', reply.status, 201);
  check('B2 reply senderKind is STAFF', reply.json?.data?.senderKind, 'STAFF');

  thread = await api(`/bookings/${IDS.bookingA}/messages`, { token: aTok });
  check('B2 thread now has 2 messages', thread.json?.data?.messages?.length, 2);
  check('B2 staff reply is unread for the customer', thread.json?.data?.unreadForMe, 1);

  const marked = await api(`/bookings/${IDS.bookingA}/messages/read`, { token: aTok, method: 'POST' });
  check('B2 customer mark-read marks 1', marked.json?.data?.marked, 1);
  thread = await api(`/bookings/${IDS.bookingA}/messages`, { token: aTok });
  check('B2 unread cleared after mark-read', thread.json?.data?.unreadForMe, 0);

  const staffThread = await api(`/bookings/${IDS.bookingA}/messages`, { token: staffTok });
  check('B2 customer message still unread for staff', staffThread.json?.data?.unreadForMe, 1);
  const staffMarked = await api(`/bookings/${IDS.bookingA}/messages/read`, { token: staffTok, method: 'POST' });
  check('B2 staff mark-read marks 1', staffMarked.json?.data?.marked, 1);

  const rowCount = await prisma.bookingMessage.count({ where: { bookingId: IDS.bookingA } });
  check('B2 two message rows persisted', rowCount, 2);

  const event = await prisma.platformEvent.findFirst({
    where: { type: 'BOOKING_MESSAGE_POSTED', entityId: IDS.bookingA },
    orderBy: { createdAt: 'asc' },
  });
  checkTrue('B2 platform event recorded', event);
  checkTrue('B2 event details carry NO message text', !JSON.stringify(event?.details || {}).includes('porch'));
  check('B2 event details carry the side only', event?.details?.senderKind, 'CUSTOMER');

  /* ------------------------------ B3 ------------------------------ */
  const in12d = new Date(Date.now() + 12 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const added = await api('/connect/appliances', {
    token: aTok, method: 'POST',
    body: { type: 'Refrigerator', brand: 'Samsung', model: 'RF28', purchaseDate: '2024-01-15', warrantyExpiresAt: in12d },
  });
  check('B3 add appliance with care dates 201', added.status, 201);
  const applianceId = added.json?.data?.id;
  check('B3 warranty expiring soon at +12d', added.json?.data?.care?.warrantyStatus, 'EXPIRING_SOON');
  checkTrue('B3 days-to-expiry within 1..30', (added.json?.data?.care?.daysToWarrantyExpiry ?? -1) >= 1 && added.json.data.care.daysToWarrantyExpiry <= 30);
  check('B3 purchase date round-trips', String(added.json?.data?.care?.purchaseDate || '').slice(0, 10), '2024-01-15');
  check('B3 no recall note on a fresh appliance', added.json?.data?.care?.recall, null);

  const in400d = new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const careActive = await api(`/connect/appliances/${applianceId}/care`, { token: aTok, method: 'POST', body: { warrantyExpiresAt: in400d } });
  check('B3 care update to +400d is ACTIVE', careActive.json?.data?.care?.warrantyStatus, 'ACTIVE');
  check('B3 purchase date preserved by partial update', String(careActive.json?.data?.care?.purchaseDate || '').slice(0, 10), '2024-01-15');

  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const careExpired = await api(`/connect/appliances/${applianceId}/care`, { token: aTok, method: 'POST', body: { warrantyExpiresAt: yesterday } });
  check('B3 care update to yesterday is EXPIRED', careExpired.json?.data?.care?.warrantyStatus, 'EXPIRED');

  const careCleared = await api(`/connect/appliances/${applianceId}/care`, { token: aTok, method: 'POST', body: { warrantyExpiresAt: null } });
  check('B3 cleared warranty is UNKNOWN', careCleared.json?.data?.care?.warrantyStatus, 'UNKNOWN');

  const foreignCare = await api(`/connect/appliances/${applianceId}/care`, { token: bTok, method: 'POST', body: { warrantyExpiresAt: in400d } });
  check('B3 other customer care edit is 404', foreignCare.status, 404);

  const custRecall = await api(`/connect/appliances/${applianceId}/recall-note`, { token: aTok, method: 'POST', body: { note: 'self-declared recall' } });
  check('B3 customer cannot set a recall note (403)', custRecall.status, 403);

  const staffRecall = await api(`/connect/appliances/${applianceId}/recall-note`, {
    token: staffTok, method: 'POST',
    body: { note: 'CPSC recall 24-123: ice maker fire risk — confirmed model match by office.', url: 'https://www.cpsc.gov/Recalls/2024/example' },
  });
  check('B3 staff sets the recall note', staffRecall.status, 200);
  checkTrue('B3 recall note lands in care', String(staffRecall.json?.data?.care?.recall?.note || '').includes('ice maker'));

  const garage = await api('/connect/appliances', { token: aTok });
  const mine = (garage.json?.data || []).find((a) => a.id === applianceId);
  checkTrue('B3 customer garage shows the curated recall', mine?.care?.recall?.note?.includes('ice maker'));

  const cleared = await api(`/connect/appliances/${applianceId}/recall-note`, { token: staffTok, method: 'POST', body: { note: '' } });
  check('B3 staff clears the recall note', cleared.json?.data?.care?.recall, null);

  const custCheck = await api('/connect/recall-check?brand=Samsung&type=Refrigerator', { token: aTok });
  check('B3 recall-check is staff-only (403 for customer)', custCheck.status, 403);

  const checkBefore = await prisma.customerAppliance.findUnique({ where: { id: applianceId } });
  const feed = await api('/connect/recall-check?brand=Samsung&type=Refrigerator', { token: staffTok });
  check('B3 staff recall-check 200', feed.status, 200);
  check('B3 recall-check source is CPSC', feed.json?.data?.source, 'CPSC SaferProducts');
  checkTrue('B3 recall-check available is boolean', typeof feed.json?.data?.available === 'boolean');
  if (feed.json?.data?.available) {
    checkTrue('B3 candidates are an array', Array.isArray(feed.json.data.candidates));
    console.log(`      (live feed: ${feed.json.data.candidates.length} Samsung refrigerator candidates)`);
    if (feed.json.data.candidates.length) {
      const c0 = feed.json.data.candidates[0];
      checkTrue('B3 candidate carries recall id + url', c0.recallId != null && typeof c0.url === 'string');
    }
  } else {
    console.log('      (live feed unavailable from this VM right now — contract still honored)');
  }
  const checkAfter = await prisma.customerAppliance.findUnique({ where: { id: applianceId } });
  check('B3 recall-check wrote NOTHING (recallNote unchanged)', checkAfter?.recallNote ?? null, checkBefore?.recallNote ?? null);

  const summary = await api('/connect/summary', { token: aTok });
  const sumApp = (summary.json?.data?.appliances || []).find((a) => a.id === applianceId);
  checkTrue('B3 summary carries the care block too', sumApp?.care && typeof sumApp.care.warrantyStatus === 'string');

  /* ------------------------------ B9 ------------------------------ */
  const meA = await api('/referrals/me', { token: aTok });
  check('B9 dashboard code', meA.json?.data?.code, 'W2TESTA');
  check('B9 dashboard link format unchanged', meA.json?.data?.link, 'https://topspeedserviceos.com/refer?c=W2TESTA');
  check('B9 stats completed counts real journeys', meA.json?.data?.stats?.completed, 4);
  check('B9 credits available count from real credits', meA.json?.data?.stats?.creditsAvailable?.count, 2);
  check('B9 credits available total from real credits', meA.json?.data?.stats?.creditsAvailable?.totalCents, 6000);
  const pA = meA.json?.data?.progress || {};
  check('B9 progress completed', pA.completed, 4);
  check('B9 next reward tier at 4 completed is TIER2', pA.nextReward?.tier, 'TIER2');
  check('B9 next reward amount is the $35 tier rate', pA.nextReward?.amountCents, 3500);
  check('B9 next tier is TIER2 at 5', pA.nextTier?.at, 5);
  check('B9 one more completion reaches tier 2', pA.nextTier?.remaining, 1);
  check('B9 milestone 10 not reached yet', pA.milestones?.[0]?.reached, false);
  check('B9 milestone 10 amount is $100', pA.milestones?.[0]?.amountCents, 10000);
  check('B9 milestone 25 amount is $250', pA.milestones?.[1]?.amountCents, 25000);
  check('B9 expiry is 365 days (12 months)', pA.rewardExpiryDays, 365);

  const meB = await api('/referrals/me', { token: bTok });
  const pB = meB.json?.data?.progress || {};
  check('B9 referrer B completed 10', pB.completed, 10);
  check('B9 next reward at 10 completed is TIER3 $50', pB.nextReward?.amountCents, 5000);
  check('B9 no next tier at the top', pB.nextTier, null);
  check('B9 milestone 10 reached for B', pB.milestones?.[0]?.reached, true);
  check('B9 milestone 25 not reached for B', pB.milestones?.[1]?.reached, false);

  const anonMe = await api('/referrals/me');
  check('B9 anon dashboard is 401', anonMe.status, 401);

  /* --------------------- restart durability (B2) -------------------- */
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  server = startServer();
  await waitForServer();
  const aTok2 = await login('cust-a@test.local');
  const after = await api(`/bookings/${IDS.bookingA}/messages`, { token: aTok2 });
  check('B2 thread survives restart (hydrated)', after.json?.data?.messages?.length, 2);
  check('B2 read state survives restart', after.json?.data?.unreadForMe, 0);

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('harness error:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) server.kill('SIGKILL');
    await cleanup();
    await prisma.$disconnect();
  });
