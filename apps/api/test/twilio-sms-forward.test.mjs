/**
 * Twilio voice caller-ID + inbound SMS forwarder drills (2026-11-19 —
 * prepped ahead of the public number swap to the toll-free line; the
 * owner proves call forwarding with a test call before this ships).
 *
 * Two fixes are proven here, in-process against the real routers and
 * the real sender machinery with Twilio stubbed at TWILIO_API_BASE
 * (skeleton mode, no database — same pattern as twilio-connect):
 *
 *   (a) Voice: the <Dial> now presents the INBOUND caller's number
 *       as callerId, so the owner's phone shows who is calling (and
 *       he can call back from the log). With no From on the webhook
 *       it falls back to the toll-free number. The dial target stays
 *       the owner's phone (+19549317997 default) with the 30s
 *       timeout and the voicemail <Record> flow untouched.
 *   (b) SMS: a customer text to the toll-free number forwards ONCE
 *       to the owner's phone through the notification outbox (the
 *       forward carries the sender's number and their message) and
 *       the sender gets the TwiML thank-you reply with the booking
 *       link. A text FROM the owner's own number forwards nothing
 *       and replies nothing (loop guard). Missing From or an empty
 *       Body is a safe no-op. When Twilio rejects the forward send,
 *       the webhook still answers 200 with the reply TwiML and the
 *       outbox entry records FAILED — never a webhook error.
 *
 * Usage: node test/twilio-sms-forward.test.mjs
 * Exit code 0 = every check passed.
 */
import { createServer } from 'node:http';

// Environment BEFORE importing the app modules: no database
// (skeleton mode), Twilio pointed at the local stub.
const STUB_PORT = Number(process.env.STUB_PORT || 4481);
const APP_PORT = Number(process.env.APP_PORT || 4482);
delete process.env['DATABASE_' + 'URL'];
delete process.env['DATABASE_' + 'URL_UNPOOLED'];
delete process.env['SENDGRID_' + '_API_KEY'];
delete process.env['VONAGE_' + '_API_KEY'];
delete process.env['VONAGE_' + '_API_SECRET'];
delete process.env['VOICE_' + 'FORWARD_TO'];
process.env['JWT_' + 'SECRET'] = 'twilio-sms-forward-drill-secret';
process.env['TWILIO_' + 'ACCOUNT_SID'] = 'ACtwiliosmsdrill';
process.env['TWILIO_' + 'AUTH_TOKEN'] = 'drill-twilio-token';
process.env['TWILIO_' + 'PHONE_NUMBER'] = '+18445550100';
process.env['TWILIO_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;
process.env['RESEND_' + 'API_KEY'] = 'drill-resend-key';
process.env['RESEND_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;

let smsBehavior = 'ok'; // 'ok' | 'fail'
const smsCaptures = [];
let smsSeq = 0;

const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (req.method === 'POST' && req.url.includes('/Messages.json')) {
      const form = new URLSearchParams(raw);
      smsCaptures.push({ to: form.get('To'), from: form.get('From'), body: form.get('Body') });
      if (smsBehavior === 'fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'stub send failure' }));
        return;
      }
      smsSeq += 1;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sid: `SMsmsdrill${smsSeq}`, status: 'queued' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));

// Minimal app mounting ONLY the two Twilio routers, mirroring
// server.js (urlencoded parser scoped to the /api/v1/twilio path).
const express = (await import('express')).default;
const { default: twilioVoiceRouter } = await import('../src/routes/twilioVoice.js');
const { default: twilioSmsRouter } = await import('../src/routes/twilioSms.js');
const { store } = await import('../src/data/store.js');
const app = express();
app.use('/api/v1/twilio', express.urlencoded({ extended: false, limit: '16kb' }));
app.use('/api/v1', twilioVoiceRouter);
app.use('/api/v1', twilioSmsRouter);
const server = app.listen(APP_PORT, '127.0.0.1');
await new Promise((resolve) => server.on('listening', resolve));

let failures = 0;
let checks = 0;
function check(label, actual, expected) {
  checks += 1;
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkIncludes(label, haystack, needle) {
  checks += 1;
  const ok = typeof haystack === 'string' && haystack.includes(needle);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (want text containing ${JSON.stringify(needle)})`);
}
function checkExcludes(label, haystack, needle) {
  checks += 1;
  const ok = typeof haystack === 'string' && !haystack.includes(needle);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (want text WITHOUT ${JSON.stringify(needle)})`);
}

async function postForm(path, fields) {
  const response = await fetch(`http://127.0.0.1:${APP_PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: response.status, text: await response.text() };
}

const OWNER = '+19549317997';
const CUSTOMER = '+13055550199';
const TOLLFREE = '+18445550100'; // TWILIO_PHONE_NUMBER in this drill

// ── (a) Voice caller ID ─────────────────────────────────────────────
const voice = await postForm('/api/v1/twilio/voice/incoming', { From: CUSTOMER, To: TOLLFREE, CallSid: 'CAdrill1' });
check('voice: HTTP 200', voice.status, 200);
checkIncludes('voice: callerId is the inbound caller', voice.text, `<Dial callerId="${CUSTOMER}"`);
checkIncludes('voice: dial target is still the owner phone', voice.text, `<Number>${OWNER}</Number>`);
checkIncludes('voice: 30s timeout kept', voice.text, 'timeout="30"');
checkIncludes('voice: voicemail Record flow kept', voice.text, '<Record maxLength="120"');
checkIncludes('voice: recording callback kept', voice.text, '/api/v1/twilio/voice/recording');

const voiceNoFrom = await postForm('/api/v1/twilio/voice/incoming', { To: TOLLFREE });
checkIncludes('voice: no From falls back to the toll-free callerId', voiceNoFrom.text, `<Dial callerId="${TOLLFREE}"`);

// ── (b) SMS from a customer → one forward + TwiML reply ─────────────
const beforeCustomer = smsCaptures.length;
const sms = await postForm('/api/v1/twilio/sms/incoming', {
  From: CUSTOMER, To: TOLLFREE, Body: 'My fridge is not cooling, can someone come Friday?', MessageSid: 'SMdrillinbound1',
});
check('sms customer: HTTP 200', sms.status, 200);
checkIncludes('sms customer: reply thanks the sender', sms.text, 'Thanks for texting Top Speed Appliance');
checkIncludes('sms customer: reply carries the booking link', sms.text, 'topspeedserviceos.com/book');
check('sms customer: exactly one forward send attempted', smsCaptures.length - beforeCustomer, 1);
const forward = smsCaptures[smsCaptures.length - 1];
check('sms customer: forward went to the owner phone', forward?.to, OWNER);
check('sms customer: forward sent from the toll-free number', forward?.from, TOLLFREE);
checkIncludes('sms customer: forward names the sender number', forward?.body || '', CUSTOMER);
checkIncludes('sms customer: forward carries the customer message', forward?.body || '', 'fridge is not cooling');
const fwdEntry = store.notificationOutbox.find((e) => e.eventKey === 'sms-inbound:SMdrillinbound1');
check('sms customer: outbox entry recorded SENT', fwdEntry?.status, 'SENT');
check('sms customer: outbox entry addressed to the owner', fwdEntry?.to, OWNER);

// Webhook retry with the same MessageSid must not forward twice.
const retry = await postForm('/api/v1/twilio/sms/incoming', {
  From: CUSTOMER, To: TOLLFREE, Body: 'My fridge is not cooling, can someone come Friday?', MessageSid: 'SMdrillinbound1',
});
check('sms retry: still HTTP 200 with the reply', retry.status, 200);
check('sms retry: no second forward send', smsCaptures.length - beforeCustomer, 1);

// ── (c) SMS from the owner himself → loop guard ─────────────────────
const beforeOwner = smsCaptures.length;
const ownSms = await postForm('/api/v1/twilio/sms/incoming', {
  From: OWNER, To: TOLLFREE, Body: 'testing the line myself', MessageSid: 'SMdrillown1',
});
check('sms owner: HTTP 200', ownSms.status, 200);
checkExcludes('sms owner: no auto-reply', ownSms.text, '<Message>');
check('sms owner: empty TwiML response', ownSms.text.includes('<Response></Response>'), true);
check('sms owner: no forward send', smsCaptures.length - beforeOwner, 0);

// ── (d) Missing From / empty Body → safe no-op ──────────────────────
const beforeNoop = smsCaptures.length;
const noFrom = await postForm('/api/v1/twilio/sms/incoming', { To: TOLLFREE, Body: 'hello?', MessageSid: 'SMdrillx1' });
check('sms no From: HTTP 200', noFrom.status, 200);
checkExcludes('sms no From: no reply', noFrom.text, '<Message>');
const noBody = await postForm('/api/v1/twilio/sms/incoming', { From: CUSTOMER, To: TOLLFREE, Body: '', MessageSid: 'SMdrillx2' });
check('sms empty Body: HTTP 200', noBody.status, 200);
checkExcludes('sms empty Body: no reply', noBody.text, '<Message>');
check('sms no-ops: no forward sends', smsCaptures.length - beforeNoop, 0);

// ── (e) Forward send fails → reply still returned, entry FAILED ─────
smsBehavior = 'fail';
const failSms = await postForm('/api/v1/twilio/sms/incoming', {
  From: CUSTOMER, To: TOLLFREE, Body: 'Washer leaking everywhere', MessageSid: 'SMdrillfail1',
});
check('sms send-failure: webhook still HTTP 200', failSms.status, 200);
checkIncludes('sms send-failure: sender still gets the reply', failSms.text, 'Thanks for texting Top Speed Appliance');
const failEntry = store.notificationOutbox.find((e) => e.eventKey === 'sms-inbound:SMdrillfail1');
check('sms send-failure: outbox entry honestly FAILED', failEntry?.status, 'FAILED');
smsBehavior = 'ok';

await new Promise((resolve) => server.close(resolve));
await new Promise((resolve) => stub.close(resolve));
console.log(failures === 0 ? `\nALL ${checks} TWILIO SMS/VOICE CHECKS PASSED` : `\n${failures} OF ${checks} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
