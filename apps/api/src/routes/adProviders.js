import { Router } from 'express';
import { z } from 'zod';
import { adProvidersRepo } from '../db/adProvidersRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';

/**
 * AdStream Providers — Ad Studio provider connections (2026-11-18,
 * Phase 1). Directed by Ramone from his ad-serving research: "Upgrade
 * ad studio … and connect to these providers" — Kevel, AdButler,
 * Google Ad Manager, SpringServe (Magnite) and FreeWheel.
 *
 * These are the PLATFORM's ad-serving providers: they would serve
 * Top Speed's own ad stack (the Flywheel / Top Speed Ads surfaces),
 * so connections are platform-level — one per provider, managed by
 * Ad Studio staff — not per-advertiser rows. The registry pattern is
 * the Pepper Lists Channel Connections one (routes/
 * pepperListsChannels.js), with the same gate as every Ad Studio
 * admin route (staffOnly in routes/adStudio.js).
 *
 * HONEST SCOPE — Phase 1 is the registry + request workflow ONLY:
 *  - No provider account exists yet and no provider API is called
 *    from here. A connect files a PENDING request the office
 *    completes once the provider account exists (self-serve signup
 *    for Kevel / AdButler / Google Ad Manager; enterprise agreements
 *    for SpringServe and FreeWheel — those signups and contracts
 *    are the owner's alone).
 *  - NOTHING here can produce a CONNECTED row: that status is only
 *    ever set when a real provider account and its key are added
 *    (Phase 2, per provider). No simulated serving, no placeholder
 *    connections, and Phase 1 stores no provider credentials at all.
 *  - Serializers are field-by-field: `meta` (request context) never
 *    leaves the server.
 *
 * The publisher inventory below is the read-only roster of house
 * surfaces the in-house Top Speed Ads display feed already serves
 * today — context for what these providers would extend, stated
 * exactly as it is.
 */
const router = Router();

const PHASE_NOTE =
  'Phase 1: connection request + tracking. Live ad serving through this provider starts when the account exists and its key is added (Phase 2).';

export const AD_SERVING_PROVIDERS = [
  {
    key: 'KEVEL', label: 'Kevel',
    bestFor: 'Building your own advertising infrastructure.',
    blurb: 'API-first ad-serving technology for custom advertising products and retail media networks. A strong candidate if Flywheel wants to retain control of its own advertiser and publisher interfaces.',
    nextSteps: 'Open a Kevel account first — Kevel sells plans and trials through kevel.com, and the account belongs to the business (owner step). Once the account exists, record its reference here; live serving starts when the API key and network ID are added in Phase 2.',
  },
  {
    key: 'ADBUTLER', label: 'AdButler',
    bestFor: 'Multi-format ad serving.',
    blurb: 'Ad serving across display, native and video from one dashboard — one place to run the formats the house surfaces and future placements need.',
    nextSteps: 'Start an AdButler account at adbutler.com first (owner step). Once the account exists, record its reference here; live serving starts when the API key is added in Phase 2.',
  },
  {
    key: 'GOOGLE_AD_MANAGER', label: 'Google Ad Manager',
    bestFor: 'Publisher ad management for display and video.',
    blurb: 'Google\u2019s publisher ad management for display and video, including basic video ad serving. Some advanced capabilities depend on account eligibility or product tier.',
    nextSteps: 'A Google Ad Manager account must exist and be approved for the business first — sign-up is at admanager.google.com and approval is Google\u2019s call (owner step). Once approved, record the network code here; the link completes in Phase 2.',
  },
  {
    key: 'SPRINGSERVE', label: 'SpringServe (Magnite)',
    bestFor: 'Video and CTV ad serving.',
    blurb: 'Video and CTV ad-serving technology, particularly relevant for streaming monetization and video advertising operations. SpringServe is Magnite\u2019s ad server.',
    nextSteps: 'SpringServe is enterprise-only — there is no self-serve signup and no API key to paste. An agreement with Magnite comes first (owner-only). Once it exists, record the account reference here and the office tracks the hookup.',
  },
  {
    key: 'FREEWHEEL', label: 'FreeWheel',
    bestFor: 'Video and CTV ad management.',
    blurb: 'Established video and CTV supply and ad management technology, used by large media owners for streaming inventory.',
    nextSteps: 'FreeWheel is enterprise-only — sales-led, with no self-serve key. An agreement with FreeWheel comes first (owner-only). Once it exists, record the account reference here and the office tracks the hookup.',
  },
];
const PROVIDER_KEYS = AD_SERVING_PROVIDERS.map((p) => p.key);
const PROVIDER_BY_KEY = new Map(AD_SERVING_PROVIDERS.map((p) => [p.key, p]));

export const PUBLISHER_INVENTORY = [
  {
    label: 'Top Speed flagship', url: 'https://topspeedserviceos.com',
    note: 'Carries the in-house display feed today (footer banner rotation), served by Top Speed Ads.',
  },
  {
    label: 'Top Speed Appliance (.net)', url: 'https://topspeedappliance.net',
    note: 'House customer site on the in-house display feed, served by Top Speed Ads.',
  },
  {
    label: 'Appliance Pro', url: 'https://appliancepro.net',
    note: 'Commercial portal on the in-house display feed, served by Top Speed Ads.',
  },
  {
    label: 'Pepper Lists', url: 'https://pepperlists.com',
    note: 'Marketplace surface on the in-house display feed, served by Top Speed Ads.',
  },
];

// Same gate as the Ad Studio admin routes (staffOnly in
// routes/adStudio.js): Marketing Managers run the studio day to day,
// Managers and the Master oversee it. Advertisers and customers are
// refused — provider connections are platform infrastructure.
const staffGate = [
  authenticate,
  requireCompany,
  requireRole(ROLES.MARKETING_MANAGER, ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN),
];

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function publicConnection(row, providerDef) {
  if (!row) {
    return {
      id: null,
      provider: providerDef.key,
      status: 'NOT_CONNECTED',
      externalAccountLabel: null,
      connectedAt: null,
      lastSyncAt: null,
      createdAt: null,
      updatedAt: null,
    };
  }
  // Deliberately field-by-field: `meta` (request context) and any
  // future credential material never leave the server.
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    externalAccountLabel: row.externalAccountLabel ?? null,
    connectedAt: iso(row.connectedAt),
    lastSyncAt: iso(row.lastSyncAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function catalogWithConnections(rows) {
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return AD_SERVING_PROVIDERS.map((def) => ({
    key: def.key,
    label: def.label,
    bestFor: def.bestFor,
    blurb: def.blurb,
    nextSteps: def.nextSteps,
    phaseNote: PHASE_NOTE,
    connection: publicConnection(byProvider.get(def.key) ?? null, def),
  }));
}

function providerOr404(req, res) {
  const def = PROVIDER_BY_KEY.get(String(req.params.provider || '').toUpperCase());
  if (!def) {
    res.status(404).json({ error: 'Unknown provider' });
    return null;
  }
  return def;
}

// ── Staff: the provider catalog, merged with connection state ──────
router.get('/ad-studio/providers', ...staffGate, async (req, res, next) => {
  try {
    const rows = await adProvidersRepo.listConnections();
    return res.json({
      data: {
        providers: catalogWithConnections(rows),
        inventory: PUBLISHER_INVENTORY,
      },
    });
  } catch (error) {
    return next(error);
  }
});

const connectSchema = z.object({
  accountLabel: z.string().trim().min(2).max(120).optional(),
});

router.post('/ad-studio/providers/:provider/connect', ...staffGate, async (req, res, next) => {
  const def = providerOr404(req, res);
  if (!def) return undefined;
  try {
    const parsed = connectSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid connection request', details: parsed.error.flatten() });
    }
    const row = await adProvidersRepo.requestConnect(def.key, parsed.data.accountLabel, req.user.id);
    return res.status(201).json({
      data: {
        connection: publicConnection(row, def),
        nextSteps: def.nextSteps,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/ad-studio/providers/:provider/disconnect', ...staffGate, async (req, res, next) => {
  const def = providerOr404(req, res);
  if (!def) return undefined;
  try {
    const row = await adProvidersRepo.disconnect(def.key, req.user.id);
    return res.json({ data: { connection: publicConnection(row, def) } });
  } catch (error) {
    return next(error);
  }
});

// ── Staff oversight: every connection row + the audit trail ───────
// Statuses + labels + who acted — no request context (`meta`), no
// credential material (Phase 1 stores none).
router.get('/ad-studio/providers/oversight', ...staffGate, async (req, res, next) => {
  try {
    const [rows, audit] = await Promise.all([
      adProvidersRepo.listConnections(),
      adProvidersRepo.listRecentAudit(100),
    ]);
    return res.json({
      data: {
        count: rows.length,
        connections: rows.map((row) => publicConnection(
          row, PROVIDER_BY_KEY.get(row.provider) || { key: row.provider },
        )),
        audit: audit.map((entry) => ({
          id: entry.id,
          connectionId: entry.connectionId,
          provider: entry.connection?.provider ?? null,
          actorUserId: entry.actorUserId ?? null,
          actor: entry.actor
            ? {
                email: entry.actor.email,
                name: [entry.actor.firstName, entry.actor.lastName].filter(Boolean).join(' ') || null,
                roles: entry.actor.roles,
              }
            : null,
          action: entry.action,
          detail: entry.detail ?? null,
          createdAt: iso(entry.createdAt),
        })),
      },
    });
  } catch (error) {
    return next(error);
  }
});

export { PROVIDER_KEYS };
export default router;
