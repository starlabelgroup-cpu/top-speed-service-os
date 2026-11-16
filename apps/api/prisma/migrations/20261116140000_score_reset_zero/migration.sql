-- Score reset to zero (Ramone, 2026-11-16): every scoring system in
-- every platform starts at zero — reviews, booking/dispatch scoring,
-- and everything fed by them.
--
-- Provider ratings: the three seeded providers (Broward Rapid
-- Refrigeration, Plantation Home Appliance Pros, Top Speed Field Team)
-- carried invented ratings of 4.9 / 4.8 / 4.8 (flagged in the
-- 2026-11-14 platform audit) that fed the dispatch match score. No
-- real review has ever been collected for them, so the honest value
-- is NULL — "no rating yet", the same state the Cleanout Vents
-- partner record has always had. Code audit confirms no API path
-- writes Provider.rating: the seed was the only source, and the seed
-- now writes null as well, so this can never re-inflate.
UPDATE "Provider"
SET "rating" = NULL
WHERE "id" IN (
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003'
)
AND "rating" IS NOT NULL;

-- Dispatch match scores: DispatchAssignment.matchScore is a cached
-- derived score. Every stored value was computed by a formula that
-- included the invented ratings above, so the cache is cleared to
-- NULL ("no score"). Nothing is deleted and no booking is touched —
-- new dispatch proposals recompute live from the reset ratings,
-- where a null rating contributes the zero baseline.
UPDATE "DispatchAssignment"
SET "matchScore" = NULL
WHERE "matchScore" IS NOT NULL;
