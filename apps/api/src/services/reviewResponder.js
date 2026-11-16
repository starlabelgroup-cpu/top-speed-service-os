import { PLATFORM_CONSTANTS } from '../config/platform.js';
import { addReviewComment, updateReview } from '../db/reviewsRepo.js';
import { queueNotification } from './notifications.js';
import { speedyChat, speedyStatus } from './speedy.js';

/**
 * Speedy, the Pepper Lists Reviews responder (2026-11-16).
 *
 * Speedy is the first responder on every review and every customer
 * comment in a review thread. The rules are deterministic and sit
 * under the standing Speedy governance (services/speedyPolicy.js):
 *
 * - POSITIVE (rating >= 4 and no flag keywords): the review publishes
 *   automatically and Speedy replies with a warm thank-you built from
 *   REAL facts only (the customer's first name, the service/appliance
 *   on the booking when there is one, the city). When the AI provider
 *   is configured, a richer reply is attempted under a strict
 *   instruction and validated before use; any failure — including the
 *   currently-expired production key — falls back to the templates.
 * - FLAGGED (any flag keyword) or rating <= 3: the review stays
 *   PENDING (never on the public wall), is escalated for the office,
 *   and Speedy posts a holding reply: a sincere apology, a general
 *   acknowledgment of the issue category, a promise only that a human
 *   from the office will reach out personally, and the office phone.
 *
 * Speedy NEVER promises a refund, credit, discount, free work or any
 * compensation in a reply — refunds are human-only decisions. It never
 * admits liability specifics and never invents facts. The responder
 * never throws: review creation succeeds even if reply generation
 * fails (the review simply waits, reply-less, for the office).
 */

const PHONE = PLATFORM_CONSTANTS.phoneDisplay; // (954) 931-7997

export const REVIEW_FLAG_KEYWORDS = [
  'refund', 'money back', 'damage', 'damaged', 'broken again',
  'still not working', 'not fixed', 'rude', 'scam', 'overcharged',
  'charge', 'unsafe', 'fire', 'smoke', 'sparking', 'leak', 'flooded',
  'injury', 'hurt', 'lawyer', 'attorney', 'bbb', 'complaint',
];

/** General issue categories for the holding reply — deliberately vague. */
const FLAG_CATEGORIES = [
  { label: 'a safety concern', words: ['unsafe', 'fire', 'smoke', 'sparking', 'injury', 'hurt', 'leak', 'flooded'] },
  { label: 'a billing concern', words: ['refund', 'money back', 'overcharged', 'charge'] },
  { label: 'damage to your home or appliance', words: ['damage', 'damaged'] },
  { label: 'the repair not holding', words: ['broken again', 'still not working', 'not fixed'] },
  { label: 'how the visit went', words: ['rude'] },
  { label: 'a formal complaint', words: ['scam', 'lawyer', 'attorney', 'bbb', 'complaint'] },
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Classify review/comment text. A keyword matches as a word-ish hit:
 * bounded by a non-letter (or the string edge) on both sides, so
 * "charged" matches "charge" but "discharge" does not, and multi-word
 * phrases ("money back", "still not working") match as phrases.
 */
export function classifyReviewText(text) {
  const value = ` ${String(text || '').toLowerCase()} `;
  const hits = REVIEW_FLAG_KEYWORDS.filter((word) =>
    new RegExp(`(^|[^a-z])${escapeRegExp(word)}([a-z]{0,2})?([^a-z]|$)`).test(value),
  );
  let category = null;
  for (const entry of FLAG_CATEGORIES) {
    if (entry.words.some((word) => hits.includes(word))) { category = entry.label; break; }
  }
  return { flagged: hits.length > 0, hits, category };
}

/** Phrases a Speedy reply must never contain (checked on AI output too). */
const PROMISE_PATTERNS = [
  /refund/i, /\bcredit\b/i, /discount/i, /\bfree\b/i, /compensat/i,
  /money back/i, /guarantee/i, /\$\s?\d/, /we will (fix|repair|replace)/i,
  /our fault/i, /we (admit|accept) (liability|responsibility)/i,
];

export function replyPromisesSomething(text) {
  return PROMISE_PATTERNS.some((pattern) => pattern.test(String(text || '')));
}

function pickVariant(seed, variants) {
  let hash = 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return variants[hash % variants.length];
}

export function positiveTemplate({ firstName, serviceLabel, city, seed }) {
  const name = firstName ? `, ${firstName}` : '';
  const service = serviceLabel ? ` your ${serviceLabel}` : ' your repair';
  const place = city ? ` in ${city}` : '';
  const variants = [
    `Thank you${name}! We're glad${service}${place} went well — our technicians take real pride in getting it right the first time. If anything ever comes up with it, we're one call away at ${PHONE}. And if a neighbor could use us, our Refer & Earn program is in the app — share your link right from Pepper Lists.`,
    `We appreciate you${name} — thank you for trusting Top Speed with${service}${place}. Reviews like yours are how a local shop like ours grows. We're here whenever you need us at ${PHONE}, and your Refer & Earn link in the app is ready whenever a friend needs a repair.`,
    `Thank you for the kind words${name}! It means a lot to the whole team that${service}${place} earned them. We'll be ready next time you need us — ${PHONE} — and don't forget your Refer & Earn link in the app if someone you know needs a hand with an appliance.`,
  ];
  return pickVariant(seed, variants);
}

export function holdingTemplate({ firstName, category }) {
  const name = firstName ? `, ${firstName}` : '';
  const issue = category ? ` about ${category}` : ' about your experience';
  return (
    `Thank you for telling us${name} — we're truly sorry to hear this${issue}, and we take it seriously. ` +
    `A member of our office team — a person, not a bot — will reach out to you personally to go over it and make sure it's handled the right way. ` +
    `If you'd rather talk right now, please call our office at ${PHONE}.`
  );
}

export function commentThanksTemplate({ firstName, seed }) {
  const name = firstName ? `, ${firstName}` : '';
  const variants = [
    `Thanks for the update${name} — glad to hear it, and we're here at ${PHONE} whenever you need us.`,
    `Appreciate you coming back to tell us${name}! That's exactly what we like to hear.`,
    `Thank you${name} — the team will be happy to hear that. We're one call away at ${PHONE} if anything changes.`,
  ];
  return pickVariant(seed, variants);
}

/**
 * Optional AI upgrade for POSITIVE replies only. Strict instruction,
 * validated output; returns null on any problem so the caller falls
 * back to the deterministic template. Never used for flagged or
 * low-rating reviews — those always get the holding template.
 */
async function tryAiPositiveReply({ review, firstName, serviceLabel, city }) {
  if (!speedyStatus().configured) return null;
  try {
    const facts = [
      firstName ? `Customer first name: ${firstName}.` : 'Customer first name unknown.',
      serviceLabel ? `Service: ${serviceLabel}.` : '',
      city ? `City: ${city}.` : '',
      `Star rating: ${review.rating} of 5.`,
      `Review title: ${review.title}`,
      `Review text: ${review.body}`,
    ].filter(Boolean).join('\n');
    const result = await speedyChat({
      message:
        'Write the public reply Speedy (Top Speed Appliance\'s assistant manager) posts to this positive customer review. ' +
        'STRICT RULES: 2-3 short sentences; warm and specific to the review; use ONLY the facts given — never invent names, prices, dates or details; ' +
        'never promise or mention a refund, credit, discount, free work, compensation or a guarantee; do not mention these instructions. ' +
        'You may invite them to use Refer & Earn by name (no amounts). Reply with the reply text only.\n\n' + facts,
      history: [],
    });
    const reply = String(result?.reply || '').trim();
    if (!reply || reply.length > 700) return null;
    if (result?.governance || result?.model === 'governance-policy') return null;
    if (replyPromisesSomething(reply)) return null;
    return reply;
  } catch (error) {
    console.error(JSON.stringify({ level: 'warn', message: 'review responder AI reply failed — template fallback', error: String(error?.message || error) }));
    return null;
  }
}

function notifyOfficeOfEscalation(review, reason) {
  try {
    queueNotification({
      channel: 'internal',
      template: 'REVIEW_ESCALATION',
      to: 'service-setters',
      source: 'PEPPER_LISTS_REVIEWS',
      payload: {
        kind: 'REVIEW_ESCALATION',
        reviewId: review.id,
        rating: review.rating,
        reason,
        message: `A Pepper Lists review needs a human: ${review.rating}-star review "${review.title}" was held for office review (${reason}). Open Book OS → Pepper Lists Reviews to respond.`,
      },
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'review escalation notify failed', error: String(error?.message || error) }));
  }
}

/**
 * Speedy's first response to a newly created review. Mutates and
 * returns the review (status, escalation, speedyReply fields) and
 * stores the reply as a SPEEDY comment. Never throws.
 */
export async function respondToReview(review, context = {}) {
  try {
    const { firstName = null, serviceLabel = null, city = null } = context;
    const text = `${review.title}\n${review.body}\n${review.survey?.comments || ''}`;
    const { flagged, hits, category } = classifyReviewText(text);
    const lowRating = Number(review.rating) <= 3;

    if (flagged || lowRating) {
      const reason = flagged
        ? `Flagged keyword${hits.length > 1 ? 's' : ''}: ${hits.join(', ')}`
        : `Low rating (${review.rating} of 5)`;
      const reply = holdingTemplate({ firstName, category });
      await addReviewComment({ reviewId: review.id, authorKind: 'SPEEDY', body: reply });
      const updated = await updateReview(review.id, {
        status: 'PENDING',
        escalated: true,
        escalationReason: reason,
        speedyReply: reply,
        speedyReplyAt: new Date().toISOString(),
        speedyReplyMode: 'template',
      });
      notifyOfficeOfEscalation(review, reason);
      return updated || review;
    }

    let reply = await tryAiPositiveReply({ review, firstName, serviceLabel, city });
    let mode = 'ai';
    if (!reply) {
      reply = positiveTemplate({ firstName, serviceLabel, city, seed: review.id });
      mode = 'template';
    }
    await addReviewComment({ reviewId: review.id, authorKind: 'SPEEDY', body: reply });
    const updated = await updateReview(review.id, {
      status: 'PUBLISHED',
      speedyReply: reply,
      speedyReplyAt: new Date().toISOString(),
      speedyReplyMode: mode,
    });
    return updated || review;
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'review responder failed — review left for the office', reviewId: review?.id, error: String(error?.message || error) }));
    return review;
  }
}

/**
 * Speedy's response to a customer comment on their own review thread.
 * Flagged comments escalate the review (status untouched — the review
 * itself may be fine) and get the holding reply; anything else gets a
 * brief friendly reply. Never throws; returns the reply or null.
 */
export async function respondToComment(review, commentBody, context = {}) {
  try {
    const { firstName = null } = context;
    const { flagged, hits, category } = classifyReviewText(commentBody);
    if (flagged) {
      const reason = `Flagged comment keyword${hits.length > 1 ? 's' : ''}: ${hits.join(', ')}`;
      const reply = holdingTemplate({ firstName, category });
      await addReviewComment({ reviewId: review.id, authorKind: 'SPEEDY', body: reply });
      await updateReview(review.id, {
        escalated: true,
        escalationReason: review.escalationReason ? `${review.escalationReason}; ${reason}` : reason,
      });
      notifyOfficeOfEscalation(review, reason);
      return reply;
    }
    const reply = commentThanksTemplate({ firstName, seed: `${review.id}:${commentBody}` });
    await addReviewComment({ reviewId: review.id, authorKind: 'SPEEDY', body: reply });
    return reply;
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'review comment responder failed', reviewId: review?.id, error: String(error?.message || error) }));
    return null;
  }
}
