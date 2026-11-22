/**
 * RULE 1 — deep-link / interconnection drills (Ramone, 2026-11-22).
 *
 * Rule 1: every link goes to a page for THAT link's own information
 * and database — never a homepage — and the page must load its own
 * real data with working actions. Local only, skeleton mode (no
 * DATABASE_URL): nothing here touches production data.
 *
 *  A. Booking notifications: every customer message that says "track"
 *     carries a dedicated /track?t= link minted for THAT booking, and
 *     the token record in the store points at that booking.
 *  B. Live HTTP against the in-process server: the Pepper Lists share
 *     page's "See it on Pepper Lists" button targets the dedicated
 *     in-app listing page (?listing=<ref>); "Message the seller"
 *     keeps its ?message= deep link; the catalog feed link stays
 *     /listing/<ref>; the seller storefront JSON renders the seller's
 *     real listings + honest review state; and a Part A tracking
 *     token actually loads its booking through /tracking/by-token.
 *  C. Pepper Lists page (vm DOM drills, same harness style as
 *     pl-signin-dom): ?listing=<ref> opens THIS listing's detail from
 *     the public API; ?inbox=<ref> (the message-notification email
 *     link) opens the conversation about THAT listing after sign-in.
 *
 * Exit code 0 = every check passed.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const flush = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 5)); };

/* ============================ A. notifications ============================ */
console.log('A. booking notification track links');
const { store } = await import('../src/data/store.js');
const N = await import('../src/services/notifications.js');

const booking = {
  id: 'booking-drill-1',
  referenceCode: 'TS-DRILL1',
  appliance: 'Refrigerator',
  issue: 'Not cooling',
  city: 'Fort Lauderdale',
  status: 'BOOKED',
  customer: { name: 'Drill Customer', email: 'drill@example.test', phone: '+15555550101' },
  appointment: { status: 'SET', date: '2026-11-24', window: 'AM', windowLabel: 'Morning (8am–12pm)', setAt: '2026-11-22T10:00:00.000Z' },
  payment: { status: 'PAID' },
  preferredWindow: 'Morning',
};
store.bookings.set(booking.id, booking);
store.notificationOutbox.length = 0;

N.notifyBookingConfirmation(booking);
N.notifyBookingReceipt(booking, 'email');
N.notifyBookingReceipt(booking, 'sms');
N.notifyAppointmentReminder(booking);
N.notifyAppointmentReminderWithReply(booking, 'MORNING_OF');
N.notifyTrackingUpdate(booking, 'Technician en route');
N.notifyBookingAssigned(booking, { id: 'assign-drill-1' });
N.notifyPhotoDiagnosis({
  submitter: { name: 'Drill Customer', email: 'drill@example.test', phone: '+15555550101' },
  diagnosis: { appliance: 'Refrigerator', visible_findings: ['Frost build-up'], likely_causes: ['Defrost heater'], safety_critical: false },
  bookingReference: 'TS-DRILL1',
});
// Regression: the en-route photo link still mints its token link.
N.notifyTechEnRoute(booking, null, {
  techFirstName: 'Sam',
  techPhotoDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
});

const messages = (store.notificationOutbox || [])
  .map((e) => e?.payload?.message || '')
  .filter(Boolean);
const trackMsgs = messages.filter((m) => /(Track your visit|Track your job live|Track it:|Track live|track any time|Track the visit|Track your technician)/.test(m));
check('track-bearing customer messages were queued', trackMsgs.length >= 8, `got ${trackMsgs.length}`);
const bare = trackMsgs.filter((m) => !m.includes('/track?t='));
check('every track link is a dedicated ?t= link (no bare /track)', bare.length === 0, bare[0] || '');

let receiptRaw = null;
for (const m of trackMsgs) {
  const match = /\/track\?t=([A-Za-z0-9_-]+)/.exec(m);
  if (match && m.includes('booking receipt')) receiptRaw = match[1];
  if (match && m.includes('Track your job live')) receiptRaw = match[1];
}
check('booking receipt carries a raw tracking token', Boolean(receiptRaw));
if (receiptRaw) {
  const hash = createHash('sha256').update(receiptRaw).digest('hex');
  const record = store.trackingTokens.get(hash);
  check('receipt token resolves in the store to THIS booking', record?.bookingId === booking.id, JSON.stringify(record || null));
  check('receipt token was minted as BOOKING_RECEIPT', record?.issuedBy === 'BOOKING_RECEIPT', record?.issuedBy || '');
}

/* ============================ B. HTTP surface ============================ */
console.log('B. Pepper Lists share page / storefront / token tracking (seeded child server)');
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const bootPath = '/tmp/rule1-boot.mjs';
writeFileSync(bootPath, `
import { store } from 'file://${process.cwd()}/src/data/store.js';
import { fileURLToPath } from 'node:url';
store.users.set('u-drill', {
  id: 'u-drill', email: 'eric@drill.test', firstName: 'Eric', lastName: 'Smith',
  roles: ['CUSTOMER'], createdAt: '2026-11-13T04:13:20.940Z',
});
store.connections.push({
  id: 'conn-drill-1', type: 'PEPPER_LISTS_SELL', reference: 'TS-DRILL9',
  email: 'eric@drill.test', name: 'Eric Smith',
  message: 'Listing title: Drill Canister\\nPrice: $12.96\\nDescription: A drill listing.\\nCategory: Other\\nCondition: New',
  createdAt: '2026-11-22T09:17:39.849Z',
});
import { createHash } from 'node:crypto';
store.bookings.set('booking-drill-1', {
  id: 'booking-drill-1', referenceCode: 'TS-DRILL1', appliance: 'Refrigerator', issue: 'Not cooling',
  city: 'Fort Lauderdale', status: 'BOOKED',
  customer: { name: 'Drill Customer', email: 'drill@example.test', phone: '+15555550101' },
  appointment: { status: 'SET', date: '2026-11-24', window: 'AM', windowLabel: 'Morning (8am-12pm)', setAt: '2026-11-22T10:00:00.000Z' },
  payment: { status: 'PAID' }, preferredWindow: 'Morning',
});
const drillHash = createHash('sha256').update('rule1drilltoken').digest('hex');
store.trackingTokens.set(drillHash, {
  id: 'track-drill-1', tokenHash: drillHash, bookingId: 'booking-drill-1', issuedBy: 'DRILL',
  expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), revokedAt: null,
  createdAt: new Date().toISOString(),
});
process.argv[1] = fileURLToPath(new URL('file://${process.cwd()}/src/server.js'));
await import('file://${process.cwd()}/src/server.js');
`);
const child = spawn('node', [bootPath], { cwd: process.cwd(), env: { ...process.env, PORT: '4498' }, stdio: 'ignore' });
const B = 'http://127.0.0.1:4498/api/v1';
let up = false;
for (let i = 0; i < 80 && !up; i += 1) {
  try { const r = await fetch(`${B}/health`); up = r.ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
}
check('API boots in skeleton mode', up);

if (up) {
  const viewRes = await fetch(`${B}/pepper-lists/listings/TS-DRILL9/view`);
  const viewHtml = await viewRes.text();
  check('share page renders the listing itself', viewRes.ok && viewHtml.includes('Drill Canister'));
  check('"See it on Pepper Lists" targets the dedicated in-app listing page', viewHtml.includes('https://pepperlists.com/?listing=TS-DRILL9'));
  check('"See it on Pepper Lists" no longer dumps to the homepage', !viewHtml.includes('<a href="https://pepperlists.com/"'));
  check('"Message the seller" keeps its ?message= deep link', viewHtml.includes('https://pepperlists.com/?message=TS-DRILL9'));

  const feedRes = await fetch(`${B}/pepper-lists/catalog.csv`);
  const feed = await feedRes.text();
  check('catalog feed link is the dedicated /listing/<ref>', feed.includes('https://pepperlists.com/listing/TS-DRILL9'));

  const sfRes = await fetch(`${B}/pepper-lists/sellers/u-drill/storefront`);
  const sf = await sfRes.json();
  check('storefront JSON renders the seller', sfRes.ok && sf?.data?.seller?.name === 'Eric S.');
  check('storefront JSON lists the seller\u2019s real listing', sf?.data?.listings?.[0]?.reference === 'TS-DRILL9');
  check('storefront reviews state is the honest empty (skeleton)', sf?.data?.reviews?.count === 0 && sf?.data?.reviews?.average === null);

  {
    const tRes = await fetch(`${B}/tracking/by-token/rule1drilltoken`);
    const tJson = await tRes.json();
    check('dedicated tracking link loads THIS booking\u2019s live job page', tRes.ok && tJson?.data?.reference === 'TS-DRILL1', JSON.stringify(tJson).slice(0, 200));
  }
}
child.kill('SIGTERM');

/* ============================ C. PL page DOM ============================ */
console.log('C. Pepper Lists page deep links (vm DOM)');
const HTML_PATH = fileURLToPath(new URL('../../web/pepper-lists-site/index.html', import.meta.url));
const html = readFileSync(HTML_PATH, 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const gateSrc = blocks.find((s) => s.includes('function plBoot'));
const trustSrc = blocks.find((s) => s.includes('function pltOpenListing'));
const msgSrc = blocks.find((s) => s.includes('function plmEnter'));
check('page script blocks found', Boolean(gateSrc && trustSrc && msgSrc));
const htmlIds = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));

function makeEl(id) {
  return {
    id, style: {}, textContent: '', innerHTML: '', className: '', value: '', disabled: false, children: [],
    addEventListener() {}, removeEventListener() {}, focus() {}, scrollIntoView() {},
    setAttribute() {}, getAttribute() { return null; }, appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return false; },
  };
}

const DETAIL = {
  id: 'lst-drill', reference: 'TS-DRILL1', title: 'Drill Canister', priceCents: 1296,
  category: 'Other', condition: 'New', description: 'A drill listing.', status: 'ACTIVE',
  featured: false, photos: [], viewCount: 0, createdAt: '2026-11-22T09:17:39.849Z',
  seller: { userId: 'u-eric', name: 'Eric Smith', badges: {}, salesCount: 0 },
  sellerReviews: { count: 0, average: null, items: [] }, comments: [],
};
const THREAD = {
  id: 'th1', listing: { reference: 'TS-DRILL1', title: 'Drill Canister', priceCents: 1296 },
  otherParty: { userId: 'u-buyer', name: 'Buyer One' }, role: 'SELLER', status: 'OPEN',
  unreadCount: 1, lastMessage: { body: 'Is this available?', senderIsMe: false }, lastMessageAt: '2026-11-22T10:00:00.000Z',
};

function makeWorld({ storage = {}, search = '' }) {
  const storeMap = new Map(Object.entries(storage));
  const localStorage = {
    getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
    setItem: (k, v) => storeMap.set(k, String(v)),
    removeItem: (k) => storeMap.delete(k),
  };
  const sessionStore = new Map();
  const sessionStorage = {
    getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
    setItem: (k, v) => sessionStore.set(k, String(v)),
    removeItem: (k) => sessionStore.delete(k),
  };
  const vault = { accounts: {}, active: null };
  const TSOSVault = {
    add(user, token) { vault.accounts[user.id] = { user, token, savedAt: 1 }; vault.active = user.id; },
    active() { const a = vault.active ? vault.accounts[vault.active] : null; return a ? { user: a.user, token: a.token, savedAt: a.savedAt } : null; },
    list() { return Object.keys(vault.accounts).map((id) => ({ user: vault.accounts[id].user, savedAt: 1, active: id === vault.active })); },
    remove(userId) { delete vault.accounts[userId]; if (vault.active === userId) vault.active = null; },
    expireActive() { return false; },
  };
  const els = new Map();
  const listeners = {};
  const document = {
    getElementById(id) {
      if (!htmlIds.has(id)) return null;
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    createElement() { return makeEl('dyn'); },
    body: makeEl('body'),
  };
  const calls = [];
  const USER = { id: 'u-eric', email: 'eric@drill.test', firstName: 'Eric', lastName: 'Smith', roles: ['CUSTOMER'] };
  const fetchImpl = async (url) => {
    const u = String(url);
    calls.push(u);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (u.includes('/auth/me')) {
      if (!storeMap.get('tsos_token')) return { ok: false, status: 401, json: async () => ({ error: 'no' }) };
      return ok({ user: USER });
    }
    if (u.includes('/pepper-lists/listings/public/TS-DRILL1')) return ok({ data: DETAIL });
    if (u.includes('/pepper-lists/listings/public')) return ok({ data: [] });
    if (u.includes('/pepper-lists/reviews/public')) return ok({ data: [], aggregate: { count: 0, average: null } });
    if (u.includes('/pepper-lists/threads/th1')) {
      return ok({ data: { thread: { id: 'th1', listing: THREAD.listing, otherParty: THREAD.otherParty, status: 'OPEN' }, messages: [{ id: 'm1', body: 'Is this available?', senderIsMe: false, senderName: 'Buyer One', createdAt: '2026-11-22T10:00:00.000Z' }] } });
    }
    if (u.includes('/pepper-lists/threads')) return ok({ data: { threads: [THREAD] } });
    if (u.includes('/pepper-lists/saved')) return ok({ data: [] });
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  };
  const sandbox = {
    console, URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    document, localStorage, sessionStorage, fetch: fetchImpl,
    location: { search, hash: '', pathname: '/', reload() {} },
    scrollTo() {}, alert() {},
    addEventListener(type, fn) { (listeners['window:' + type] ||= []).push(fn); },
    MutationObserver: class { observe() {} disconnect() {} },
    TSOSVault,
    TSOSLayer2: { run() { return true; }, isChallenge: () => false },
  };
  sandbox.window = sandbox;
  sandbox.window.scrollTo = () => {};
  sandbox.window.addEventListener = sandbox.addEventListener;
  vm.createContext(sandbox);
  vm.runInContext(gateSrc, sandbox, { filename: 'pl-gate.js' });
  vm.runInContext(trustSrc, sandbox, { filename: 'pl-trust.js' });
  vm.runInContext(msgSrc, sandbox, { filename: 'pl-messages.js' });
  return {
    sandbox, calls,
    el: (id) => document.getElementById(id),
    fireDCL: () => (listeners.DOMContentLoaded || []).forEach((fn) => fn()),
  };
}

// C1 — ?listing=<ref> opens THIS listing's detail (signed out is fine: the detail is public)
{
  const w = makeWorld({ search: '?listing=TS-DRILL1' });
  w.fireDCL(); await flush();
  check('?listing= fetches the listing by its reference', w.calls.some((u) => u.includes('/pepper-lists/listings/public/TS-DRILL1')));
  check('?listing= renders THIS listing\u2019s detail', (w.el('pltDetail')?.innerHTML || '').includes('Drill Canister'));
}

// C2 — ?inbox=<ref> opens the conversation about THAT listing after sign-in
{
  const w = makeWorld({ storage: { tsos_token: 'tokA' }, search: '?inbox=TS-DRILL1' });
  w.fireDCL(); await flush(14);
  check('?inbox= loads the signed-in user\u2019s threads', w.calls.some((u) => u.includes('/pepper-lists/threads')));
  check('?inbox= opens the thread for THAT listing', w.calls.some((u) => u.includes('/pepper-lists/threads/th1')));
  check('the opened conversation renders', (w.el('plmThreadTitle')?.textContent || '').includes('Drill Canister'));
}

console.log(`\nRULE 1 DRILLS: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
