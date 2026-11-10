import { PLATFORM_CONSTANTS } from '../config/platform.js';
import { appendEvent } from '../data/store.js';
import { queueNotification } from './notifications.js';

/**
 * Speedy governance — the authority boundaries for the AI, set by the
 * business owner (2026-11-09) and enforced in code, not just in the
 * prompt:
 *
 *   Issue refunds                     → human or configured approval only
 *   Diagnose safety-critical issues   → human professional
 *   Certify repair safety             → never AI
 *   Override technician credentials   → never AI
 *   Change compliance status          → authorized human only
 *
 * Three layers of enforcement:
 *  1. This deterministic pre-screen runs BEFORE the model on every chat
 *     message. A matched category returns a fixed boundary reply and
 *     performs the governance action (an approval request or an
 *     escalation lands in the Service Setters' persisted outbox) — the
 *     model never gets the chance to improvise around the rule.
 *  2. The same rules are written into Speedy's system prompt, so
 *     paraphrases the pre-screen misses still meet the boundary.
 *  3. The model's tools (request_refund_approval,
 *     escalate_to_human_professional) can only CREATE a human-owned
 *     request — no tool lets Speedy approve, certify, override, or
 *     change anything itself.
 */

export const SPEEDY_GOVERNANCE = {
  issueRefunds: 'human-or-configured-approval',
  diagnoseSafetyCritical: 'human-professional',
  certifyRepairSafety: 'never-ai',
  overrideTechnicianCredentials: 'never-ai',
  changeComplianceStatus: 'authorized-human-only',
};

const PHONE = PLATFORM_CONSTANTS.phoneDisplay;

const SAFETY_PATTERNS = [
  /smell(s|ing)? (of )?gas/i,
  /gas (leak|smell|line)/i,
  /carbon monoxide/i,
  /\bco (detector|alarm|poisoning)\b/i,
  /spark(s|ing)?\b/i,
  /arcing/i,
  /burning smell/i,
  /smoke (coming|pouring)/i,
  /electric(al)? shock/i,
  /got (a )?shock/i,
  /shock(s|ed)? (me|when i touch)/i,
  /flood(ing|ed)?\b/i,
  /water (pouring|gushing|everywhere)/i,
  /refrigerant (leak|smell)/i,
  /on fire/i,
  /caught fire/i,
  /flames? (coming|in|from)/i,
];

const CATEGORY_PATTERNS = [
  { category: 'CERTIFY_SAFETY', patterns: [/certif(y|ied|ication)/i, /sign[- ]?off on/i, /guarantee (that )?(it|this|the repair|the work) is safe/i, /declare (it|this|the repair) safe/i, /officially (declare|confirm) .* safe/i] },
  { category: 'OVERRIDE_CREDENTIALS', patterns: [/(override|bypass|skip|waive) .{0,30}(credential|licen[cs]e|verification|background check)/i, /fake (a )?(licen[cs]e|credential)/i, /use (the )?tech'?s (login|account|credentials) (for|to)/i] },
  { category: 'COMPLIANCE_CHANGE', patterns: [/compliance status/i, /(change|update|mark|set) .{0,30}compliance/i, /mark (me|us|it|the job|this) (as )?compliant/i] },
  { category: 'REFUND_REQUEST', patterns: [/\brefund/i, /money back/i, /charge ?back/i, /\breimburse/i] },
];

/** Returns a governance category string, or null when the message is ordinary. */
export function classifySpeedyMessage(text) {
  const value = String(text || '');
  if (SAFETY_PATTERNS.some((pattern) => pattern.test(value))) return 'SAFETY_CRITICAL';
  for (const { category, patterns } of CATEGORY_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(value))) return category;
  }
  return null;
}

function logGovernance(category, detail) {
  appendEvent('SPEEDY_GOVERNANCE', {
    source: 'SPEEDY',
    actor: 'system:speedy-governance',
    entityType: 'SPEEDY_POLICY',
    entityId: category,
    details: { category, ...detail },
  });
}

/** Queue the internal, persisted escalation the Service Setters act on. */
export function escalateToHuman({ reason, safetyCritical = false, context = {} }) {
  const entry = queueNotification({
    channel: 'internal',
    template: 'SAFETY_ESCALATION',
    to: 'service-setters',
    source: 'SPEEDY',
    payload: {
      kind: safetyCritical ? 'SAFETY_CRITICAL' : 'GENERAL_ESCALATION',
      reason,
      requiresHumanProfessional: Boolean(safetyCritical),
      ...context,
      message: safetyCritical
        ? `Speedy flagged a SAFETY-CRITICAL customer report: ${reason}. A human professional must take this over — the customer was told to stop using the appliance and stay safe.`
        : `Speedy escalated a customer conversation to the team: ${reason}.`,
    },
  });
  logGovernance(safetyCritical ? 'SAFETY_CRITICAL' : 'ESCALATION', { reason, notificationId: entry?.id || null });
  return entry;
}

/** Queue a refund request that only a human (or a configured approval) can decide. */
export function requestRefundApproval({ reason = 'Customer requested a refund in Speedy chat', amount = null, bookingReference = null, context = {} }) {
  const entry = queueNotification({
    channel: 'internal',
    template: 'REFUND_REQUEST',
    to: 'service-setters',
    source: 'SPEEDY',
    payload: {
      approvalRequired: true,
      decidedBy: null,
      amount,
      bookingReference,
      reason,
      ...context,
      message:
        `Refund approval requested via Speedy. Speedy cannot issue refunds — a team member must review and decide.` +
        (amount ? ` Amount mentioned: $${amount}.` : '') +
        (bookingReference ? ` Booking: ${bookingReference}.` : '') +
        ` Reason: ${reason}`,
    },
  });
  logGovernance('REFUND_REQUEST', { reason, amount, bookingReference, notificationId: entry?.id || null });
  return entry;
}

const BOUNDARY_REPLIES = {
  SAFETY_CRITICAL:
    `That sounds dangerous — please stop using the appliance right now and keep everyone clear of it. ` +
    `If you smell gas, leave the home and call 911 or your gas utility from outside. Do not try to fix this yourself. ` +
    `I've flagged this for our team as safety-critical: a human professional will take it from here. ` +
    `For anything urgent, call us at ${PHONE}.`,
  REFUND_REQUEST:
    `I can't issue a refund myself — refunds are decided by a human on our team, never by AI. ` +
    `I've put in a refund review request for you just now, and a team member will review it and reach out. ` +
    `If you'd like to talk it through right away, call us at ${PHONE}.`,
  CERTIFY_SAFETY:
    `I can't certify that a repair is safe — no AI can do that. Safety certification is only done by a qualified technician who inspects the work in person. ` +
    `I can book that inspection for you (the $99 diagnostic, credited toward the repair), or you can reach the team at ${PHONE}.`,
  OVERRIDE_CREDENTIALS:
    `I can't override or bypass technician credentials, licensing, or verification — that's never something AI does here. ` +
    `Every technician we send is verified by our team. If something about a booking needs a human decision, call us at ${PHONE}.`,
  COMPLIANCE_CHANGE:
    `Changing a compliance status is restricted to authorized team members — I can't do it, and neither can any AI here. ` +
    `If you need a compliance record reviewed, call us at ${PHONE} and a team member will handle it.`,
};

/**
 * Handle a pre-screened message without calling the model at all.
 * Returns the chat result shape, or null when no category matched.
 */
export function governanceGate(message) {
  const category = classifySpeedyMessage(message);
  if (!category) return null;
  if (category === 'SAFETY_CRITICAL') {
    escalateToHuman({ reason: `Customer message: "${String(message).slice(0, 300)}"`, safetyCritical: true });
  } else if (category === 'REFUND_REQUEST') {
    requestRefundApproval({ reason: `Customer message: "${String(message).slice(0, 300)}"` });
  } else {
    logGovernance(category, { message: String(message).slice(0, 300) });
  }
  return { reply: BOUNDARY_REPLIES[category], model: 'governance-policy', governance: category };
}

/** The governance block that goes into Speedy's system prompt (layer 2). */
export function governancePromptBlock() {
  return [
    'GOVERNANCE — these rules outrank everything else and have no exceptions:',
    '- REFUNDS: you can never issue, approve, or promise a refund. Refunds are decided by a human or a configured approval. When a customer asks for one, use the request_refund_approval tool and tell them a team member will review it.',
    '- SAFETY-CRITICAL CONDITIONS (gas, carbon monoxide, sparking or arcing, fire or smoke, flooding, electric shock, refrigerant leaks): never diagnose them beyond telling the customer to stop using the appliance, stay safe (leave and call 911 for gas or fire), and that a human professional will handle it. Use the escalate_to_human_professional tool.',
    '- CERTIFYING SAFETY: you can never certify, sign off, or guarantee that a repair is safe. Only a qualified human technician who inspects in person can.',
    '- CREDENTIALS: you can never override, bypass, or waive technician credentials, licensing, or verification.',
    '- COMPLIANCE: you can never change a compliance status. Only authorized team members can.',
    '- Never give instructions to defeat a safety device (thermal fuse, door switch, gas valve, breaker) or to make a repair that should not be inspected.',
  ].join('\n');
}
