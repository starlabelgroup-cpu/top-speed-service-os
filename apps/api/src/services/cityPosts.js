import { facebookOsPostsRepo } from '../db/facebookOsRepo.js';
import { CITY_POSTS_SERIES_KEY, buildCityPosts } from './cityPostGenerator.js';
import { createStreamPost } from './facebookOs.js';

/**
 * City Posts loader (2026-11-23) — registers the generated City
 * Spotlight set as DRAFTS in the Facebook OS stream queue.
 *
 * Idempotent per page: a page's post is keyed by (seriesKey,
 * linkUrl) — the linkUrl IS the page's canonical URL, whose path is
 * the page slug — so re-running the loader adds 0 and reports the
 * existing rows as duplicates. Records are born DRAFT through the
 * same createStreamPost path as every other stream post (the repo
 * forces DRAFT); nothing here approves, schedules, or publishes —
 * each post still moves through the lifecycle by staff action and
 * Ramone's per-post approval, exactly like the series queue.
 */
export async function ingestCityPosts(actorId) {
  const generated = buildCityPosts();
  const created = [];
  const duplicates = [];
  for (const post of generated) {
    const { manifest, ...input } = post;
    const existing = await facebookOsPostsRepo.findBySeriesAndLink(
      CITY_POSTS_SERIES_KEY, input.linkUrl,
    );
    if (existing) {
      duplicates.push(existing);
      continue;
    }
    created.push(await createStreamPost(input, actorId));
  }
  return {
    seriesKey: CITY_POSTS_SERIES_KEY,
    total: generated.length,
    created,
    duplicates,
  };
}
