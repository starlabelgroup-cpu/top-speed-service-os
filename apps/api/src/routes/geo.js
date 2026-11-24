import { Router } from 'express';
import { z } from 'zod';
import { intakeRateLimit } from '../middleware/intakeShield.js';
import { matchCoordinates } from '../services/geoMatch.js';
import { areasForZip, PUBLISHED_CITIES, SERVICE_CITIES } from '../config/serviceAreas.js';

const router = Router();

/**
 * Book by Location (2026-11-23): POST /geo/match — the public
 * coordinate check behind the shared location-booking card.
 *
 * The customer taps "Use my location" (never an auto-prompt); the
 * browser sends the device coordinate here and the platform answers
 * from the SAME area model the booking matcher uses
 * (config/serviceAreas.js via services/geoMatch.js): the nearest of
 * the 65 published cities and the matcher's own tier vocabulary —
 * IN_AREA / AREA_REVIEW / OUT_OF_AREA. Nothing is stored by this
 * route; the verified result rides the booking itself when the
 * customer submits the form (geo fields on the create paths).
 *
 * Public by design (it answers a coverage question, like the service
 * area directory), rate-limited per route via the intake shield —
 * never router-wide, per the shared-prefix rule.
 */
const matchSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

router.post('/geo/match', intakeRateLimit('geoMatch'), async (req, res) => {
  const parsed = matchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid coordinates', details: parsed.error.flatten() });
  }
  const match = matchCoordinates(parsed.data.lat, parsed.data.lng);
  if (!match) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }
  return res.json({
    data: {
      matchedCity: match.matchedCity,
      tier: match.tier,
      distanceMiles: match.distanceMiles,
    },
  });
});

/**
 * GET /geo/zip?zip=33313 — the Book by ZIP wizard's live area check.
 * Answers from the matcher's own ZIP table (areasForZip): one area →
 * IN_AREA; several → AREA_REVIEW with the candidate cities the
 * customer picks from (the matcher's ZIP_AMBIGUOUS outcome); none →
 * the ZIP is outside the core ZIP table — the tier stays
 * OUT_OF_AREA *for the ZIP alone*, and the wizard falls back to the
 * stated-city path (a named published city is still IN_AREA at
 * booking time, exactly as resolveArea decides). Nothing is stored.
 */
const zipSchema = z.object({ zip: z.string().regex(/^\d{5}$/) });

router.get('/geo/zip', intakeRateLimit('geoMatch'), async (req, res) => {
  const parsed = zipSchema.safeParse({ zip: String(req.query.zip || '') });
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid ZIP', details: parsed.error.flatten() });
  }
  const areas = areasForZip(parsed.data.zip);
  const tier = areas.length === 1 ? 'IN_AREA' : areas.length > 1 ? 'AREA_REVIEW' : 'OUT_OF_AREA';
  return res.json({ data: { zip: parsed.data.zip, areas, tier } });
});

/**
 * GET /geo/cities — the published-city list the wizard's manual city
 * picker renders, served from the area model itself so the form can
 * never offer a city the platform does not serve (or drop one it
 * does). `core` marks the 12 original crew cities.
 */
router.get('/geo/cities', async (req, res) => {
  const core = new Set(SERVICE_CITIES);
  return res.json({
    data: {
      cities: PUBLISHED_CITIES.map(({ name, county }) => ({ name, county, core: core.has(name) })),
    },
  });
});

export default router;
