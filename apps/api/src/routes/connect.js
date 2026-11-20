import { Router } from 'express';
import { z } from 'zod';
import { createId, store } from '../data/store.js';
import { deleteAppliance, persistAppliance } from '../db/appliancesRepo.js';
import { activeConnection, listConnections, persistConnection } from '../db/applianceConnectionsRepo.js';
import { authenticate } from '../middleware/auth.js';

/**
 * Appliance Connect — the customer's connected garage. Every appliance
 * they register lives on their Service OS record: Speedy sees it, the
 * setters see it, and the service history (their real bookings) sits
 * next to it. Connect Pro is the same registry at portfolio scale for
 * property managers and commercial accounts.
 */
const router = Router();

const applianceSchema = z.object({
  type: z.string().trim().min(2).max(60),
  brand: z.string().trim().max(60).optional(),
  model: z.string().trim().max(80).optional(),
  serial: z.string().trim().max(80).optional(),
  year: z.number().int().min(1950).max(2100).optional(),
  notes: z.string().trim().max(300).optional(),
});

router.get('/connect/appliances', authenticate, (req, res) => {
  const mine = [...store.appliances.values()]
    .filter((a) => a.userId === req.user.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((a) => ({ ...a, connections: listConnections(a.id) }));
  return res.json({ data: mine });
});

/**
 * Connected appliances — the foundation registry (2026-11-19).
 * A customer registers a manufacturer network for one of their
 * garage appliances and consents to Top Speed recording the
 * connection. Registration is consent + registry ONLY: no
 * manufacturer link exists yet (developer approvals have not been
 * filed), so the row is created REGISTERED with externalId NULL.
 * LINKED is part of the status vocabulary for the future brand
 * integrations and NO endpoint here may set it — any status a
 * client sends is ignored; the server owns the status.
 */
export const APPLIANCE_CONNECTION_PROVIDERS = ['HOME_CONNECT', 'SMARTTHINGS', 'THINQ', 'SMARTHQ', 'OTHER'];

const connectionRegisterSchema = z.object({
  provider: z.enum(APPLIANCE_CONNECTION_PROVIDERS),
  consent: z.boolean().optional(),
});

function myAppliance(req, res) {
  const appliance = store.appliances.get(req.params.id);
  if (!appliance || appliance.userId !== req.user.id) {
    res.status(404).json({ error: 'Appliance not found' });
    return null;
  }
  return appliance;
}

router.post('/connect/appliances/:id/connections', authenticate, async (req, res) => {
  const appliance = myAppliance(req, res);
  if (!appliance) return;
  const parsed = connectionRegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid connection', details: parsed.error.flatten() });
  }
  // Consent is the whole point of the registry: without an explicit
  // yes there is no registration (422, nothing written).
  if (parsed.data.consent !== true) {
    return res.status(422).json({
      error: 'Consent is required to register a connected appliance.',
      code: 'CONSENT_REQUIRED',
    });
  }
  if (activeConnection(appliance.id, parsed.data.provider)) {
    return res.status(409).json({ error: 'This appliance is already registered for that network.' });
  }
  const now = new Date().toISOString();
  const connection = {
    id: createId(),
    applianceId: appliance.id,
    provider: parsed.data.provider,
    externalId: null,
    status: 'REGISTERED',
    consentAt: now,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  store.applianceConnections.set(connection.id, connection);
  await persistConnection(connection);
  return res.status(201).json({ data: connection });
});

router.post('/connect/appliances/:id/connections/:connectionId/revoke', authenticate, async (req, res) => {
  const appliance = myAppliance(req, res);
  if (!appliance) return;
  const connection = store.applianceConnections.get(req.params.connectionId);
  if (!connection || connection.applianceId !== appliance.id) {
    return res.status(404).json({ error: 'Connection not found' });
  }
  if (connection.status === 'REVOKED') {
    return res.json({ data: connection });
  }
  connection.status = 'REVOKED';
  connection.revokedAt = new Date().toISOString();
  connection.updatedAt = connection.revokedAt;
  await persistConnection(connection);
  return res.json({ data: connection });
});

router.post('/connect/appliances', authenticate, async (req, res) => {
  const parsed = applianceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid appliance', details: parsed.error.flatten() });
  }
  const appliance = {
    id: createId(),
    userId: req.user.id,
    ...parsed.data,
    brand: parsed.data.brand || null,
    model: parsed.data.model || null,
    serial: parsed.data.serial || null,
    year: parsed.data.year ?? null,
    notes: parsed.data.notes || null,
    createdAt: new Date().toISOString(),
  };
  store.appliances.set(appliance.id, appliance);
  await persistAppliance(appliance);
  return res.status(201).json({ data: appliance });
});

router.delete('/connect/appliances/:id', authenticate, async (req, res) => {
  const appliance = store.appliances.get(req.params.id);
  if (!appliance || appliance.userId !== req.user.id) {
    return res.status(404).json({ error: 'Appliance not found' });
  }
  store.appliances.delete(appliance.id);
  await deleteAppliance(appliance.id);
  return res.json({ data: { removed: true } });
});

/** The Connect home view: garage + real service history (their bookings). */
router.get('/connect/summary', authenticate, (req, res) => {
  const email = (req.user.email || '').toLowerCase();
  const phoneDigits = String(req.user.phone || '').replace(/\D/g, '').slice(-10);
  const myBookings = [...store.bookings.values()]
    .filter((b) => {
      const c = b.customer || {};
      const emailMatch = email && (c.email || '').toLowerCase() === email;
      const phoneMatch = phoneDigits && String(c.phone || '').replace(/\D/g, '').slice(-10) === phoneDigits;
      return emailMatch || phoneMatch;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((b) => ({
      referenceCode: b.referenceCode,
      appliance: b.appliance,
      issue: b.issue,
      city: b.city,
      status: b.status,
      createdAt: b.createdAt,
    }));
  const appliances = [...store.appliances.values()].filter((a) => a.userId === req.user.id);
  return res.json({ data: { appliances, serviceHistory: myBookings } });
});

/**
 * Garage promotions for the signed-in customer: the published offers
 * with honest per-account eligibility, plus their referral code when
 * one has been issued (referral codes are issued on a completed repair).
 */
router.get('/connect/promotions', authenticate, (req, res) => {
  const record = store.users.get(req.user.id) || {};
  const email = String(record.email || req.user.email || '').toLowerCase();
  const phoneDigits = String(record.phone || '').replace(/\D/g, '').slice(-10);
  const myBookings = [...store.bookings.values()].filter((b) => {
    const c = b.customer || {};
    if (c.userId && c.userId === req.user.id) return true;
    if (email && String(c.email || '').toLowerCase() === email) return true;
    if (phoneDigits && String(c.phone || '').replace(/\D/g, '').slice(-10) === phoneDigits) return true;
    return false;
  });
  const hasCompletedRepair = myBookings.some((b) => b.status === 'COMPLETED');
  const myCustomerIds = new Set(myBookings.map((b) => b.customer?.id).filter(Boolean));
  let referralCode = null;
  for (const referral of store.referrals.values()) {
    if (referral.status === 'ACTIVE' && myCustomerIds.has(referral.customerId)) {
      referralCode = referral.code;
      break;
    }
  }
  return res.json({
    data: {
      offers: [
        {
          id: 'FIRST_REPAIR_25',
          title: '$25 off your first repair',
          detail: 'For new registered customers — $25 off your first eligible repair with Top Speed.',
          eligible: !hasCompletedRepair,
          eligibilityNote: hasCompletedRepair
            ? 'Your first repair is already on your service history.'
            : 'Available on your account — mention it when you book and we apply it to your first repair.',
        },
        {
          id: 'DIAGNOSTIC_CREDIT',
          title: '$99 diagnostic, credited toward your repair',
          detail: 'The residential diagnostic fee is collected at booking and credited in full toward your repair.',
          eligible: true,
          eligibilityNote: 'Applies to every residential booking.',
        },
        {
          id: 'MEMBERSHIPS',
          title: 'Top Speed memberships',
          detail: 'Maintenance plans and member offers for your home appliances.',
          eligible: true,
          eligibilityNote: 'See the memberships page for plan details.',
          url: '/memberships',
        },
      ],
      referral: {
        code: referralCode,
        note: referralCode
          ? 'Share your code — your referral booking is tagged to you automatically.'
          : 'Your personal referral code is issued when your first repair is completed.',
      },
    },
  });
});

export default router;
