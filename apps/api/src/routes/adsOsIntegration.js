import { Router } from 'express';
import { store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { authenticate } from '../middleware/auth.js';
import {
  ADS_OS_KEY_HEADER,
  adsOsConfigured,
  adsOsKeyMatches,
  buildAdsOsSummary,
} from '../services/adsOsSummary.js';
import {
  exchangeAdsOsConnectCode,
  mintAdsOsConnectCode,
} from '../services/adsOsSso.js';
import { buildAdsOsPlatform, buildAdsOsPlatforms } from '../services/adsOsPlatforms.js';

/**
 * Top Speed Ads OS integration (2026-11-20): the read-only summary
 * feed the Ads OS console's advertising flywheel reads from Service
 * OS — bookings grouped by advertising source label, bookings by
 * status, and completed-job counts, all-time and last 30 days.
 * Counts and labels only; no PII ever leaves through this door,
 * and the route writes nothing.
 *
 * Auth is a dedicated service key in the x-ads-os-key header,
 * checked against the ADS_OS_SERVICE_KEY environment variable —
 * the same env-secret discipline as the cron drains in
 * routes/integrations.js, with one deliberate difference in shape:
 * an unset key answers 503 ADS_OS_NOT_CONFIGURED ("integration not
 * configured") rather than 403, so the console can distinguish
 * "not set up yet" from "set up and refusing" (401). The key value
 * itself is set in the host environment by the owner; it never
 * appears in code.
 */

const router = Router();

/**
 * The one service-key gate every Ads OS read door shares — the
 * summary below and the unified platforms feed under it answer
 * the identical 503 / 401 shapes, so a caller can never tell the
 * doors apart by their refusals.
 */
function adsOsGate(req, res) {
  if (!adsOsConfigured()) {
    res.status(503).json({
      error: 'Ads OS integration is not configured (the service key environment variable is not set)',
      code: 'ADS_OS_NOT_CONFIGURED',
    });
    return false;
  }
  if (!adsOsKeyMatches(req.get(ADS_OS_KEY_HEADER))) {
    res.status(401).json({ error: 'Invalid Ads OS service key', code: 'ADS_OS_UNAUTHORIZED' });
    return false;
  }
  return true;
}

router.get('/integrations/ads-os/summary', (req, res) => {
  if (!adsOsGate(req, res)) return undefined;
  return res.json({ data: buildAdsOsSummary([...store.bookings.values()]) });
});

// ---------------------------------------------------------------------------
// The UNIFIED advertising feed (2026-11-22): one aggregate over
// all five advertising platforms in Service OS — Top Speed Ads
// (Ad Studio), Ads Console (Advertiser Console), Top Speed Local
// OS, Marketing OS and Flywheel Advertising — so the Ads OS
// Manager app is one front door over all of them. Same service
// key gate as the summary, same counts-and-labels discipline:
// read-only, no PII, nothing written. A platform whose source is
// unavailable answers a dark section (available:false) instead of
// failing the whole feed. See services/adsOsPlatforms.js.
// ---------------------------------------------------------------------------

router.get('/integrations/ads-os/platforms', async (req, res, next) => {
  if (!adsOsGate(req, res)) return undefined;
  try {
    return res.json({ data: await buildAdsOsPlatforms() });
  } catch (error) {
    return next(error);
  }
});

router.get('/integrations/ads-os/platforms/:key', async (req, res, next) => {
  if (!adsOsGate(req, res)) return undefined;
  try {
    const section = await buildAdsOsPlatform(req.params.key);
    if (!section) {
      return res.status(404).json({ error: 'Unknown Ads OS platform', code: 'ADS_OS_PLATFORM_UNKNOWN' });
    }
    return res.json({ data: section });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Sign in with Top Speed Service OS (2026-11-20): the one-time
// connect code the Ads OS console's "Sign in with Service OS" door
// exchanges for the account identity. Mirrors the email sign-in
// link door (services/adsOsSso.js): hash-only storage, single-use,
// 10-minute expiry, minting supersedes, Master exempt from the
// mint cap. The mint takes NO account parameter — the code is
// bound to the account on the caller's own session, so nobody can
// mint a code for someone else. The exchange is public (the code
// is the credential) and every failure is the same generic 401.
// ---------------------------------------------------------------------------

async function loadSessionUser(req) {
  if (DATABASE_ENABLED) {
    return db().user.findUnique({ where: { id: req.user.id } });
  }
  return store.users.get(req.user.id) || null;
}

router.post('/integrations/ads-os/sso/code', authenticate, async (req, res, next) => {
  try {
    const user = await loadSessionUser(req);
    if (!user || user.active === false) {
      return res.status(401).json({ error: 'Account not found', code: 'ACCOUNT_NOT_FOUND' });
    }
    const minted = await mintAdsOsConnectCode(user);
    return res.json({
      data: {
        code: minted.code,
        expiresAt: minted.expiresAt,
        expiresInSeconds: 600,
      },
    });
  } catch (error) {
    if (error?.status) {
      return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
    return next(error);
  }
});

router.post('/integrations/ads-os/sso/exchange', async (req, res, next) => {
  try {
    const presented = typeof req.body?.code === 'string' ? req.body.code : '';
    const { identity } = await exchangeAdsOsConnectCode(presented, { ip: req.ip });
    return res.json({ data: identity });
  } catch (error) {
    if (error?.status) {
      return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
    return next(error);
  }
});

export default router;
