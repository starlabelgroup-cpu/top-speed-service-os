/**
 * Outbox drain keep-alive — verification harness (2026-11-18).
 *
 * Root cause this guards: on Vercel serverless, the opportunistic
 * post-queue drain in services/notifications.js was a fire-and-forget
 * unref'd 1200ms timer. The function instance froze when the HTTP
 * response returned, the timer never fired, and entries sat QUEUED
 * forever (the first production password-reset emails, 2026-11-18).
 * The fix registers a keeper promise with the platform's waitUntil
 * at schedule time; the keeper settles only when the batch's drain
 * has finished.
 *
 * Proofs, in-process against the real services with Resend pointed
 * at a local stub (no database — persistence is disabled without a
 * DATABASE_URL, exactly the skeleton mode):
 *   (a) with a Vercel request context installed (the real mechanism
 *       @vercel/functions reads: globalThis[Symbol.for(
 *       '@vercel/request-context')]), queueing an email registers
 *       exactly one promise with waitUntil — synchronously, inside
 *       the queue call — and awaiting that promise means the entry
 *       has been delivered through the real sender path.
 *   (b) with NO request context (plain Node: local dev, this
 *       harness), queueing still delivers via the timer fallback —
 *       waitUntil is a no-op and nothing throws.
 *
 * Usage: node test/outbox-drain.test.mjs
 * Exit code 0 = every check passed.
 */
import { createServer } from 'node:http';

// Environment BEFORE importing the services: Resend stub only, no
// database, no fallback providers, so the email chain is exactly one
// provider and delivery outcomes are unambiguous.
const STUB_PORT = Number(process.env.STUB_PORT || 4472);
delete process.env['DATABASE_' + 'URL'];
delete process.env['DATABASE_' + 'URL_UNPOOLED'];
delete process.env['SENDGRID_' + 'API_KEY'];
delete process.env['TWILIO_' + 'ACCOUNT_SID'];
delete process.env['TWILIO_' + 'AUTH_TOKEN'];
delete process.env['TWILIO_' + 'PHONE_NUMBER'];
process.env['RESEND_' + 'API_KEY'] = 'drain-drill-key';
process.env['RESEND_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;
process.env['EMAIL_' + 'FROM'] = 'Top Speed Appliance <service@topspeedappliance.net>';

const captures = [];
const stub = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/emails') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { captures.push(JSON.parse(raw)); } catch { captures.push({ raw }); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: `stub-${captures.length}` }));
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{}');
});
await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));

const { queueNotification } = await import('../src/services/notifications.js');

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms)),
  ]);
}

async function pollStatus(entry, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (entry.status === 'SENT') return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return entry.status === 'SENT';
}

/* ---- (a) waitUntil registration + delivery under a request context ---- */
const registered = [];
globalThis[Symbol.for('@vercel/request-context')] = {
  get: () => ({ waitUntil: (promise) => { registered.push(promise); } }),
};

const entryA = queueNotification({
  channel: 'email',
  template: 'BOOKING_CONFIRMATION',
  to: 'drain-a@test.local',
  payload: { message: 'Drain proof A — waitUntil path.', subject: 'Drain proof A' },
  source: 'outbox-drain-test',
});
check('(a) entry starts QUEUED', entryA.status, 'QUEUED');
check('(a) waitUntil registered synchronously during queue', registered.length, 1);
check('(a) registered value is a promise', typeof registered[0]?.then, 'function');
await withTimeout(registered[0], 8000, 'the waitUntil keeper promise');
check('(a) entry SENT once the keeper settles', entryA.status, 'SENT');
check('(a) exactly one email reached the Resend stub', captures.length, 1);
check('(a) stub email recipient', captures[0]?.to?.[0], 'drain-a@test.local');
check('(a) stub email subject', captures[0]?.subject, 'Drain proof A');

/* ---- (b) plain-Node fallback: no request context, timer delivers ---- */
delete globalThis[Symbol.for('@vercel/request-context')];

const entryB = queueNotification({
  channel: 'email',
  template: 'BOOKING_CONFIRMATION',
  to: 'drain-b@test.local',
  payload: { message: 'Drain proof B — fallback path.', subject: 'Drain proof B' },
  source: 'outbox-drain-test',
});
check('(b) entry starts QUEUED', entryB.status, 'QUEUED');
check('(b) entry delivered by the timer fallback', await pollStatus(entryB), true);
check('(b) second email reached the Resend stub', captures.length, 2);
check('(b) stub email recipient', captures[1]?.to?.[0], 'drain-b@test.local');

await new Promise((resolve) => stub.close(resolve));
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
