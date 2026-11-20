import { store } from '../data/store.js';
import { GOOD_MATCH_SCORE, formatKnowledgeForPrompt, searchKnowledge } from '../knowledge/index.js';
import { balanceOf, foldJobState } from './dispatchOps.js';
import { PEPPER_AUTHORITY_LIMITS, PEPPER_IDENTITY } from './pepperConsole.js';
import { speedyStatus } from './speedy.js';

/**
 * Ask Pepper for providers (2026-11-20, recommendations D13).
 *
 * Pepper's staff chat (services/pepperChat.js) is staff-only by
 * design — which is exactly why Field Pro shipped without it. This
 * is the PROVIDER lane of the same assistant: a network or company
 * tech asks job-help questions and gets answers from exactly three
 * sources, and no fourth exists in this module:
 *
 *   1. THEIR OWN BOARD — assignments belonging to the signed-in
 *      provider's record, read from the same store the Tech App
 *      reads. A job that is not on their board is answered as "not
 *      on your board" — the module never loads another provider's
 *      assignments, so it cannot leak one, to the model or anyone.
 *   2. THE REAL KNOWLEDGE BASES — the same site / glossary /
 *      industry packs the provider knowledge search already serves
 *      (plate and error-code lookups, how repairs and the platform
 *      work).
 *   3. NOTHING ELSE. Office data (setter queue, unassigned jobs,
 *      other providers, finance, payouts, customer lists) is out of
 *      scope BY CONSTRUCTION: no reader for it exists here, and a
 *      deterministic scope wall answers those asks before the model
 *      ever sees them.
 *
 * The 2026-11-10 authority limits bind this lane exactly as they
 * bind Speedy and staff Pepper: no refunds, no safety-critical
 * diagnosis, no safety certification, no credential overrides, no
 * compliance changes. Refusals name the human path (the office).
 *
 * Engine discipline mirrors Pepper chat: the OpenAI Responses API
 * when configured (the provider-scoped prompt carries ONLY the
 * matched knowledge + the tech's own board brief), a grounded
 * knowledge fallback when it is not — honestly labeled in
 * answeredBy, never dressed up as the AI.
 */

export function providerPepperStatus() {
  const speedy = speedyStatus();
  return { configured: speedy.configured, model: speedy.model, provider: speedy.provider };
}

function openAiConfig() {
  // Same key precedence as Speedy / Pepper chat (2026-11-17): V2 first.
  const apiKey = process.env.OPENAI_API_KEY_V2 || process.env.OPENAI_API_KEY;
  return {
    configured: Boolean(apiKey),
    apiKey,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    base: process.env.OPENAI_API_BASE || 'https://api.openai.com',
  };
}

/* ------------------------------ scope wall ------------------------------ */

const SCOPE_WALL = [
  {
    topic: 'refunds',
    pattern: /\b(refund|chargeback|money back|give (them|the customer) back)\b/i,
    pointer:
      'Refunds are a human decision — the office (Service Setters / Ramone) handles them, never an AI. Call the office and they will take it from there.',
  },
  {
    topic: 'credentials and access',
    pattern: /\b(reset|change|forgot|recover) (my |the |a )?(password|access code|verify code|verification code)\b|\bwhat('s| is) my (password|access code|verify code)\b|\b(approve|activate) my account\b|\bchange my role\b|\bmy permissions\b/i,
    pointer:
      'Passwords, access codes and account approvals are the Master\u2019s hands only — I can\u2019t touch them from here. Use the sign-in screen\u2019s reset link for a password, and call the office for anything about your account\u2019s access.',
  },
  {
    topic: 'other providers',
    pattern: /\b(other|another) (provider|tech|technician|company|crew)\b|\bcompetitor(s| business)?\b/i,
    pointer:
      'I can only see your own board — other providers\u2019 jobs and details are theirs, and this lane never loads them. For anything about another tech\u2019s work, the office dispatch board is the place.',
  },
  {
    topic: 'office and finance data',
    pattern: /\b(revenue|payouts?|how much (did|does) (the )?(company|business|we) (make|earn)|total (sales|income|revenue)|setter queue|unassigned jobs|all (the )?customers|customer list|every (job|booking))\b/i,
    pointer:
      'That\u2019s office data — this lane only carries your own jobs and the trade knowledge base. Book OS and the office team hold the company-wide picture.',
  },
  {
    topic: 'safety certification',
    pattern: /\bcertify\b|\bis (it|this|the repair) safe\b|\bsafe to use\b|\bsign off on\b/i,
    pointer:
      'Certifying that a repair is safe is never an AI call — that is a licensed human\u2019s judgment on site. If something on a job looks unsafe, keep people clear and call the office / Ramone right away.',
  },
  {
    topic: 'compliance status',
    pattern: /\b(compliance status|change .* compliance|license status|insurance status)\b/i,
    pointer:
      'Compliance status changes are authorized-human only. The office keeps those records — talk to them directly.',
  },
];

export function scopeWallHit(message) {
  const value = String(message || '');
  for (const entry of SCOPE_WALL) {
    if (entry.pattern.test(value)) return entry;
  }
  return null;
}

function scopeWallReply(entry) {
  return {
    reply:
      `That\u2019s outside what I can do in the provider lane. I answer job-help questions: your own jobs and offers, rating-plate and error-code lookups, and how the work flows. ${entry.pointer}`,
    answeredBy: 'scope-wall',
    model: null,
    scope: { blocked: entry.topic },
  };
}

/* ------------------------------- own board ------------------------------ */

const OPEN_ASSIGNMENT_STATUSES = ['APPROVED', 'ACCEPTED'];

export function ownAssignments(provider) {
  if (!provider) return [];
  return [...store.dispatchAssignments.values()]
    .filter((a) => a.providerId === provider.id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function jobBrief(assignment) {
  const booking = store.bookings.get(assignment.bookingId);
  if (!booking) return null;
  const state = foldJobState(booking);
  const balance = balanceOf(booking, state);
  const a = booking.appointment;
  return {
    assignmentId: assignment.id,
    assignmentStatus: assignment.status,
    referenceCode: booking.referenceCode || null,
    appliance: booking.appliance,
    issue: booking.issue,
    city: booking.city,
    zip: booking.zip,
    status: booking.status,
    customer: booking.customer
      ? { name: booking.customer.name, phone: booking.customer.phone, address: booking.customer.address || null }
      : null,
    appointment: a?.status === 'SET'
      ? { date: a.date, window: a.window }
      : null,
    awaitingParts: state.awaitingParts,
    awaitingDiagnosis: state.awaitingDiagnosis,
    estimateTotalCents: balance.estimateTotalCents,
    balanceDueCents: balance.balanceDueCents,
  };
}

export function ownJobBriefs(provider) {
  return ownAssignments(provider).map(jobBrief).filter(Boolean);
}

function formatJobLine(job) {
  const parts = [
    `${job.referenceCode || 'No ref'} — ${job.appliance} in ${job.city}`,
    `job status ${job.status}, assignment ${job.assignmentStatus}`,
  ];
  if (job.appointment) parts.push(`appointment ${job.appointment.date} (${job.appointment.window})`);
  if (job.awaitingParts) parts.push('awaiting parts');
  if (job.awaitingDiagnosis) parts.push('awaiting diagnosis');
  if (job.estimateTotalCents != null) {
    parts.push(`estimate $${(job.estimateTotalCents / 100).toFixed(2)}`);
    if (job.balanceDueCents != null) parts.push(`balance due $${(job.balanceDueCents / 100).toFixed(2)}`);
  }
  return `- ${parts.join(' · ')}`;
}

const BOARD_PATTERNS = [
  /\bmy (jobs|board|offers|schedule|work)\b/i,
  /\bwhat('s| is| do i have) on (my|the) board\b/i,
  /\bdo i have (any )?(jobs|offers|work)\b/i,
  /\b(show|list|see) my (jobs|offers)\b/i,
];

export function messageAsksBoard(message) {
  const value = String(message || '');
  return BOARD_PATTERNS.some((pattern) => pattern.test(value));
}

export function referenceCodeIn(message) {
  const match = /\bTS-[A-Z0-9]{6}\b/i.exec(String(message || ''));
  return match ? match[0].toUpperCase() : null;
}

function composeBoardReply(provider) {
  const jobs = ownJobBriefs(provider);
  const offers = jobs.filter((j) => j.assignmentStatus === 'APPROVED');
  const open = jobs.filter((j) => j.assignmentStatus === 'ACCEPTED');
  const done = jobs.filter((j) => j.assignmentStatus === 'COMPLETED');
  if (!jobs.length) {
    return 'Your board is clear right now — no offers waiting and no open jobs assigned to you. New offers land here as soon as Service Setters dispatch approves them.';
  }
  const lines = [`Here is your board, ${provider.businessName}:`];
  if (offers.length) {
    lines.push(`Offers waiting for your answer (${offers.length}):`);
    for (const job of offers.slice(0, 6)) lines.push(formatJobLine(job));
  }
  if (open.length) {
    lines.push(`Your open jobs (${open.length}):`);
    for (const job of open.slice(0, 8)) lines.push(formatJobLine(job));
  }
  if (done.length) lines.push(`Completed on record: ${done.length}.`);
  lines.push('Open any job in the Tech App for the full workspace — photos, diagnosis, estimate and receipts live there.');
  return lines.join('\n');
}

function composeJobReply(job) {
  const lines = [formatJobLine(job).replace(/^- /, '')];
  if (job.issue) lines.push(`Reported issue: ${job.issue}`);
  if (job.customer) {
    lines.push(
      `Customer: ${job.customer.name}${job.customer.phone ? ` · ${job.customer.phone}` : ''}${job.customer.address ? ` · ${job.customer.address}` : ''}`,
    );
  }
  lines.push('That is the job as the office record holds it — the full workspace (photos, diagnosis, estimate, receipts) is in the Tech App.');
  return lines.join('\n');
}

/* ---------------------------------- AI ---------------------------------- */

function providerSystemPrompt({ knowledgeText, boardText }) {
  return [
    `You are Pepper — ${PEPPER_IDENTITY.title} of the Top Speed Service OS — talking to a field provider (technician) in the provider lane of the Tech App. This is job help only.`,
    'Your scope is hard: answer from (a) the knowledge provided below and (b) the tech\u2019s OWN board brief below. You have no other data — no other providers, no office or finance figures, no customer lists — and you must never invent any. If the answer is not in what is provided, say so plainly and point to the office (Book OS / the Service Setters) or the Tech App job workspace.',
    `Authority limits that bind you: ${PEPPER_AUTHORITY_LIMITS.join(' ')} You never issue refunds, diagnose safety-critical conditions, certify a repair safe, override credentials, or change compliance status. Safety-critical symptoms (gas smell, sparking, scorching, refrigerant leak signs) get one answer: keep people clear, do not open or recharge anything, call the office / Ramone.`,
    'Plate and error-code questions: transcribe and explain only what the knowledge says; a model/serial read is a draft the tech confirms on the plate itself.',
    'Style: direct, brief, plain language — a competent duty officer talking to a working tech. Short answers; steps when the question needs steps.',
    knowledgeText ? `\nKnowledge matched to this question:\n${knowledgeText}` : '',
    boardText ? `\nThe tech\u2019s own board (the ONLY jobs you may discuss):\n${boardText}` : '\nThe tech\u2019s board is empty right now.',
  ].join('\n');
}

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

/* --------------------------------- chat --------------------------------- */

/**
 * One provider-lane turn. `provider` is the signed-in account's own
 * provider record (resolved by the route with the Tech App's
 * linkage); when it is null the lane still answers knowledge
 * questions but has no board to read.
 */
export async function providerPepperChat({ message, history = [], provider = null }) {
  // 0) Scope wall — deterministic, before any data or model.
  const wall = scopeWallHit(message);
  if (wall) return scopeWallReply(wall);

  // 1) A reference code names a job: answer ONLY from their board.
  const ref = referenceCodeIn(message);
  if (ref) {
    const job = ownJobBriefs(provider).find((j) => j.referenceCode === ref);
    if (job) return { reply: composeJobReply(job), answeredBy: 'own-jobs', model: null, job };
    return {
      reply:
        `${ref} is not on your board — I can only see jobs assigned to ${provider ? provider.businessName : 'your provider record'}. ` +
        'If dispatch just sent it, check your offers in the Tech App; if it belongs to another tech, it stays on their board. Anything else about it goes through the office.',
      answeredBy: 'own-jobs',
      model: null,
      job: null,
    };
  }

  // 2) Board questions — composed from their own assignments only.
  if (messageAsksBoard(message)) {
    if (!provider) {
      return {
        reply: 'Your account has no provider record linked yet, so there is no board for me to read. The office can link your account — call Book OS and they will sort it.',
        answeredBy: 'own-jobs',
        model: null,
      };
    }
    return { reply: composeBoardReply(provider), answeredBy: 'own-jobs', model: null };
  }

  // 3) Knowledge — AI when configured, grounded fallback when not.
  const matches = searchKnowledge(message, 4);
  const config = openAiConfig();
  if (config.configured) {
    try {
      const boardJobs = ownJobBriefs(provider)
        .filter((j) => OPEN_ASSIGNMENT_STATUSES.includes(j.assignmentStatus))
        .slice(0, 8);
      const body = await responsesRequest({
        instructions: providerSystemPrompt({
          knowledgeText: matches.length ? formatKnowledgeForPrompt(matches) : '',
          boardText: boardJobs.length ? boardJobs.map(formatJobLine).join('\n') : '',
        }),
        input: [
          ...history.slice(-10).map((turn) => ({ role: turn.role, content: String(turn.content) })),
          { role: 'user', content: message },
        ],
        temperature: 0.3,
        max_output_tokens: 600,
      });
      const reply = extractText(body);
      if (reply) return { reply, answeredBy: 'ai', model: body.model || config.model };
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'provider pepper provider failed — knowledge fallback engaged',
        error: String(error?.message || error),
      }));
    }
  }

  const best = matches[0];
  if (best && best.score >= GOOD_MATCH_SCORE) {
    return { reply: best.entry.answer, answeredBy: 'knowledge-base', model: null };
  }
  return {
    reply:
      'I don\u2019t have that in the trade knowledge base, and I won\u2019t guess at it. Here is what I can do in this lane: ' +
      'look up rating plates and error codes ("What does error F8E1 mean?"), explain how a repair or the platform flow works, ' +
      'and read your own board ("Show my jobs", or ask me about one of your job references). ' +
      'For anything on a live job that the knowledge doesn\u2019t cover, the office (Book OS) is the next call.',
    answeredBy: 'knowledge-fallback',
    model: null,
  };
}
