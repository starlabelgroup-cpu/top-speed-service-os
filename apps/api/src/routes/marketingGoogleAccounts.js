import { Router } from 'express';
import { z } from 'zod';
import { appendEvent, createId, store } from '../data/store.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import {
  GOOGLE_ACCOUNT_ROLES,
  GOOGLE_ACCOUNT_STATUSES,
  googleAccountChecklist,
} from '../data/googleAccounts.js';
import { ensureGoogleAccountSeeds, persistGoogleAccountLink } from '../db/googleAccountsRepo.js';

/**
 * Marketing OS — multi-account Google manager registry.
 *
 * Ramone runs the Top Speed Google presence (Business Profile, Local
 * Services Ads, Google Ads, Search Console) from more than one Gmail
 * account and directed a registry inside Marketing OS where more Gmail
 * accounts can be added — each with its business profiles and ads
 * accounts — all linked to the Service OS.
 *
 * HONEST SCOPE: this is a registry and a guide, not a live Google
 * connection. Invites are sent and accepted inside Google's own
 * screens; this API records the structure and returns the Google-side
 * steps. A status changes only when a human changes it here — an
 * account that has been invited stays INVITED until someone who saw
 * the acceptance marks it ACTIVE. Nothing here calls Google.
 *
 * Staff-gated with the same roles as the rest of Marketing OS admin.
 */
const router = Router();
const marketingOnly = [
  authenticate,
  requireCompany,
  requireRole(ROLES.MARKETING_MANAGER, ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN),
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const gbpProfileSchema = z.object({
  name: z.string().trim().min(1).max(160),
  verificationStatus: z.string().trim().max(60).optional(),
}).passthrough();

const adsAccountSchema = z.object({
  customerId: z.string().trim().min(1).max(40),
  name: z.string().trim().max(160).optional(),
  status: z.string().trim().max(60).optional(),
}).passthrough();

const lsaAccountSchema = z.object({
  id: z.string().trim().min(1).max(60),
  status: z.string().trim().max(60).optional(),
}).passthrough();

const assetsSchema = z.object({
  gbpProfiles: z.array(gbpProfileSchema).max(50).optional(),
  adsAccounts: z.array(adsAccountSchema).max(50).optional(),
  lsaAccounts: z.array(lsaAccountSchema).max(50).optional(),
  searchConsole: z.boolean().optional(),
}).passthrough();

const createSchema = z.object({
  email: z.string().trim().max(200).refine((value) => EMAIL_RE.test(value), 'A valid email address is required'),
  label: z.string().trim().min(1).max(120),
  role: z.enum(GOOGLE_ACCOUNT_ROLES).optional(),
  assets: assetsSchema.optional(),
  notes: z.string().trim().max(2000).optional(),
});

const patchSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  role: z.enum(GOOGLE_ACCOUNT_ROLES).optional(),
  status: z.enum(GOOGLE_ACCOUNT_STATUSES).optional(),
  assets: assetsSchema.optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

// The two real accounts are seeded at boot hydration in database mode.
// In skeleton mode hydration is skipped, so the first registry read
// ensures the same seeds lazily — idempotent by email either way, and
// create-only, so it can never overwrite an owner's edit.
let seedEnsured = false;
async function ensureSeeded() {
  if (seedEnsured) return;
  seedEnsured = true;
  try {
    await ensureGoogleAccountSeeds();
  } catch (error) {
    seedEnsured = false;
    console.error('ensureGoogleAccountSeeds (lazy) failed', error?.message || error);
  }
}

function publicLink(link) {
  return {
    id: link.id,
    email: link.email,
    label: link.label,
    role: link.role,
    status: link.status,
    assets: link.assets && typeof link.assets === 'object' ? link.assets : {},
    notes: link.notes || null,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

function sortedLinks() {
  const rank = { PRIMARY_OWNER: 0, OWNER: 1, ADMIN: 2, MANAGER: 3 };
  return [...store.googleAccountLinks].sort((a, b) => {
    const byRole = (rank[a.role] ?? 9) - (rank[b.role] ?? 9);
    if (byRole !== 0) return byRole;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

router.get('/marketing-os/google-accounts', ...marketingOnly, async (req, res) => {
  await ensureSeeded();
  return res.json({ data: sortedLinks().map(publicLink) });
});

router.get('/marketing-os/google-accounts/checklist', ...marketingOnly, async (req, res) => {
  await ensureSeeded();
  return res.json({ data: googleAccountChecklist(sortedLinks()) });
});

router.post('/marketing-os/google-accounts', ...marketingOnly, async (req, res) => {
  await ensureSeeded();
  const parsed = createSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid Google account', details: parsed.error.flatten() });
  }
  const email = parsed.data.email.toLowerCase();
  // Email is the unique key (case-insensitive: Gmail addresses are).
  if (store.googleAccountLinks.some((link) => link.email.toLowerCase() === email)) {
    return res.status(409).json({ error: 'That Gmail address is already in the registry' });
  }
  const now = new Date().toISOString();
  const link = {
    id: createId(),
    email,
    label: parsed.data.label,
    role: parsed.data.role || 'MANAGER',
    // A new registry entry always starts INVITED: the Google-side
    // invites still have to be sent and accepted. A human marks it
    // ACTIVE afterwards — never at creation, never automatically.
    status: 'INVITED',
    assets: parsed.data.assets || {},
    notes: parsed.data.notes || null,
    createdAt: now,
    updatedAt: now,
  };
  store.googleAccountLinks.push(link);
  await persistGoogleAccountLink(link);
  appendEvent('GOOGLE_ACCOUNT_ADDED', {
    source: 'marketing-os-google-accounts',
    actor: req.user?.email || null,
    entityType: 'googleAccountLink',
    entityId: link.id,
    details: { email: link.email, role: link.role },
  });
  return res.status(201).json({ data: publicLink(link) });
});

router.patch('/marketing-os/google-accounts/:id', ...marketingOnly, async (req, res) => {
  const link = store.googleAccountLinks.find((entry) => entry.id === req.params.id);
  if (!link) return res.status(404).json({ error: 'Google account not found' });
  const parsed = patchSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid Google account update', details: parsed.error.flatten() });
  }
  const previousStatus = link.status;
  Object.assign(link, parsed.data, { updatedAt: new Date().toISOString() });
  await persistGoogleAccountLink(link);
  if (parsed.data.status && parsed.data.status !== previousStatus) {
    appendEvent('GOOGLE_ACCOUNT_STATUS_CHANGED', {
      source: 'marketing-os-google-accounts',
      actor: req.user?.email || null,
      entityType: 'googleAccountLink',
      entityId: link.id,
      details: { email: link.email, from: previousStatus, to: link.status },
    });
  }
  return res.json({ data: publicLink(link) });
});

router.delete('/marketing-os/google-accounts/:id', ...marketingOnly, async (req, res) => {
  const link = store.googleAccountLinks.find((entry) => entry.id === req.params.id);
  if (!link) return res.status(404).json({ error: 'Google account not found' });
  // Revoke, don't erase: the registry is the audit trail of who held
  // access. DELETE moves the account to REVOKED; the row stays so the
  // history of the structure survives. (Actual Google-side removal
  // still has to happen inside Google's own user lists.)
  if (link.status !== 'REVOKED') {
    link.status = 'REVOKED';
    link.updatedAt = new Date().toISOString();
    await persistGoogleAccountLink(link);
    appendEvent('GOOGLE_ACCOUNT_REVOKED', {
      source: 'marketing-os-google-accounts',
      actor: req.user?.email || null,
      entityType: 'googleAccountLink',
      entityId: link.id,
      details: { email: link.email },
    });
  }
  return res.json({ data: publicLink(link) });
});

export default router;
