import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { voiceConfig } from '../config/platform.js';
import { queueNotification, NOTIFICATION_TEMPLATES } from '../services/notifications.js';
import { drainEntries, normalizePhone } from '../services/senders.js';
import { logInboundContact } from '../services/trackingNumbers.js';
import { recordInboundSms } from '../services/messageThreads.js';
import { appendEvent, store } from '../data/store.js';
import { persistCustomer } from '../db/bookingsRepo.js';
import { findWinbackRecipient, isStopText } from '../services/winback.js';

/**
 * Twilio SMS — inbound text forwarder for the toll-free business line.
 *
 * Since the public platform number became the Twilio number
 * (+1 (844) 460-7038), customers text THAT number, not the owner's
 * cell. A text to it hits POST /api/v1/twilio/sms/incoming and:
 *   (a) the message is forwarded to the owner's phone
 *       (VOICE_FORWARD_TO, default 954-931-7997) through the normal
 *       notification outbox + Twilio sender, worded with the sender's
 *       number so the owner can text or call them back; and
 *   (b) the sender gets an immediate TwiML <Message> reply thanking
 *       them and pointing at online booking.
 *
 * Loop guards: a text FROM the owner's own number (he texted the
 * business line himself, or a forwarded copy bouncing back) and a
 * text from the toll-free number itself are dropped silently — no
 * forward, no auto-reply. A missing From or an empty Body is a safe
 * no-op. The webhook NEVER errors back to Twilio: if the forward
 * send fails, the outbox entry records FAILED honestly and the
 * sender still gets the thank-you reply.
 *
 * Signature validation mirrors routes/twilioVoice.js exactly
 * (validate-when-configured): when TWILIO_AUTH_TOKEN is set AND the
 * request carries an X-Twilio-Signature header, the signature must
 * verify or the request is rejected; unsigned setup tests still
 * receive TwiML. Twilio posts form-urlencoded; server.js registers
 * a urlencoded parser for the /api/v1/twilio path.
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

const REPLY_TEXT =
  'Thanks for texting Top Speed Appliance — we got your message and the team will respond shortly. ' +
  'Need service fast? Book anytime at topspeedserviceos.com/book';

async function handleIncomingSms(req, res) {
  if (!signatureOk(req)) {
    return res.status(403).type('text/plain').send('Invalid Twilio signature');
  }
  const body = req.body || {};
  const from = body.From ? normalizePhone(body.From) : '';
  const text = String(body.Body || '').trim();
  // Safe no-ops: nothing to forward, or nothing to say back.
  if (!from || !text) return emptyTwiml(res);

  const { tollFreeNumber, forwardTo } = voiceConfig();
  // Tracking-number attribution (2026-11-19): record which number
  // the text reached, as a fire-and-forget side effect.
  // logInboundContact never throws and never rejects, so the forward
  // and reply below are untouched whether the log write succeeds,
  // fails, or the database is down. The MessageSid dedupes Twilio
  // retries into one contact row.
  const trackInbound = () => {
    const dialed = String(body.To || '').trim();
    if (dialed) {
      void logInboundContact({
        channel: 'SMS',
        to: dialed,
        from,
        externalSid: body.MessageSid ? String(body.MessageSid) : null,
      });
    }
  };
  // Loop guards: never forward the owner's own texts back to him, and
  // never react to a message from the business number itself. (The
  // text still arrived at the tracked number, so it is still logged.)
  if (from === forwardTo || from === tollFreeNumber) {
    trackInbound();
    return emptyTwiml(res);
  }

  // Setter–customer threads (2026-11-20, Wave 1 D2): file the text
  // on the customer's message thread and act on a reminder reply
  // (C confirms the appointment, R flags a reschedule request for
  // the setters). ADDITIVE ONLY — fully guarded, and the forward +
  // TwiML reply below proceed exactly as before whatever happens
  // here.
  try {
    await recordInboundSms({
      from,
      text,
      externalId: body.MessageSid ? String(body.MessageSid) : null,
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'inbound SMS thread filing failed', error: String(error?.message || error) }));
  }
  // Win-back side effects (2026-11-20, D6) — fire-and-forget, exactly
  // like the tracking log above: the forward and the auto-reply below
  // are untouched whether these writes succeed, fail, or the database
  // is down.
  //  - A STOP text from a customer records their marketing opt-out
  //    (Customer.marketingOptOutAt, source SMS_STOP) — the exclusion
  //    every win-back segment honors absolutely.
  //  - Any other text from a recent win-back recipient is recorded
  //    as a campaign reply (WINBACK_REPLY platform event), which is
  //    what routes it to the setters' win-back worklist in the CRM.
  const recordWinback = () => {
    void (async () => {
      try {
        const customers = [...store.customers.values()];
        const digitsOf = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);
        const mine = customers.filter((c) => digitsOf(c.phone) === digitsOf(from));
        if (!mine.length) return;
        if (isStopText(text)) {
          for (const customer of mine) {
            if (customer.marketingOptOutAt) continue;
            customer.marketingOptOutAt = new Date().toISOString();
            customer.marketingOptOutSource = 'SMS_STOP';
            await persistCustomer(customer);
            await appendEvent('WINBACK_OPT_OUT_SET', {
              source: 'TWILIO_SMS',
              actor: 'customer',
              entityType: 'CUSTOMER',
              entityId: customer.id,
              details: { companyId: customer.companyId, source: 'SMS_STOP' },
            });
          }
          return;
        }
        const hit = findWinbackRecipient({ customers, outbox: store.notificationOutbox, fromPhone: from, now: new Date() });
        if (hit) {
          await appendEvent('WINBACK_REPLY', {
            source: 'TWILIO_SMS',
            actor: 'customer',
            entityType: 'CUSTOMER',
            entityId: hit.customer.id,
            details: {
              companyId: hit.customer.companyId,
              customerId: hit.customer.id,
              customerName: hit.customer.name || null,
              from,
              body: text,
              campaignId: hit.campaignId,
            },
          });
        }
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', message: 'win-back inbound SMS recording failed', error: String(error?.message || error) }));
      }
    })();
  };

  const forwardText =
    `New text to Top Speed (${tollFreeNumber}) from ${from}:\n${text}`;
  try {
    const entry = queueNotification({
      channel: 'sms',
      template: NOTIFICATION_TEMPLATES.STAFF_SUBMISSION_ALERT,
      to: forwardTo,
      payload: { kind: 'INBOUND_SMS', message: forwardText },
      source: 'TWILIO_SMS',
      // Twilio retries webhooks; the MessageSid keeps one text from
      // ever forwarding twice.
      eventKey: body.MessageSid ? `sms-inbound:${body.MessageSid}` : null,
      eventType: 'SUBMISSION',
    });
    // Attempt the forward now; the outcome (SENT/FAILED) is recorded
    // on the outbox entry either way — never thrown at the webhook.
    await drainEntries([entry]);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'inbound SMS forward failed', error: String(error?.message || error) }));
  }
  trackInbound();
  recordWinback();
  return res.type('text/xml').send(twiml(`<Message>${xmlEscape(REPLY_TEXT)}</Message>`));
}

router.post('/twilio/sms/incoming', handleIncomingSms);
router.get('/twilio/sms/incoming', handleIncomingSms);

export default router;
