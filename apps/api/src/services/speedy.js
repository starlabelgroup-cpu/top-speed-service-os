import { PLATFORM_CONSTANTS } from '../config/platform.js';
import {
  SPEEDY_GOVERNANCE,
  escalateToHuman,
  governanceGate,
  governancePromptBlock,
  requestRefundApproval,
} from './speedyPolicy.js';
import { speedyKnowledgeSections } from './speedyKnowledge.js';
import { PUBLISHED_CITY_NAMES } from '../config/serviceAreas.js';
import { augmentSpanishQuery, resolveChatLanguage, SPANISH_SYSTEM_DIRECTIVE } from './speedyLanguage.js';
import { formatKnowledgeForPrompt, knowledgeStats, searchKnowledge } from '../knowledge/index.js';
import { createInvite, getReferralStatusForCode, resolveCode } from './referrals.js';
import { buildOrderTrail } from './superapp.js';
import { store } from '../data/store.js';

/**
 * Speedy — the Top Speed Service OS Assistant Manager (AI customer assistant), powered by OpenAI.
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
 * status itself. The ApplianceReferral tools follow the same shape:
 * send_referral_invite is consent-gated in code (no explicit customer
 * confirmation, no send) and get_referral_status is read-only and
 * aggregate — neither can issue, approve, or redeem a referral credit,
 * and neither exposes a program reward amount.
 *
 * Everything Speedy is allowed to state as fact comes from the platform
 * config (phone, the $99 diagnostic terms, the 65 published service
 * cities) and the grounded knowledge base in services/speedyKnowledge.js
 * — nothing else. It never invents repair prices or arrival-time
 * promises. Spanish conversations (2026-11-20, A5) are detected in
 * services/speedyLanguage.js and answered in Spanish under the same
 * rules — the language changes, the facts and gates never do.
 */

const SERVICES = [
  'Refrigerator', 'Freezer / Ice Maker', 'Washer', 'Dryer', 'Oven / Range',
  'Dishwasher', 'Microwave', 'Garbage Disposal', 'Installation',
];

function openAiConfig() {
  // Key precedence (Ramone, 2026-11-17): production runs on the V2 key
  // ("Speedy AI — New Version"); the original key is the fallback.
  const apiKey = process.env.OPENAI_API_KEY_V2 || process.env.OPENAI_API_KEY;
  return {
    configured: Boolean(apiKey),
    apiKey,
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
    knowledge: knowledgeStats(),
    languages: ['en', 'es'],
  };
}

export function speedySystemPrompt() {
  const areas = PUBLISHED_CITY_NAMES.join(', ');
  return [
    `You are Speedy, the Assistant Manager of the Top Speed Service OS for ${PLATFORM_CONSTANTS.platformOwner} ("Top Speed Appliance"), an appliance repair company in Fort Lauderdale and Broward County, Florida. Slogan: "${PLATFORM_CONSTANTS.slogan}"`,
    `Services: ${SERVICES.join(', ')}.`,
    `Service areas (the only cities served — the 65 published cities across Broward, Palm Beach and Miami-Dade): ${areas}.`,
    `Pricing facts: ${PLATFORM_CONSTANTS.feeTerms} That residential diagnostic is how every repair starts. Never quote a repair price — only a technician who has run the diagnostic can. Commercial accounts are priced by custom quote per facility, never the $99 diagnostic.`,
    `Bookings: the ${PLATFORM_CONSTANTS.dispatchTeam} team confirms every booking. To book, collect step by step: name, phone, city, ZIP, appliance, and what is wrong. When you have all of them, summarize them back clearly and say the team will confirm the appointment. Never promise a specific arrival time or same-day completion.`,
    `Phone: ${PLATFORM_CONSTANTS.phoneDisplay}. If someone is outside the service areas, or asks for something Top Speed does not do, say so kindly and give the phone number.`,
    `Location: Top Speed is a service-area business — we do not publish a street address, and you must never state one. When someone asks where we are located, whether we have an office, or where to find us, explain that repairs happen at the customer's home or business, that our team is based in the Coconut Creek / Coral Springs area, and that we serve 65 cities across Broward, Palm Beach and Miami-Dade. Technicians are dispatched to the customer's location; customers never come to us.`,
    'You are the front door of the Top Speed communication engine: "Ask Speedy — How can we help with your appliance? Start with your appliance problem. Speedy will help you reach the right person." Chat, voice, video, media and email all run through this one engine and the same customer record — never treat them as separate systems.',
    'One shared record: everything the customer shares — their problem, photos, consultation, technician notes and attachments — is saved to their customer history. Say so when it helps ("I have that saved to your record, so you will not have to explain it again"). Never ask for the same problem details twice in a conversation. Note: a guest booking creates that customer record automatically, but a record is NOT an account — never present it as one or as a substitute for signing up (see Accounts).',
    'Accounts — Top Speed HAS real accounts and creating one is free. NEVER say or imply that account creation does not exist, that there is no sign-up process, or that the automatic customer record replaces an account. The doors: anyone creates an account at https://topspeedserviceos.com/signup and picks their type — Homeowner, Business, or Property Manager (all register as platform customer accounts; the chosen type routes them to the right app). Homeowners and property managers use Appliance Connect Pro (https://topspeedserviceos.com/connect-pro-app): appliance registry, service history, Speedy booking, and bulk service requests for property managers. Business and commercial customers use Appliance Pro (https://topspeedserviceos.com/appliance-pro): equipment registry, bulk service requests, service activity. Customers can also use Appliance Connect (https://topspeedserviceos.com/app), book at https://topspeedserviceos.com/book, and track a job at https://topspeedserviceos.com/track. Service providers and technicians use the Tech App (https://topspeedserviceos.com/tech) — that door is for providers only; never send a customer there for their account. Staff consoles (Book OS and the other OS consoles) are for the team only — never direct a customer to them.',
    'Offering an account: when a guest would benefit from an account — their history and appliances saved under them, repeat bookings, tracking their jobs — offer the door that matches their type ONCE and ask before sending them there, for example: "Want me to point you to create your free account so this is saved under you?" Only direct them to sign up after they agree. If they decline, keep helping them as a guest with no pressure and do not raise it again in that conversation. When someone asks how to make an account, answer directly with the signup link and the app that fits them — never deflect to the customer record.',
    'Guided pre-consultation: once you know the appliance, ask short guided questions one or two at a time before recommending anything — the same questions a technician would ask before a video call or a visit. For a refrigerator, the sequence starts: "Which brand is your refrigerator?" then "Is your freezer cooling?" — then follow the answers (temperatures, noises, leaks, ice buildup, error codes). For other appliances, follow the same pattern: brand first, then the specific symptom checks for that appliance.',
    'Close every consultation with three things: your findings in plain language, the next steps, and the appointment option (the $99 diagnostic visit, credited toward the repair). An estimate for the repair itself comes only from the technician after the diagnostic — never from you.',
    `Live video consultations: when a customer wants to show the problem live, the ${PLATFORM_CONSTANTS.dispatchTeam} team arranges it three ways — immediate when a qualified technician is available, scheduled when nobody is free, or manager-assisted when a manager should join. Collect their name, phone and appliance, tell them which mode fits, and say the team will set it up. Never claim a video call has started inside this chat.`,
    'Wider network: this same engine and record will serve the wider Top Speed Service Network (including future Top Speed trades such as HVAC, plumbing and electrical). Today, Top Speed serves appliances only — if someone asks for another trade, say it is coming to the network and give the phone number for anything urgent.',
    'Style: friendly, fast, plain language. Short answers unless detail is needed. If a problem sounds unsafe (sparking, gas smell, flooding), tell them to stop using the appliance and stay safe first.',
    'ALWAYS ANSWER (owner rule, 2026-11-15): you always give the customer an answer — never a dead end and never a bare refusal to help. When the knowledge base or the retrieved knowledge covers the question, answer from it. When it does not, answer from general appliance and home-service knowledge, framed as general guidance ("typically", "in general"). NEVER invent a Top Speed-specific fact — a price, a policy term, a coverage claim, a timeline, a statistic — that is not in your knowledge. For a Top Speed detail you cannot confirm, say plainly that it is not confirmed and give the path that resolves it: book the $99 diagnostic visit, send a photo for a preliminary read, or call (844) 460-7038. That IS an answer. Use the search_knowledge tool when a platform, program, symptom, or maintenance question is not already answered by your instructions.',
    'INFORM ABOUT THE ECOSYSTEM (owner rule, 2026-11-15): customers should leave knowing how the whole Top Speed ecosystem fits together — not just the one door they knocked on. FIRST answer the customer\'s actual question, completely. THEN, only when their situation genuinely touches another part of the ecosystem, add ONE short note — one or two sentences, plain and useful — naming that part and giving its link or path. The natural pairings: a property manager or landlord asking about repairs → Appliance Connect Pro (one place for requests across their properties, photo reports, one monthly invoice); a business, restaurant, hotel, or facility → Appliance Pro (the commercial door — equipment registry, priority dispatch, custom quote, never the residential $99); a customer who is happy with their repair or wants to recommend us → Refer & Earn (they earn service credit; their friend gets $25 off a first repair); a technician or provider curious about working with us → Speedy Pro (Field Pro work orders + Appliance Plug, inside the Tech App); someone selling or decluttering household items → Pepper Lists It (snap a photo, get a drafted listing); dryer-vent or lint/airflow trouble → Cleanout Vents, our network partner for exactly that. This is insight, not a sales push: never pitch, never pressure, never repeat the same ecosystem note twice in one conversation, and never let the note crowd out or delay the answer itself. If nothing else in the ecosystem genuinely fits their situation, say nothing extra.',
    ...speedyKnowledgeSections(),
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
    name: 'send_referral_invite',
    description:
      'Send an ApplianceReferral invite to a friend on behalf of a customer, using the customer\'s personal referral code (TS-REF-XXXX). Call ONLY after collecting the friend\'s name plus a phone number or email, reading back exactly what will be sent, asking "Should I send it?", and getting an explicit yes — set customerConfirmed to true only then. The friend-facing offer in the invite is the published New Customer Welcome; the referrer-reward terms Speedy may state are the approved program terms in the knowledge base.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        referrerCode: { type: 'string', description: 'The customer\'s personal referral code, e.g. TS-REF-XXXX.' },
        friendName: { type: 'string', description: 'The friend\'s name.' },
        friendPhone: { type: 'string', description: 'The friend\'s phone number, or an empty string if none was provided.' },
        friendEmail: { type: 'string', description: 'The friend\'s email address, or an empty string if none was provided.' },
        customerConfirmed: { type: 'boolean', description: 'True only when the customer explicitly confirmed the send after the read-back. Never true on an assumption.' },
      },
      required: ['referrerCode', 'friendName', 'friendPhone', 'friendEmail', 'customerConfirmed'],
    },
  },
  {
    type: 'function',
    name: 'get_referral_status',
    description:
      'Look up aggregate ApplianceReferral status for a customer\'s personal referral code (TS-REF-XXXX): journey counts by stage and how many issued credits are available. Returns no friend contact details — an available-credit total appears only when a credit was actually issued to this customer by human approval. Report only what it returns; program terms (amounts, tiers, milestones) come from the knowledge base, not from this tool.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', description: 'The customer\'s personal referral code, e.g. TS-REF-XXXX.' },
      },
      required: ['code'],
    },
  },
  {
    type: 'function',
    name: 'get_job_departments',
    description:
      'Look up where a customer\'s job is right now, department by department (Booking → Service Setters dispatch → Field Service → Parts Supply → Billing → Referrals). Requires the booking reference (TS-XXXXXX) AND the phone number on the booking — the same check as public tracking. Report only what it returns: the current stage, which department holds the job, and recorded facts. Never invent a status, an ETA, a part, or a payment it does not return.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reference: { type: 'string', description: 'The booking reference code, e.g. TS-XXXXXX.' },
        phone: { type: 'string', description: 'The phone number on the booking, for verification.' },
      },
      required: ['reference', 'phone'],
    },
  },
  {
    type: 'function',
    name: 'search_knowledge',
    description:
      'Search the Top Speed knowledge base — live site facts (pricing, coverage, offers), the platform glossary (what each app, door, and program is), and appliance industry guides (symptoms, maintenance, repair-vs-replace, brands). Use it when a question is not already answered by your instructions. Returns grounded entries: state Top Speed facts ONLY from returned entries, never from memory or invention.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'The question or topic to look up, in the customer\'s words.' },
      },
      required: ['query'],
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

async function executeSpeedyTool(call) {
  let args = {};
  try { args = JSON.parse(call.arguments || '{}'); } catch { args = {}; }
  if (call.name === 'send_referral_invite') {
    // Consent is enforced HERE, in code — not left to the prompt: without
    // an explicit customer confirmation nothing is sent, and the tool
    // result sends the model back to ask for one.
    if (args.customerConfirmed !== true) {
      return {
        sent: false,
        confirmationRequired: true,
        message: 'Do NOT send this invite yet. Read back to the customer exactly what will be sent — the friend\'s name, the phone number or email it will go to, and that it carries the customer\'s referral link — then ask "Should I send it?" Call send_referral_invite again with customerConfirmed=true only after the customer explicitly says yes.',
      };
    }
    const referrerCode = String(args.referrerCode || '').trim();
    const friendName = String(args.friendName || '').trim();
    const friendPhone = String(args.friendPhone || '').trim() || null;
    const friendEmail = String(args.friendEmail || '').trim() || null;
    const referral = resolveCode(referrerCode);
    if (!referral) {
      return { sent: false, error: 'CODE_NOT_FOUND', message: 'That referral code was not found. Ask the customer to check the code on their "Refer & Earn" screen in Appliance Connect and try again — do not guess a code.' };
    }
    if (!friendName) {
      return { sent: false, error: 'FRIEND_NAME_REQUIRED', message: 'Ask for the friend\'s name before sending an invite.' };
    }
    if (!friendPhone && !friendEmail) {
      return { sent: false, error: 'CONTACT_REQUIRED', message: 'Ask for the friend\'s phone number or email address — an invite needs at least one of them.' };
    }
    try {
      const { journey, created } = await createInvite({
        code: referral.code,
        friendName,
        phone: friendPhone,
        email: friendEmail,
        source: 'SPEEDY',
      });
      return {
        sent: created,
        alreadyInvited: !created,
        journeyId: journey.id,
        status: journey.status,
        referralCode: referral.code,
        referralLink: `https://topspeedserviceos.com/refer?c=${referral.code}`,
        message: created
          ? 'The invite was recorded and queued to send to the friend through the referral program. Tell the customer it is on its way; do not claim a delivery confirmation you do not have, and do not promise that any credit has been issued.'
          : 'This friend already has an invite on this code, so no duplicate was sent. Tell the customer the earlier invite stands.',
      };
    } catch (error) {
      // Self-referral, a disabled program, and validation failures come
      // back as plain tool results the model can explain to the customer.
      return { sent: false, error: error?.code || 'INVITE_FAILED', message: error?.message || 'The invite could not be sent.' };
    }
  }
  if (call.name === 'search_knowledge') {
    const matches = searchKnowledge(String(args.query || ''), 4);
    return {
      found: matches.length > 0,
      entries: matches.map(({ entry }) => ({
        topic: entry.topic,
        answer: entry.answer,
        link: entry.link || null,
      })),
      message: matches.length
        ? 'Answer from these entries for any Top Speed fact. Industry entries are general guidance — present them as "typically" / "common causes include" and land on the on-site diagnostic as the confirming step.'
        : 'No knowledge entry matched. Answer from general appliance knowledge if you can, framed as general guidance; for a Top Speed detail you cannot confirm, say so plainly and give the path (the $99 diagnostic visit, a photo read, or (844) 460-7038). Never invent a Top Speed fact.',
    };
  }
  if (call.name === 'get_job_departments') {
    const reference = String(args.reference || '').trim().toUpperCase();
    const phoneDigits = String(args.phone || '').replace(/\D/g, '').slice(-10);
    const booking = [...store.bookings.values()].find(
      (b) => String(b.referenceCode || '').toUpperCase() === reference,
    );
    if (!booking || !phoneDigits || String(booking.customer?.phone || '').replace(/\D/g, '').slice(-10) !== phoneDigits) {
      return {
        found: false,
        message: 'No job matched that reference and phone number. Ask the customer to check the reference on their booking confirmation and the phone they booked with — do not guess a status.',
      };
    }
    const context = { bookings: [booking], customerIds: new Set([booking.customerId].filter(Boolean)) };
    const trail = buildOrderTrail(context, booking.referenceCode);
    return {
      found: true,
      reference: trail.reference,
      appliance: trail.appliance,
      currentStage: trail.tracking.stageLabel8,
      stageNumber: trail.tracking.stageIndex + 1,
      ofStages: 8,
      technician: trail.tracking.technician,
      etaMinutes: trail.tracking.etaMinutes,
      departments: trail.trail.map((step) => ({
        department: step.department, title: step.title, detail: step.detail, state: step.state,
      })),
      message: 'Explain in plain words which department holds the job now and what happens next, using only these returned facts.',
    };
  }
  if (call.name === 'get_referral_status') {
    try {
      return getReferralStatusForCode(String(args.code || '').trim());
    } catch (error) {
      return { found: false, error: error?.code || 'STATUS_FAILED', message: error?.message || 'Referral status could not be read.' };
    }
  }
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

/* --------------------- chat latency: intent routing ----------------------
 * Measured in production (2026-11-13): a pure-knowledge question ("How
 * does track my tech works") took 31.4s cold / 12.7s warm because EVERY
 * chat ran the tool loop — sequential Responses rounds with the full
 * tool list attached — even though the answer sits in the system-prompt
 * knowledge base. Long-pending requests die on mobile connections and
 * the customer sees the "connection snag" fallback.
 *
 * Fix: a message with NO action intent is answered with ONE tools-free
 * Responses call (same system prompt, same KB, same governance block —
 * only the tools are left off). Anything that could need a tool keeps
 * the full loop below, untouched. The classifier is deliberately
 * conservative — every pattern errs toward the full loop, the
 * governance pre-screen still runs FIRST on every message, and the
 * governance rules also live in the shared system prompt, so the fast
 * path can never become a governance bypass.
 */

// Any ONE of these in the current message sends the chat to the full
// tool loop. Grouped by the tool/flow the message could plausibly need.
const ACTION_INTENT_PATTERNS = [
  // Identifiers: a booking/referral code, a phone number, or an email
  // address means job- or account-specific territory (tracking with
  // verification, referral status, receipt/invite sends).
  /\bTS-[A-Z0-9]{3,}\b/i,
  /(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/,
  /[\w.+-]+@[\w-]+\.[\w.]{2,}/,
  // (Booking/scheduling words are checked separately below — process
  // questions like "How does booking work?" are knowledge, not intent.)
  // Their appliance, or a symptom: a diagnosis/consultation flow, which
  // the prompt runs as a guided pre-consultation toward a booking.
  /\bmy (refrigerator|fridge|freezer|ice ?maker|washer|washing machine|dryer|oven|range|stove|dishwasher|microwave|garbage disposal|disposal)\b/i,
  /\b(not (cooling|heating|draining|spinning|working|turning on|making ice)|stopped working|won't (start|turn|drain|spin|heat|cool|run)|error code|making (a )?(loud )?noise|leaking|is leaking)\b/i,
  /\bdiagnose\b/i,
  // Photo / live-video flows.
  /\b(send|sending|sent|upload|show|look at|check) (a |the |this |my )?(photo|picture|pic|image|video)\b/i,
  /\b(video (call|consultation|chat)|live video)\b/i,
  // Receipts, invoices, and "send it to me" sends.
  /\b(receipt|invoice)\b/i,
  /\b(send|text|email) (me|us)\b/i,
  // Referral ACTIONS (program-terms questions stay knowledge: the terms
  // are in the KB; a code in the message is caught by the TS- pattern).
  /\bmy referral/i,
  /\breferral (status|code|credits?)\b/i,
  /\binvite\b/i,
  /\brefer (a|my|this) friend\b/i,
  // Tracking / status of a specific job. The feature name "Track My
  // Tech" alone is knowledge — these require a job noun, so "How does
  // track my tech works" does NOT match.
  /\bwhere('s| is) my\b/i,
  /\btrack(ing)?\b[^.?!]{0,20}\b(my|the|that|this) (job|booking|appointment|repair|order|visit)\b/i,
  /\b(job|booking|appointment) status\b/i,
  /\bmy (job|booking|appointment|repair|technician)\b/i,
  // A quote or price for THEIR job (generic price questions are KB).
  /\bquote\b/i,
  /\b(how much|what) (will|would|is) my\b/i,
  /\bmy\b[^.?!]{0,20}\b(cost|price)\b/i,
  // A human, a callback, or anything account-specific.
  /\b(human|real person|live person|manager|supervisor|representative)\b/i,
  /\b(call me|speak (to|with)|talk to (a|the|someone))\b/i,
  /\bmy (account|history|credits?|appliances?|units?|property|properties)\b/i,
  // First-person service requests.
  /\bi (need|want|'d like|would like)\b[^.?!]{0,30}\b(repair|service|technician|appointment|visit|someone)\b/i,
  /\bfix (my|this|the)\b/i,
  /\b(come out|send someone)\b/i,
  // Spanish (2026-11-20, A5): the same action signals in Spanish, so a
  // Spanish booking conversation takes the full tool loop exactly like
  // an English one — booking words, their appliance/symptom, photos,
  // receipts, tracking, and first-person service requests.
  /\b(reservar|reserva|agendar|cita|reprogramar|cancelar la cita)\b/i,
  /\bmi (refrigerador|nevera|lavadora|secadora|horno|estufa|lavavajillas|lavaplatos|congelador|microondas|triturador|electrodoméstico)\b/i,
  /\b(no (enfría|congela|calienta|drena|centrifuga|funciona|enciende|prende)|dejó de funcionar|hace (mucho )?ruido|está goteando|tiene una fuga|código de error)\b/i,
  /\b(enviar|mandar|mostrar|ver) (una |la |esta )?(foto|imagen|video)\b/i,
  /\b(recibo|factura)\b/i,
  /\b(quiero|necesito|quisiera)\b[^.?!]{0,30}\b(reparación|reparar|arreglar|servicio|técnico|cita|visita)\b/i,
  /\b(dónde está mi|estado de mi)\b[^.?!]{0,20}\b(reparación|reserva|cita|visita|trabajo)\b/i,
];

// A bare ZIP is usually a booking detail being collected — except when
// the message is plainly an area-coverage question.
const ZIP_PATTERN = /\b\d{5}\b/;
const AREA_QUESTION_PATTERN = /\b(do you|does|is|are|can you)\b[^.?!]{0,40}\b(service|serve|cover|come to|area)\b/i;
// "How does booking work?" asks about the process (KB), not for a booking.
const PROCESS_QUESTION_PATTERN = /\bhow (does|do)\b[^.?!]{0,30}\b(book|booking|scheduling|appointments?)\b[^.?!]{0,10}\bwork/i;
const BOOKING_WORD_PATTERN = /\b(book|booking|schedule|scheduling|reschedule|appointment|cancel)\b/i;
// The assistant's last turn was collecting booking details or asking
// for a booking confirmation — a short reply is a continuation of
// that flow, not a fresh knowledge question.
const COLLECTION_CUE_PATTERN = /(your (phone|name|city|zip|address)|what('s| is) your|may i have|can i get your|want me to book|shall i book|should i book|confirm|tu (teléfono|nombre|ciudad|dirección)|cuál es tu|me das tu|quieres que (reserve|agende)|deseas que (reserve|agende)|confirmas|confirmar)/i;

function messageHasActionIntent(text) {
  const value = String(text || '');
  if (ZIP_PATTERN.test(value) && !AREA_QUESTION_PATTERN.test(value)) return true;
  if (BOOKING_WORD_PATTERN.test(value) && !PROCESS_QUESTION_PATTERN.test(value)) return true;
  return ACTION_INTENT_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * True when this turn — or the conversation so far — could need a
 * tool, a record lookup, or a multi-step flow. Sticky on purpose: once
 * any earlier customer turn carried action intent, the conversation
 * stays on the full loop (booking collection is exactly the case where
 * a bare "Coral Springs" or "Tuesday" reply carries no signal itself).
 */
export function hasActionIntent(message, history = []) {
  if (messageHasActionIntent(message)) return true;
  const turns = Array.isArray(history) ? history.slice(-10) : [];
  if (turns.some((turn) => turn?.role === 'user' && messageHasActionIntent(turn.content))) return true;
  const lastAssistant = [...turns].reverse().find((turn) => turn?.role === 'assistant');
  if (
    lastAssistant &&
    COLLECTION_CUE_PATTERN.test(String(lastAssistant.content || '')) &&
    String(message || '').trim().split(/\s+/).length <= 8
  ) {
    return true;
  }
  return false;
}

// If a slow-path round has already produced usable text and the clock
// passes this, answer with that text instead of starting another round.
const SLOW_PATH_TEXT_DEADLINE_MS = 25000;

function logChatTiming(path, rounds, startedAt) {
  // One structured line per chat for the Vercel logs — timing and path
  // only. No message content, no customer data.
  console.log(JSON.stringify({ event: 'speedy_chat_timing', path, rounds, elapsedMs: Date.now() - startedAt }));
}

/* --------------------------------- chat ---------------------------------- */

/** history: prior turns [{ role: 'user'|'assistant', content }], oldest first. */
export async function speedyChat({ message, history = [], language } = {}) {
  const startedAt = Date.now();
  // Governance layer 1: the deterministic pre-screen. A matched category
  // is answered by policy (and its action performed) without the model.
  const gated = governanceGate(message);
  if (gated) {
    logChatTiming('governance', 0, startedAt);
    return gated;
  }

  // Language (2026-11-20, A5): Spanish conversations are answered in
  // Spanish — the directive is appended to the same standing prompt,
  // and retrieval runs on a term-augmented query so Spanish questions
  // still land on the grounded English entries. The summary-confirm
  // gate is structural (extractor + customer confirm tap) and does
  // not depend on the reply language.
  const chatLanguage = resolveChatLanguage({ message, history, language });

  const input = [
    ...history.slice(-10).map((turn) => ({ role: turn.role, content: String(turn.content) })),
    { role: 'user', content: message },
  ];
  // Learning system: retrieve the knowledge entries this question
  // matches and put them in front of the model for THIS turn (bounded
  // — see formatKnowledgeForPrompt), on top of the standing prompt KB.
  const knowledgeSection = formatKnowledgeForPrompt(
    searchKnowledge(chatLanguage === 'es' ? augmentSpanishQuery(message) : message, 3),
  );
  const baseInstructions = knowledgeSection
    ? `${speedySystemPrompt()}\n${knowledgeSection}`
    : speedySystemPrompt();
  const instructions = chatLanguage === 'es'
    ? `${baseInstructions}\n${SPANISH_SYSTEM_DIRECTIVE}`
    : baseInstructions;

  // Fast path: informational questions are answered from the knowledge
  // base in the system prompt — one Responses call, NO tools attached,
  // so no tool-loop rounds can stack up. Same prompt, same temperature
  // and token caps as the full loop. An empty or failed fast reply
  // falls through to the full loop rather than failing the customer.
  if (!hasActionIntent(message, history)) {
    try {
      const fastBody = await responsesRequest({
        instructions,
        input,
        temperature: 0.4,
        max_output_tokens: 500,
      });
      const fastReply = extractText(fastBody);
      if (fastReply) {
        logChatTiming('fast', 0, startedAt);
        return { reply: fastReply, model: fastBody.model || openAiConfig().model };
      }
    } catch {
      // Fall through to the full loop; its error surfaces as before.
    }
  }

  let body = await responsesRequest({
    instructions,
    input,
    tools: SPEEDY_TOOLS,
    temperature: 0.4,
    max_output_tokens: 500,
  });

  // Tool loop: Speedy's tools only create human-owned requests. Capped
  // at 2 rounds (was 3); if a round already produced usable text and
  // the elapsed time passes ~25s, return that text instead of starting
  // another round. Never returns an empty reply.
  let rounds = 0;
  for (let round = 0; round < 2; round++) {
    const calls = (body.output || []).filter((item) => item?.type === 'function_call');
    if (!calls.length) break;
    if (Date.now() - startedAt > SLOW_PATH_TEXT_DEADLINE_MS && extractText(body)) break;
    const outputs = [];
    for (const call of calls) {
      outputs.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(await executeSpeedyTool(call)),
      });
    }
    body = await responsesRequest({
      previous_response_id: body.id,
      input: outputs,
      tools: SPEEDY_TOOLS,
      temperature: 0.4,
      max_output_tokens: 500,
    });
    rounds++;
  }

  const reply = extractText(body);
  if (!reply) throw new Error('OpenAI returned an empty reply');
  logChatTiming('slow', rounds, startedAt);
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

/**
 * Upload hardening (security pass, 2026-11-16): the diagnose/plate schemas
 * validate the data URL's DECLARED image type; this verifies the actual
 * bytes match it (JPEG/PNG/WebP magic numbers) before anything reaches the
 * vision model. Uploaded photos are never written to disk, stored, or
 * served back — they exist only as this data URL inside the request — so a
 * mismatched payload has nowhere to execute; the check simply refuses
 * non-image bytes early. Plain http(s) image URLs pass through unchanged
 * (the model fetches those itself). Real photos are unaffected.
 */
export function assertImageDataUrl(value) {
  if (typeof value !== 'string') return value;
  const match = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)/.exec(value);
  if (!match) return value; // Not a data URL — the zod schema governs shape.
  const declared = match[1] === 'jpg' ? 'jpeg' : match[1];
  const head = Buffer.from(match[2].slice(0, 24), 'base64');
  const isJpeg = head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const isPng =
    head.length >= 8 &&
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a;
  const isWebp =
    head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP';
  const ok =
    (declared === 'jpeg' && isJpeg) || (declared === 'png' && isPng) || (declared === 'webp' && isWebp);
  if (!ok) {
    throw new Error('That file is not a real photo — its contents do not match an image format');
  }
  return value;
}

export async function speedyDiagnose({ imageUrl, note = '' }) {
  assertImageDataUrl(imageUrl);
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
      '\nExtraction mode: read the conversation and extract the booking details into the required structured format. Copy values exactly as the customer stated them — never invent a name, phone, city, ZIP, appliance or issue that is not there. Set ready=true only when every required field is present.' +
      '\nThe conversation may be in Spanish (2026-11-20): extract the same fields — keep the name, phone, city and ZIP exactly as the customer stated them, normalize the appliance to the canonical English service name, and write the issue as a brief English summary for the office record.',
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

const DIAGNOSIS_DRAFT_FORMAT = {
  type: 'json_schema',
  name: 'speedy_diagnosis_draft',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      brand: { type: ['string', 'null'], description: 'Appliance brand the technician named, or null if not stated.' },
      model: { type: ['string', 'null'], description: 'Model exactly as the technician stated it, or null.' },
      serial: { type: ['string', 'null'], description: 'Serial exactly as the technician stated it, or null.' },
      symptoms: { type: 'string', description: 'What the customer reported and the tech observed, rewritten cleanly — facts only, nothing added.' },
      confirmed_fault: { type: ['string', 'null'], description: 'The fault the technician says they confirmed by testing, or null if they did not state one. Never invent a confirmed fault.' },
      recommended_repair: { type: ['string', 'null'], description: 'The repair the technician recommends in their words, or null if not stated.' },
      parts_suggested: { type: 'array', items: { type: 'string' }, description: 'Part CATEGORIES the fault plainly calls for (e.g. "Drain pump") — plain category names, no part numbers, no prices.' },
      likely_causes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { cause: { type: 'string' }, check: { type: 'string' } }, required: ['cause', 'check'] }, description: 'Most likely causes for the symptoms on THIS appliance, ranked most likely first (max 5). Each carries the quick field test that confirms or rules it out.' },
      parts_from_catalog: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { sku: { type: 'string' }, name: { type: 'string' }, why: { type: 'string' } }, required: ['sku', 'name', 'why'] }, description: 'Parts chosen ONLY from the Parts OS catalog list supplied in the input — exact SKU and name copied from that list, with a one-line reason. Empty when the catalog has no fitting part. Never invent a SKU.' },
    },
    required: ['brand', 'model', 'serial', 'symptoms', 'confirmed_fault', 'recommended_repair', 'parts_suggested', 'likely_causes', 'parts_from_catalog'],
  },
};

/**
 * AI-fill for the Field Pro diagnosis form (Ramone, 2026-11-19): the
 * tech describes the job in their own words and Speedy drafts the
 * form fields. The result is a DRAFT only — nothing persists until
 * the tech reviews, edits and taps Save in the app (the same
 * confirm-before-commit rule as the Speedy summary gate). No prices
 * exist in this schema: estimate money is computed by the server
 * pricing rules, never by the model.
 */
export async function speedyDraftDiagnosis(text, context = {}) {
  const appliance = context.appliance || {};
  const catalog = Array.isArray(context.catalog) ? context.catalog : [];
  const contextLines = [];
  if (appliance.brand || appliance.model || appliance.applianceType) {
    contextLines.push(
      `Appliance: ${[appliance.brand, appliance.model, appliance.applianceType].filter(Boolean).join(' · ')}${appliance.serial ? ` · serial ${appliance.serial}` : ''}`,
    );
  }
  if (catalog.length > 0) {
    contextLines.push('Parts OS catalog for this appliance (the ONLY parts you may pick by SKU):');
    for (const p of catalog) {
      contextLines.push(`- ${p.sku} · ${`${p.brand || ''} ${p.name}`.trim()} · ${p.category || ''}`.replace(/\s+/g, ' '));
    }
  }
  const body = await responsesRequest({
    model: process.env.OPENAI_DIAGNOSIS_MODEL || 'gpt-4o',
    instructions: [
      'You are Speedy AI running the full-package technician diagnosis for Top Speed Appliance field technicians inside Appliance Plug Pro (Field Pro app). You are ChatGPT with the Top Speed Parts OS catalog as your parts database.',
      'Work like a master appliance technician: from the appliance identity and the technician\'s notes, rank the most likely causes for the symptoms and give the quick field test for each. Use model-specific knowledge where you have it — error codes, known failure points for the model family, service bulletins you know.',
      'Parts: when the supplied Parts OS catalog carries a part that fits this appliance and fault, pick it in parts_from_catalog with its EXACT SKU and name copied from the list — never invent or alter a SKU, and never state a price. parts_suggested stays as plain part categories for anything the catalog does not cover.',
      'Facts discipline: brand, model and serial come from the appliance identity when one is supplied. symptoms rewrites what the customer reported and the tech observed — facts only. A confirmed fault is NEVER invented: confirmed_fault is only what the technician says they confirmed by testing. Never certify that a repair is safe. This is a draft the technician reviews and confirms before anything is saved.',
    ].join('\n'),
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [...contextLines, '', 'Technician notes:', String(text || '').slice(0, 4000)].join('\n'),
          },
        ],
      },
    ],
    text: { format: DIAGNOSIS_DRAFT_FORMAT },
    max_output_tokens: 1400,
  });
  return JSON.parse(extractText(body));
}

/* ---------------- Pepper Chat diagnostics + Speedy AI parts search ----------------
 * Pepper is the staff-facing assistant (owner rule: Ask Pepper serves
 * staff surfaces and the Tech App; Ask Speedy serves customers). Pepper
 * Chat inside Appliance Plug Pro helps the assigned technician think a
 * diagnosis through conversationally, grounded in the live Parts OS
 * catalog slice for the appliance in front of them. Pepper advises;
 * the technician decides — nothing here certifies a repair or a fault.
 */

const PEPPER_CHAT_FORMAT = {
  type: 'json_schema',
  name: 'pepper_chat_diagnosis',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reply: { type: 'string', description: "Pepper's reply to the technician: plain, direct, practical. One question at a time when a test result is needed." },
      part_skus: { type: 'array', items: { type: 'string' }, description: 'SKUs from the supplied Parts OS catalog that fit the diagnosis so far — exact SKUs copied from the list only; empty until a part is actually called for.' },
    },
    required: ['reply', 'part_skus'],
  },
};

export async function pepperDiagnoseChat({ messages, appliance = {}, catalog = [] }) {
  const history = (Array.isArray(messages) ? messages : []).slice(-12);
  const catalogLines = (Array.isArray(catalog) ? catalog : []).map((p) =>
    `- ${p.sku} · ${`${p.brand || ''} ${p.name}`.trim()} · ${p.category || ''}`.replace(/\s+/g, ' '),
  );
  const instructions = [
    'You are Pepper, the Top Speed Appliance systems operations manager, chatting with one of our field technicians inside Appliance Plug Pro (the Field Pro tech app). This is Pepper Chat — diagnostics.',
    'Help the technician diagnose the appliance in front of them like a master tech riding along: ask the next right question, name the most likely causes in order, give the exact field test for each (what to measure, what reading rules it in or out), and interpret the results they report back.',
    appliance.brand || appliance.model || appliance.applianceType
      ? `Appliance on this job: ${[appliance.brand, appliance.model, appliance.applianceType].filter(Boolean).join(' · ')}${appliance.serial ? ` · serial ${appliance.serial}` : ''}.`
      : 'The appliance identity was not supplied — ask for the brand and model early; diagnosis quality depends on it.',
    catalogLines.length > 0
      ? `Parts OS catalog for this appliance (the only parts you may name by SKU):\n${catalogLines.join('\n')}`
      : 'No Parts OS catalog slice was supplied — suggest part categories only, never a SKU.',
    'When a part is actually called for, list its SKU in part_skus (exact, copied from the catalog list) so the app can offer the one-tap order. Never invent a SKU, a price, or a stock count.',
    'Never certify that a repair is safe, and never declare a confirmed fault the technician has not tested — you advise, the technician confirms. If something sounds unsafe (gas smell, sparking, flooding), lead with making it safe.',
    'Keep replies tight and field-practical — the tech is standing in front of the machine. No customer-facing language, no prices, no booking talk.',
  ].join('\n');
  const input = history.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: String(m.content || '').slice(0, 2000) }],
  }));
  const body = await responsesRequest({
    model: process.env.OPENAI_DIAGNOSIS_MODEL || 'gpt-4o',
    instructions,
    input,
    text: { format: PEPPER_CHAT_FORMAT },
    max_output_tokens: 900,
  });
  return JSON.parse(extractText(body));
}

const PARTS_QUERY_FORMAT = {
  type: 'json_schema',
  name: 'speedy_parts_query',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      terms: { type: 'array', items: { type: 'string' }, description: 'The part-name search terms in the request, e.g. ["drain pump"]. Keep the words a parts catalog would use.' },
      brand: { type: ['string', 'null'], description: 'Appliance or part brand named in the request, or null.' },
      sku: { type: ['string', 'null'], description: 'An exact OEM part number / SKU when the request contains one, or null.' },
      category: { type: ['string', 'null'], description: 'Appliance category named or implied (Washer, Dryer, Refrigerator, Dishwasher, Oven / Range, Microwave, Ice Maker, Freezer), or null.' },
    },
    required: ['terms', 'brand', 'sku', 'category'],
  },
};

export async function speedyParsePartsQuery(text) {
  const body = await responsesRequest({
    instructions:
      "Parse a technician's natural-language parts request into catalog search intent. The request may describe a symptom or a whole job (\"drain pump for a Samsung top loader that won't drain\") — extract the part they need, its brand, any exact SKU written in the request, and the appliance category. Never invent a SKU that is not written in the request.",
    input: [{ role: 'user', content: [{ type: 'input_text', text: String(text || '').slice(0, 500) }] }],
    text: { format: PARTS_QUERY_FORMAT },
    max_output_tokens: 200,
  });
  return JSON.parse(extractText(body));
}

/* ---------------- Appliance Plug: model plate + parts finder ----------------
 * The field-tech side of Speedy (Appliance Plug, inside Speedy Pro).
 * The plate reader transcribes ONLY what is printed on the rating plate
 * — the technician confirms every field before anything is ordered.
 * The parts finder returns part CATEGORIES with fitment and
 * verify-first notes. It has no field for an OEM part number or a
 * price and must never invent one: exact part numbers and prices are
 * confirmed by Parts Supply OS at order time.
 */

const PLATE_FORMAT = {
  type: 'json_schema',
  name: 'speedy_model_plate',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      brand: { type: ['string', 'null'], description: 'Brand exactly as printed on the plate, or null if not legible.' },
      model: { type: ['string', 'null'], description: 'Model number exactly as printed, character for character, or null if not legible.' },
      serial: { type: ['string', 'null'], description: 'Serial number exactly as printed, character for character, or null if not legible.' },
      appliance_type: { type: ['string', 'null'], description: 'Appliance type shown or unmistakable from the plate (e.g. Refrigerator, Washer, Dryer), or null.' },
      fuel: { type: ['string', 'null'], description: 'Fuel/power type if printed (e.g. Electric, Natural Gas), or null.' },
      confidence: { type: 'number', description: '0 to 1 — how legible and complete the plate read is.' },
    },
    required: ['brand', 'model', 'serial', 'appliance_type', 'fuel', 'confidence'],
  },
};

/* ---------------- Pepper Lists: listing draft from a photo ----------------
 * The Sell lane of the Pepper Lists camera platform (2026-11-17).
 * A seller photographs an item and Speedy drafts the Marketplace
 * listing from ONLY what is visible — the same structured-vision
 * machinery as the plate read, pointed at a sale item instead of a
 * rating plate. The schema deliberately has NO price field: a price
 * is never invented for an item (Pepper Lists rule) — the seller sets
 * their own number in the draft form, and nothing posts until the
 * seller confirms the final listing.
 */

export const LISTING_CATEGORIES = [
  'Produce & fruit',
  'Trees & plants',
  'Appliances',
  'Furniture',
  'Electronics',
  'Home & garden',
  'Vehicles & parts',
  'Clothing',
  'Other',
];

export const LISTING_CONDITIONS = ['New', 'Used - like new', 'Used - good', 'Used - fair'];

const LISTING_DRAFT_FORMAT = {
  type: 'json_schema',
  name: 'speedy_listing_draft',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      item: { type: ['string', 'null'], description: 'What the item in the photo appears to be, in a few words, or null if it cannot be identified.' },
      title: { type: ['string', 'null'], description: 'A short, factual Marketplace listing title (max ~80 characters) built only from what is visible, or null if the item cannot be identified.' },
      description: { type: ['string', 'null'], description: 'A plain, factual listing description of what is visible — quantity, size or ripeness ONLY when clearly visible. Never invent details, or null if the item cannot be identified.' },
      category: { type: ['string', 'null'], enum: [...LISTING_CATEGORIES, null], description: 'The listing category that best fits the item, or null.' },
      condition: { type: ['string', 'null'], enum: [...LISTING_CONDITIONS, null], description: 'A condition suggestion from visible wear only, or null when condition cannot be judged from the photo.' },
      confidence: { type: 'number', description: '0 to 1 — how clearly the item can be identified from this photo.' },
    },
    required: ['item', 'title', 'description', 'category', 'condition', 'confidence'],
  },
};

export async function speedyDraftListing(imageUrl) {
  assertImageDataUrl(imageUrl);
  const body = await responsesRequest({
    instructions:
      speedySystemPrompt() +
      '\nListing mode: a Pepper Lists seller photographed an item they want to sell on Facebook Marketplace. Identify ONLY what is visibly in the photo and draft the listing in the required structured format: a short factual title, a plain description, the best-fit category and a condition suggestion from visible wear only. Never invent a price, brand, model, quantity or any detail you cannot see — return null for anything not visible. This is a draft: the seller edits and confirms every field, and sets their own price, before anything posts.',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Draft a Marketplace listing for the item in this photo.' },
          { type: 'input_image', image_url: imageUrl },
        ],
      },
    ],
    text: { format: LISTING_DRAFT_FORMAT },
    max_output_tokens: 500,
  });
  return JSON.parse(extractText(body));
}

export async function speedyExtractModelPlate(imageUrl) {
  assertImageDataUrl(imageUrl);
  const body = await responsesRequest({
    instructions:
      speedySystemPrompt() +
      '\nPlate mode: a field technician photographed an appliance rating plate. Transcribe ONLY what is printed on the plate into the required structured format, character for character. Never guess or complete a model or serial number that is not legible — return null for anything you cannot read exactly. This transcription is a draft: the technician confirms every field before it is used.',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Transcribe this appliance model plate.' },
          { type: 'input_image', image_url: imageUrl },
        ],
      },
    ],
    text: { format: PLATE_FORMAT },
    max_output_tokens: 400,
  });
  return JSON.parse(extractText(body));
}

/* ---------------- Device Camera: photo diagnosis + part ID ----------------
 * The high-tech camera for the work order and Appliance Plug Pro: the
 * technician points the camera at ANY appliance or part — no pairing,
 * no device account — and Speedy vision reads what the photo shows.
 * DIAGNOSE mode reports the visible fault evidence; IDENTIFY mode
 * names the part the way a catalog names it and matches it against
 * the live Parts OS catalog slice. Only what is visible is reported;
 * nothing here certifies a fault or a repair.
 */

const DEVICE_PHOTO_FORMAT = {
  type: 'json_schema',
  name: 'speedy_device_photo',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      appliance_seen: { type: ['string', 'null'], description: 'The appliance or device in the photo, as specific as the photo honestly allows (brand and type), or null when it cannot be told.' },
      findings: { type: 'string', description: 'What the photo shows, in plain field language: fault evidence, damage, wear, leaks, error codes, part condition. Only what is visible — never invent what the photo does not show.' },
      likely_part: { type: ['string', 'null'], description: 'The part shown or implicated, named the way a parts catalog names it (e.g. "Drain pump"), or null.' },
      part_skus: { type: 'array', items: { type: 'string' }, description: 'SKUs from the supplied Parts OS catalog that match the part in the photo — exact SKUs copied from the list only; empty when none fit.' },
      next_step: { type: 'string', description: 'The single most useful next step for the technician.' },
    },
    required: ['appliance_seen', 'findings', 'likely_part', 'part_skus', 'next_step'],
  },
};

export async function speedyAnalyzeDevicePhoto({ imageUrl, mode, appliance = {}, catalog = [] }) {
  assertImageDataUrl(imageUrl);
  const catalogLines = (Array.isArray(catalog) ? catalog : []).map((p) =>
    `- ${p.sku} · ${`${p.brand || ''} ${p.name}`.trim()} · ${p.category || ''}`.replace(/\s+/g, ' '),
  );
  const instructions = [
    'You are Speedy AI running the Device Camera for Top Speed Appliance field technicians (Field Pro app — the work order and Appliance Plug Pro). The camera connects the technician to any appliance in front of them: no pairing or device account exists, so the photo itself is the connection.',
    mode === 'identify'
      ? 'IDENTIFY mode: name the part in this photo the way a parts catalog names it, describe its visible condition, and match it to the supplied Parts OS catalog.'
      : 'DIAGNOSE mode: read the fault evidence in this photo — damage, wear, leaks, burn marks, error codes, broken or disconnected parts — and say what it points to.',
    appliance.brand || appliance.model || appliance.applianceType
      ? `Appliance on this job: ${[appliance.brand, appliance.model, appliance.applianceType].filter(Boolean).join(' · ')}${appliance.serial ? ` · serial ${appliance.serial}` : ''}.`
      : 'No appliance identity was supplied — say what the photo itself shows.',
    catalogLines.length > 0
      ? `Parts OS catalog for this appliance (the only parts you may name by SKU):\n${catalogLines.join('\n')}`
      : 'No Parts OS catalog slice was supplied — name part categories only, never a SKU.',
    'Describe ONLY what is visible in the photo. Never invent a reading, a code, or a fault the photo does not show, never state a price, and never certify that a repair is safe. If the photo shows a hazard (damaged gas line, sparking, active flooding), lead the findings with making it safe.',
  ].join('\n');
  const body = await responsesRequest({
    model: process.env.OPENAI_DIAGNOSIS_MODEL || 'gpt-4o',
    instructions,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: mode === 'identify' ? 'Identify the part in this photo and match it to the Parts OS catalog.' : 'Analyze this appliance photo for the technician.',
          },
          { type: 'input_image', image_url: imageUrl },
        ],
      },
    ],
    text: { format: DEVICE_PHOTO_FORMAT },
    max_output_tokens: 700,
  });
  return JSON.parse(extractText(body));
}

/**
 * The normalized plate DRAFT envelope (camera upgrade, 2026-11-20):
 * the same transcription speedyExtractModelPlate returns, reshaped
 * once so every consumer (Pepper Lists plate lane, Appliance Plug,
 * Field Pro) pre-fills from ONE camelCase draft shape. Additive —
 * the original `plate` payload is unchanged everywhere it is served.
 * A draft is all this ever is: the human confirms every field
 * against the physical plate before anything is saved.
 */
export function plateDraft(plate) {
  const p = plate || {};
  return {
    brand: p.brand ?? null,
    model: p.model ?? null,
    serial: p.serial ?? null,
    applianceType: p.appliance_type ?? null,
    fuel: p.fuel ?? null,
    confidence: typeof p.confidence === 'number' ? p.confidence : null,
    status: 'DRAFT',
    source: 'speedy-plate-read',
  };
}

const PARTS_FINDER_FORMAT = {
  type: 'json_schema',
  name: 'speedy_parts_finder',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      candidates: {
        type: 'array',
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            category: { type: 'string', description: 'The part CATEGORY only (e.g. "Drain pump", "Heating element") — never a brand-specific part name with a number.' },
            why: { type: 'string', description: 'Why this category fits the reported issue, in one or two sentences.' },
            fitment_notes: { type: 'string', description: 'What determines the exact part for this category on this appliance (model revision, size, rating, connector).' },
            verify_first: { type: 'array', items: { type: 'string' }, description: 'Checks the technician should run before ordering, so a category is not ordered on a guess.' },
          },
          required: ['category', 'why', 'fitment_notes', 'verify_first'],
        },
      },
    },
    required: ['candidates'],
  },
};

/*
 * Top Speed Ads — Speedy copy drafter (2026-11-17).
 *
 * "Draft with Speedy" in Ad Studio: Speedy writes Google-style
 * headlines/descriptions (streaming placements) or a banner
 * headline/copy pair (banner placements) for a campaign the staff
 * describe. The brand rules are HARD, in the instructions and again
 * server-side in routes/adStudio.js (limits + price/claim filters):
 * no reviews, ratings or stars; no invented prices, discounts,
 * statistics or guarantees; the only price that may ever appear is
 * the $99 residential diagnostic, credited toward the repair, and
 * only for the Top Speed line — never commercial, never Cleanout
 * Vents (no vent prices exist), never CocoCane. No phone numbers.
 * A draft is only a draft: it lands in the owner's approval queue
 * as a PENDING_APPROVAL campaign and the AI never publishes.
 */

const AD_COPY_FORMAT = {
  type: 'json_schema',
  name: 'speedy_ad_copy_draft',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      headlines: {
        type: 'array',
        maxItems: 15,
        items: { type: 'string' },
        description: 'Short ad headlines. For streaming text/display ads each is at most 30 characters; for other placements at most 120 characters.',
      },
      descriptions: {
        type: 'array',
        maxItems: 4,
        items: { type: 'string' },
        description: 'Ad descriptions. For streaming ads each is at most 90 characters; for other placements at most 400 characters.',
      },
      longHeadline: { type: ['string', 'null'], description: 'One longer headline for display ads (at most 90 characters), or null.' },
      headline: { type: ['string', 'null'], description: 'For banner placements: the single banner headline (at most 120 characters), or null.' },
      copy: { type: ['string', 'null'], description: 'For banner placements: the supporting banner copy (at most 400 characters), or null.' },
    },
    required: ['headlines', 'descriptions', 'longHeadline', 'headline', 'copy'],
  },
};

export async function speedyDraftAdCopy({ businessLine, topic, destinationUrl, placement, streamingFormat }) {
  const lineLabel = {
    TOP_SPEED: 'Top Speed Appliance (appliance repair, installation, sales & delivery)',
    CLEANOUT_VENTS: 'Cleanout Vents (dryer vent cleaning — a Top Speed network partner)',
    COCOCANE: 'CocoCane (fresh coconut drinks and whole coconuts, Fort Lauderdale pickup)',
    EXTERNAL: 'an outside advertiser on the Top Speed platforms',
  }[businessLine] || 'Top Speed Appliance';
  const streaming = placement === 'STREAMING';
  const facts = [
    `Business line: ${lineLabel}`,
    `What is being advertised: ${topic}`,
    destinationUrl ? `Destination page: ${destinationUrl}` : null,
    `Placement: ${placement}${streaming ? ` (streaming ${streamingFormat || 'TEXT'} ad)` : ''}`,
  ].filter(Boolean).join('\n');
  const body = await responsesRequest({
    instructions:
      speedySystemPrompt() +
      '\nAd copy mode: you are drafting advertising copy for Top Speed Ads, the in-house Flywheel AI Advertising system. Write in the house voice: fast, plain, factual. HARD RULES — never break these: no reviews, ratings, stars or testimonials; no invented prices, discounts, statistics, guarantees or claims; no phone numbers; if hours are mentioned they are exactly "Mon–Fri 8am–7pm". The ONLY price that may appear is the $99 diagnostic for RESIDENTIAL Top Speed appliance repair, always phrased as credited toward the repair — and only when the business line is Top Speed Appliance. Commercial work is custom-quoted: never attach the $99 (or any price) to it. Cleanout Vents has NO published prices: never state a vent price. CocoCane copy carries no prices in drafts. ' +
      (streaming
        ? 'This is a streaming ad: return up to 15 headlines of at most 30 characters each, up to 4 descriptions of at most 90 characters each, and one long headline of at most 90 characters. Set headline and copy to null.'
        : 'This is a banner/link placement: return one headline (at most 120 characters) and one supporting copy text (at most 400 characters); also return a few short headlines (at most 120 characters each) and descriptions (at most 400 characters each) as alternates. Set longHeadline to null.') +
      ' This is a draft for the owner approval queue: a human reviews and approves every word before anything runs.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: facts.slice(0, 2000) }] }],
    text: { format: AD_COPY_FORMAT },
    max_output_tokens: 700,
  });
  return JSON.parse(extractText(body));
}

export async function speedyPartsFinder({ brand, model, applianceType, issue }) {
  const facts = [
    brand ? `Brand: ${brand}` : null,
    model ? `Model: ${model}` : null,
    applianceType ? `Appliance: ${applianceType}` : null,
    issue ? `Reported issue: ${issue}` : null,
  ].filter(Boolean).join('\n');
  const body = await responsesRequest({
    instructions:
      speedySystemPrompt() +
      '\nParts Finder mode: a field technician needs the part CATEGORIES most likely involved in this job. Return categories only — NEVER an OEM part number, a SKU, or a price; exact part numbers and prices are confirmed by Parts Supply OS at order time against the full model and revision. Order candidates by likelihood. Every candidate needs fitment notes and verify-first checks so the technician confirms the diagnosis before ordering.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: facts.slice(0, 2000) }] }],
    text: { format: PARTS_FINDER_FORMAT },
    max_output_tokens: 800,
  });
  return JSON.parse(extractText(body));
}
