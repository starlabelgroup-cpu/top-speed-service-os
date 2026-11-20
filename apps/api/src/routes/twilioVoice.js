import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { voiceConfig } from '../config/platform.js';
import { notifyStaffAlert } from '../services/notifications.js';
import { logInboundContact } from '../services/trackingNumbers.js';
import { attachCallTranscript, recordCallRecording } from '../db/callRecordingsRepo.js';
import { afterHoursAiConfig, afterHoursEntryTwiml, handleAfterHoursStep, shouldRouteToMessageService } from '../services/afterHours.js';

/**
 * Twilio Voice — inbound call forwarding for the toll-free business line.
 *
 * A call to +1 (844) 460-7038 hits POST /api/v1/twilio/voice/incoming and
 * Twilio executes the TwiML it returns: dial the owner's phone
 * (VOICE_FORWARD_TO, default 954-931-7997) showing the CALLER's own
 * number as caller ID (the toll-free number only when Twilio sends no
 * From, so the owner always sees who is actually calling); if nobody
 * answers, the same document continues to a
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
  // After-hours AI message service (F8, 2026-11-20) — SHIPS DARK.
  // shouldRouteToMessageService() is false unless Ramone activates
  // AFTER_HOURS_AI_ENABLED (and the moment is outside business
  // hours), so with the flag off this branch never runs and the
  // response below is byte-identical to the pre-existing flow. When
  // it does run, the same tracking-number log fires as a side effect.
  if (shouldRouteToMessageService()) {
    const dialed = String((req.body || {}).To || '').trim();
    const inboundFrom = String((req.body || {}).From || '').trim();
    if (dialed && inboundFrom) {
      void logInboundContact({
        channel: 'VOICE',
        to: dialed,
        from: inboundFrom,
        externalSid: String((req.body || {}).CallSid || '') || null,
      });
    }
    return res.type('text/xml').send(afterHoursEntryTwiml(publicBase(req)));
  }
  const { tollFreeNumber, forwardTo, dialTimeoutSeconds, callRecordingEnabled, callRecordingAnnouncement } =
    voiceConfig();
  // Present the inbound caller's own number to the owner's phone so he
  // sees who is calling (and can call back from his call log). Twilio
  // permits the original caller's number as the <Dial> callerId on a
  // forwarded inbound call. Fall back to the toll-free number only
  // when the webhook carries no From (console setup tests).
  const inboundFrom = String((req.body || {}).From || '').trim();
  const callerId = inboundFrom || tollFreeNumber;
  const recordingCallback = `${publicBase(req)}/api/v1/twilio/voice/recording`;
  // Call recording (D8, 2026-11-20) ships dark: while
  // CALL_RECORDING_ENABLED is off (the default), both fragments below
  // are empty strings and the TwiML is byte-identical to the
  // pre-recording document. With the flag on, the caller first hears
  // the consent announcement and the dial records both legs,
  // reporting to the call-recording callback (a different endpoint
  // from the voicemail callback above — the two flows stay distinct).
  const consentAnnouncement = callRecordingEnabled
    ? `<Say voice="Polly.Joanna">${xmlEscape(callRecordingAnnouncement)}</Say>`
    : '';
  const dialRecording = callRecordingEnabled
    ? ` record="record-from-answer-dual" recordingStatusCallback="${xmlEscape(
        `${publicBase(req)}/api/v1/twilio/voice/call-recording`,
      )}" recordingStatusCallbackMethod="POST"`
    : '';
  const body =
    consentAnnouncement +
    `<Dial callerId="${xmlEscape(callerId)}" timeout="${dialTimeoutSeconds}"${dialRecording}>` +
    `<Number>${xmlEscape(forwardTo)}</Number></Dial>` +
    `<Say voice="Polly.Joanna">Thanks for calling Top Speed Appliance. ` +
    `We&apos;re with another customer right now — please leave your name, number, ` +
    `and what appliance needs help, or book anytime at topspeedserviceos.com.</Say>` +
    `<Record maxLength="120" playBeep="true" method="POST" ` +
    `recordingStatusCallback="${xmlEscape(recordingCallback)}" recordingStatusCallbackMethod="POST"/>` +
    `<Say voice="Polly.Joanna">Thank you — we&apos;ll get back to you shortly. Goodbye.</Say>`;
  // Tracking-number attribution (2026-11-19): the response above is
  // fully computed; record which number was dialed as a
  // fire-and-forget side effect. logInboundContact never throws and
  // never rejects, so the TwiML sent below is byte-identical whether
  // the log write succeeds, fails, or the database is down.
  const dialed = String((req.body || {}).To || '').trim();
  if (dialed && inboundFrom) {
    void logInboundContact({
      channel: 'VOICE',
      to: dialed,
      from: inboundFrom,
      externalSid: String((req.body || {}).CallSid || '') || null,
    });
  }
  return res.type('text/xml').send(twiml(body));
}

router.post('/twilio/voice/incoming', handleIncoming);
router.get('/twilio/voice/incoming', handleIncoming);

/**
 * After-hours message-service steps (F8). Each Gather in the flow
 * posts here with the accumulated answers in the query string; the
 * machine lives in services/afterHours.js. Inert unless the feature
 * is enabled — with the flag off the endpoint answers an empty
 * TwiML document and files nothing, so the routes are safe to exist
 * in production before activation.
 */
async function handleAfterHoursStepRoute(req, res) {
  if (!signatureOk(req)) return rejectBadSignature(res);
  if (!afterHoursAiConfig().enabled) return emptyTwiml(res);
  try {
    const document = await handleAfterHoursStep(req, publicBase(req));
    return res.type('text/xml').send(document);
  } catch (error) {
    // A filing failure must not strand the caller mid-call: close
    // politely and let the recording/voicemail norms stand. The
    // error is logged for the office.
    console.error(JSON.stringify({ level: 'error', message: 'after-hours step failed', error: String(error?.message || error) }));
    return res.type('text/xml').send(twiml('<Say voice="Polly.Joanna">Thank you — we have your message, and a member of our team will call you back during business hours. Goodbye.</Say><Hangup/>'));
  }
}

router.post('/twilio/voice/after-hours/step', handleAfterHoursStepRoute);
router.get('/twilio/voice/after-hours/step', handleAfterHoursStepRoute);

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

/**
 * Call-recording status callback (D8, 2026-11-20) — the platform's
 * own call recording, DISTINCT from the voicemail callback above:
 * Twilio posts here when a <Dial record="record-from-answer-dual">
 * recording completes. That Dial attribute only exists while
 * CALL_RECORDING_ENABLED is on, and this handler double-guards: with
 * the flag off it acknowledges and stores NOTHING, so even a stray
 * or replayed callback can never create a recording record while
 * recording is disabled. With the flag on, a completed recording is
 * upserted by CallSid (redeliveries update the same row) for the CRM
 * customer timeline.
 */
router.post('/twilio/voice/call-recording', async (req, res) => {
  if (!signatureOk(req)) return rejectBadSignature(res);
  const body = req.body || {};
  if (voiceConfig().callRecordingEnabled && body.RecordingStatus === 'completed' && body.CallSid) {
    try {
      await recordCallRecording({
        callSid: String(body.CallSid),
        recordingSid: body.RecordingSid ? String(body.RecordingSid) : null,
        fromNumber: String(body.From || ''),
        toNumber: String(body.To || ''),
        recordingUrl: body.RecordingUrl ? String(body.RecordingUrl) : null,
        durationSec: body.RecordingDuration ? Number(body.RecordingDuration) : null,
        // The recording instruction only rides TwiML that also
        // played the consent announcement first.
        consentAnnouncementPlayed: true,
      });
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'call recording store failed', error: String(error?.message || error) }));
    }
  }
  return emptyTwiml(res);
});

/**
 * Call-transcription callback (D8): Twilio posts the transcript of a
 * recorded call here (transcription is requested on the recording
 * resource; the callback URL is configured with it). Same dark-ship
 * guard as the recording callback: flag off → acknowledged, ignored,
 * nothing stored. Flag on → the transcript attaches to the recording
 * row for the call, or the row is marked FAILED when Twilio reports
 * a transcription error.
 */
router.post('/twilio/voice/call-transcription', async (req, res) => {
  if (!signatureOk(req)) return rejectBadSignature(res);
  const body = req.body || {};
  if (voiceConfig().callRecordingEnabled && body.CallSid) {
    try {
      const failed = Boolean(body.TranscriptionStatus && body.TranscriptionStatus !== 'completed');
      await attachCallTranscript({
        callSid: String(body.CallSid),
        transcript: body.TranscriptionText ? String(body.TranscriptionText) : '',
        failed,
      });
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'call transcript store failed', error: String(error?.message || error) }));
    }
  }
  return emptyTwiml(res);
});

export default router;
