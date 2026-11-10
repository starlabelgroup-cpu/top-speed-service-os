import { Router } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { createConnectionRecord } from '../db/connectionsRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';

/**
 * Public web intake — every surface's form posts here (flagship,
 * /service, /network, /commercial, /property-managers, /ads, media…).
 * Records are real: persisted, reference-numbered, and listed for the
 * team. This endpoint is the fallback channel; Speedy conversation is
 * the front door.
 */
const router = Router();

const connectionSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(30),
  email: z.string().email().optional(),
  type: z.string().trim().min(2).max(48),
  source: z.string().trim().max(60).optional(),
  message: z.string().trim().max(3000).optional(),
});

router.post('/connections', async (req, res) => {
  const parsed = connectionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid connection request', details: parsed.error.flatten() });
  }
  const record = await createConnectionRecord(parsed.data);
  return res.status(201).json({ data: { reference: record.reference, type: record.type } });
});

router.get('/connections', authenticate, requireCompany, requireRole(...STAFF_ROLES), (req, res) => {
  return res.json({ data: [...store.connections].reverse() });
});

export default router;
