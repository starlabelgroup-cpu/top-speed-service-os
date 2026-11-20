/**
 * Call recordings + transcripts drill (2026-11-20, D8 — SHIPS DARK).
 *
 * Proves the dark-ship contract:
 *  FLAG OFF (the shipped default):
 *   1. The inbound voice TwiML is BYTE-IDENTICAL to the
 *      pre-recording document — no consent announcement, no record
 *      attribute on the <Dial>, the voicemail flow untouched.
 *   2. The call-recording callback acknowledges (200) and stores
 *      NOTHING.
 *   3. The call-transcription callback acknowledges (200) and
 *      stores NOTHING.
 *  FLAG ON (flipped mid-drill; voiceConfig reads env live):
 *   4. The TwiML gains the consent announcement + dual-channel
 *      recording on the <Dial>, pointed at the call-recording
 *      callback — while the voicemail <Record> stays as it was.
 *   5. A completed recording callback stores exactly one row;
 *      a redelivery updates it instead of duplicating.
 *   6. A transcription callback attaches the transcript.
 *   7. The CRM customer record shows the recording + transcript
 *      for the customer whose number was on the call, excludes it
 *      for anyone else, reports the flag state honestly, and stays
 *      staff-only (anonymous → 401).
 *
 * Nothing in this suite talks to Twilio or a database.
 *
 * Run: node test/call-recordings-dark.test.mjs   (exit 0 = pass)
 */
import { createHmac } from 'node:crypto';

delete process.env.DATABASE_URL;
delete process.env.DATABASE_URL_UNPOOLED;
delete process.env.DIRECT_URL;
delete process.env.CALL_RECORDING_ENABLED;
delete process.env.TWILIO_AUTH_TOKEN;
process.env.JWT_SECRET = 'call-recordings-drill-secret';
delete process.env.ALLOW_DEMO_AUTH;

const express = (await import('express')).default;
const { default: twilioVoiceRouter } = await import('../src/routes/twilioVoice.js');
const { default: crmRouter } = await import('../src/routes/crm.js');
const { store, PLATFORM_COMPANY_ID } = await import('../src/data/store.js');

let failures = 0;
function check(label, ok, extra = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
}

function mintToken(roles) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({
    sub: 'drill-user', companyId: PLATFORM_COMPANY_ID, email: 'drill@example.test',
    roles, exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const sig = createHmac('sha256', process.env.JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

store.customers.set('drill-cust-1', {
  id: 'drill-cust-1', name: 'Drill Customer', phone: '(954) 555-0199',
  email: 'drill-customer@example.test', city: 'Davie', zip: '33314',
  address: '1 Main Street', createdAt: '2026-11-01T00:00:00.000Z',
});
store.customers.set('drill-cust-2', {
  id: 'drill-cust-2', name: 'Other Customer', phone: '(954) 555-0100',
  email: 'other@example.test', city: 'Davie', zip: '33314',
  address: '2 Main Street', createdAt: '2026-11-01T00:00:00.000Z',
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api/v1', twilioVoiceRouter);
app.use('/api/v1', crmRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

async function postForm(path, fields) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, text: await res.text() };
}
async function getJson(path, token) {
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

const FROM = '+19545550199';
const TO = '+18444607038';

/* ── FLAG OFF ──────────────────────────────────────────────────── */
const expectedOff =
  `<?xml version="1.0" encoding="UTF-8"?>\n<Response>` +
  `<Dial callerId="${FROM}" timeout="30"><Number>+19549317997</Number></Dial>` +
  `<Say voice="Polly.Joanna">Thanks for calling Top Speed Appliance. ` +
  `We&apos;re with another customer right now — please leave your name, number, ` +
  `and what appliance needs help, or book anytime at topspeedserviceos.com.</Say>` +
  `<Record maxLength="120" playBeep="true" method="POST" ` +
  `recordingStatusCallback="http://127.0.0.1:${PORT}/api/v1/twilio/voice/recording" recordingStatusCallbackMethod="POST"/>` +
  `<Say voice="Polly.Joanna">Thank you — we&apos;ll get back to you shortly. Goodbye.</Say></Response>`;

const incomingOff = await postForm('/twilio/voice/incoming', { From: FROM, To: TO, CallSid: 'CAoff1' });
check('flag off: incoming answers 200', incomingOff.status === 200, String(incomingOff.status));
check('flag off: TwiML is byte-identical to the pre-recording document',
  incomingOff.text === expectedOff,
  incomingOff.text === expectedOff ? '' : `got: ${incomingOff.text}`);
check('flag off: no recording attribute anywhere', !incomingOff.text.includes('record='));
check('flag off: no consent announcement', !incomingOff.text.includes('may be recorded'));

const recOff = await postForm('/twilio/voice/call-recording', {
  RecordingStatus: 'completed', CallSid: 'CAoff1', RecordingSid: 'REoff1',
  RecordingUrl: 'https://api.twilio.com/recordings/REoff1', RecordingDuration: '42', From: FROM, To: TO,
});
check('flag off: recording callback acknowledges (200)', recOff.status === 200, String(recOff.status));
check('flag off: recording callback stores NOTHING', store.callRecordings.length === 0, String(store.callRecordings.length));

const trxOff = await postForm('/twilio/voice/call-transcription', {
  CallSid: 'CAoff1', TranscriptionStatus: 'completed', TranscriptionText: 'should never be stored',
});
check('flag off: transcription callback acknowledges (200)', trxOff.status === 200, String(trxOff.status));
check('flag off: transcription stores NOTHING', store.callRecordings.length === 0);

/* ── FLAG ON ───────────────────────────────────────────────────── */
process.env.CALL_RECORDING_ENABLED = 'true';

const incomingOn = await postForm('/twilio/voice/incoming', { From: FROM, To: TO, CallSid: 'CAon1' });
check('flag on: consent announcement is spoken before the dial',
  incomingOn.text.includes('<Say voice="Polly.Joanna">This call may be recorded for quality and training purposes.</Say>'));
check('flag on: the dial records both legs',
  incomingOn.text.includes('record="record-from-answer-dual"'));
check('flag on: recording reports to the call-recording callback',
  incomingOn.text.includes(`recordingStatusCallback="http://127.0.0.1:${PORT}/api/v1/twilio/voice/call-recording"`));
check('flag on: the voicemail flow is untouched and distinct',
  incomingOn.text.includes('<Record maxLength="120"') &&
  incomingOn.text.includes(`/api/v1/twilio/voice/recording"`));

const recOn = await postForm('/twilio/voice/call-recording', {
  RecordingStatus: 'completed', CallSid: 'CAon1', RecordingSid: 'REon1',
  RecordingUrl: 'https://api.twilio.com/recordings/REon1', RecordingDuration: '42', From: FROM, To: TO,
});
check('flag on: recording callback stores the recording', recOn.status === 200 && store.callRecordings.length === 1,
  String(store.callRecordings.length));
const row = store.callRecordings[0] || {};
check('stored row carries the call facts',
  row.callSid === 'CAon1' && row.recordingSid === 'REon1' && row.durationSec === 42 &&
  row.fromNumber === FROM && row.consentAnnouncementPlayed === true,
  JSON.stringify(row));

await postForm('/twilio/voice/call-recording', {
  RecordingStatus: 'completed', CallSid: 'CAon1', RecordingSid: 'REon1',
  RecordingUrl: 'https://api.twilio.com/recordings/REon1', RecordingDuration: '42', From: FROM, To: TO,
});
check('a redelivered callback updates instead of duplicating', store.callRecordings.length === 1);

await postForm('/twilio/voice/call-transcription', {
  CallSid: 'CAon1', TranscriptionStatus: 'completed',
  TranscriptionText: 'Customer needs the fridge fixed Friday.',
});
check('transcription attaches to the recording',
  store.callRecordings[0].transcript === 'Customer needs the fridge fixed Friday.' &&
  store.callRecordings[0].transcriptStatus === 'RECEIVED');

/* ── CRM timeline ──────────────────────────────────────────────── */
const staff = mintToken(['DISPATCHER']);
const detail = await getJson('/crm/customers/drill-cust-1', staff);
check('CRM detail answers staff', detail.status === 200, String(detail.status));
check('CRM shows the recording on the matching customer record',
  Array.isArray(detail.json?.data?.callRecordings) && detail.json.data.callRecordings.length === 1);
check('CRM recording carries the transcript',
  detail.json?.data?.callRecordings?.[0]?.transcript === 'Customer needs the fridge fixed Friday.');
check('CRM reports the flag state honestly (on)', detail.json?.data?.callRecordingEnabled === true);
const other = await getJson('/crm/customers/drill-cust-2', staff);
check('CRM excludes the recording from other customers',
  Array.isArray(other.json?.data?.callRecordings) && other.json.data.callRecordings.length === 0);
const anon = await getJson('/crm/customers/drill-cust-1');
check('CRM recordings stay staff-only (anonymous → 401)', anon.status === 401, String(anon.status));

delete process.env.CALL_RECORDING_ENABLED;
server.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
