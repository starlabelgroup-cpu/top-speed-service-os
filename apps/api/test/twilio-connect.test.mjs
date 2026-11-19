/**
 * Twilio full-connection drills (2026-11-18 — the owner upgraded the
 * Twilio account out of trial: "I paid for full access to twillo
 * let's connect fully").
 *
 * Before this build, services/senders.js channelHealth() hardcoded
 * sms.trial = true, so the Notifications console, the Link Center
 * banner and the Speedy receipt copy all kept claiming a trial
 * account no matter what Twilio's actual state was. The fix reads
 * the account state from Twilio itself (GET /Accounts/{sid}.json →
 * type "Trial" | "Full", cached) and words every surface for the
 * probed state. These drills stub Twilio at TWILIO_API_BASE and
 * prove, in-process against the real services (no database — the
 * skeleton mode, exactly like outbox-drain.test.mjs):
 *
 *   (a) the probe reports trial=false for a "Full" account,
 *       trial=true for a "Trial" account, and null (unknown — never
 *       guessed) when Twilio cannot be reached;
 *   (b) with an upgraded account, an outbox SMS entry drains to SENT
 *       through the real Twilio sender (provider + message id kept);
 *   (c) Layer 2 sends its sign-in code by SMS for real on the
 *       upgraded account: sendLayer2Code returns sent on the SMS
 *       channel, the code in the stubbed message body verifies, and
 *       a wrong code is refused;
 *   (d) with a trial account whose sends Twilio rejects (21608), the
 *       same Layer 2 send still fails honestly — 502 with the
 *       trial-plan wording and the outbox entry FAILED, never SENT.
 *
 * Usage: node test/twilio-connect.test.mjs
 * Exit code 0 = every check passed.
 */
import { createServer } from 'node:http';

// Environment BEFORE importing the services: no database (skeleton
// mode), Twilio + Resend pointed at the local stub.
const STUB_PORT = Number(process.env.STUB_PORT || 4479);
delete process.env['DATABASE_' + 'URL'];
delete process.env['DATABASE_' + 'URL_UNPOOLED'];
delete process.env['SENDGRID_' + '_API_KEY'];
delete process.env['VONAGE_' + '_API_KEY'];
delete process.env['VONAGE_' + '_API_SECRET'];
process.env['JWT_' + 'SECRET'] = 'twilio-connect-drill-secret';
process.env['TWILIO_' + 'ACCOUNT_SID'] = 'ACtwilioconnectdrill';
process.env['TWILIO_' + 'AUTH_TOKEN'] = 'drill-twilio-token';
process.env['TWILIO_' + 'PHONE_NUMBER'] = '+18445550100';
process.env['TWILIO_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;
process.env['RESEND_' + 'API_KEY'] = 'drill-resend-key';
process.env['RESEND_' + 'API_BASE'] = `http://127.0.0.1:${STUB_PORT}`;

// Stub behavior, flipped between phases.
let accountType = 'Full'; // 'Trial' | 'Full' | 'Error'
let smsBehavior = 'ok'; // 'ok' | 'trialfail'
const smsCaptures = [];
let smsSeq = 0;

const stub = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (req.method === 'GET' && req.url.includes('/2010-04-01/Accounts/')) {
      if (accountType === 'Error') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'stub account lookup failure' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sid: 'ACtwilioconnectdrill', type: accountType, status: 'active', friendly_name: 'Drill' }));
      return;
    }
    if (req.method === 'POST' && req.url.includes('/Messages.json')) {
      const form = new URLSearchParams(raw);
      smsCaptures.push({ to: form.get('To'), from: form.get('From'), body: form.get('Body') });
      if (smsBehavior === 'trialfail') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 21608, message: "The 'To' number is not a verified number for this trial account." }));
        return;
      }
      smsSeq += 1;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sid: `SMtwiliodrill${smsSeq}`, status: 'queued' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/emails') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'resend-drill' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});
await new Promise((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));

const { store } = await import('../src/data/store.js');
const senders = await import('../src/services/senders.js');
const { queueNotification } = await import('../src/services/notifications.js');
const layer2 = await import('../src/services/layer2.js');

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }
function checkIncludes(label, haystack, needle) {
  const ok = typeof haystack === 'string' && haystack.includes(needle);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (want text containing ${JSON.stringify(needle)})`);
}

function drillUser(id, phone) {
  const user = {
    id, companyId: 'drill-company', email: `${id}@example.com`, firstName: 'Drill',
    phone, roles: ['CUSTOMER'], active: true, layer2Required: true,
  };
  store.users.set(id, user);
  return user;
}

// ── (a) Probe states ────────────────────────────────────────────────
accountType = 'Full';
senders.resetTwilioTrialCache();
check('probe: upgraded account reports trial=false', await senders.twilioTrialState(), false);
check('channelHealth carries the probed full state', senders.channelHealth({ smsTrial: false }).sms.trial, false);
check('channelHealth default is unknown (null), never a guess', senders.channelHealth().sms.trial, null);
check('sms channel configured', senders.channelConfigured('sms'), true);

accountType = 'Error';
senders.resetTwilioTrialCache();
check('probe: unreachable Twilio reports unknown (null)', await senders.twilioTrialState(), null);

// ── (b) Outbox SMS on the upgraded account → SENT ───────────────────
accountType = 'Full';
smsBehavior = 'ok';
const outEntry = queueNotification({
  channel: 'sms', template: 'LINK_SEND', to: '9545550142',
  payload: { message: 'Twilio connect drill text' }, source: 'TWILIO_CONNECT_DRILL',
});
await senders.drainEntries([outEntry]);
check('outbox SMS: status SENT on upgraded account', outEntry.status, 'SENT');
check('outbox SMS: provider is twilio', outEntry.provider, 'twilio');
checkTrue('outbox SMS: provider message id recorded', String(outEntry.providerId || '').startsWith('SMtwiliodrill'));
const outCapture = smsCaptures.find((c) => c.body === 'Twilio connect drill text');
check('outbox SMS: stub received the send to the E.164 number', outCapture?.to, '+19545550142');
check('outbox SMS: sent from the configured number', outCapture?.from, '+18445550100');

// ── (c) Layer 2 SMS on the upgraded account ─────────────────────────
const user1 = drillUser('twilio-drill-user-1', '9545550142');
check('layer2 status: sms channel configured', layer2.layer2StatusView(user1).smsConfigured, true);
const view1 = await layer2.beginLayer2Challenge(user1);
const sent1 = await layer2.sendLayer2Code(view1.challenge, 'SMS');
check('layer2 SMS: send accepted', sent1.sent, true);
check('layer2 SMS: channel is SMS', sent1.channel, 'SMS');
check('layer2 SMS: destination masked to last 4', sent1.destination, '•••0142');
const codeCapture = smsCaptures.find((c) => String(c.body || '').includes('Top Speed sign-in code:'));
checkTrue('layer2 SMS: stub delivered a code text', Boolean(codeCapture));
const realCode = /sign-in code: (\d{6})/.exec(codeCapture?.body || '')?.[1];
checkTrue('layer2 SMS: code present in the text body', /^\d{6}$/.test(realCode || ''));
const wrongCode = realCode === '999999' ? '111111' : '999999';
let wrongError = null;
try { await layer2.verifyLayer2Code(view1.challenge, wrongCode); } catch (error) { wrongError = error; }
check('layer2 SMS: wrong code refused 401', wrongError?.status, 401);
const verified = await layer2.verifyLayer2Code(view1.challenge, realCode);
check('layer2 SMS: the texted code verifies the sign-in', verified.user.id, user1.id);
check('layer2 SMS: not a bypass (alreadySatisfied false)', verified.alreadySatisfied, false);

// ── (d) Trial account: honest failure, trial wording ────────────────
accountType = 'Trial';
smsBehavior = 'trialfail';
senders.resetTwilioTrialCache();
check('probe: trial account reports trial=true', await senders.twilioTrialState(), true);
const user2 = drillUser('twilio-drill-user-2', '9545550143');
const view2 = await layer2.beginLayer2Challenge(user2);
let sendError = null;
try { await layer2.sendLayer2Code(view2.challenge, 'SMS'); } catch (error) { sendError = error; }
check('layer2 SMS on trial: send fails 502', sendError?.status, 502);
check('layer2 SMS on trial: error code', sendError?.code, 'LAYER2_SEND_FAILED');
checkIncludes('layer2 SMS on trial: wording names the plan limit', sendError?.message || '', 'messaging plan');
const trialEntry = [...store.notificationOutbox].reverse()
  .find((e) => e.template === 'LAYER2_SIGNIN_CODE' && e.channel === 'sms' && e.to === '+19545550143');
check('trial outbox entry: FAILED, never SENT', trialEntry?.status, 'FAILED');
checkIncludes('trial outbox entry: carries Twilio\'s reason', trialEntry?.error || '', 'verified');

await new Promise((resolve) => stub.close(resolve));
console.log(failures === 0 ? '\nALL TWILIO-CONNECT CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
