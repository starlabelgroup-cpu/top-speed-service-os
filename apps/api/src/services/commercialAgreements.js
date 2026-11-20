import { createHash, randomBytes } from 'node:crypto';
import { addBookingEvent, appendEvent, createId, createWorkOrderCode, store } from '../data/store.js';
import { persistBooking } from '../db/bookingsRepo.js';
import { createCommercialBooking, deriveWorkOrderPriority } from './commercial.js';
import { notifyCommercialWorkOrderReceived } from './notifications.js';

/**
 * Commercial recurring revenue — maintenance agreements (B7) and
 * structured quotes with approve-by-link (B8), 2026-11-20, from the
 * recommendations program Ramone approved in full.
 *
 * B7 — MAINTENANCE AGREEMENTS. An agreement is a commercial account's
 * scheduled preventive-maintenance cadence. When a visit comes due,
 * the generator spawns the SAME commercial work order the office
 * creates by hand (same priority derivation, same linked booking in
 * the Service Setters pipeline) — no side channel. Generation runs
 * lazily when staff read the agreements surface, plus on an explicit
 * staff run — the platform's established no-cron idiom (the same one
 * advertiser-plan downgrades and grace states use). Agreement terms
 * are DATA the office records per client (scope / terms / billing
 * notes); nothing here invents a term, a price, or a visit.
 *
 * B8 — COMMERCIAL QUOTES. A quote is structured line items priced by
 * the OFFICE (custom commercial pricing is the office's number, typed
 * per quote — the system never invents one) with the total computed
 * server-side. Commercial is quote-only: no diagnostic fee appears
 * anywhere in this flow. Approval rides a token link in the
 * email-change idiom — a random 32-byte token, SHA-256 hash at rest,
 * single-decision. Approval converts the quote into a commercial
 * work order carrying the quote's line items and total VERBATIM.
 */

// ---------------------------------------------------------------------------
// B7 — agreements
// ---------------------------------------------------------------------------

export const AGREEMENT_CADENCES = ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'];
export const CADENCE_MONTHS = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12 };
export const AGREEMENT_STATUSES = ['ACTIVE', 'PAUSED', 'ENDED'];

/** Catch-up cap per generation run: a long-dormant agreement spawns
 * at most this many missed visits in one pass. */
export const MAX_CATCHUP_VISITS = 12;

export function addMonths(iso, months) {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString();
}

/**
 * Spawn a commercial work order exactly the way POST
 * /commercial/work-orders does — same priority derivation, same
 * linked booking, same notifications — for a system origin (an
 * agreement visit or an approved quote). `extra` fields land on the
 * work order record (agreementId / quoteId / quote totals).
 */
export async function spawnCommercialWorkOrder({ companyId, account, facility, equipment = null, issue, actor, eventSource, eventDetails = {}, extra = {} }) {
  const { priority, reasons } = deriveWorkOrderPriority(account, equipment);
  const now = new Date().toISOString();
  const workOrder = {
    id: createId(),
    companyId,
    referenceCode: createWorkOrderCode(),
    accountId: account.id,
    facilityId: facility.id,
    equipmentId: equipment?.id || null,
    assetTag: equipment?.assetTag || null,
    issue,
    priority,
    priorityReasons: reasons,
    status: 'OPEN',
    bookingId: null,
    bookingReferenceCode: null,
    ...extra,
    createdAt: now,
    updatedAt: now,
  };

  const booking = await createCommercialBooking({ companyId, account, facility, equipment, workOrder });
  workOrder.bookingId = booking.id;
  workOrder.bookingReferenceCode = booking.referenceCode;
  store.commercialWorkOrders.set(workOrder.id, workOrder);

  await appendEvent('COMMERCIAL_WORK_ORDER_CREATED', {
    source: eventSource,
    actor,
    entityType: 'COMMERCIAL_WORK_ORDER',
    entityId: workOrder.id,
    referenceCode: workOrder.referenceCode,
    details: {
      accountId: account.id,
      accountReference: account.referenceCode,
      facilityId: facility.id,
      equipmentId: equipment?.id || null,
      assetTag: equipment?.assetTag || null,
      slaTier: account.slaTier,
      priority,
      priorityReasons: reasons,
      bookingId: booking.id,
      bookingReferenceCode: booking.referenceCode,
      ...eventDetails,
    },
  });
  notifyCommercialWorkOrderReceived(workOrder, booking, account, facility, eventSource);
  return { workOrder, booking };
}

/**
 * Generate every due agreement visit. For each ACTIVE agreement whose
 * nextVisitAt has arrived, spawn one work order per due period
 * (catch-up capped) and advance the schedule from the SCHEDULED date
 * — never from "now" — so cadence never drifts. Idempotent at any
 * instant: a second run at the same `now` creates nothing.
 */
export async function generateDueAgreementVisits({ now = new Date(), companyId = null } = {}) {
  const nowMs = now.getTime();
  const summary = [];
  for (const agreement of store.maintenanceAgreements.values()) {
    if (agreement.status !== 'ACTIVE') continue;
    if (companyId && agreement.companyId !== companyId) continue;
    if (!agreement.nextVisitAt || new Date(agreement.nextVisitAt).getTime() > nowMs) continue;

    const account = store.commercialAccounts.get(agreement.accountId);
    const facility = store.commercialFacilities.get(agreement.facilityId);
    if (!account || !facility) {
      summary.push({ agreementId: agreement.id, referenceCode: agreement.referenceCode, workOrdersCreated: 0, error: 'account or facility no longer exists' });
      continue;
    }
    const equipment = agreement.equipmentId ? store.commercialEquipment.get(agreement.equipmentId) || null : null;
    const months = CADENCE_MONTHS[agreement.cadence] || 1;
    let created = 0;
    let scheduledFor = agreement.nextVisitAt;
    try {
      while (new Date(scheduledFor).getTime() <= nowMs && created < MAX_CATCHUP_VISITS) {
        const issue =
          `Scheduled preventive maintenance visit — agreement ${agreement.referenceCode}` +
          (agreement.scopeNotes ? ` · Scope: ${agreement.scopeNotes}` : '') +
          ` · Visit scheduled for ${String(scheduledFor).slice(0, 10)}`;
        const { workOrder } = await spawnCommercialWorkOrder({
          companyId: agreement.companyId,
          account,
          facility,
          equipment,
          issue,
          actor: 'maintenance-agreement',
          eventSource: 'MAINTENANCE_AGREEMENT',
          eventDetails: { agreementId: agreement.id, agreementReference: agreement.referenceCode, scheduledFor },
          extra: { agreementId: agreement.id, agreementReference: agreement.referenceCode, scheduledFor },
        });
        await appendEvent('MAINTENANCE_VISIT_GENERATED', {
          source: 'MAINTENANCE_AGREEMENT',
          actor: 'maintenance-agreement',
          entityType: 'MAINTENANCE_AGREEMENT',
          entityId: agreement.id,
          referenceCode: agreement.referenceCode,
          details: { workOrderId: workOrder.id, workOrderReference: workOrder.referenceCode, scheduledFor },
        });
        agreement.lastVisitAt = scheduledFor;
        scheduledFor = addMonths(scheduledFor, months);
        created += 1;
      }
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'agreement visit generation failed', agreementId: agreement.id, error: String(error?.message || error) }));
      summary.push({ agreementId: agreement.id, referenceCode: agreement.referenceCode, workOrdersCreated: created, error: String(error?.message || error) });
      continue;
    }
    agreement.nextVisitAt = scheduledFor;
    agreement.updatedAt = new Date().toISOString();
    summary.push({
      agreementId: agreement.id,
      referenceCode: agreement.referenceCode,
      workOrdersCreated: created,
      nextVisitAt: agreement.nextVisitAt,
    });
  }
  return summary;
}

// ---------------------------------------------------------------------------
// B8 — quotes
// ---------------------------------------------------------------------------

export const QUOTE_STATUSES = ['DRAFT', 'SENT', 'APPROVED', 'DECLINED', 'EXPIRED'];
export const QUOTE_APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const QUOTE_INVALID_MESSAGE = 'This approval link is invalid or has expired';

/** Validate + price quote line items. Totals are computed HERE, from
 * the office's per-line numbers — a client-sent total is never read. */
export function priceQuoteLineItems(items) {
  const lineItems = (items || []).map((item) => {
    const quantity = Number(item.quantity);
    const unitPriceCents = Number(item.unitPriceCents);
    return {
      description: String(item.description || '').trim(),
      quantity,
      unitPriceCents,
      totalCents: Math.round(quantity * unitPriceCents),
    };
  });
  const totalCents = lineItems.reduce((sum, item) => sum + item.totalCents, 0);
  return { lineItems, totalCents };
}

export function quoteEffectiveStatus(quote, now = new Date()) {
  if (quote.status === 'SENT' && quote.validUntil) {
    const today = now.toISOString().slice(0, 10);
    if (quote.validUntil < today) return 'EXPIRED';
  }
  return quote.status;
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Issue an approval token for a quote (superseding any outstanding
 * one). The raw token exists only in the returned approval URL; the
 * store keeps its SHA-256 hash. Expiry is the earlier of the 30-day
 * TTL and the quote's valid-until date.
 */
export function issueQuoteApprovalToken(quote, now = new Date()) {
  for (const [key, record] of store.commercialQuoteTokens.entries()) {
    if (record.quoteId === quote.id && !record.usedAt) {
      record.usedAt = now.toISOString();
      store.commercialQuoteTokens.set(key, record);
    }
  }
  const token = randomBytes(32).toString('base64url');
  let expiresAt = new Date(now.getTime() + QUOTE_APPROVAL_TTL_MS);
  if (quote.validUntil) {
    const validEnd = new Date(`${quote.validUntil}T23:59:59.999Z`);
    if (validEnd < expiresAt) expiresAt = validEnd;
  }
  const record = {
    id: createId(),
    quoteId: quote.id,
    expiresAt: expiresAt.toISOString(),
    usedAt: null,
    createdAt: now.toISOString(),
  };
  store.commercialQuoteTokens.set(hashToken(token), record);
  return { token, expiresAt: record.expiresAt, tokenId: record.id };
}

export function findQuoteApproval(rawToken) {
  if (!rawToken) return { state: 'invalid' };
  const record = store.commercialQuoteTokens.get(hashToken(rawToken));
  if (!record) return { state: 'invalid' };
  const quote = store.commercialQuotes.get(record.quoteId);
  if (!quote) return { state: 'invalid' };
  if (record.usedAt) return { state: 'used', record, quote };
  if (new Date(record.expiresAt).getTime() <= Date.now()) return { state: 'expired', record, quote };
  return { state: 'ok', record, quote };
}

/**
 * Record the customer's decision from the approval link. The token
 * is claimed exactly once; a quote that already carries a decision
 * answers already_decided and changes nothing. APPROVED converts
 * the quote into a commercial work order carrying the quote's line
 * items and total verbatim.
 */
export async function decideQuoteByToken(rawToken, decision, { decidedByName = null } = {}) {
  const found = findQuoteApproval(rawToken);
  if (found.state === 'invalid' || found.state === 'expired') {
    return { ok: false, status: 400, error: QUOTE_INVALID_MESSAGE, code: 'QUOTE_LINK_INVALID' };
  }
  const { record, quote } = found;
  const effective = quoteEffectiveStatus(quote);
  if (quote.status === 'APPROVED' || quote.status === 'DECLINED') {
    return { ok: false, status: 409, error: 'already_decided', code: 'QUOTE_ALREADY_DECIDED', quote };
  }
  // A used token on an undecided quote is a SUPERSEDED link (a newer
  // one was issued) — it views the quote but can never decide it.
  if (found.state === 'used') {
    return { ok: false, status: 400, error: QUOTE_INVALID_MESSAGE, code: 'QUOTE_LINK_INVALID' };
  }
  if (effective === 'EXPIRED') {
    return { ok: false, status: 422, error: 'This quote has expired — call the office and we will re-issue it.', code: 'QUOTE_EXPIRED', quote };
  }
  if (quote.status !== 'SENT') {
    return { ok: false, status: 400, error: QUOTE_INVALID_MESSAGE, code: 'QUOTE_LINK_INVALID' };
  }
  // Claim the token: exactly one decision can ever land.
  record.usedAt = new Date().toISOString();
  store.commercialQuoteTokens.set(hashToken(rawToken), record);

  const now = new Date().toISOString();
  quote.decidedAt = now;
  quote.decidedByName = decidedByName;
  quote.updatedAt = now;

  if (decision === 'DECLINED') {
    quote.status = 'DECLINED';
    await appendEvent('COMMERCIAL_QUOTE_DECLINED', {
      source: 'COMMERCIAL_QUOTE', actor: 'customer-link', entityType: 'COMMERCIAL_QUOTE', entityId: quote.id,
      referenceCode: quote.referenceCode,
      details: { accountId: quote.accountId, totalCents: quote.totalCents },
    });
    return { ok: true, quote, workOrder: null };
  }

  quote.status = 'APPROVED';
  const account = store.commercialAccounts.get(quote.accountId);
  const facility = store.commercialFacilities.get(quote.facilityId);
  const equipment = quote.equipmentId ? store.commercialEquipment.get(quote.equipmentId) || null : null;
  const issue =
    `Approved quote ${quote.referenceCode} — ${quote.title} · ` +
    quote.lineItems.map((item) => `${item.description} ×${item.quantity}`).join('; ');
  const { workOrder, booking } = await spawnCommercialWorkOrder({
    companyId: quote.companyId,
    account,
    facility,
    equipment,
    issue,
    actor: 'customer-link',
    eventSource: 'COMMERCIAL_QUOTE',
    eventDetails: { quoteId: quote.id, quoteReference: quote.referenceCode, quoteTotalCents: quote.totalCents },
    extra: {
      quoteId: quote.id,
      quoteReference: quote.referenceCode,
      quoteTotalCents: quote.totalCents,
      quoteLineItems: quote.lineItems,
    },
  });
  quote.workOrderId = workOrder.id;
  quote.workOrderReference = workOrder.referenceCode;
  addBookingEvent(booking, 'QUOTE_APPROVED', 'customer-link', {
    quoteReference: quote.referenceCode,
    quoteTotalCents: quote.totalCents,
  });
  await persistBooking(booking).catch(() => {});
  await appendEvent('COMMERCIAL_QUOTE_APPROVED', {
    source: 'COMMERCIAL_QUOTE', actor: 'customer-link', entityType: 'COMMERCIAL_QUOTE', entityId: quote.id,
    referenceCode: quote.referenceCode,
    details: {
      accountId: quote.accountId, totalCents: quote.totalCents,
      workOrderId: workOrder.id, workOrderReference: workOrder.referenceCode,
      bookingReferenceCode: booking.referenceCode,
    },
  });
  return { ok: true, quote, workOrder };
}

/** The customer-facing view of a quote (approval page payload). */
export function publicQuoteView(quote) {
  const account = store.commercialAccounts.get(quote.accountId);
  const facility = store.commercialFacilities.get(quote.facilityId);
  return {
    referenceCode: quote.referenceCode,
    title: quote.title,
    companyName: account?.companyName || null,
    facilityName: facility?.name || null,
    facilityCity: facility?.city || null,
    lineItems: quote.lineItems,
    totalCents: quote.totalCents,
    currency: 'USD',
    notes: quote.notes || null,
    termsNotes: quote.termsNotes || null,
    validUntil: quote.validUntil || null,
    status: quoteEffectiveStatus(quote),
    decidedAt: quote.decidedAt || null,
    workOrderReference: quote.workOrderReference || null,
    createdAt: quote.createdAt,
  };
}
