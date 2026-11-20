import { z } from 'zod';
import { addBookingEvent, appendEvent, createId, store } from '../data/store.js';
import { persistBooking } from '../db/bookingsRepo.js';
import { persistInvoice } from '../db/techPackageRepo.js';
import { notifyTrackingUpdate } from './notifications.js';
import { computeTracking } from './tracking.js';

/**
 * Job money — the ONE estimate → decision → invoice → receipt chain,
 * shared by every surface that works a job (2026-11-19 create flows).
 *
 * Until tonight these operations lived only inside the Tech App's
 * provider routes, so the office could watch money but never originate
 * it. They now live here, surface-neutral: the Tech App calls them
 * with source TECH_APP, Book OS with source BOOK_OS — same records
 * (the booking's history is the estimate/decision/receipt ledger; the
 * Invoice table is the invoice of record), same server-side pricing,
 * same overpayment refusal. No surface gets its own money math.
 *
 * Pricing (Launch Pack, server-computed — the client never sets a
 * total): $99 residential diagnostic credited in full toward an
 * approved repair, $210 flat repair labor, $150 flat installation,
 * parts at the quoted per-line price, tech-entered tax on parts.
 * Commercial jobs carry NO $99 and no flat labor — their labor is the
 * custom-quoted amount entered on the estimate.
 */

export const ESTIMATE_LABOR_CENTS = { REPAIR: 21000, INSTALLATION: 15000 };

export const estimateSchema = z.object({
  kind: z.enum(['REPAIR', 'INSTALLATION']),
  laborCents: z.number().int().min(0).max(100000000).optional(),
  parts: z.array(z.object({
    description: z.string().trim().min(2).max(160),
    qty: z.number().int().min(1).max(999),
    unitPriceCents: z.number().int().min(0).max(100000000),
  })).max(30).optional(),
  discountCents: z.number().int().min(0).max(100000000).optional(),
  taxRatePercent: z.number().min(0).max(30).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export const authorizeSchema = z.object({
  method: z.enum(['IN_PERSON_VERBAL', 'SIGNATURE_ON_DEVICE', 'PHONE', 'TEXT', 'EMAIL', 'OTHER']),
  authorizedByName: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});

export const estimateDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'DECLINED']),
  // APPROVAL_LINK (2026-11-20): the customer decided on the public
  // estimate approval page (services/estimateApproval.js) — recorded
  // through this same schema/recorder so the event shape never forks.
  method: z.enum(['IN_PERSON_VERBAL', 'SIGNATURE_ON_DEVICE', 'PHONE', 'TEXT', 'EMAIL', 'OTHER', 'APPROVAL_LINK']).optional(),
  authorizedByName: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});

/* External receipts: money taken outside the platform (cash, check,
 * an external card payment, Zelle…). The record says THAT it was
 * received, by whom and how — card numbers are never collected. */
export const receiptSchema = z.object({
  method: z.enum(['CASH', 'CHECK', 'CARD_EXTERNAL', 'ZELLE', 'VENMO', 'OTHER']),
  amountCents: z.number().int().min(1).max(100000000),
  note: z.string().trim().max(300).nullable().optional(),
});

/* ---------------- Read models (fold the history back into state) -------- */

export function latestEstimate(booking) {
  let found = null;
  for (const event of booking.history || []) {
    if (event.type === 'ESTIMATE_SAVED' && event.estimate) found = event.estimate;
  }
  return found;
}

export function authorizationLog(booking) {
  return (booking.history || [])
    .filter((event) => event.type === 'ESTIMATE_APPROVED')
    .map((event) => ({
      at: event.at || null,
      actor: event.actor || null,
      method: event.method || 'RECORDED_IN_APP',
      authorizedByName: event.authorizedByName || null,
      estimateId: event.estimateId || null,
      note: event.note || null,
    }))
    .reverse();
}

export function estimateDecision(booking) {
  let found = null;
  for (const event of booking.history || []) {
    if (event.type === 'ESTIMATE_APPROVED') {
      found = {
        decision: 'APPROVED',
        estimateId: event.estimateId || null,
        at: event.at || null,
        actor: event.actor || null,
        method: event.method || 'RECORDED_IN_APP',
        authorizedByName: event.authorizedByName || null,
        note: event.note || null,
      };
    }
    if (event.type === 'ESTIMATE_DECLINED') {
      found = {
        decision: 'DECLINED',
        estimateId: event.estimateId || null,
        at: event.at || null,
        actor: event.actor || null,
        method: null,
        authorizedByName: null,
        note: event.note || null,
      };
    }
  }
  return found;
}

export function jobInvoice(booking) {
  const list = (store.invoices || []).filter((inv) => inv.serviceRequestId === booking.id && inv.status !== 'VOID');
  return list.length ? list[list.length - 1] : null;
}

export function jobReceipts(booking) {
  return (booking.history || [])
    .filter((event) => event.type === 'RECEIPT_RECORDED' && event.receipt)
    .map((event) => event.receipt)
    .reverse();
}

export function invoiceMoney(booking) {
  // The invoice is the balance of record once one exists (payments are
  // recorded against the invoice, never past its total). Before that,
  // the estimate total is the reference.
  const invoice = jobInvoice(booking);
  const receipts = jobReceipts(booking);
  const receiptsTotalCents = receipts.reduce((sum, r) => sum + (r.amountCents || 0), 0);
  const estimate = latestEstimate(booking);
  const invoiceTotalCents = invoice ? Math.round(Number(invoice.total || 0) * 100) : null;
  const referenceTotalCents = invoiceTotalCents != null ? invoiceTotalCents : estimate ? estimate.totalCents : null;
  return {
    invoice,
    receipts,
    receiptsTotalCents,
    invoiceTotalCents,
    balanceDueCents: referenceTotalCents == null ? null : Math.max(0, referenceTotalCents - receiptsTotalCents),
  };
}

/** The full money picture for one job — what the workspace and the
 * Book OS detail panel both render. */
export function jobMoneyView(booking) {
  const estimate = latestEstimate(booking);
  const money = invoiceMoney(booking);
  return {
    estimate,
    estimateDecision: estimateDecision(booking),
    authorizationLog: authorizationLog(booking),
    invoice: money.invoice,
    receipts: money.receipts,
    payments: {
      estimateTotalCents: estimate ? estimate.totalCents : null,
      receiptsTotalCents: money.receiptsTotalCents,
      invoiceTotalCents: money.invoiceTotalCents,
      balanceDueCents: money.balanceDueCents,
      invoice: money.invoice,
    },
  };
}

/* ---------------- Pricing ---------------- */

export function computeEstimate(booking, input) {
  const segment = booking.segment || 'RESIDENTIAL';
  const commercial = segment === 'COMMERCIAL';
  const diagnosticFeeCents = commercial ? 0 : Math.round(Number(booking.diagnosticFee ?? 99) * 100);
  const laborCents = commercial ? (input.laborCents ?? null) : ESTIMATE_LABOR_CENTS[input.kind];
  const parts = (input.parts || []).map((line) => ({
    description: line.description,
    qty: line.qty,
    unitPriceCents: line.unitPriceCents,
    lineTotalCents: line.qty * line.unitPriceCents,
  }));
  const partsSubtotalCents = parts.reduce((sum, line) => sum + line.lineTotalCents, 0);
  const taxRatePercent = input.taxRatePercent || 0;
  const taxCents = Math.round((partsSubtotalCents * taxRatePercent) / 100);
  const discountCents = input.discountCents || 0;
  // The $99 diagnostic is credited toward an approved REPAIR (Launch
  // Pack terms). It is not credited on a standalone installation, and
  // it never exists on a commercial job.
  const diagnosticCreditCents =
    !commercial && input.kind === 'REPAIR' && booking.diagnosticFeeCreditedTowardRepair !== false
      ? diagnosticFeeCents
      : 0;
  const totalCents = Math.max(
    0,
    (laborCents || 0) + partsSubtotalCents + taxCents - discountCents - diagnosticCreditCents,
  );
  return {
    segment,
    kind: input.kind,
    diagnosticFeeCents,
    diagnosticCreditCents,
    laborCents,
    parts,
    partsSubtotalCents,
    taxRatePercent,
    taxCents,
    discountCents,
    totalCents,
    notes: input.notes || null,
  };
}

/* ---------------- Write operations ----------------
 * Each returns { ok: true, ... } or { ok: false, status, error, ... }
 * so route wrappers keep their exact HTTP shapes. ctx: { actor,
 * source, assignmentId?, confirmedBy? } — confirmedBy records WHICH
 * human role stands behind the entry (TECHNICIAN in the field,
 * SERVICE_SETTERS in the office). */

export async function saveEstimateForJob(booking, input, ctx) {
  const computed = computeEstimate(booking, input);
  if (computed.segment === 'COMMERCIAL' && computed.laborCents == null) {
    return { ok: false, status: 400, error: 'Commercial jobs are priced by custom quote — enter the quoted labor amount' };
  }
  const t = new Date().toISOString();
  const prior = (booking.history || []).filter((e) => e.type === 'ESTIMATE_SAVED').length;
  const estimate = {
    id: createId(),
    version: prior + 1,
    ...computed,
    createdBy: ctx.actor,
    createdAt: t,
  };
  addBookingEvent(booking, 'ESTIMATE_SAVED', ctx.actor, {
    ...(ctx.assignmentId ? { assignmentId: ctx.assignmentId } : {}),
    estimate,
    confirmedBy: ctx.confirmedBy || 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  await appendEvent('ESTIMATE_SAVED', {
    source: ctx.source,
    actor: ctx.actor,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { estimateId: estimate.id, version: estimate.version, totalCents: estimate.totalCents },
  });
  return { ok: true, estimate };
}

export async function authorizeEstimateForJob(booking, input, ctx) {
  const estimate = latestEstimate(booking);
  if (!estimate) {
    return { ok: false, status: 409, error: 'Save the estimate first — an authorization must attach to a written quote' };
  }
  const t = new Date().toISOString();
  addBookingEvent(booking, 'ESTIMATE_APPROVED', ctx.actor, {
    ...(ctx.assignmentId ? { assignmentId: ctx.assignmentId } : {}),
    estimateId: estimate.id,
    method: input.method,
    authorizedByName: input.authorizedByName || null,
    note: input.note || null,
    confirmedBy: ctx.confirmedBy || 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  await appendEvent('ESTIMATE_APPROVED', {
    source: ctx.source,
    actor: ctx.actor,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { estimateId: estimate.id, method: input.method },
  });
  notifyTrackingUpdate(booking, computeTracking(booking).stageLabel8, ctx.source, `booking:${booking.id}:stage:ESTIMATE_APPROVED:${t}`);
  return { ok: true, authorizationLog: authorizationLog(booking) };
}

export async function recordEstimateDecisionForJob(booking, input, ctx) {
  const estimate = latestEstimate(booking);
  if (!estimate) {
    return { ok: false, status: 409, error: 'Save the estimate first — a decision must attach to a written quote' };
  }
  const t = new Date().toISOString();
  if (input.decision === 'APPROVED') {
    addBookingEvent(booking, 'ESTIMATE_APPROVED', ctx.actor, {
      ...(ctx.assignmentId ? { assignmentId: ctx.assignmentId } : {}),
      estimateId: estimate.id,
      method: input.method || 'RECORDED_IN_APP',
      authorizedByName: input.authorizedByName || null,
      note: input.note || null,
      confirmedBy: ctx.confirmedBy || 'TECHNICIAN',
    });
  } else {
    addBookingEvent(booking, 'ESTIMATE_DECLINED', ctx.actor, {
      ...(ctx.assignmentId ? { assignmentId: ctx.assignmentId } : {}),
      estimateId: estimate.id,
      note: input.note || null,
      confirmedBy: ctx.confirmedBy || 'TECHNICIAN',
    });
  }
  booking.updatedAt = t;
  await persistBooking(booking);
  await appendEvent(input.decision === 'APPROVED' ? 'ESTIMATE_APPROVED' : 'ESTIMATE_DECLINED', {
    source: ctx.source,
    actor: ctx.actor,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { estimateId: estimate.id, decision: input.decision },
  });
  if (input.decision === 'APPROVED') {
    notifyTrackingUpdate(booking, computeTracking(booking).stageLabel8, ctx.source, `booking:${booking.id}:stage:ESTIMATE_APPROVED:${t}`);
  }
  return { ok: true, estimateDecision: estimateDecision(booking), authorizationLog: authorizationLog(booking) };
}

export async function generateInvoiceForJob(booking, ctx) {
  const estimate = latestEstimate(booking);
  if (!estimate) {
    return { ok: false, status: 409, error: 'Save the estimate first — an invoice is generated from the approved estimate' };
  }
  const approved = (booking.history || []).some(
    (event) => event.type === 'ESTIMATE_APPROVED' && event.estimateId === estimate.id,
  );
  if (!approved) {
    return { ok: false, status: 409, error: 'The customer has not approved this estimate yet — record the decision before invoicing' };
  }
  const existing = (store.invoices || []).find(
    (inv) => inv.serviceRequestId === booking.id && inv.status !== 'VOID' && inv.estimateId === estimate.id,
  );
  if (existing) return { ok: true, invoice: existing, created: false };
  const t = new Date().toISOString();
  const invoice = {
    id: createId(),
    companyId: booking.companyId,
    serviceRequestId: booking.id,
    customerId: booking.customerId || null,
    status: 'SENT',
    subtotal: ((estimate.laborCents || 0) + estimate.partsSubtotalCents + estimate.taxCents - estimate.discountCents) / 100,
    diagnosticFee: estimate.diagnosticFeeCents / 100,
    diagnosticCredit: estimate.diagnosticCreditCents / 100,
    total: estimate.totalCents / 100,
    currency: 'USD',
    estimateId: estimate.id,
    createdBy: ctx.actor,
    createdAt: t,
    updatedAt: t,
  };
  store.invoices.push(invoice);
  await persistInvoice(invoice);
  addBookingEvent(booking, 'INVOICE_GENERATED', ctx.actor, {
    ...(ctx.assignmentId ? { assignmentId: ctx.assignmentId } : {}),
    invoiceId: invoice.id,
    estimateId: estimate.id,
    totalCents: estimate.totalCents,
    confirmedBy: ctx.confirmedBy || 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  await appendEvent('INVOICE_GENERATED', {
    source: ctx.source,
    actor: ctx.actor,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { invoiceId: invoice.id, estimateId: estimate.id, totalCents: estimate.totalCents },
  });
  return { ok: true, invoice, created: true };
}

export async function recordReceiptForJob(booking, input, ctx) {
  // Overpayment prevention (blueprint rule): once an invoice exists
  // for this job, recorded payments may never exceed its total — a
  // receipt past the balance due is refused, not clamped, so the
  // record always says what a human actually took.
  const moneyBefore = invoiceMoney(booking);
  if (moneyBefore.invoice && moneyBefore.balanceDueCents != null) {
    if (input.amountCents > moneyBefore.balanceDueCents) {
      return {
        ok: false,
        status: 409,
        error: `That receipt would overpay the invoice — the balance due is $${(moneyBefore.balanceDueCents / 100).toFixed(2)}`,
        balanceDueCents: moneyBefore.balanceDueCents,
      };
    }
  }
  const t = new Date().toISOString();
  const receipt = {
    id: createId(),
    method: input.method,
    amountCents: input.amountCents,
    note: input.note || null,
    at: t,
    recordedBy: ctx.actor,
  };
  addBookingEvent(booking, 'RECEIPT_RECORDED', ctx.actor, {
    ...(ctx.assignmentId ? { assignmentId: ctx.assignmentId } : {}),
    receipt,
    confirmedBy: ctx.confirmedBy || 'TECHNICIAN',
  });
  booking.updatedAt = t;
  await persistBooking(booking);
  await appendEvent('RECEIPT_RECORDED', {
    source: ctx.source,
    actor: ctx.actor,
    entityType: 'BOOKING',
    entityId: booking.id,
    referenceCode: booking.referenceCode,
    details: { receiptId: receipt.id, method: receipt.method, amountCents: receipt.amountCents },
  });
  // Keep the invoice's status honest against what has actually been
  // recorded: fully covered → PAID, partly → PARTIALLY_PAID.
  const moneyAfter = invoiceMoney(booking);
  if (moneyAfter.invoice) {
    const nextStatus = moneyAfter.balanceDueCents === 0 ? 'PAID' : moneyAfter.receiptsTotalCents > 0 ? 'PARTIALLY_PAID' : moneyAfter.invoice.status;
    if (nextStatus !== moneyAfter.invoice.status) {
      moneyAfter.invoice.status = nextStatus;
      moneyAfter.invoice.updatedAt = t;
      await persistInvoice(moneyAfter.invoice);
    }
  }
  const receipts = jobReceipts(booking);
  const estimate = latestEstimate(booking);
  const receiptsTotalCents = receipts.reduce((sum, r) => sum + (r.amountCents || 0), 0);
  return {
    ok: true,
    receipt,
    receipts,
    payments: {
      estimateTotalCents: estimate ? estimate.totalCents : null,
      receiptsTotalCents,
      invoiceTotalCents: moneyAfter.invoiceTotalCents,
      balanceDueCents: moneyAfter.balanceDueCents,
      invoice: moneyAfter.invoice,
    },
  };
}
