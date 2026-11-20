/**
 * Win-back campaigns (2026-11-20, D6 — Ramone approved all 55
 * recommendations).
 *
 * A staff tool for bringing past customers back: pick a lapsed
 * segment (last completed job N+ months ago, nothing booked since),
 * preview exactly who would be contacted and who is excluded and
 * why, then a Service Setter presses send. Sends ride the normal
 * notification outbox. There is NO scheduler and NO auto-send path
 * in this module or anywhere else: a campaign exists only because a
 * staff member triggered it.
 *
 * Exclusions are absolute and are computed identically at preview
 * and at send time (the send re-evaluates the segment from live
 * records, so an opt-out or complaint that lands between preview
 * and send still protects the customer):
 *  - OPTED_OUT — the customer opted out of marketing (texted STOP
 *    to the business line, or staff recorded it in the CRM).
 *  - OPEN_COMPLAINT — the customer has an escalated review the
 *    office has not answered yet (the platform's own complaint
 *    signal, the same one the exception queue derives from).
 *  - NO_CONTACT — no email and no phone on file: nothing to send to.
 *  - RECENTLY_CONTACTED — a win-back offer already went to this
 *    customer within the frequency window (90 days).
 *
 * This module is pure over plain record shapes so the segment math
 * drills without a database; routes assemble the inputs from the
 * store and the reviews repo.
 */

export const WINBACK_SEGMENTS = [
  { id: 'lapsed-3', months: 3, label: 'Lapsed 3+ months', blurb: 'Last completed job 3 or more months ago, nothing booked since.' },
  { id: 'lapsed-6', months: 6, label: 'Lapsed 6+ months', blurb: 'Last completed job 6 or more months ago, nothing booked since.' },
  { id: 'lapsed-12', months: 12, label: 'Lapsed 12+ months', blurb: 'Last completed job a year or more ago, nothing booked since.' },
];

export function winbackSegment(id) {
  return WINBACK_SEGMENTS.find((s) => s.id === id) || null;
}

/** One win-back offer per customer at most once per this window. */
export const WINBACK_RECENT_SEND_DAYS = 90;
/** An inbound text counts as a campaign reply within this window. */
export const WINBACK_REPLY_WINDOW_DAYS = 30;

const DAY_MS = 24 * 3600 * 1000;

export function monthsBefore(now, months) {
  const d = new Date(now);
  d.setMonth(d.getMonth() - months);
  return d;
}

function timeOf(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : null;
}

function last10(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

/**
 * Evaluate one segment over plain records.
 *
 * Inputs:
 *  - customers: the company's customer records.
 *  - bookings: the company's bookings (any status).
 *  - openComplaintCustomerIds: Set of customer ids with an open
 *    (escalated, office-unanswered) complaint.
 *  - lastWinbackSentAtByCustomer: Map customerId -> ISO time of the
 *    latest win-back offer actually queued/sent.
 *  - segment: a WINBACK_SEGMENTS entry. now: Date.
 *
 * Returns { members, excluded, counts } — members carry everything
 * the send + preview need; excluded carry the reason; counts names
 * why the rest of the customer base is not in the segment at all
 * (no completed job / too recent / booked since / active now), so
 * the preview numbers always add up in front of the setter.
 */
export function evaluateWinbackSegment({
  customers,
  bookings,
  openComplaintCustomerIds = new Set(),
  lastWinbackSentAtByCustomer = new Map(),
  segment,
  now = new Date(),
}) {
  const threshold = monthsBefore(now, segment.months).getTime();
  const recentCutoff = now.getTime() - WINBACK_RECENT_SEND_DAYS * DAY_MS;
  const byCustomer = new Map();
  for (const booking of bookings || []) {
    if (!booking.customerId) continue;
    if (!byCustomer.has(booking.customerId)) byCustomer.set(booking.customerId, []);
    byCustomer.get(booking.customerId).push(booking);
  }

  const members = [];
  const excluded = [];
  const counts = {
    totalCustomers: (customers || []).length,
    noCompletedJob: 0,
    tooRecent: 0,
    bookedSince: 0,
    activeNow: 0,
    excludedOptedOut: 0,
    excludedOpenComplaint: 0,
    excludedNoContact: 0,
    excludedRecentlyContacted: 0,
    members: 0,
  };

  for (const customer of customers || []) {
    const mine = byCustomer.get(customer.id) || [];
    const completed = mine.filter((b) => b.status === 'COMPLETED');
    if (!completed.length) {
      counts.noCompletedJob += 1;
      continue;
    }
    const lastCompleted = completed
      .map((b) => ({ booking: b, at: timeOf(b.completedAt) ?? timeOf(b.updatedAt) ?? timeOf(b.createdAt) ?? 0 }))
      .sort((a, b) => b.at - a.at)[0];
    if (lastCompleted.at > threshold) {
      counts.tooRecent += 1;
      continue;
    }
    const bookedSince = mine.some(
      (b) => b.status !== 'CANCELLED' && (timeOf(b.createdAt) ?? 0) > lastCompleted.at,
    );
    if (bookedSince) {
      counts.bookedSince += 1;
      continue;
    }
    const openNow = mine.some((b) => !['COMPLETED', 'CANCELLED'].includes(b.status));
    if (openNow) {
      counts.activeNow += 1;
      continue;
    }

    const base = {
      customerId: customer.id,
      name: customer.name || null,
      email: customer.email || null,
      phone: customer.phone || null,
      lastCompletedAt: new Date(lastCompleted.at).toISOString(),
      lastAppliance: lastCompleted.booking.appliance || null,
      lastReferenceCode: lastCompleted.booking.referenceCode || null,
      monthsSince: Math.max(segment.months, Math.floor((now.getTime() - lastCompleted.at) / (30.4375 * DAY_MS))),
    };

    if (customer.marketingOptOutAt) {
      counts.excludedOptedOut += 1;
      excluded.push({ ...base, reason: 'OPTED_OUT', reasonLabel: 'Opted out of marketing — never contacted' });
      continue;
    }
    if (openComplaintCustomerIds.has(customer.id)) {
      counts.excludedOpenComplaint += 1;
      excluded.push({ ...base, reason: 'OPEN_COMPLAINT', reasonLabel: 'Open complaint — an escalated review the office has not answered yet' });
      continue;
    }
    if (!customer.email && !customer.phone) {
      counts.excludedNoContact += 1;
      excluded.push({ ...base, reason: 'NO_CONTACT', reasonLabel: 'No email or phone on file' });
      continue;
    }
    const lastSent = lastWinbackSentAtByCustomer.get(customer.id);
    if (lastSent && (timeOf(lastSent) ?? 0) > recentCutoff) {
      counts.excludedRecentlyContacted += 1;
      excluded.push({ ...base, reason: 'RECENTLY_CONTACTED', reasonLabel: `Win-back offer already sent ${String(lastSent).slice(0, 10)} — one per ${WINBACK_RECENT_SEND_DAYS} days` });
      continue;
    }
    members.push(base);
  }

  counts.members = members.length;
  members.sort((a, b) => String(a.lastCompletedAt).localeCompare(String(b.lastCompletedAt)));
  return { members, excluded, counts };
}

/** Latest win-back send per customer, read off the outbox itself. */
export function lastWinbackSentByCustomer(outbox) {
  const map = new Map();
  for (const entry of outbox || []) {
    if (entry.template !== 'WINBACK_OFFER') continue;
    if (!['QUEUED', 'SENT'].includes(entry.status)) continue;
    const customerId = entry.payload?.customerId;
    if (!customerId) continue;
    const at = entry.createdAt || '';
    if (!map.has(customerId) || String(at) > String(map.get(customerId))) map.set(customerId, at);
  }
  return map;
}

/**
 * The campaign log, grouped from the outbox entries themselves (the
 * durable send record) — one row per campaignId with its real
 * delivery states, plus reply counts matched from WINBACK_REPLY
 * platform events (a reply counts when it arrives from a recipient
 * within the reply window after the send).
 */
export function groupWinbackCampaigns(outbox, events = []) {
  const byId = new Map();
  for (const entry of outbox || []) {
    if (entry.template !== 'WINBACK_OFFER' || !entry.payload?.campaignId) continue;
    const id = entry.payload.campaignId;
    if (!byId.has(id)) {
      byId.set(id, {
        campaignId: id,
        segment: entry.payload.segment || null,
        offerSlug: entry.payload.offerSlug || null,
        sentBy: entry.payload.sentBy || null,
        at: entry.createdAt || null,
        recipients: new Set(),
        queued: 0,
        sent: 0,
        failed: 0,
        gated: 0,
        entries: 0,
      });
    }
    const row = byId.get(id);
    row.entries += 1;
    if (entry.payload.customerId) row.recipients.add(entry.payload.customerId);
    if (entry.status === 'QUEUED') row.queued += 1;
    else if (entry.status === 'SENT') row.sent += 1;
    else if (entry.status === 'FAILED') row.failed += 1;
    else if (entry.status === 'GATED') row.gated += 1;
    if (entry.createdAt && (!row.at || entry.createdAt < row.at)) row.at = entry.createdAt;
  }
  const replies = (events || []).filter((e) => e.type === 'WINBACK_REPLY');
  const campaigns = [...byId.values()].map((row) => {
    const sentAt = timeOf(row.at) ?? 0;
    const replyCount = replies.filter((e) => {
      const at = timeOf(e.at) ?? 0;
      return (
        row.recipients.has(e.details?.customerId) &&
        at >= sentAt &&
        at <= sentAt + WINBACK_REPLY_WINDOW_DAYS * DAY_MS
      );
    }).length;
    return {
      campaignId: row.campaignId,
      segment: row.segment,
      offerSlug: row.offerSlug,
      sentBy: row.sentBy,
      at: row.at,
      recipientCount: row.recipients.size,
      queued: row.queued,
      sent: row.sent,
      failed: row.failed,
      gated: row.gated,
      replyCount,
    };
  });
  campaigns.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return campaigns;
}

/**
 * If an inbound text comes from a customer who received a win-back
 * offer within the reply window, it is a campaign reply: returns
 * { customer, campaignId, sentAt } or null. Matching is by the last
 * 10 phone digits, the same identity the rest of the platform uses.
 */
export function findWinbackRecipient({ customers, outbox, fromPhone, now = new Date() }) {
  const wanted = last10(fromPhone);
  if (!wanted) return null;
  // Prefer the live record over a merged-away duplicate (CRM merge,
  // 2026-11-20 D5): a tombstone keeps its old phone as an alias, but
  // the survivor is the customer.
  const matches = (customers || []).filter((c) => last10(c.phone) === wanted);
  const customer = matches.find((c) => !c.mergedIntoId) || matches[0];
  if (!customer) return null;
  const cutoff = now.getTime() - WINBACK_REPLY_WINDOW_DAYS * DAY_MS;
  let best = null;
  for (const entry of outbox || []) {
    if (entry.template !== 'WINBACK_OFFER') continue;
    if (entry.payload?.customerId !== customer.id) continue;
    if (!['QUEUED', 'SENT'].includes(entry.status)) continue;
    const at = timeOf(entry.createdAt) ?? 0;
    if (at < cutoff) continue;
    if (!best || at > best.at) best = { at, campaignId: entry.payload.campaignId || null };
  }
  if (!best) return null;
  return { customer, campaignId: best.campaignId, sentAt: new Date(best.at).toISOString() };
}

/** A text is an opt-out when its whole body is a STOP keyword. */
export function isStopText(text) {
  const body = String(text || '').trim().toUpperCase();
  return ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(body);
}
