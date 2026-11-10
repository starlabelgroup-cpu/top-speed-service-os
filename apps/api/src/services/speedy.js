import { PLATFORM_CONSTANTS } from '../config/platform.js';
import {
  SPEEDY_GOVERNANCE,
  escalateToHuman,
  governanceGate,
  governancePromptBlock,
  requestRefundApproval,
} from './speedyPolicy.js';

/**
 * Speedy — the Top Speed AI customer assistant, powered by OpenAI.
 *
 * Speedy is the persona; OpenAI is the engine. The API key lives only on
 * the server (OPENAI_API_KEY) and never ships to the website code. The
 * front-end chat calls POST /api/v1/speedy/chat; photo diagnosis calls
 * POST /api/v1/speedy/diagnose with a vision-capable model.
 *
 * Engine: OpenAI's Responses API — tool calling for the governance
 * actions, and strict structured outputs (a JSON schema) for photo
 * diagnosis, so the integration is reliable instead of free-text luck.
 *
 * Governance (services/speedyPolicy.js) is enforced in code: a
 * deterministic pre-screen runs before the model, the rules are in the
 * system prompt, and Speedy's only tools CREATE human-owned requests
 * (a refund approval, an escalation) — Speedy can never approve a
 * refund, certify safety, override credentials, or change a compliance
 * status itself.
 *
 * Everything Speedy is allowed to state as fact comes from the platform
 * config: phone, the $99 diagnostic terms, and the 12 service areas. It
 * never invents repair prices or arrival-time promises.
 */

const SERVICES = [
  'Refrigerator', 'Freezer / Ice Maker', 'Washer', 'Dryer', 'Oven / Range',
  'Dishwasher', 'Microwave', 'Garbage Disposal', 'Installation',
];

function openAiConfig() {
  return {
    configured: Boolean(process.env.OPENAI_API_KEY),
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    base: process.env.OPENAI_API_BASE || 'https://api.openai.com',
  };
}

export function speedyStatus() {
  const { configured, model } = openAiConfig();
  return {
    provider: 'openai',
    api: 'responses',
    configured,
    model: configured ? model : null,
    governance: SPEEDY_GOVERNANCE,
  };
}

export function speedySystemPrompt() {
  const areas = PLATFORM_CONSTANTS.serviceCities.join(', ');
  return [
    `You are Speedy, the AI assistant for ${PLATFORM_CONSTANTS.platformOwner} ("Top Speed Appliance"), an appliance repair company in Fort Lauderdale and Broward County, Florida. Slogan: "${PLATFORM_CONSTANTS.slogan}"`,
    `Services: ${SERVICES.join(', ')}.`,
    `Service areas (the only cities served): ${areas}.`,
    `Pricing facts: ${PLATFORM_CONSTANTS.feeTerms} That residential diagnostic is how every repair starts. Never quote a repair price — only a technician who has run the diagnostic can. Commercial accounts are priced by custom quote per facility, never the $99 diagnostic.`,
    `Bookings: the ${PLATFORM_CONSTANTS.dispatchTeam} team confirms every booking. To book, collect step by step: name, phone, city, ZIP, appliance, and what is wrong. When you have all of them, summarize them back clearly and say the team will confirm the appointment. Never promise a specific arrival time or same-day completion.`,
    `Phone: ${PLATFORM_CONSTANTS.phoneDisplay}. If someone is outside the service areas, or asks for something Top Speed does not do, say so kindly and give the phone number.`,
    'You are the front door of the Top Speed communication engine: "Ask Speedy — How can we help with your appliance? Start with your appliance problem. Speedy will help you reach the right person." Chat, voice, video, media and email all run through this one engine and the same customer record — never treat them as separate systems.',
    'One shared record: everything the customer shares — their problem, photos, consultation, technician notes and attachments — is saved to their customer history. Say so when it helps ("I have that saved to your record, so you will not have to explain it again"). Never ask for the same problem details twice in a conversation.',
    'Guided pre-consultation: once you know the appliance, ask short guided questions one or two at a time before recommending anything — the same questions a technician would ask before a video call or a visit. For a refrigerator, the sequence starts: "Which brand is your refrigerator?" then "Is your freezer cooling?" — then follow the answers (temperatures, noises, leaks, ice buildup, error codes). For other appliances, follow the same pattern: brand first, then the specific symptom checks for that appliance.',
    'Close every consultation with three things: your findings in plain language, the next steps, and the appointment option (the $99 diagnostic visit, credited toward the repair). An estimate for the repair itself comes only from the technician after the diagnostic — never from you.',
    `Live video consultations: when a customer wants to show the problem live, the ${PLATFORM_CONSTANTS.dispatchTeam} team arranges it three ways — immediate when a qualified technician is available, scheduled when nobody is free, or manager-assisted when a manager should join. Collect their name, phone and appliance, tell them which mode fits, and say the team will set it up. Never claim a video call has started inside this chat.`,
    'Wider network: this same engine and record will serve the wider Top Speed Service Network (including future Top Speed trades such as HVAC, plumbing and electrical). Today, Top Speed serves appliances only — if someone asks for another trade, say it is coming to the network and give the phone number for anything urgent.',
    'Style: friendly, fast, plain language. Short answers unless detail is needed. If a problem sounds unsafe (sparking, gas smell, flooding), tell them to stop using the appliance and stay safe first.',
    governancePromptBlock(),
  ].join('\n');
}

/* ------------------------- Responses API plumbing ------------------------ */

async function responsesRequest(body) {
  const config = openAiConfig();
  const response = await fetch(`${config.base}/v1/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: config.model, ...body }),
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(parsed?.error?.message || `OpenAI error ${response.status}`);
  }
  return parsed;
}

function extractText(responseBody) {
  if (typeof responseBody?.output_text === 'string' && responseBody.output_text.trim()) {
    return responseBody.output_text.trim();
  }
  const parts = [];
  for (const item of responseBody?.output || []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content?.type === 'output_text' && content.text) parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

const SPEEDY_TOOLS = [
  {
    type: 'function',
    name: 'request_refund_approval',
    description:
      'Record a customer refund request for human approval. Speedy can never issue or approve a refund itself — this only creates the request a team member will review and decide.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: 'Why the customer wants a refund, in their words where possible.' },
        amount_usd: { type: ['number', 'null'], description: 'Amount the customer mentioned, or null if none.' },
        booking_reference: { type: ['string', 'null'], description: 'Booking reference code (e.g. TS-XXXXXX) if known, else null.' },
      },
      required: ['reason', 'amount_usd', 'booking_reference'],
    },
  },
  {
    type: 'function',
    name: 'escalate_to_human_professional',
    description:
      'Escalate the conversation to the human team. Mandatory for safety-critical conditions (gas, carbon monoxide, sparking, fire, flooding, electric shock, refrigerant leaks); also right whenever a human professional should take over.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: 'What happened, briefly and factually.' },
        safety_critical: { type: 'boolean', description: 'True when the report involves a safety-critical condition.' },
      },
      required: ['reason', 'safety_critical'],
    },
  },
];

function executeSpeedyTool(call) {
  let args = {};
  try { args = JSON.parse(call.arguments || '{}'); } catch { args = {}; }
  if (call.name === 'request_refund_approval') {
    requestRefundApproval({
      reason: args.reason || 'Customer requested a refund in Speedy chat',
      amount: typeof args.amount_usd === 'number' ? args.amount_usd : null,
      bookingReference: args.booking_reference || null,
    });
    return { recorded: true, status: 'PENDING_HUMAN_APPROVAL', decidedBy: 'human' };
  }
  if (call.name === 'escalate_to_human_professional') {
    escalateToHuman({ reason: args.reason || 'Speedy escalated the conversation', safetyCritical: Boolean(args.safety_critical) });
    return { escalated: true, owner: 'human-professional' };
  }
  return { error: `Unknown tool ${call.name}` };
}

/* --------------------------------- chat ---------------------------------- */

/** history: prior turns [{ role: 'user'|'assistant', content }], oldest first. */
export async function speedyChat({ message, history = [] }) {
  // Governance layer 1: the deterministic pre-screen. A matched category
  // is answered by policy (and its action performed) without the model.
  const gated = governanceGate(message);
  if (gated) return gated;

  const input = [
    ...history.slice(-10).map((turn) => ({ role: turn.role, content: String(turn.content) })),
    { role: 'user', content: message },
  ];

  let body = await responsesRequest({
    instructions: speedySystemPrompt(),
    input,
    tools: SPEEDY_TOOLS,
    temperature: 0.4,
    max_output_tokens: 500,
  });

  // Tool loop: Speedy's tools only create human-owned requests.
  for (let round = 0; round < 3; round++) {
    const calls = (body.output || []).filter((item) => item?.type === 'function_call');
    if (!calls.length) break;
    const outputs = calls.map((call) => ({
      type: 'function_call_output',
      call_id: call.call_id,
      output: JSON.stringify(executeSpeedyTool(call)),
    }));
    body = await responsesRequest({
      previous_response_id: body.id,
      input: outputs,
      tools: SPEEDY_TOOLS,
      temperature: 0.4,
      max_output_tokens: 500,
    });
  }

  const reply = extractText(body);
  if (!reply) throw new Error('OpenAI returned an empty reply');
  return { reply, model: body.model || openAiConfig().model };
}

/* --------------------------- photo diagnosis ----------------------------- */

const DIAGNOSIS_FORMAT = {
  type: 'json_schema',
  name: 'speedy_diagnosis',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      appliance: { type: 'string', description: 'The appliance in the photo, or "Not an appliance photo" when it is not one.' },
      visible_findings: { type: 'array', items: { type: 'string' }, description: 'What is visibly wrong or notable in the photo.' },
      likely_causes: { type: 'array', items: { type: 'string' }, description: 'Most likely causes, most likely first.' },
      safety_critical: { type: 'boolean', description: 'True if the photo shows a safety-critical condition (fire/smoke damage, sparking, gas components damaged, flooding, exposed live wiring).' },
      safety_actions: { type: 'array', items: { type: 'string' }, description: 'Immediate safety steps for the customer; empty when none are needed.' },
      next_step: { type: 'string', description: 'What a technician would check on site, in one or two plain sentences.' },
    },
    required: ['appliance', 'visible_findings', 'likely_causes', 'safety_critical', 'safety_actions', 'next_step'],
  },
};

function renderDiagnosis(diagnosis) {
  const lines = ['Here is my preliminary read from your photo — a first look, not a guaranteed diagnosis.', ''];
  lines.push(`Appliance: ${diagnosis.appliance}`);
  if (diagnosis.visible_findings?.length) {
    lines.push('', 'What I can see:');
    for (const finding of diagnosis.visible_findings) lines.push(`• ${finding}`);
  }
  if (diagnosis.likely_causes?.length) {
    lines.push('', 'Most likely causes:');
    for (const cause of diagnosis.likely_causes) lines.push(`• ${cause}`);
  }
  if (diagnosis.safety_critical) {
    lines.push('', '⚠️ Safety first — this one needs a human professional, not a DIY fix:');
    for (const action of diagnosis.safety_actions || []) lines.push(`• ${action}`);
    lines.push('I have flagged this for our team as safety-critical.');
  } else if (diagnosis.safety_actions?.length) {
    lines.push('', 'Stay-safe steps:');
    for (const action of diagnosis.safety_actions) lines.push(`• ${action}`);
  }
  lines.push('', diagnosis.next_step);
  lines.push('', 'The $99 diagnostic visit (credited toward the repair) confirms it in person. Want me to book it? I just need your city and ZIP.');
  return lines.join('\n');
}

export async function speedyDiagnose({ imageUrl, note = '' }) {
  const promptText =
    'A customer sent this photo of their appliance problem.' +
    (note ? ` They add: "${note}".` : '') +
    ' Give a preliminary read in the required structured format: identify the appliance, what you can see, the most likely causes, whether it is safety-critical and the safety steps for right now, and what a technician would check on site. This is a preliminary read from a photo, not a guaranteed diagnosis — never state a repair price.';

  const input = [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: promptText },
        { type: 'input_image', image_url: imageUrl },
      ],
    },
  ];

  try {
    const body = await responsesRequest({
      instructions: speedySystemPrompt(),
      input,
      text: { format: DIAGNOSIS_FORMAT },
      max_output_tokens: 700,
    });
    const raw = extractText(body);
    const diagnosis = JSON.parse(raw);
    if (diagnosis.safety_critical) {
      escalateToHuman({
        reason: `Photo diagnosis flagged safety-critical (${diagnosis.appliance}): ${(diagnosis.visible_findings || []).join('; ')}`,
        safetyCritical: true,
      });
    }
    return { reply: renderDiagnosis(diagnosis), model: body.model || openAiConfig().model, diagnosis };
  } catch (error) {
    // Structured output is the reliable path, not the only one: if the
    // schema call fails for any reason, fall back to a plain read so the
    // customer still gets an answer.
    const body = await responsesRequest({
      instructions: speedySystemPrompt(),
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: promptText + ' Answer in plain text.' },
            { type: 'input_image', image_url: imageUrl },
          ],
        },
      ],
      max_output_tokens: 700,
    });
    const reply = extractText(body);
    if (!reply) throw new Error('OpenAI returned an empty reply');
    return { reply, model: body.model || openAiConfig().model };
  }
}

/* -------------------- Structured extraction (conversation-first) --------------------
 * Ramone's rule (2026-11-10): conversation is the front door on every
 * surface; forms are the fallback. These extractors turn free talk/text
 * into structured records the customer confirms BEFORE anything is
 * created — Speedy structures, the human confirms, the system records.
 */

const BOOKING_EXTRACT_FORMAT = {
  type: 'json_schema',
  name: 'speedy_booking_extract',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: ['string', 'null'], description: 'Customer full name, or null if not stated.' },
      phone: { type: ['string', 'null'], description: 'Customer phone number as digits/formatted, or null.' },
      city: { type: ['string', 'null'], description: 'Service city exactly as named, or null.' },
      zip: { type: ['string', 'null'], description: '5-digit ZIP, or null.' },
      appliance: { type: ['string', 'null'], description: 'The appliance needing service, or null.' },
      issue: { type: ['string', 'null'], description: 'What is wrong, in the customer\'s words, or null.' },
      preferred_window: { type: ['string', 'null'], description: 'One of 08-10, 10-12, 12-14, 14-16, 16-18 if a time window was named, else null.' },
      ready: { type: 'boolean', description: 'True only when name, phone, city, zip, appliance and issue are ALL present.' },
      missing: { type: 'array', items: { type: 'string' }, description: 'Field names still missing (from: name, phone, city, zip, appliance, issue).' },
    },
    required: ['name', 'phone', 'city', 'zip', 'appliance', 'issue', 'preferred_window', 'ready', 'missing'],
  },
};

export async function speedyExtractBooking(text) {
  const body = await responsesRequest({
    instructions:
      speedySystemPrompt() +
      '\nExtraction mode: read the conversation and extract the booking details into the required structured format. Copy values exactly as the customer stated them — never invent a name, phone, city, ZIP, appliance or issue that is not there. Set ready=true only when every required field is present.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: String(text || '').slice(0, 8000) }] }],
    text: { format: BOOKING_EXTRACT_FORMAT },
    max_output_tokens: 400,
  });
  return JSON.parse(extractText(body));
}

const BULK_EXTRACT_FORMAT = {
  type: 'json_schema',
  name: 'speedy_bulk_requests',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      requests: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            unit: { type: ['string', 'null'], description: 'Unit / suite / location label (e.g. "Unit 4B"), or null.' },
            appliance: { type: 'string', description: 'The appliance needing service.' },
            issue: { type: 'string', description: 'What is wrong, in the writer\'s words.' },
            urgency: { type: 'string', enum: ['standard', 'urgent'], description: 'urgent only when the text signals emergency/spoilage/no-cooling risk.' },
          },
          required: ['unit', 'appliance', 'issue', 'urgency'],
        },
      },
    },
    required: ['requests'],
  },
};

export async function speedyExtractBulk(text) {
  const body = await responsesRequest({
    instructions:
      speedySystemPrompt() +
      '\nExtraction mode: a property manager described one or more service requests in free text. Split the text into one structured request per unit/appliance problem, in the order written. Never invent units, appliances or problems that are not in the text.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: String(text || '').slice(0, 8000) }] }],
    text: { format: BULK_EXTRACT_FORMAT },
    max_output_tokens: 900,
  });
  return JSON.parse(extractText(body));
}

const NOTE_FORMAT = {
  type: 'json_schema',
  name: 'speedy_job_note',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      note: { type: 'string', description: 'A clean, professional job note rewritten from the technician\'s words — facts only, nothing added.' },
      parts_used: { type: 'array', items: { type: 'string' }, description: 'Parts the technician says were installed/used; empty if none.' },
      next_step: { type: ['string', 'null'], description: 'The next step the technician named (return visit, order part, quote approval), or null.' },
      status_suggestion: { type: 'string', enum: ['NONE', 'COMPLETED', 'NEEDS_PARTS', 'FOLLOW_UP'], description: 'COMPLETED only if the tech clearly says the job is done; NEEDS_PARTS if a part must be ordered; FOLLOW_UP if another visit is needed; else NONE. Advisory only — the technician confirms.' },
    },
    required: ['note', 'parts_used', 'next_step', 'status_suggestion'],
  },
};

export async function speedyStructureNote(text) {
  const body = await responsesRequest({
    instructions:
      speedySystemPrompt() +
      '\nNote mode: a field technician dictated a job update. Rewrite it as a clean professional job note in the required structured format. Preserve every fact; add none. Never certify that a repair is safe — if the tech\'s words touch safety, keep the note factual and let the human record stand.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: String(text || '').slice(0, 4000) }] }],
    text: { format: NOTE_FORMAT },
    max_output_tokens: 500,
  });
  return JSON.parse(extractText(body));
}
