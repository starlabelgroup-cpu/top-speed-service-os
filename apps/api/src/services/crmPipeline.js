import { store } from '../data/store.js';
import { leadTypeOf } from './leadBookings.js';
import { invoiceMoney, latestEstimate } from './jobMoney.js';

/**
 * Top Speed CRM — Leads & Pipeline board (2026-11-19, Ramone approved
 * both CRM upgrades: this board + customer lifetime value / status
 * flags; see routes/crm.js for the flag + LTV side).
 *
 * The board assembles the SAME lead records the intake and Book OS
 * already work: the lead-type Connections (services/leadBookings.js
 * LEAD_TYPES — the exact set that also mints a setter-queue booking).
 * Provider applications, advertiser contacts and every other intake
 * type are NOT leads and never appear here. A Pepper Lists SALE is
 * not a lead either (it is not in LEAD_TYPES) — nothing here changes
 * that standing rule.
 *
 * The lead ↔ booking link is the platform's established one, the same
 * join the unified admin delete uses: the booking's in-memory
 * `lead.connectionReference`, or — the durable form that survives a
 * cold start, since bookingFromRow does not rebuild `lead` — the
 * BOOKING_CREATED entry in the booking's persisted history JSON.
 *
 * Stages: NEW / CONTACTED / ESTIMATE / WON / LOST.
 *  - A stage a setter stored on the connection (Connection.
 *    pipelineStage, via POST /crm/pipeline/:id/stage) always wins.
 *  - Otherwise the stage is derived from the linked booking:
 *    booking COMPLETED, or its invoice fully paid → WON; an estimate
 *    exists on the booking → ESTIMATE; anything else → NEW.
 *  - CONTACTED and LOST are staff-set only. There is deliberately no
 *    CONTACTED derivation: no per-connection staff-touch signal is
 *    recorded against a Connection (CRM notes hang on customers,
 *    outbox entries on bookings, inbox rows are matched on inbound
 *    mail) — inventing one would misstate the record.
 *
 * Per-lead value is the linked booking's REAL money only: the latest
 * estimate's total when an estimate exists, else the invoice total
 * when invoiced, else null. Null renders as "—" — a value is never
 * invented, defaulted, or estimated for display.
 */

export const PIPELINE_STAGES = ['NEW', 'CONTACTED', 'ESTIMATE', 'WON', 'LOST'];

export const PIPELINE_STAGE_LABELS = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  ESTIMATE: 'Estimate',
  WON: 'Won',
  LOST: 'Lost',
};

/** The established lead link, mirrored from routes/admin.js. */
export function leadConnectionReferenceOf(booking) {
  if (booking?.lead?.connectionReference) return booking.lead.connectionReference;
  const created = (booking?.history || []).find(
    (h) => (h?.type || h?.event) === 'BOOKING_CREATED' && h?.connectionReference,
  );
  return created?.connectionReference || null;
}

/** Map of connection reference → its linked booking, built per read. */
function bookingsByConnectionReference() {
  const map = new Map();
  for (const booking of store.bookings.values()) {
    const reference = leadConnectionReferenceOf(booking);
    if (reference && !map.has(reference)) map.set(reference, booking);
  }
  return map;
}

function invoiceFullyPaid(booking) {
  const money = invoiceMoney(booking);
  if (!money.invoice || money.invoiceTotalCents == null) return false;
  if (money.invoice.status === 'PAID') return true;
  return money.invoiceTotalCents > 0 && money.balanceDueCents === 0;
}

export function derivePipelineStage(connection, booking) {
  if (PIPELINE_STAGES.includes(connection?.pipelineStage)) return connection.pipelineStage;
  if (!booking) return 'NEW';
  if (booking.status === 'COMPLETED' || invoiceFullyPaid(booking)) return 'WON';
  if (latestEstimate(booking)) return 'ESTIMATE';
  return 'NEW';
}

export function leadValueCents(booking) {
  if (!booking) return null;
  const estimate = latestEstimate(booking);
  if (estimate && Number.isFinite(estimate.totalCents)) return estimate.totalCents;
  const invoice = invoiceMoney(booking).invoice;
  if (invoice) return Math.round(Number(invoice.total || 0) * 100);
  return null;
}

export function pipelineRow(connection, booking) {
  const lead = leadTypeOf(connection.type);
  return {
    id: connection.id,
    reference: connection.reference,
    name: connection.name,
    phone: connection.phone,
    email: connection.email || null,
    type: connection.type,
    typeLabel: lead ? lead.label : connection.type,
    source: connection.source || null,
    via: connection.attribution?.via || null,
    sourcePage: connection.attribution?.page || null,
    message: connection.message || null,
    bookingId: booking?.id || null,
    bookingReference: booking?.referenceCode || null,
    bookingStatus: booking?.status || null,
    customerId: booking?.customerId || null,
    service: booking?.appliance || null,
    city: booking?.city || null,
    stage: derivePipelineStage(connection, booking),
    stageStored: PIPELINE_STAGES.includes(connection?.pipelineStage),
    valueCents: leadValueCents(booking),
    createdAt: connection.createdAt,
  };
}

/**
 * The full board: one column per stage, in pipeline order, each with
 * its lead count and the sum of its KNOWN values (valueCents is null
 * for a column where no lead carries a real figure yet — never a
 * dressed-up zero).
 */
export function pipelineBoard() {
  const byReference = bookingsByConnectionReference();
  const columns = PIPELINE_STAGES.map((stage) => ({
    stage,
    label: PIPELINE_STAGE_LABELS[stage],
    count: 0,
    valueCents: null,
    leads: [],
  }));
  const columnOf = new Map(columns.map((c) => [c.stage, c]));
  let totalLeads = 0;
  const leads = [...store.connections]
    .filter((c) => leadTypeOf(c.type))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  for (const connection of leads) {
    const row = pipelineRow(connection, byReference.get(connection.reference) || null);
    const column = columnOf.get(row.stage);
    column.leads.push(row);
    column.count += 1;
    if (row.valueCents != null) {
      column.valueCents = (column.valueCents ?? 0) + row.valueCents;
    }
    totalLeads += 1;
  }
  return { columns, totalLeads, generatedAt: new Date().toISOString() };
}
