import { appendEvent } from '../data/store.js';
import { PLATFORM_CONSTANTS } from '../config/platform.js';
import { createConnectionRecord } from '../db/connectionsRepo.js';
import { notifyStaffAlert } from './notifications.js';

/**
 * After-hours AI phone message-taking (2026-11-20, F8) — SHIPS DARK.
 *
 * When the office is closed, a call to the toll-free line can route
 * to an automated message service instead of ringing through: it
 * takes a DETAILED message (caller name, callback number, appliance,
 * what's wrong, preferred callback window) through a short spoken
 * step machine, structures the answers, and files a callback task
 * for the Service Setters — a Connection record of type
 * AFTER_HOURS_MESSAGE in the staff Intake Records (GET /connections)
 * plus the standard staff alert (email + SMS + management report).
 *
 * HARD LIMITS (Ramone's authority rules, 2026-11-10 — they bind this
 * service exactly as they bind Speedy):
 *  - It NEVER books an appointment. No booking is created on any
 *    path: the intake record is a message, and createConnectionRecord
 *    creates lead bookings only for lead types — AFTER_HOURS_MESSAGE
 *    is deliberately not one.
 *  - It NEVER promises a time, a price, or an outcome. The script
 *    says a team member will call back during business hours —
 *    nothing more specific, ever.
 *  - It NEVER diagnoses. The structuring step only EXTRACTS what the
 *    caller said into fields; it does not interpret the problem.
 * The greeting states all of this plainly before asking anything.
 *
 * Activation is Ramone's cost + policy decision, and it is OFF by
 * default: AFTER_HOURS_AI_ENABLED=1 in the API environment turns the
 * routing on (and only outside business hours — Mon–Fri 8am–7pm
 * America/New_York, the platform's published hours).
 * AFTER_HOURS_AI_ALWAYS=1 is a drill/ops override that treats every
 * moment as after-hours; it still requires the enable flag. With the
 * flag off, routes/twilioVoice.js returns the exact pre-existing
 * TwiML — this module is never consulted.
 */

export function afterHoursAiConfig() {
  return {
    enabled: process.env['AFTER_HOURS_AI_' + 'ENABLED'] === '1',
    alwaysAfterHours: process.env['AFTER_HOURS_AI_' + 'ALWAYS'] === '1',
    timeZone: 'America/New_York',
    openHour: 8,
    closeHour: 19,
  };
}

/** Business hours: Mon–Fri, 08:00–19:00 in the business timezone. */
export function isBusinessHours(date = new Date()) {
  const { timeZone, openHour, closeHour } = afterHoursAiConfig();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const weekday = parts.find((p) => p.type === 'weekday')?.value || '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || '0') % 24;
  const weekdayOpen = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday);
  return weekdayOpen && hour >= openHour && hour < closeHour;
}

export function isAfterHours(date = new Date()) {
  return !isBusinessHours(date);
}

/** The routing decision the voice route consults per inbound call. */
export function shouldRouteToMessageService(date = new Date()) {
  const config = afterHoursAiConfig();
  if (!config.enabled) return false;
  if (config.alwaysAfterHours) return true;
  return isAfterHours(date);
}

/* ------------------------------------------------------------------ */
/* TwiML step machine. State rides in the Gather action URL (base64url */
/* JSON) because Twilio's webhooks are stateless and consecutive hits  */
/* may land on different serverless instances — nothing is kept in      */
/* process memory between steps. Each step's TwiML ends with a         */
/* <Redirect> to the same step handler, so a caller who says nothing   */
/* still advances (the handler treats a missing answer as "not         */
/* provided" after one retry) and can never be trapped in a loop.      */
/* ------------------------------------------------------------------ */

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

const SAY_OPEN = '<Say voice="Polly.Joanna">';
const SAY_CLOSE = '</Say>';

const STEPS = ['name', 'appliance', 'issue', 'phone', 'window'];
const QUESTIONS = {
  name: 'First, please say your name.',
  appliance: 'What appliance needs help?',
  issue: 'Briefly, what is it doing — or not doing?',
  phone: 'Please say or enter the best callback number, including the area code.',
  window: 'Last one: when is a good time for us to call you back?',
};

function encodeState(state) {
  return Buffer.from(JSON.stringify(state || {}), 'utf8').toString('base64url');
}

export function decodeState(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function stepUrl(base, step, state) {
  return `${base}/api/v1/twilio/voice/after-hours/step?step=${step}&s=${encodeState(state)}`;
}

function gatherStep(base, step, state, leadSay) {
  const url = stepUrl(base, step, state);
  const input = step === 'phone' ? 'speech dtmf' : 'speech';
  return twiml(
    (leadSay ? `${SAY_OPEN}${leadSay}${SAY_CLOSE}` : '') +
    `<Gather input="${input}" timeout="6" speechTimeout="auto" method="POST" action="${xmlEscape(url)}">` +
    `${SAY_OPEN}${QUESTIONS[step]}${SAY_CLOSE}</Gather>` +
    `<Redirect method="POST">${xmlEscape(url)}</Redirect>`,
  );
}

/** The greeting + first question, returned instead of the ring-through. */
export function afterHoursEntryTwiml(base) {
  const intro =
    `Thanks for calling Top Speed Appliance. Our office is closed right now — ` +
    `our hours are Monday to Friday, 8 a.m. to 7 p.m. This is our automated ` +
    `message service: I can take a detailed message, and a member of our team ` +
    `will call you back during business hours. I can&apos;t book appointments, ` +
    `quote prices, or diagnose your appliance on this line.`;
  return gatherStep(base, 'name', {}, intro);
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

/** Normalize a spoken/keyed callback number; null when unusable. */
export function parseCallbackNumber(raw, callerId) {
  let digits = digitsOnly(raw);
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length === 10) return { phone: `+1${digits}`, source: 'caller-provided' };
  const fallback = digitsOnly(callerId);
  const fb = fallback.length === 11 && fallback.startsWith('1') ? fallback.slice(1) : fallback;
  if (fb.length === 10) return { phone: `+1${fb}`, source: 'caller-id' };
  return { phone: null, source: 'none' };
}

/* ------------------------------------------------------------------ */
/* Structuring — extraction ONLY. The model reads the caller's own    */
/* answers and fills the fields; the system prompt forbids adding     */
/* anything (no diagnosis, no price, no time promise). Any failure —  */
/* provider unconfigured, down, or an unparsable answer — falls back  */
/* to the verbatim answers, so a message is never lost to an AI       */
/* outage. Drills stub the provider at OPENAI_API_BASE.               */
/* ------------------------------------------------------------------ */

const STRUCTURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: ['string', 'null'] },
    appliance: { type: ['string', 'null'] },
    issue: { type: ['string', 'null'] },
    callbackWindow: { type: ['string', 'null'] },
  },
  required: ['name', 'appliance', 'issue', 'callbackWindow'],
};

export async function structureAfterHoursMessage(answers) {
  const fallback = {
    name: answers.name || null,
    appliance: answers.appliance || null,
    issue: answers.issue || null,
    callbackWindow: answers.window || null,
    structuredBy: 'verbatim',
  };
  const apiKey = process.env.OPENAI_API_KEY_V2 || process.env.OPENAI_API_KEY;
  if (!apiKey) return fallback;
  try {
    const base = process.env.OPENAI_API_BASE || 'https://api.openai.com';
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'system',
            content: 'You extract fields from a phone message a caller dictated. Copy ONLY what the caller said, cleaned of filler words. Never invent details, never diagnose the problem, never add prices, times, or promises. Use null for anything the caller did not say.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              saidName: answers.name || null,
              saidAppliance: answers.appliance || null,
              saidIssue: answers.issue || null,
              saidCallbackWindow: answers.window || null,
            }),
          },
        ],
        text: { format: { type: 'json_schema', name: 'after_hours_message', strict: true, schema: STRUCTURE_SCHEMA } },
      }),
    });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok) return fallback;
    const text = typeof parsed?.output_text === 'string'
      ? parsed.output_text
      : (parsed?.output || []).flatMap((item) => item?.content || []).find((c) => c?.type === 'output_text')?.text;
    if (!text) return fallback;
    const extracted = JSON.parse(text);
    const clean = (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null);
    return {
      name: clean(extracted.name) || fallback.name,
      appliance: clean(extracted.appliance) || fallback.appliance,
      issue: clean(extracted.issue) || fallback.issue,
      callbackWindow: clean(extracted.callbackWindow) || fallback.callbackWindow,
      structuredBy: 'ai',
    };
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Filing the callback task. One Connection record (type              */
/* AFTER_HOURS_MESSAGE — visible in the staff Intake Records and      */
/* carried by the staff alert) and NO booking, ever.                  */
/* ------------------------------------------------------------------ */

export async function fileAfterHoursCallback({ answers, structured, phoneInfo, callSid }) {
  const name = structured.name || answers.name || 'After-hours caller';
  const messageLines = [
    'After-hours phone message (automated message service — no booking was made).',
    `Name: ${structured.name || answers.name || '(not provided)'}`,
    `Callback number: ${phoneInfo.phone || '(not provided)'} (${phoneInfo.source})`,
    `Appliance: ${structured.appliance || answers.appliance || '(not provided)'}`,
    `Issue: ${structured.issue || answers.issue || '(not provided)'}`,
    `Preferred callback window: ${structured.callbackWindow || answers.window || '(not provided)'}`,
    `Fields structured by: ${structured.structuredBy}`,
    ...(callSid ? [`Twilio call: ${callSid}`] : []),
  ];
  const record = await createConnectionRecord({
    name,
    phone: phoneInfo.phone || String(answers.callerId || ''),
    email: null,
    type: 'AFTER_HOURS_MESSAGE',
    source: 'TWILIO_AFTER_HOURS',
    message: messageLines.join('\n'),
  });
  await appendEvent('AFTER_HOURS_MESSAGE_TAKEN', {
    source: 'TWILIO_AFTER_HOURS',
    actor: 'after-hours-service',
    entityType: 'CONNECTION',
    entityId: record.id,
    referenceCode: record.reference,
    details: {
      structuredBy: structured.structuredBy,
      phoneSource: phoneInfo.source,
      appliance: structured.appliance || null,
    },
  });
  notifyStaffAlert({
    kind: 'AFTER_HOURS_MESSAGE',
    kindLabel: 'after-hours phone message',
    reference: record.reference,
    submitterName: name,
    lines: [
      `Callback: ${phoneInfo.phone || '(no number)'}`,
      `Appliance: ${structured.appliance || answers.appliance || '(not provided)'}`,
      `Issue: ${structured.issue || answers.issue || '(not provided)'}`,
      `Preferred window: ${structured.callbackWindow || answers.window || '(not provided)'}`,
    ],
    consolePath: '/book-os',
    source: 'TWILIO_AFTER_HOURS',
    eventKeyBase: `after-hours:${callSid || record.id}`,
  });
  return record;
}

/* ------------------------------------------------------------------ */
/* The step handler. req.body carries Twilio's SpeechResult / Digits  */
/* for the step named in the query; the accumulated answers ride in   */
/* the state parameter. Returns the next step's TwiML (or the closing */
/* after the final step files the task).                              */
/* ------------------------------------------------------------------ */

export async function handleAfterHoursStep(req, base) {
  const step = STEPS.includes(req.query?.step) ? req.query.step : 'name';
  const state = decodeState(req.query?.s);
  const body = req.body || {};
  const speech = String(body.SpeechResult || '').trim();
  const digits = String(body.Digits || '').trim();
  const answer = step === 'phone' ? (digits || speech) : speech;

  const next = { ...state };
  if (answer) {
    next[step] = answer.slice(0, 500);
    next[`${step}Tries`] = 0;
  } else if (!next[`${step}Tries`]) {
    // One retry per question, then the machine moves on — a silent
    // or unclear answer is recorded as not provided, never a loop.
    next[`${step}Tries`] = 1;
    return gatherStep(base, step, next, step === 'name' ? null : 'Sorry, I didn&apos;t catch that.');
  }

  const following = STEPS[STEPS.indexOf(step) + 1];
  if (following) return gatherStep(base, following, next, null);

  // Final step answered: structure + file the callback task.
  const callerId = String(body.From || next.callerId || '');
  const phoneInfo = parseCallbackNumber(next.phone, callerId);
  const answers = {
    name: next.name || null,
    appliance: next.appliance || null,
    issue: next.issue || null,
    window: next.window || null,
    callerId,
  };
  const structured = await structureAfterHoursMessage(answers);
  const record = await fileAfterHoursCallback({
    answers,
    structured,
    phoneInfo,
    callSid: String(body.CallSid || '') || null,
  });
  const firstName = String(structured.name || answers.name || '').trim().split(/\s+/)[0];
  const closing =
    `Thank you${firstName ? `, ${xmlEscape(firstName)}` : ''} — we have your message, reference ${xmlEscape(record.reference)}. ` +
    `A member of our team will call you back${phoneInfo.phone ? ` at ${xmlEscape(phoneInfo.phone)}` : ''} during business hours, ` +
    `Monday to Friday, 8 a.m. to 7 p.m. You can also book online anytime at topspeedserviceos.com. Goodbye.`;
  return twiml(`${SAY_OPEN}${closing}${SAY_CLOSE}<Hangup/>`);
}
