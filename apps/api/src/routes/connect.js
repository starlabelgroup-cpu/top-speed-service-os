import { Router } from 'express';
import { z } from 'zod';
import { createId, store } from '../data/store.js';
import { deleteAppliance, persistAppliance } from '../db/appliancesRepo.js';
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
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return res.json({ data: mine });
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

export default router;
