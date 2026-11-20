import { Router } from 'express';
import { z } from 'zod';
import { createReferenceCode, store } from '../data/store.js';
import { createConnectionRecord } from '../db/connectionsRepo.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { STAFF_ROLES } from '../config/security.js';
import { notifySubmission } from '../services/notifications.js';
import { attributionFields, normalizeAttribution } from '../services/attribution.js';
import { recordReferralLead } from '../services/referrals.js';
import { intakeRateLimit } from '../middleware/intakeShield.js';
import {
  INVALID_PHONE_MESSAGE,
  evaluateFormShield,
  honeypotTripped,
  validateNanpPhone,
} from '../services/intakeShield.js';

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
  // Landing-page + UTM attribution (Fusion absorb Stage 3) — optional,
  // see services/attribution.js for the accepted shapes.
  ...attributionFields,
  // ApplianceReferral: a lead that arrived through a personal referral
  // code. A connection is a LEAD, not a booking — Phase 1 records an
  // INVITED journey for it (see services/referrals.js recordReferralLead);
  // it advances to BOOKED only when a real booking is created and
  // matched by phone/email in attachReferralToBooking.
  referralCode: z.string().trim().max(32).transform((value) => value.toUpperCase()).optional(),
});

router.post('/connections', intakeRateLimit('connections'), async (req, res) => {
  const parsed = connectionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid connection request', details: parsed.error.flatten() });
  }
  // Intake shield: the phone must be a plausible NANP number (kills
  // the unassigned-area-code fakes — 355, 691 — at the door). Phase
  // 1's precedence is preserved exactly: a honeypot hit ghosts
  // first; otherwise an invalid phone is a visible 400 (never a
  // silent drop, and it persists nothing either way); the Phase 2
  // verdict below ghosts after that.
  const honeypot = honeypotTripped(req.body);
  if (!honeypot) {
    const phoneCheck = validateNanpPhone(parsed.data.phone);
    if (!phoneCheck.ok) {
      return res.status(400).json({ error: INVALID_PHONE_MESSAGE, code: 'INVALID_PHONE' });
    }
  }
  // Intake shield (2026-11-19): honeypot — a filled hidden field is
  // an automated form-filler. Answer with the same 201 shape a real
  // submission gets, but persist NOTHING and queue NO notification.
  // Phase 2 (2026-11-20): the form-token + gibberish layers score
  // every intake type; Turnstile (when configured) is enforced only
  // for PROVIDER_APPLICATION — the wired provider-join form — so a
  // configured widget can never silently eat ordinary leads from
  // forms that do not render it.
  const shieldVerdict = await evaluateFormShield(req.body, {
    names: [parsed.data.name],
    email: parsed.data.email ?? null,
    ip: req.ip,
    door: 'connections',
    enforceTurnstile: parsed.data.type === 'PROVIDER_APPLICATION',
  });
  if (honeypot || shieldVerdict.discard) {
    return res.status(201).json({ data: { reference: createReferenceCode(), type: parsed.data.type } });
  }
  const record = await createConnectionRecord({ ...parsed.data, attribution: normalizeAttribution(parsed.data) });
  // Unified notifications: the submitter gets a confirmation and the
  // business gets an instant alert for EVERY form on every surface.
  notifySubmission({
    kind: record.type,
    reference: record.reference,
    submitter: { name: record.name, phone: record.phone, email: record.email },
    lines: [
      ...(record.message ? [`Message: ${record.message.slice(0, 240)}`] : []),
      ...(record.source ? [`Submitted via: ${record.source}`] : []),
      ...(record.attribution?.page ? [`Landing page: ${record.attribution.page}`] : []),
      ...(record.attribution?.utmSource
        ? [`Campaign: ${record.attribution.utmSource}${record.attribution.utmMedium ? ` / ${record.attribution.utmMedium}` : ''}${record.attribution.utmCampaign ? ` / ${record.attribution.utmCampaign}` : ''}`]
        : []),
    ],
    source: record.source || 'connections',
  });
  // ApplianceReferral: record the lead on the referrer's journey track.
  // Wrapped so a referral problem can never fail a public form.
  if (parsed.data.referralCode) {
    try {
      await recordReferralLead({
        code: parsed.data.referralCode,
        name: record.name,
        phone: record.phone,
        email: record.email,
        reference: record.reference,
        source: record.source || 'connections',
      });
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'referral lead record failed', error: String(error?.message || error) }));
    }
  }
  return res.status(201).json({ data: { reference: record.reference, type: record.type } });
});

router.get('/connections', authenticate, requireCompany, requireRole(...STAFF_ROLES), (req, res) => {
  return res.json({ data: [...store.connections].reverse() });
});

export default router;
