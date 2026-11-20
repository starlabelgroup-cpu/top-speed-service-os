import { createHash, randomBytes } from 'node:crypto';
import { createId, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { estimateDecision, latestEstimate, recordEstimateDecisionForJob } from './jobMoney.js';

/**
 * Estimate approval links (2026-11-20, Wave 1 D3 — Ramone approved
 * the recommendations list) — the customer-facing half of the
 * estimate → decision chain that until now ended in person.
 *
 * A staff member sends the link from the Link Center (linkType
 * ESTIMATE, services/linkCenter.js) or any console CTA wired to it.
 * The link opens /estimate?ref=TS-XXXXXX&token=… where the customer
 * sees the estimate EXACTLY as saved on the booking — line items and
 * total read from the ESTIMATE_SAVED history event, never recomputed
 * — and approves or declines it. The decision lands through the SAME
 * recorder the in-person flows use (recordEstimateDecisionForJob in
 * services/jobMoney.js), so the ESTIMATE_APPROVED / ESTIMATE_DECLINED
 * history events, the authorization log, the tracking timeline, the
 * completion gate and the invoice gate all read it with no changes.
 * This service owns only the link: minting, state, and the claim.
 *
 * Token discipline mirrors services/emailChange.js: a random 32-byte
 * token whose SHA-256 hash is all that is stored. Links live 7 days.
 * One decision per link — the decision is claimed atomically on the
 * token row before the booking is touched, and after a decision the
 * link only ever shows the recorded outcome. A NEW estimate
 * supersedes every outstanding link for the booking twice over:
 * issuing a link stamps supersededAt on the older ones, and resolve /
 * decide re-check that the link's estimate is still the latest.
 *
 * No payment is collected on the approval page — the diagnostic
 * payment flow is separate and unchanged.
 */
export const ESTIMATE_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ESTIMATE_APPROVAL_TTL_LABEL = '7 days';
export const ESTIMATE_LINK_INVALID_MESSAGE = 'This estimate link is invalid';
export const ESTIMATE_LINK_INACTIVE_MESSAGE =
  'This estimate link is no longer active — it may have expired or been replaced by a newer estimate. Ask us to send a fresh one and we will.';

const APP_BASE = process.env.PUBLIC_WEB_BASE || 'https://topspeedserviceos.com';

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function estimateApprovalUrl(referenceCode, token) {
  return `${APP_BASE}/estimate?ref=${encodeURIComponent(referenceCode || '')}&token=${encodeURIComponent(token)}`;
}

function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

/** Find a booking in the working store by its reference code. */
function findBookingByRef(reference) {
  const wanted = String(reference || '').trim().toUpperCase();
  if (!wanted) return null;
  for (const booking of store.bookings.values()) {
    if (String(booking.referenceCode || '').toUpperCase() === wanted) return booking;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Repository: Prisma (database) or the in-memory skeleton — same
// shape as the repos in services/emailChange.js.
// ---------------------------------------------------------------------------
const tokensRepo = DATABASE_ENABLED
  ? {
      async create(record) {
        return db().estimateApprovalToken.create({
          data: {
            id: record.id, tokenHash: record.tokenHash, bookingId: record.bookingId,
            estimateId: record.estimateId, expiresAt: record.expiresAt,
            createdBy: record.createdBy,
          },
        });
      },
      async findByHash(tokenHash) {
        return db().estimateApprovalToken.findUnique({ where: { tokenHash } });
      },
      async findById(id) {
        return db().estimateApprovalToken.findUnique({ where: { id } });
      },
      async supersedeOutstanding(bookingId) {
        await db().estimateApprovalToken.updateMany({
          where: { bookingId, decision: null, supersededAt: null },
          data: { supersededAt: new Date() },
        });
      },
      async claimDecision(id, { decision, declineNote, decidedAt }) {
        const claimed = await db().estimateApprovalToken.updateMany({
          where: { id, decision: null, supersededAt: null },
          data: { decision, declineNote, decidedAt },
        });
        return claimed.count > 0;
      },
    }
  : {
      async create(record) {
        store.estimateApprovalTokens.set(record.tokenHash, {
          ...record,
          decision: null,
          declineNote: null,
          decidedAt: null,
          supersededAt: null,
          expiresAt: record.expiresAt.toISOString(),
          createdAt: record.createdAt.toISOString(),
        });
        return record;
      },
      async findByHash(tokenHash) {
        return store.estimateApprovalTokens.get(tokenHash) ?? null;
      },
      async findById(id) {
        for (const record of store.estimateApprovalTokens.values()) {
          if (record.id === id) return record;
        }
        return null;
      },
      async supersedeOutstanding(bookingId) {
        for (const [key, record] of store.estimateApprovalTokens.entries()) {
          if (record.bookingId === bookingId && !record.decision && !record.supersededAt) {
            record.supersededAt = new Date().toISOString();
            store.estimateApprovalTokens.set(key, record);
          }
        }
      },
      async claimDecision(id, { decision, declineNote, decidedAt }) {
        for (const [key, record] of store.estimateApprovalTokens.entries()) {
          if (record.id === id) {
            if (record.decision || record.supersededAt) return false;
            record.decision = decision;
            record.declineNote = declineNote;
            record.decidedAt = decidedAt.toISOString();
            store.estimateApprovalTokens.set(key, record);
            return true;
          }
        }
        return false;
      },
    };

/**
 * Mint a fresh approval link for the booking's CURRENT estimate.
 * The caller (Link Center resolve) has already answered the honest
 * errors for a missing booking / missing estimate. Issuing stamps
 * every still-outstanding link for this booking superseded, so only
 * the newest send is live.
 */
export async function issueEstimateApprovalLink(booking, { createdBy = null } = {}) {
  const estimate = latestEstimate(booking);
  if (!estimate) {
    fail(409, 'no_estimate', 'There is no saved estimate on this booking yet — save the estimate first, then send the approval link.');
  }
  const token = randomBytes(32).toString('base64url');
  const record = {
    id: createId(),
    tokenHash: hashToken(token),
    bookingId: booking.id,
    estimateId: estimate.id,
    expiresAt: new Date(Date.now() + ESTIMATE_APPROVAL_TTL_MS),
    createdBy,
    createdAt: new Date(),
  };
  await tokensRepo.supersedeOutstanding(booking.id);
  await tokensRepo.create(record);
  return {
    url: estimateApprovalUrl(booking.referenceCode, token),
    tokenId: record.id,
    estimateId: estimate.id,
    estimateTotalCents: estimate.totalCents,
    expiresAt: record.expiresAt.toISOString(),
  };
}

/** Load the (booking, token record) pair a link names, or throw the
 * one generic 404 — an unknown ref, an unknown token, and a token
 * minted for a different booking are indistinguishable by design. */
async function loadLink(reference, rawToken) {
  const booking = findBookingByRef(reference);
  if (!booking) fail(404, 'ESTIMATE_LINK_INVALID', ESTIMATE_LINK_INVALID_MESSAGE);
  const record = await tokensRepo.findByHash(hashToken(rawToken || ''));
  if (!record || record.bookingId !== booking.id) {
    fail(404, 'ESTIMATE_LINK_INVALID', ESTIMATE_LINK_INVALID_MESSAGE);
  }
  return { booking, record };
}

function linkState(booking, record) {
  if (record.decision) return 'DECIDED';
  const latest = latestEstimate(booking);
  if (record.supersededAt || !latest || record.estimateId !== latest.id) return 'SUPERSEDED';
  if (new Date(record.expiresAt).getTime() <= Date.now()) return 'EXPIRED';
  return 'PENDING';
}

function bookingBrief(booking) {
  const fullName = String(booking.customer?.name || '').trim();
  return {
    referenceCode: booking.referenceCode || null,
    appliance: booking.appliance || null,
    city: booking.city || null,
    customerFirstName: fullName ? fullName.split(/\s+/)[0] : null,
  };
}

function decisionView(booking, record) {
  if (!record.decision) return null;
  // The booking's own decision read model is the ledger's word; the
  // token row's copy covers the (never expected) case where the two
  // disagree, so the customer always sees the recorded outcome.
  const landed = estimateDecision(booking);
  const fromLedger = landed && landed.estimateId === record.estimateId ? landed : null;
  return {
    decision: record.decision,
    at: record.decidedAt ? new Date(record.decidedAt).toISOString() : fromLedger?.at || null,
    note: record.declineNote || fromLedger?.note || null,
    method: fromLedger?.method || 'APPROVAL_LINK',
  };
}

/**
 * The page's read model: the estimate exactly as saved (the same
 * object the office sees in the money view), the link's state, and —
 * once decided — the recorded outcome.
 */
export async function resolveEstimateApproval(reference, rawToken) {
  const { booking, record } = await loadLink(reference, rawToken);
  const state = linkState(booking, record);
  const estimate = (booking.history || [])
    .filter((event) => event.type === 'ESTIMATE_SAVED' && event.estimate?.id === record.estimateId)
    .map((event) => event.estimate)[0] || null;
  return {
    state,
    booking: bookingBrief(booking),
    estimate: state === 'SUPERSEDED' ? null : estimate,
    decision: decisionView(booking, record),
    expiresAt: new Date(record.expiresAt).toISOString(),
  };
}

/**
 * Record the customer's decision. Already-decided links answer with
 * the recorded outcome and change nothing (safe retries, double
 * taps). A live link claims its decision atomically, then lands it
 * on the booking through the shared recorder — same event shape as
 * an in-person decision, with method APPROVAL_LINK and the platform
 * event sourced ESTIMATE_LINK so the office feed shows where it
 * came from.
 */
export async function decideEstimateApproval(reference, rawToken, { decision, reason = null }) {
  const { booking, record } = await loadLink(reference, rawToken);
  if (record.decision) {
    return { alreadyDecided: true, state: 'DECIDED', decision: decisionView(booking, record) };
  }
  const state = linkState(booking, record);
  if (state !== 'PENDING') {
    fail(400, 'ESTIMATE_LINK_INACTIVE', ESTIMATE_LINK_INACTIVE_MESSAGE);
  }
  const declineNote = decision === 'DECLINED' ? reason || null : null;
  const claimed = await tokensRepo.claimDecision(record.id, {
    decision,
    declineNote,
    decidedAt: new Date(),
  });
  if (!claimed) {
    // A concurrent tap won the claim — answer with what landed.
    const fresh = await tokensRepo.findById(record.id);
    if (fresh?.decision) {
      return { alreadyDecided: true, state: 'DECIDED', decision: decisionView(booking, fresh) };
    }
    fail(400, 'ESTIMATE_LINK_INACTIVE', ESTIMATE_LINK_INACTIVE_MESSAGE);
  }
  const result = await recordEstimateDecisionForJob(
    booking,
    {
      decision,
      method: 'APPROVAL_LINK',
      authorizedByName: booking.customer?.name || null,
      note: declineNote,
    },
    { actor: 'customer', source: 'ESTIMATE_LINK', confirmedBy: 'CUSTOMER' },
  );
  if (!result.ok) {
    // Unreachable by construction (the estimate was validated as the
    // latest above) — surface it honestly rather than pretend.
    fail(result.status || 500, 'ESTIMATE_DECISION_FAILED', result.error || 'The decision could not be recorded');
  }
  const fresh = await tokensRepo.findById(record.id);
  return {
    alreadyDecided: false,
    state: 'DECIDED',
    decision: decisionView(booking, fresh || record),
    estimateDecision: result.estimateDecision,
  };
}
