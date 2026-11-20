import { Router } from 'express';
import { z } from 'zod';
import { createId, PLATFORM_COMPANY_ID, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { hashPassword, verifyPassword } from '../services/passwords.js';
import { notifyAccountCreated } from '../services/notifications.js';
import { issueEmailVerification } from '../services/emailVerification.js';
import {
  getVerifyState,
  isMasterAccount,
  registrationStartsUnverified,
} from '../services/speedyVerify.js';
import { layer2StatusView, registrationLayer2Required, updateLayer2Settings } from '../services/layer2.js';
import {
  issueTempPassword,
  revokeTempPassword,
  tempStatusView,
} from '../services/tempPasswords.js';
import { assignEmployeeNumber, isEmployeeAccount } from '../services/employeeNumbers.js';
import { publicUser } from './auth.js';

/**
 * Work Time Account Access (2026-11-17) — the Master's account console.
 *
 * One place where Ramone, signed in as COMPANY_OWNER, creates accounts
 * for every Service OS access point with passwords HE chooses, resets
 * any account's password, and sees each account's employee number and
 * 2-step state (Speedy Verify + Layer 2 — the existing systems,
 * surfaced here, never rebuilt).
 *
 * EVERY route is Master-only: authenticate + requireRole(COMPANY_OWNER).
 * Managers and platform admins get 403; signed-out requests get 401.
 *
 * Hard rules (Rule Zero):
 * - COMPANY_OWNER can never be created here — the Master tier is
 *   single-holder (Ramone alone), so no surface maps to it and an
 *   explicit role request is refused with 403.
 * - The owner account can never be deactivated, demoted, or deleted
 *   through these endpoints — no such endpoint exists. The only
 *   owner-affecting action is resetting the Master's OWN password,
 *   which additionally requires his current password in the request.
 * - Passwords are scrypt-hashed server-side (services/passwords) and
 *   are never logged or returned.
 */
const router = Router();

const masterOnly = [authenticate, requireRole(ROLES.COMPANY_OWNER)];
// Path-scoped to /access-control ON PURPOSE (hotfix 2026-11-17): this
// router is mounted at /api/v1 ahead of most other routers, and an
// UNSCOPED router.use(masterOnly) here answered every later router's
// traffic first — public routes (Speedy chat/status, payments status,
// the /app image routes, the engines) all returned 401/403 in
// production. Scoped, the gate still covers every route below (they
// all live under /access-control/*) and nothing else.
router.use('/access-control', ...masterOnly);

// ---------------------------------------------------------------------------
// The surface catalog: what the create form offers, in plain words.
// `role` + `signupAudience` are the existing account model — the same
// mapping POST /auth/register + config/offers.js use — so an account
// created here is indistinguishable from one created anywhere else.
// ---------------------------------------------------------------------------
export const ACCESS_SURFACES = [
  {
    key: 'service-setter',
    label: 'Service Setter',
    detail: 'Staff — Book OS, dispatch queue and the Service Setters consoles.',
    role: ROLES.DISPATCHER,
    signupAudience: null,
  },
  {
    key: 'manager',
    label: 'Manager',
    detail: 'Staff — Turbo Boss, ApplianceMan, Dispatch and Oversight consoles.',
    role: ROLES.COMPANY_ADMIN,
    signupAudience: null,
  },
  {
    key: 'provider',
    label: 'Provider / Technician',
    detail: 'Speedy Pro (Tech App) — jobs, route and job-day tools.',
    role: ROLES.PROVIDER_TECH,
    signupAudience: null,
  },
  {
    key: 'business',
    label: 'Business (Connect Pro)',
    detail: 'A business account on Appliance Connect Pro — passes the business login gate.',
    role: ROLES.CUSTOMER,
    signupAudience: 'commercial',
  },
  {
    key: 'property-manager',
    label: 'Property Manager (Connect Pro)',
    detail: 'A property-manager account on Appliance Connect Pro — passes the business login gate.',
    role: ROLES.CUSTOMER,
    signupAudience: 'property-manager',
  },
  {
    key: 'commercial',
    label: 'Commercial (Appliance Pro)',
    detail: 'A commercial account for the Appliance Pro portal (appliancepro.net).',
    role: ROLES.CUSTOMER,
    signupAudience: 'commercial',
  },
  {
    key: 'customer',
    label: 'Customer (Appliance Connect)',
    detail: 'A homeowner account for the Appliance Connect app (/app).',
    role: ROLES.CUSTOMER,
    signupAudience: 'homeowner',
  },
  {
    key: 'advertiser',
    label: 'Advertiser — Flywheel AI Advertising',
    detail: 'A Flywheel AI Advertising account — the business runs its ads in the Advertiser Console (the Pepper Lists / Flywheel advertise lane) with Top Speed.',
    role: ROLES.ADVERTISER,
    signupAudience: null,
  },
  {
    // Flywheel AI Advertising (2026-11-17): the marketing agency's own
    // staff surface. Ramone directed Flywheel into Work Time "with same
    // ability" — a marketing manager account is office-issued here like
    // every other workforce account, with the same 2-step defaults
    // (Speedy Verify starts unverified, Layer 2 on) computed by the same
    // helpers as every surface below. The self-serve marketing signup
    // door (PUBLIC_SELF_SERVE_ROLES) is the agency-client path and is
    // untouched — this surface is the office-issued staff path. Under
    // the existing employee-numbering rule, marketing roles are NOT
    // employee accounts, so no TS- number is minted for this surface.
    key: 'flywheel-manager',
    label: 'Flywheel Marketing Manager',
    detail: 'Flywheel AI Advertising staff — the agency marketing manager: Marketing OS, Page Studio, the SEO dashboard and Ad Studio.',
    role: ROLES.MARKETING_MANAGER,
    signupAudience: null,
  },
  {
    // Ad Specialist (2026-11-19, Ramone's directive): Top Speed's own
    // ad specialists — a staff-class account fully separate from the
    // advertiser marketplace (advertisers and self-serve marketing
    // roles are a different population). Office-issued here like every
    // workforce account: Speedy Verify starts unverified, Layer 2 on,
    // and — specialists are employees of the company, never outside
    // clients — an employee number IS minted (the existing rule in
    // services/employeeNumbers.js). Their stations are the marketing
    // workstations only: Marketing OS / Top Speed Local OS, Ad Studio
    // (Top Speed Ads), Page Studio, Media OS admin and Insights.
    // Campaign approval stays owner-only. The public door is the
    // /ad-specialist application, which creates the account PENDING
    // for the Master's activation — never an instant account.
    key: 'ad-specialist',
    label: 'Ad Specialist',
    detail: 'Top Speed ad specialist — runs Google, Facebook, SEO and Flywheel in-house ads from Marketing OS, Top Speed Ads (Ad Studio), Page Studio, Media OS and Insights. Marketing workstations only.',
    role: ROLES.AD_SPECIALIST,
    signupAudience: null,
  },
  {
    // Media OS Content Creator / Publisher (2026-11-19, Ramone's
    // order): an EXTERNAL account — the creator works in the Media OS
    // creator workspace on their own content only, and publishing
    // stays with the Media OS admin flow. Like the advertiser surface
    // it starts Speedy-Verify unverified (creators are a covered role)
    // and waits for the Master's code; Layer 2 is mandatory for the
    // role itself, not just the new-account default. External
    // accounts are not employees, so no TS- number is minted.
    key: 'content-creator',
    label: 'Content Creator / Publisher',
    detail: 'Media OS creator workspace — external content creators and publishers who submit content for staff review and publishing.',
    role: ROLES.CONTENT_CREATOR,
    signupAudience: null,
  },
];

const SURFACE_KEYS = ACCESS_SURFACES.map((surface) => surface.key);

function surfaceFor(key) {
  return ACCESS_SURFACES.find((surface) => surface.key === key) || null;
}

function surfaceLabelFor(user) {
  const roles = Array.isArray(user.roles) ? user.roles : [];
  if (isMasterAccount(user)) return 'Master — Owner account';
  for (const surface of ACCESS_SURFACES) {
    if (surface.role === ROLES.CUSTOMER) continue;
    if (roles.includes(surface.role)) return surface.label;
  }
  if (roles.includes(ROLES.PLATFORM_ADMIN)) return 'Platform Admin';
  if (roles.includes(ROLES.CUSTOMER)) {
    if (user.signupAudience === 'commercial') return 'Business / Commercial';
    if (user.signupAudience === 'property-manager') return 'Property Manager (Connect Pro)';
    return 'Customer (Appliance Connect)';
  }
  if (roles.includes(ROLES.MARKETING_MANAGER)) return 'Marketing Manager';
  if (roles.includes(ROLES.DEVELOPER)) return 'Developer';
  return roles.join(', ') || 'Account';
}

// ---------------------------------------------------------------------------
// User repository: Prisma (real database) or the in-memory skeleton —
// the same dual pattern as routes/auth.js.
// ---------------------------------------------------------------------------
const usersRepo = DATABASE_ENABLED
  ? {
      async findByEmail(companyId, email) {
        return db().user.findUnique({ where: { companyId_email: { companyId, email } } });
      },
      async findById(id) {
        return db().user.findUnique({ where: { id } });
      },
      async create(user) {
        return db().user.create({
          data: {
            id: user.id, companyId: user.companyId, email: user.email,
            passwordHash: user.passwordHash, firstName: user.firstName,
            lastName: user.lastName, phone: user.phone, roles: user.roles,
            active: user.active,
            emailVerifiedAt: user.emailVerifiedAt ?? null,
            signupSource: user.signupSource ?? null,
            signupOfferSlug: user.signupOfferSlug ?? null,
            signupAudience: user.signupAudience ?? null,
            verifyRequired: user.verifyRequired ?? false,
            layer2Required: user.layer2Required ?? false,
            layer2Phone: user.layer2Phone ?? null,
            layer2Channel: user.layer2Channel ?? null,
            employeeNumber: user.employeeNumber ?? null,
          },
        });
      },
      async updatePassword(id, passwordHash) {
        return db().user.update({ where: { id }, data: { passwordHash } });
      },
      async listAll() {
        return db().user.findMany({});
      },
    }
  : {
      async findByEmail(companyId, email) {
        for (const user of store.users.values()) {
          if (user.companyId === companyId && user.email === email) return user;
        }
        return null;
      },
      async findById(id) {
        return store.users.get(id) ?? null;
      },
      async create(user) {
        store.users.set(user.id, user);
        return user;
      },
      async updatePassword(id, passwordHash) {
        const user = store.users.get(id);
        if (user) {
          user.passwordHash = passwordHash;
          user.updatedAt = new Date().toISOString();
        }
        return user;
      },
      async listAll() {
        return [...store.users.values()];
      },
    };

async function accountRow(user) {
  const verify = await getVerifyState(user);
  return {
    ...publicUser(user),
    employeeNumber: user.employeeNumber ?? null,
    master: isMasterAccount(user),
    employee: isEmployeeAccount(user),
    surfaceLabel: surfaceLabelFor(user),
    verify,
    layer2: layer2StatusView(user),
    // Temporary passwords (2026-11-17): status + audit view for the
    // office's anytime monitoring — never the hash.
    temp: tempStatusView(user),
  };
}

// ---------------------------------------------------------------------------
// The surface catalog + the 2-step policy defaults that will apply, so
// the create form shows Ramone exactly what a new account starts with.
// ---------------------------------------------------------------------------
router.get('/access-control/surfaces', async (req, res) => {
  const surfaces = ACCESS_SURFACES.map((surface) => {
    const probe = {
      roles: [surface.role],
      signupAudience: surface.signupAudience,
    };
    return {
      key: surface.key,
      label: surface.label,
      detail: surface.detail,
      role: surface.role,
      signupAudience: surface.signupAudience,
      employee: isEmployeeAccount(probe),
      defaults: {
        speedyVerifyRequired: registrationStartsUnverified(probe, true),
        layer2Required: registrationLayer2Required(probe),
      },
    };
  });
  return res.json({ data: surfaces, count: surfaces.length });
});

// ---------------------------------------------------------------------------
// Account list: searchable, every account, with role(s), surface,
// employee number, and both 2-step states.
// ---------------------------------------------------------------------------
router.get('/access-control/accounts', async (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim().toLowerCase();
    let users = await usersRepo.listAll();
    if (query) {
      users = users.filter((user) => {
        const name = `${user.firstName || ''} ${user.lastName || ''}`.trim().toLowerCase();
        return (
          String(user.email || '').toLowerCase().includes(query) ||
          name.includes(query) ||
          String(user.employeeNumber || '').toLowerCase().includes(query) ||
          // The accounts list is the office's anytime window across
          // all four populations (employees, contractors, customers,
          // vendors) — searching a group or surface name finds its
          // accounts too.
          surfaceLabelFor(user).toLowerCase().includes(query) ||
          (Array.isArray(user.roles) ? user.roles : []).some((role) => String(role).toLowerCase().includes(query))
        );
      });
    }
    users.sort((a, b) => {
      if (isMasterAccount(a) !== isMasterAccount(b)) return isMasterAccount(a) ? -1 : 1;
      return String(a.email).localeCompare(String(b.email));
    });
    const rows = [];
    for (const user of users) rows.push(await accountRow(user));
    return res.json({ data: rows, count: rows.length });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Create an account with a password the Master chooses.
// ---------------------------------------------------------------------------
const createSchema = z.object({
  surface: z.enum(SURFACE_KEYS),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(10, 'Password must be at least 10 characters').max(200),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().min(7).max(30).optional(),
  verifyRequired: z.boolean().optional(),
});

router.post('/access-control/accounts', async (req, res, next) => {
  try {
    // Rule Zero, stated out loud: the Master tier is never on offer
    // here — not as a surface, and not smuggled in as a role field.
    if (req.body?.role === ROLES.COMPANY_OWNER || req.body?.surface === 'master') {
      return res.status(403).json({
        error: 'The Master (COMPANY_OWNER) account is held by the owner alone and cannot be created here.',
      });
    }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid account', details: parsed.error.flatten() });
    }
    const surface = surfaceFor(parsed.data.surface);
    const { email, password, firstName, lastName, phone } = parsed.data;

    if (await usersRepo.findByEmail(PLATFORM_COMPANY_ID, email)) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const draft = {
      id: createId(),
      companyId: PLATFORM_COMPANY_ID,
      email,
      passwordHash: await hashPassword(password),
      firstName: firstName ?? null,
      lastName: lastName ?? null,
      phone: phone ?? null,
      roles: [surface.role],
      active: true,
      emailVerifiedAt: null,
      signupSource: 'ACCESS_CONTROL',
      signupOfferSlug: null,
      signupAudience: surface.signupAudience,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // 2-step defaults, identical to POST /auth/register's rules: new
    // staff + business/PM (+ advertiser) accounts start with Speedy
    // Verify required and wait for the Master's code; providers start
    // flagged; every new account starts with Layer 2 on. The Master's
    // explicit toggle in the form wins over the default.
    draft.verifyRequired = typeof parsed.data.verifyRequired === 'boolean'
      ? parsed.data.verifyRequired
      : registrationStartsUnverified(draft, true);
    draft.layer2Required = registrationLayer2Required(draft);

    let user;
    try {
      user = await usersRepo.create(draft);
    } catch (error) {
      if (error?.code === 'P2002') {
        // Either the (companyId, email) pair raced us, or — impossible
        // here, employeeNumber is null at create — the number index.
        if (await usersRepo.findByEmail(PLATFORM_COMPANY_ID, email)) {
          return res.status(409).json({ error: 'An account with this email already exists' });
        }
      }
      throw error;
    }

    // Employee accounts are numbered at issuance (TS-1001…). A
    // numbering failure never loses the account — it is reported so
    // the Master sees the number is missing rather than invented.
    let employeeNumber = null;
    if (isEmployeeAccount(user)) {
      try {
        user = await assignEmployeeNumber(user);
        employeeNumber = user.employeeNumber ?? null;
      } catch (error) {
        console.error(JSON.stringify({ level: 'error', message: 'employee number assignment failed', error: String(error?.message || error) }));
      }
    }

    // Same guarded side effects as registration: welcome + staff
    // alert, and the single-use email-verification link. Neither may
    // fail the creation.
    try {
      notifyAccountCreated(user, 'ACCESS_CONTROL');
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'account-created notification failed', error: String(error?.message || error) }));
    }
    try {
      await issueEmailVerification(user, 'ACCESS_CONTROL');
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'email verification issue failed', error: String(error?.message || error) }));
    }

    const row = await accountRow(user);
    return res.status(201).json({
      user: row,
      employeeNumber,
      note: row.verify?.pendingApproval
        ? 'Account created unverified — issue its Speedy Verify code from the accounts list so the holder can sign in.'
        : 'Account created. The holder signs in with the email and the password you set.',
    });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Reset a password — the Master chooses the new one.
// ---------------------------------------------------------------------------
const resetSchema = z.object({
  userId: z.string().uuid(),
  newPassword: z.string().min(10, 'Password must be at least 10 characters').max(200),
  currentPassword: z.string().min(1).max(200).optional(),
});

router.post('/access-control/reset-password', async (req, res, next) => {
  try {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid password reset', details: parsed.error.flatten() });
    }
    const target = await usersRepo.findById(parsed.data.userId);
    if (!target) return res.status(404).json({ error: 'Account not found' });

    if (isMasterAccount(target)) {
      // Rule Zero: the ONLY owner-affecting action in this console is
      // the Master resetting his OWN password, and it demands his
      // current password in the same request — there is no
      // forgot-password endpoint, so this is the lockout guard.
      if (target.id !== req.user.id) {
        return res.status(403).json({ error: 'The Master account can only be changed by the Master himself.' });
      }
      if (!parsed.data.currentPassword) {
        return res.status(400).json({
          error: 'Enter your current password as well — resetting the Master password always requires it.',
          code: 'CURRENT_PASSWORD_REQUIRED',
        });
      }
      const currentOk = await verifyPassword(parsed.data.currentPassword, target.passwordHash);
      if (!currentOk) return res.status(401).json({ error: 'Current password is incorrect' });
    }

    await usersRepo.updatePassword(target.id, await hashPassword(parsed.data.newPassword));
    return res.json({ ok: true, note: 'Password updated. The account holder signs in with the new password you set.' });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Layer 2 requirement toggle for another account — reuses the Layer 2
// service (its own Rule Zero guard refuses to switch the Master on).
// Speedy Verify's requirement switch already lives at
// POST /speedy-verify/requirement; the console calls both.
// ---------------------------------------------------------------------------
const layer2RequirementSchema = z.object({
  userId: z.string().uuid(),
  required: z.boolean(),
});

router.post('/access-control/layer2-requirement', async (req, res, next) => {
  try {
    const parsed = layer2RequirementSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid Layer 2 requirement', details: parsed.error.flatten() });
    }
    const target = await usersRepo.findById(parsed.data.userId);
    if (!target) return res.status(404).json({ error: 'Account not found' });
    try {
      const layer2 = await updateLayer2Settings(target, { required: parsed.data.required });
      return res.json({ layer2 });
    } catch (error) {
      if (error?.status) {
        return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Temporary passwords (2026-11-17): issue / revoke. OFFICE-SIDE ONLY —
// these routes inherit the Master gate above (every non-owner role,
// managers and setters included, is refused 401/403), and no employee
// or contractor surface links here. The holder's experience is
// receive-only: temporary password → the usual sign-in gates → set
// their own password → in. Works for every population equally —
// employees, contractors, customers and vendors — because it operates
// on the account row, not on any surface. The Master account itself
// is refused (Rule Zero) inside the service.
// ---------------------------------------------------------------------------
const tempPasswordSchema = z.object({
  userId: z.string().uuid(),
});

router.post('/access-control/temp-password/issue', async (req, res, next) => {
  try {
    const parsed = tempPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid temporary password request', details: parsed.error.flatten() });
    }
    try {
      const issued = await issueTempPassword(req.user, parsed.data.userId);
      // tempPassword is the plain temporary password — returned ONLY
      // in this response, ONLY to the Master, exactly once. It is
      // never stored or logged; the account row holds only its hash.
      return res.status(201).json(issued);
    } catch (error) {
      if (error?.status) {
        return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

router.post('/access-control/temp-password/revoke', async (req, res, next) => {
  try {
    const parsed = tempPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid temporary password request', details: parsed.error.flatten() });
    }
    try {
      const temp = await revokeTempPassword(parsed.data.userId);
      return res.json({ temp });
    } catch (error) {
      if (error?.status) {
        return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

export default router;
