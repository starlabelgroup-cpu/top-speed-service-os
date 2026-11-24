import { campaignEngineRepo } from '../db/campaignEngineRepo.js';
import { facebookOsPostsRepo } from '../db/facebookOsRepo.js';
import { createStreamPost } from './facebookOs.js';
import {
  DIVISIONS,
  LAUNCH_BATCH_KEY,
  dailyBatchKey,
  generateDailyBatch,
  generateLaunchBatch,
} from './campaignFactory.js';
import { campaignVisualUrl } from './pepperVisualUrl.js';
import {
  composePepperVisual,
  ctaLabelForLanding,
  visualLineFromCopy,
} from './pepperVisual.js';

/**
 * Top Speed Campaign Engine — the service (2026-11-23). Persists
 * what the factory generates, idempotently, and keeps the
 * interconnection honest:
 *
 *  - A batch generates EXACTLY ONCE per batchKey: the batch row is
 *    the receipt; a repeat call answers the existing receipt and
 *    inserts nothing (the unique campaignKey is the second lock).
 *  - The day's social selection (up to SOCIAL_QUEUE_PER_BATCH
 *    Facebook campaigns) is queued into the Facebook OS stream as
 *    DRAFT posts under the 'campaign-engine' series — the same
 *    born-DRAFT path as every other stream post (createStreamPost
 *    → the repo forces DRAFT). Publishing from there is unchanged:
 *    staff lifecycle + Ramone's per-post approval card. The engine
 *    queues; it never publishes.
 *  - Email/SMS records are STAGED drafts naming their lawful
 *    audience (factory audienceNote). Nothing in this service
 *    sends anything.
 */

export const CAMPAIGN_ENGINE_SERIES_KEY = 'campaign-engine';
export const SOCIAL_QUEUE_PER_BATCH = 7;

function fail(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

async function queueSocialSelection(records, actorId) {
  const candidates = records.filter((r) => r.surface === 'SOCIAL_FB');
  let queued = 0;
  for (const record of candidates) {
    if (queued >= SOCIAL_QUEUE_PER_BATCH) break;
    const linkUrl = record.landingBase;
    const existing = await facebookOsPostsRepo.findBySeriesAndLink(CAMPAIGN_ENGINE_SERIES_KEY, linkUrl);
    if (existing) {
      await campaignEngineRepo.update(record.id, { linkedRef: existing.id });
      continue;
    }
    // Pepper visual (2026-11-23): the queued draft carries its
    // designed Pepper graphic as its media, so the approval-card
    // preview in the Facebook OS queue shows the graphic, not a
    // text-only card. The URL is set only when the composer passes
    // the claim gate for this record's own strings — a gated
    // record queues without a graphic rather than with a bad one.
    // (At publish time Pepper's flow records the real post graphic
    // exactly as today; this media belongs to the DRAFT.)
    const divisionName = DIVISIONS.find((d) => d.key === record.division)?.name || 'Top Speed';
    const visualOk = composePepperVisual({
      kicker: divisionName,
      headline: record.subject,
      subline: visualLineFromCopy(record.copy),
      ctaLabel: ctaLabelForLanding(record.landingBase),
      size: 'square',
      divisionKey: record.division,
    });
    const post = await createStreamPost({
      seriesKey: CAMPAIGN_ENGINE_SERIES_KEY,
      format: record.angle === 'CITY_SPOTLIGHT' ? 'CITY_SPOTLIGHT' : 'CUSTOM',
      title: record.name.slice(0, 120),
      copy: record.copy.slice(0, 1024),
      mediaUrl: visualOk ? campaignVisualUrl(record) : null,
      mediaKind: visualOk ? 'PEPPER_VISUAL' : null,
      linkUrl,
      statusNote: `Campaign Engine ${record.batchKey} · ${record.campaignKey} — queued by the factory; publish only through the lifecycle + owner approval.`,
    }, actorId);
    await campaignEngineRepo.update(record.id, { status: 'QUEUED', linkedRef: post.id });
    queued += 1;
  }
  return queued;
}

async function runBatch(batchKey, kind, records, actorId) {
  const existingBatch = await campaignEngineRepo.findBatch(batchKey);
  if (existingBatch) {
    return { batch: existingBatch, created: 0, socialQueued: 0, alreadyGenerated: true };
  }
  const created = await campaignEngineRepo.insertMany(
    records.map((r) => ({ ...r, createdById: actorId ?? null })),
  );
  // Re-read the persisted rows so queueing can link by id.
  const persisted = await campaignEngineRepo.list({ batchKey, limit: 1000 });
  const socialQueued = await queueSocialSelection(persisted, actorId);
  const batch = await campaignEngineRepo.recordBatch({
    batchKey, kind, campaignCount: created, socialQueued,
  });
  return { batch, created, socialQueued, alreadyGenerated: false };
}

export async function generateLaunch(actorId) {
  return runBatch(LAUNCH_BATCH_KEY, 'LAUNCH', generateLaunchBatch(), actorId);
}

export async function generateDaily(date = new Date(), actorId) {
  return runBatch(dailyBatchKey(date), 'DAILY', generateDailyBatch(date), actorId);
}

/** Scheduler interface (tech pack d): the daily cron's one call. */
export async function generateForDate(isoDate, actorId) {
  const date = isoDate ? new Date(`${isoDate}T12:00:00Z`) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw fail(400, 'DATE_INVALID', `Not a date: ${isoDate}`);
  }
  // The launch batch is the registry's foundation — if it has not
  // run yet (e.g. the endpoint is hit before the first deploy's
  // seed), run it first so daily batches never stand alone.
  const launch = await campaignEngineRepo.findBatch(LAUNCH_BATCH_KEY);
  if (!launch) await generateLaunch(actorId);
  return generateDaily(date, actorId);
}

function countInto(map, key) {
  map[key] = (map[key] || 0) + 1;
}

/** Registry summary: counts by division / surface / status + the
 * per-division interconnection rows (campaigns + console link). */
export async function campaignEngineSummary() {
  const rows = await campaignEngineRepo.counts();
  const byDivision = {};
  const bySurface = {};
  const byStatus = {};
  for (const row of rows) {
    countInto(byDivision, row.division);
    countInto(bySurface, row.surface);
    countInto(byStatus, row.status);
  }
  const batches = await campaignEngineRepo.listBatches(10);
  return {
    total: rows.length,
    byDivision,
    bySurface,
    byStatus,
    divisions: DIVISIONS.map((d) => ({
      key: d.key,
      name: d.name,
      consoleUrl: d.consoleUrl,
      campaigns: byDivision[d.key] || 0,
      surfaces: d.surfaces,
    })),
    batches: {
      total: batches.length,
      latest: batches[0] || null,
      recent: batches,
    },
  };
}

export async function listCampaigns(filters) {
  const rows = await campaignEngineRepo.list(filters);
  // Pepper visual at READ time (2026-11-23): records persisted
  // before the factory carried visuals in creativeSpec get theirs
  // computed from their own campaignKey + surface here — the
  // registry rows themselves are never rewritten for a graphic.
  return rows.map((row) => {
    const visual = campaignVisualUrl(row);
    if (!visual) return row; // text-only surface — no visual, ever
    if (row.creativeSpec?.visual) return { ...row, visual: row.creativeSpec.visual };
    return { ...row, visual, creativeSpec: { ...(row.creativeSpec || {}), visual } };
  });
}

export async function listBatches(limit) {
  return campaignEngineRepo.listBatches(limit);
}
