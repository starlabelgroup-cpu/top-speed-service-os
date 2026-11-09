import { PLATFORM_CONSTANTS } from '../config/platform.js';

/**
 * Speedy — the Top Speed AI customer assistant, powered by OpenAI.
 *
 * Speedy is the persona; OpenAI is the engine. The API key lives only on
 * the server (OPENAI_API_KEY) and never ships to the website code. The
 * front-end chat calls POST /api/v1/speedy/chat; photo diagnosis calls
 * POST /api/v1/speedy/diagnose with a vision-capable model.
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
  return { provider: 'openai', configured, model: configured ? model : null };
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
  ].join('\n');
}

async function chatCompletion(messages, { maxTokens = 500 } = {}) {
  const config = openAiConfig();
  const response = await fetch(`${config.base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.4,
      max_tokens: maxTokens,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `OpenAI error ${response.status}`);
  }
  const reply = body?.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('OpenAI returned an empty reply');
  return { reply, model: body.model || config.model };
}

/** history: prior turns [{ role: 'user'|'assistant', content }], oldest first. */
export async function speedyChat({ message, history = [] }) {
  const messages = [
    { role: 'system', content: speedySystemPrompt() },
    ...history.slice(-10),
    { role: 'user', content: message },
  ];
  return chatCompletion(messages);
}

export async function speedyDiagnose({ imageUrl, note = '' }) {
  const messages = [
    { role: 'system', content: speedySystemPrompt() },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            'A customer sent this photo of their appliance problem.' +
            (note ? ` They add: "${note}".` : '') +
            ' Give a preliminary read: what appliance it is, what you can see, the most likely causes, any safety step they should take now, and what a technician would check on site. Be clear this is a preliminary read from a photo, not a guaranteed diagnosis, and recommend the $99 diagnostic visit (credited toward the repair) to confirm. Ask for their city and ZIP if they want to book.',
        },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    },
  ];
  return chatCompletion(messages, { maxTokens: 700 });
}
