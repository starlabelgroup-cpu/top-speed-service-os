import { store } from '../data/store.js';
import { leadTypeOf } from './leadBookings.js';
import { derivePipelineStage, leadConnectionReferenceOf, leadValueCents } from './crmPipeline.js';
import { jobReceipts, latestEstimate } from './jobMoney.js';

/**
 * Top Speed Ads — cost per WON job report (2026-11-20, Ramone
 * approved recommendation E1 from the 2026-11-20 feature list).
 *
 * The join this report makes, per campaign: attributed intake →
 * CRM pipeline outcome → real money collected on the won jobs.
 *
 * ATTRIBUTION. A record belongs to a campaign when it carries the
 * campaign's sourceTag — the same carriesTag test Ad Studio's own
 * results counter uses (routes/adStudio.js): the flat intake
 * `source`, or the attribution object's `via` / `utmCampaign` (a
 * campaign link carries ?utm_campaign=<sourceTag>).
 *
 * THE FUNNEL SPINE is the CRM pipeline's own universe
 * (services/crmPipeline.js): lead-type Connections, each joined to
 * its linked booking by the established connectionReference link,
 * staged by the pipeline's own derivePipelineStage (a setter-stored
 * stage wins; else COMPLETED / fully-paid → WON, an estimate on
 * file → ESTIMATE, else NEW). A tagged booking that no lead
 * connection claims (a direct booking whose intake carried the tag)
 * stands as its own unit, staged from the booking alone — so a lead
 * and its booking are never double-counted.
 *
 * WON VALUE is money ACTUALLY RECEIVED, in integer cents, summed
 * with the CRM lifetime-value idiom (routes/crm.js): the Payment
 * table's PAID rows for the booking plus its recorded external
 * receipts (RECEIPT_RECORDED history events, via jobMoney's
 * jobReceipts). The two ledgers never double-count (receipts are
 * capped at the invoice balance; PAID Payment rows are the online
 * checkouts). Estimates are NEVER revenue here. The pipeline's own
 * per-lead value (latest estimate, else invoice total, else null)
 * rides alongside as wonPipelineValueCents, labeled as what it is,
 * with a count of how many won units carry a known figure.
 *
 * IMPRESSIONS / CLICKS are the campaign's linked Banner counters —
 * running all-time counters bumped by the display feed and the
 * click path. They are NOT a windowed log: no per-day breakdown
 * exists, so the report labels them ALL_TIME and never pretends
 * they belong to the window. A campaign with no banner carries
 * null (nothing was ever counted for it), not a dressed-up zero.
 *
 * COST — the honest center of this report. As modeled today the
 * AdCampaign record carries NO budget and NO spend field (verified
 * in prisma/schema.prisma and the create/patch schemas in
 * routes/adStudio.js): the in-house studio spends nothing outside
 * itself by design, and spend on the external platforms (Google,
 * Meta, Microsoft) lives in those platforms — their registry here
 * (data/externalAds.js) holds daily BUDGET labels, which are not
 * recorded spend, and this report never turns a budget label into
 * a cost. recordedCostCents below is the single seam: it reads a
 * recorded spend/budget figure off the campaign record if one is
 * ever modeled there, and returns null until then. Every row
 * therefore reports costPerWonCents null with status
 * NO_COST_RECORDED — "no cost recorded" — instead of a division
 * by an invented number.
 */

export const COST_PER_WON_NOTE =
  'No campaign in this system carries a recorded spend figure: the in-house Ad Studio spends nothing outside itself, '
  + 'and spend on the external platforms (Google, Meta, Microsoft) lives in those platforms and is never imported here. '
  + 'Until a recorded spend figure exists on a campaign record, cost per won job reads "No cost recorded" rather than '
  + 'a number divided out of a budget label.';

/** Mirrors carriesTag in routes/adStudio.js (same test, same shapes). */
export function carriesCampaignTag(record, sourceTag) {
  if (!record) return false;
  if (record.source === sourceTag) return true;
  const attribution = record.attribution;
  return Boolean(attribution && (attribution.via === sourceTag || attribution.utmCampaign === sourceTag));
}

/**
 * The recorded cost of a campaign, in integer cents — or null when
 * the campaign record carries no recorded spend/budget figure. As
 * modeled on 2026-11-20 no such field exists on AdCampaign, so this
 * returns null for every real campaign; the reads below are the
 * seam a future recorded-spend field plugs into, and nothing else
 * in the report changes the day one exists.
 */
export function recordedCostCents(campaign) {
  if (!campaign) return null;
  for (const field of ['spendCents', 'budgetCents']) {
    const value = campaign[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value);
  }
  return null;
}

/** Pure division, drilled directly: null unless both sides are real. */
export function costPerWonCents(costCents, wonCount) {
  if (costCents == null || !Number.isFinite(costCents)) return null;
  if (!wonCount || !Number.isFinite(wonCount) || wonCount <= 0) return null;
  return Math.round(costCents / wonCount);
}

/** PAID Payment rows by booking — the CRM LTV idiom (routes/crm.js). */
function paidCentsByBooking() {
  const map = new Map();
  for (const payment of store.payments.values()) {
    if (payment.status !== 'PAID') continue;
    map.set(payment.bookingId, (map.get(payment.bookingId) || 0) + (payment.amountCents || 0));
  }
  return map;
}

/** Money actually received for one booking: PAID payments + receipts. */
function collectedCents(booking, paidMap) {
  if (!booking) return 0;
  let total = paidMap.get(booking.id) || 0;
  for (const receipt of jobReceipts(booking)) total += receipt.amountCents || 0;
  return total;
}

/**
 * Build every funnel unit once, tagged with the campaign it belongs
 * to (or null). Spine: lead-type connections claim their linked
 * booking; unclaimed bookings stand alone. A unit's tag comes from
 * its connection first, else its booking — either record carrying
 * the tag attributes the lead.
 */
function buildUnits(tags) {
  const byReference = new Map();
  for (const booking of store.bookings.values()) {
    const reference = leadConnectionReferenceOf(booking);
    if (reference && !byReference.has(reference)) byReference.set(reference, booking);
  }
  const tagOf = (record) => {
    for (const tag of tags) if (carriesCampaignTag(record, tag)) return tag;
    return null;
  };
  const units = [];
  const claimed = new Set();
  for (const connection of store.connections || []) {
    if (!leadTypeOf(connection.type)) continue;
    const booking = byReference.get(connection.reference) || null;
    if (booking) claimed.add(booking.id);
    units.push({
      connection,
      booking,
      tag: tagOf(connection) || (booking ? tagOf(booking) : null),
      createdAt: connection.createdAt || booking?.createdAt || null,
    });
  }
  for (const booking of store.bookings.values()) {
    if (claimed.has(booking.id)) continue;
    units.push({ connection: null, booking, tag: tagOf(booking), createdAt: booking.createdAt || null });
  }
  return units;
}

function summarizeUnits(units, paidMap) {
  const stageCounts = { NEW: 0, CONTACTED: 0, ESTIMATE: 0, WON: 0, LOST: 0 };
  let estimates = 0;
  let wonCollectedCents = 0;
  let wonPipelineValueCents = null;
  let wonPipelineValueKnown = 0;
  for (const unit of units) {
    const stage = derivePipelineStage(unit.connection, unit.booking);
    if (stageCounts[stage] != null) stageCounts[stage] += 1;
    if (unit.booking && latestEstimate(unit.booking)) estimates += 1;
    if (stage === 'WON') {
      wonCollectedCents += collectedCents(unit.booking, paidMap);
      const value = leadValueCents(unit.booking);
      if (value != null) {
        wonPipelineValueCents = (wonPipelineValueCents ?? 0) + value;
        wonPipelineValueKnown += 1;
      }
    }
  }
  return {
    leads: units.length,
    stageCounts,
    estimates,
    won: stageCounts.WON,
    wonCollectedCents,
    wonPipelineValueCents,
    wonPipelineValueKnown,
  };
}

export function campaignOutcomeReport({ days = 30 } = {}) {
  const windowDays = Math.min(365, Math.max(1, Number(days) || 30));
  const sinceMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = (unit) => {
    const t = new Date(unit.createdAt || 0).getTime();
    return Number.isFinite(t) && t >= sinceMs;
  };
  const paidMap = paidCentsByBooking();
  const campaigns = [...store.adCampaigns].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const units = buildUnits(campaigns.map((c) => c.sourceTag)).filter(inWindow);

  const rows = campaigns.map((campaign) => {
    const summary = summarizeUnits(units.filter((u) => u.tag === campaign.sourceTag), paidMap);
    const banner = campaign.bannerId ? store.banners.find((b) => b.id === campaign.bannerId) : null;
    const costCents = recordedCostCents(campaign);
    const perWon = costPerWonCents(costCents, summary.won);
    return {
      campaignId: campaign.id,
      name: campaign.name,
      sourceTag: campaign.sourceTag,
      status: campaign.status,
      businessLine: campaign.businessLine,
      // House vs advertiser, the way the data itself distinguishes
      // them: advertiser campaigns are businessLine EXTERNAL.
      kind: campaign.businessLine === 'EXTERNAL' ? 'ADVERTISER' : 'HOUSE',
      impressions: banner ? banner.impressions || 0 : null,
      clicks: banner ? banner.clicks || 0 : null,
      impressionsClicksScope: 'ALL_TIME',
      ...summary,
      cost: {
        recordedCents: costCents,
        perWonCents: perWon,
        status: perWon == null ? 'NO_COST_RECORDED' : 'RECORDED',
      },
    };
  });

  const unattributed = summarizeUnits(units.filter((u) => u.tag == null), paidMap);
  const attributedTotals = summarizeUnits(units.filter((u) => u.tag != null), paidMap);
  return {
    windowDays,
    since: new Date(sinceMs).toISOString(),
    generatedAt: new Date().toISOString(),
    costNote: COST_PER_WON_NOTE,
    rows,
    unattributed: { label: 'Not attributed to any campaign', ...unattributed },
    totals: {
      leads: attributedTotals.leads + unattributed.leads,
      estimates: attributedTotals.estimates + unattributed.estimates,
      won: attributedTotals.won + unattributed.won,
      wonCollectedCents: attributedTotals.wonCollectedCents + unattributed.wonCollectedCents,
    },
  };
}
