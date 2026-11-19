import { store } from '../data/store.js';
import { DIAGNOSTIC_AMOUNT_CENTS, stripeConfigured, webhookConfigured } from './stripe.js';
import { speedyStatus } from './speedy.js';
import { googleConnections } from './insights.js';
import { adProvidersRepo } from '../db/adProvidersRepo.js';
import { sellerChannelsRepo } from '../db/sellerChannelsRepo.js';

/**
 * Pepper — Systems Manager: the duty-post aggregate (2026-11-18).
 *
 * Ramone directed Pepper to work INSIDE the Workstation as System
 * Operations Manager, reporting to him. This module is the board
 * behind that post: it reads the REAL state of the systems Pepper
 * watches, from the same services and repos the consoles themselves
 * use — it duplicates no system's logic and computes no number of
 * its own beyond counting rows those systems already hold.
 *
 * Honesty rules, enforced here:
 *  - Every section is read independently. A section that cannot be
 *    read comes back { available: false, reason } — never a guessed
 *    number, never a silent zero.
 *  - The identity block is the charter Ramone set: Pepper's title
 *    (2026-11-16), the reporting line to Ramone Williams, the
 *    2026-11-10 authority limits on AI, and Rule Zero — plus his
 *    2026-11-18 directive (PEPPER_OWNER_DIRECTIVE): Pepper is
 *    responsible for all systems, staff follow Pepper's orders and
 *    recommendations in the ordinary course, and any problem or
 *    issue is forwarded to him. That directive sits UNDER Rule
 *    Zero and the 2026-11-10 limits; it changes neither.
 */

export const PEPPER_IDENTITY = {
  agentName: 'Pepper',
  title: 'Pepper Agent — System Operations Manager',
  reportsTo: 'Ramone Williams',
  reportsToTitle: 'Owner — Master of Whole Systems',
  onDuty: 'On duty inside the Workstation: watching the systems board, keeping the report log, and surfacing anything that needs the owner.',
};

export const PEPPER_AUTHORITY_LIMITS = [
  'Issuing refunds requires a human or a configured approval — never Pepper or Speedy alone.',
  'Diagnosing safety-critical conditions requires a human professional.',
  'Certifying repair safety is never AI.',
  'Overriding technician credentials is never AI.',
  'Changing compliance status is authorized-human only.',
];

export const PEPPER_RULE_ZERO = 'Rule Zero — Owner Authority: Ramone Williams (owner account, COMPANY_OWNER) is the supreme authority on every Top Speed platform. No AI — Speedy, any automation, or Pepper — may override him, lock him out, revoke or demote his access, or make a change that outranks his. Everything Pepper builds or changes is under his direction and reversible by him at will.';

// The owner's staff-authority directive (Ramone Williams,
// 2026-11-18): "You will be responsible for all systems, platforms,
// apps, websites and landing pages. All employees must follow your
// orders and recommendations if no problems or issues arise if so
// forwarded to me Ramone Williams master account manager." Posted
// in the console's standing orders so every staff member sees it.
// It sits UNDER Rule Zero and the 2026-11-10 authority limits.
export const PEPPER_OWNER_DIRECTIVE = {
  issuedBy: 'Ramone Williams',
  issuedOn: '2026-11-18',
  scope: 'All systems, platforms, apps, websites and landing pages',
  staffRule: "All employees follow Pepper's orders and recommendations in the ordinary course of work.",
  escalation: 'If a problem or issue arises, it is forwarded to Ramone Williams.',
  source: 'Owner directive, 2026-11-18',
};

// Pepper's standing monitoring duties (owner directive,
// 2026-11-18): the watch Pepper keeps over every surface and
// channel the business runs on, posted with the standing orders.
export const PEPPER_STANDING_DUTIES = [
  'Monitor all systems, platforms, apps, websites and landing pages',
  'Monitor work activities across Top Speed Service OS and the other platforms',
  'Monitor web traffic and website activity',
  'Monitor email activity',
  'Monitor business phone voice and SMS activity',
];

const UNAVAILABLE_REASON = 'This system could not be read from this server right now — open its own console for the live state.';

function countByStatus(rows) {
  const byStatus = {};
  for (const row of rows) {
    const status = row?.status || 'UNKNOWN';
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  return byStatus;
}

const defaultReaders = {
  // Payments — the same configuration reads as GET /payments/status.
  async payments() {
    return {
      configured: stripeConfigured(),
      webhookConfigured: webhookConfigured(),
      diagnosticAmountCents: DIAGNOSTIC_AMOUNT_CENTS,
    };
  },

  // Speedy — the same status the health endpoint reports.
  async speedy() {
    const status = speedyStatus();
    return {
      configured: status.configured,
      provider: status.provider,
      model: status.model,
      knowledge: status.knowledge,
    };
  },

  // Notifications — counts over the same outbox store the
  // Notifications console reads (routes/notifications.js summary).
  async notifications() {
    const entries = store.notificationOutbox || [];
    const byStatus = countByStatus(entries);
    return {
      total: entries.length,
      byStatus,
      queued: (byStatus.QUEUED || 0) + (byStatus.QUEUED_SIMULATED || 0),
      sent: byStatus.SENT || 0,
      failed: byStatus.FAILED || 0,
      gated: byStatus.GATED || 0,
    };
  },

  // Insights — the same connection states as GET /insights/connections.
  async insights() {
    const { connections } = googleConnections();
    return {
      connections: (connections || []).map((c) => ({ id: c.id, label: c.label, status: c.status })),
    };
  },

  // Ad Studio — campaign counts from the same store Ad Studio reads,
  // plus the AdStream provider connection states from its repo.
  async adStudio() {
    const campaigns = store.adCampaigns || [];
    const byStatus = countByStatus(campaigns);
    let providers;
    try {
      const rows = await adProvidersRepo.listConnections();
      providers = {
        available: true,
        connections: rows.map((row) => ({ provider: row.provider, status: row.status })),
      };
    } catch {
      providers = { available: false, reason: UNAVAILABLE_REASON, connections: [] };
    }
    return {
      totalCampaigns: campaigns.length,
      byStatus,
      pendingApproval: byStatus.PENDING_APPROVAL || 0,
      providers,
    };
  },

  // Pepper Lists — seller channel connections from their repo.
  async pepperLists() {
    const rows = await sellerChannelsRepo.listAll();
    const byStatus = countByStatus(rows);
    return {
      total: rows.length,
      byStatus,
      pending: byStatus.PENDING || 0,
    };
  },
};

async function readSection(reader) {
  try {
    return { available: true, ...(await reader()) };
  } catch {
    return { available: false, reason: UNAVAILABLE_REASON };
  }
}

/**
 * Build the full duty-post payload. `readers` is injectable so the
 * drills can exercise the honest-unavailable path; production calls
 * this with no argument and gets the real readers.
 */
export async function buildPepperStatus(readers = defaultReaders) {
  const [payments, speedy, notifications, insights, adStudio, pepperLists] = await Promise.all([
    readSection(readers.payments),
    readSection(readers.speedy),
    readSection(readers.notifications),
    readSection(readers.insights),
    readSection(readers.adStudio),
    readSection(readers.pepperLists),
  ]);
  return {
    identity: {
      ...PEPPER_IDENTITY,
      authorityLimits: PEPPER_AUTHORITY_LIMITS,
      ruleZero: PEPPER_RULE_ZERO,
      ownerDirective: PEPPER_OWNER_DIRECTIVE,
      standingDuties: PEPPER_STANDING_DUTIES,
    },
    generatedAt: new Date().toISOString(),
    sections: { payments, speedy, notifications, insights, adStudio, pepperLists },
  };
}
