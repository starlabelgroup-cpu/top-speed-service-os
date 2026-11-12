import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { voiceConfig } from '../config/platform.js';
import { notifyStaffAlert } from '../services/notifications.js';

/**
 * Twilio Voice — inbound call forwarding for the toll-free business line.
 *
 * A call to +1 (844) 460-7038 hits POST /api/v1/twilio/voice/incoming and
 * Twilio executes the TwiML it returns: dial the owner's phone
 * (VOICE_FORWARD_TO, default 954-931-7997) showing the toll-free number
 * as caller ID; if nobody answers, the same document continues to a
 * voicemail prompt + <Record>. When a recording completes, Twilio calls
 * POST /api/v1/twilio/voice/recording and the business gets a staff alert
 * through the notification outbox (services/notifications.js).
 *
 * This endpoint only RETURNS TwiML — it never places a call — so a direct
 * hit from anything other than Twilio is harmless. Signature validation
 * is validate-when-configured: when TWILIO_AUTH_TOKEN is set AND the
 * request carries an X-Twilio-Signature header, the signature must verify
 * (HMAC-SHA1 over the public URL + sorted POST params, per Twilio's
 * scheme) or the request is rejected. Unsigned hits (console setup
 * tests, health checks) still receive TwiML.
 *
 * Twilio posts application/x-www-form-urlencoded; server.js registers a
 * urlencoded parser for the /api/v1/twilio path.
 */
const router = Router();

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twiml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${inner}</Response>`;
}

function emptyTwiml(res) {
  return res.type('text/xml').send(twiml(''));
}

/** The public base URL Twilio reached us at (behind Vercel's proxy). */
function publicBase(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host') || '';
  return `${proto}://${host}`;
}

function signatureOk(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.get('x-twilio-signature');
  if (!token || !signature) return true; // tolerant: nothing to verify, or an unsigned setup test
  const url = `${publicBase(req)}${req.originalUrl}`;
  const params = req.body && typeof req.body === 'object' ? req.body : {};
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = createHmac('sha1', token).update(data, 'utf-8').digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

function rejectBadSignature(res) {
  return res.status(403).type('text/plain').send('Invalid Twilio signature');
}

function handleIncoming(req, res) {
  if (!signatureOk(req)) return rejectBadSignature(res);
  const { tollFreeNumber, forwardTo, dialTimeoutSeconds } = voiceConfig();
  const recordingCallback = `${publicBase(req)}/api/v1/twilio/voice/recording`;
  const body =
    `<Dial callerId="${xmlEscape(tollFreeNumber)}" timeout="${dialTimeoutSeconds}">` +
    `<Number>${xmlEscape(forwardTo)}</Number></Dial>` +
    `<Say voice="Polly.Joanna">Thanks for calling Top Speed Appliance. ` +
    `We&apos;re with another customer right now — please leave your name, number, ` +
    `and what appliance needs help, or book anytime at topspeedserviceos.com.</Say>` +
    `<Record maxLength="120" playBeep="true" method="POST" ` +
    `recordingStatusCallback="${xmlEscape(recordingCallback)}" recordingStatusCallbackMethod="POST"/>` +
    `<Say voice="Polly.Joanna">Thank you — we&apos;ll get back to you shortly. Goodbye.</Say>`;
  return res.type('text/xml').send(twiml(body));
}

router.post('/twilio/voice/incoming', handleIncoming);
router.get('/twilio/voice/incoming', handleIncoming);

/**
 * Recording status callback: when a voicemail finishes recording, alert
 * the business through the notification outbox (email + SMS staff alert
 * with the caller number and the recording link). Idempotent per
 * recording via the outbox event key.
 */
router.post('/twilio/voice/recording', (req, res) => {
  if (!signatureOk(req)) return rejectBadSignature(res);
  const body = req.body || {};
  if (body.RecordingStatus === 'completed' && body.RecordingUrl) {
    const caller = body.From || 'unknown caller';
    const reference = `VM-${String(body.CallSid || body.RecordingSid || '').slice(-8).toUpperCase() || 'CALL'}`;
    try {
      notifyStaffAlert({
        kind: 'VOICEMAIL',
        kindLabel: 'voicemail',
        reference,
        submitterName: caller,
        lines: [
          `Caller: ${caller}`,
          `Called: ${body.To || voiceConfig().tollFreeNumber}`,
          ...(body.RecordingDuration ? [`Length: ${body.RecordingDuration}s`] : []),
          `Listen: ${body.RecordingUrl}.mp3`,
        ],
        consolePath: '/notifications',
        source: 'TWILIO_VOICE',
        eventKeyBase: `voicemail:${body.RecordingSid || body.CallSid}`,
      });
    } catch (error) {
      // The alert is best-effort; Twilio only needs the 200 below.
      console.error(JSON.stringify({ level: 'error', message: 'voicemail alert failed', error: String(error?.message || error) }));
    }
  }
  return emptyTwiml(res);
});

export default router;
