import { Router } from 'express';
import { z } from 'zod';
import { appendEvent, createId, PLATFORM_COMPANY_ID, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { ROLES } from '../config/security.js';
import { hashPassword } from '../services/passwords.js';
import { registrationStartsUnverified } from '../services/speedyVerify.js';
import { registrationLayer2Required } from '../services/layer2.js';
import {
  LEGAL_DOCUMENTS,
  createUserWithTerms,
  termsStatusForUser,
  validateTermsAcceptance,
} from '../services/legalTerms.js';
import { emailVerificationState, issueEmailVerification } from '../services/emailVerification.js';
import { notifyAccountCreated } from '../services/notifications.js';
import { intakeRateLimit } from '../middleware/intakeShield.js';
import {
  INVALID_PHONE_MESSAGE,
  honeypotTripped,
  validateNanpPhone,
} from '../services/intakeShield.js';
import { publicUser } from './auth.js';

/**
 * Media OS creator applications (2026-11-19, Ramone's order) —
 * POST /creator/signup.
 *
 * The public application door for Content Creator / Publisher
 * accounts. It is its OWN scoped endpoint on purpose: POST
 * /auth/register keeps refusing the CONTENT_CREATOR role for
 * non-administrators, exactly like every staff/provider role.
 *
 * An application creates the account in the platform's PENDING
 * posture for external accounts: Speedy Verify required, no access
 * code issued, so sign-in is denied (SPEEDY_VERIFY_NO_CODE) and the
 * account waits in the Master's Speedy Verify panel in ApplianceMan
 * — the same queue business/PM/advertiser accounts wait in — until
 * he issues its code. Layer 2 is on from creation and mandatory for
 * the role besides (services/layer2.js). The application details
 * (creator type, publisher name, portfolio links) ride on the
 * CREATOR_APPLICATION platform event and the staff account alert —
 * the office record of who applied and with what work.
 *
 * Intake Shield: the route carries the family rate limit, the
 * honeypot (a tripped honeypot gets the same 201 pending shape and
 * persists NOTHING), and the NANP phone check — the same three
 * layers as POST /auth/register, so this door is not a bot door.
 */
const router = Router();

const usersRepo = DATABASE_ENABLED
  ? {
      async findByEmail(companyId, email) {
        return db().user.findUnique({ where: { companyId_email: { companyId, email } } });
      },
    }
  : {
      async findByEmail(companyId, email) {
        for (const user of store.users.values()) {
          if (user.companyId === companyId && user.email === email) return user;
        }
        return null;
      },
    };

const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(10, 'Password must be at least 10 characters').max(200),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().min(7).max(30),
  creatorType: z.enum(['CREATOR', 'PUBLISHER']).optional(),
  organization: z.string().trim().max(120).optional(),
  portfolioLinks: z.array(z.string().trim().min(3).max(300)).max(5).optional(),
  termsAcceptance: z.unknown().optional(),
});

const PENDING_MESSAGE =
  'Your creator account was created and is pending activation. Speedy Verify: the office issues your access code before your first sign-in — you will get it from the office directly.';

function pendingResponse(res, user, terms) {
  return res.status(201).json({
    user: publicUser(user),
    emailVerification: emailVerificationState(user),
    terms,
    termsStatus: terms,
    speedyVerify: { status: 'PENDING', message: PENDING_MESSAGE },
  });
}

router.post('/creator/signup', intakeRateLimit('creatorSignup'), async (req, res, next) => {
  try {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid application', details: parsed.error.flatten() });
    }
    // Honeypot: answer with the same pending shape, persist nothing,
    // queue no notification (the register door's discipline).
    if (honeypotTripped(req.body)) {
      const ghost = {
        id: createId(),
        companyId: PLATFORM_COMPANY_ID,
        email: parsed.data.email,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName ?? null,
        phone: parsed.data.phone,
        roles: [ROLES.CONTENT_CREATOR],
        active: true,
        emailVerifiedAt: null,
        signupSource: 'CREATOR_SIGNUP',
        signupOfferSlug: null,
        signupAudience: null,
        verifyRequired: true,
        layer2Required: true,
        mustChangePassword: false,
        createdAt: new Date().toISOString(),
      };
      const terms = await termsStatusForUser(ghost.id);
      return pendingResponse(res, ghost, terms);
    }
    const phoneCheck = validateNanpPhone(parsed.data.phone);
    if (!phoneCheck.ok) {
      return res.status(400).json({ error: INVALID_PHONE_MESSAGE, code: 'INVALID_PHONE' });
    }
    // Legal gate: a public signup signs the current legal documents —
    // no acceptance, no account (the register door's rule).
    const validatedTerms = validateTermsAcceptance(parsed.data.termsAcceptance);
    if (!validatedTerms.ok) {
      return res.status(422).json({
        error: validatedTerms.error,
        code: 'TERMS_ACCEPTANCE_REQUIRED',
        documents: LEGAL_DOCUMENTS,
      });
    }
    const { email, password, firstName, lastName, phone } = parsed.data;
    if (await usersRepo.findByEmail(PLATFORM_COMPANY_ID, email)) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const draft = {
      id: createId(),
      companyId: PLATFORM_COMPANY_ID,
      email,
      passwordHash: await hashPassword(password),
      firstName,
      lastName: lastName ?? null,
      phone,
      roles: [ROLES.CONTENT_CREATOR],
      active: true,
      emailVerifiedAt: null,
      signupSource: 'CREATOR_SIGNUP',
      signupOfferSlug: null,
      signupAudience: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Pending posture, computed by the same helpers every other door
    // uses: Speedy Verify covered role → starts unverified; Layer 2
    // on for every new account (and mandatory for this role besides).
    draft.verifyRequired = registrationStartsUnverified(draft, false);
    draft.layer2Required = registrationLayer2Required(draft);

    let user;
    try {
      user = await createUserWithTerms(draft, validatedTerms);
    } catch (error) {
      if (error?.code === 'P2002') {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }
      throw error;
    }

    appendEvent('CREATOR_APPLICATION', {
      source: 'creator-signup',
      actor: email,
      entityType: 'USER',
      entityId: user.id,
      details: {
        creatorType: parsed.data.creatorType || 'CREATOR',
        organization: parsed.data.organization || null,
        portfolioLinks: parsed.data.portfolioLinks || [],
      },
    });
    try {
      notifyAccountCreated(user, 'CREATOR_SIGNUP');
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'creator account-created notification failed', error: String(error?.message || error) }));
    }
    try {
      await issueEmailVerification(user, 'CREATOR_SIGNUP');
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'creator email verification issue failed', error: String(error?.message || error) }));
    }

    const terms = await termsStatusForUser(user.id);
    return pendingResponse(res, user, terms);
  } catch (error) {
    return next(error);
  }
});

export default router;
