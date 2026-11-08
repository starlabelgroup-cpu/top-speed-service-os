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
