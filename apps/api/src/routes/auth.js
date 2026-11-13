import { Router } from 'express';
import { z } from 'zod';
import { createId, PLATFORM_COMPANY_ID, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { authenticate, optionalAuthenticate, requireRole } from '../middleware/auth.js';
import { MARKETING_ROLES, PUBLIC_SELF_SERVE_ROLES, ROLES } from '../config/security.js';
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from '../services/passwords.js';
import { signAccessToken } from '../services/tokens.js';
import { notifyAccountCreated } from '../services/notifications.js';
import { OFFER_SIGNUP_TYPES, appPathForAudience, getOffer, OFFERS, publicOffer } from '../config/offers.js';
import { consumeEmailVerification, emailVerificationState, issueEmailVerification } from '../services/emailVerification.js';
import { resolveArea } from '../config/serviceAreas.js';
import { persistCustomer } from '../db/bookingsRepo.js';
import { persistAppliance } from '../db/appliancesRepo.js';
import {
  LEGAL_DOCUMENTS,
  createUserWithTerms,
  recordTermsAcceptance,
  termsStatusForUser,
  validateTermsAcceptance,
} from '../services/legalTerms.js';

/**
 * The Service OS login system.
 *
 * Accounts mirror the Prisma User model (companyId + email unique, scrypt
 * passwordHash, roles array). Storage runs on the real PostgreSQL database
 * when DATABASE_URL is set; without it, the Phase-1 in-memory skeleton is
 * used so the flow can be exercised with no database at all.
 *
 * Public self-registration creates CUSTOMER accounts on the platform tenant.
 * Staff and provider roles can only be granted by an authenticated
 * PLATFORM_ADMIN / COMPANY_OWNER. (An ALLOW_STAFF_REGISTRATION env bypass
 * existed for the first-admin bootstrap; the bootstrap completed on
 * 2026-11-09 and the bypass was removed the same day — do not re-add it:
 * with the flag live on production, anyone could self-register as owner.)
 *
 * Responses never include passwordHash.
 */
const router = Router();

const ALL_ROLES = Object.values(ROLES);

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(10, 'Password must be at least 10 characters').max(200),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().min(7).max(30).optional(),
  role: z.enum(ALL_ROLES).optional(),
  // Offer attribution: the offer pages send the slug of the offer the
  // visitor signed up from. It is validated against config/offers —
  // an unknown slug is ignored, never fatal — and the audience is
  // pinned from the catalog, never trusted from the client.
  offerSlug: z.string().trim().max(60).optional(),
  // Admin-only: create the account inside another company (e.g. a
  // provider's company, so its techs can sign in to the Tech App).
  // Honored only when canGrantStaffRoles(req) — see the handler.
  companyId: z.string().uuid().optional(),
  // Legal gate: the signup forms send the two document agreements plus
  // the typed full name used as the signature. Validated for real in
  // services/legalTerms.js so the error copy stays plain and specific.
  termsAcceptance: z.object({
    signatureName: z.string().trim().max(120).optional(),
    documents: z.array(z.object({
      document: z.string().trim().max(60),
      version: z.string().trim().max(20),
      agreed: z.boolean().optional(),
    })).max(4).optional(),
  }).optional(),
});

const acceptTermsSchema = registerSchema.shape.termsAcceptance;

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10, 'Password must be at least 10 characters').max(200),
});

// ---------------------------------------------------------------------------
// User repository: Prisma (real database) or the in-memory skeleton.
// Both return the same plain-object shape.
// ---------------------------------------------------------------------------
const usersRepo = DATABASE_ENABLED
  ? {
      async findByEmail(companyId, email) {
        return db().user.findUnique({ where: { companyId_email: { companyId, email } } });
      },
      async findAllByEmail(email) {
        return db().user.findMany({ where: { email } });
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
            serviceStreet: user.serviceStreet ?? null,
            serviceCity: user.serviceCity ?? null,
            serviceZip: user.serviceZip ?? null,
            serviceArea: user.serviceArea ?? null,
            serviceAreaStatus: user.serviceAreaStatus ?? null,
          },
        });
      },
      async updateProfile(id, fields) {
        return db().user.update({ where: { id }, data: fields });
      },
      async updatePassword(id, passwordHash) {
        return db().user.update({ where: { id }, data: { passwordHash } });
      },
      async listForCompany(companyId, includeAll) {
        return db().user.findMany({ where: includeAll ? {} : { companyId } });
      },
    }
  : {
      async findByEmail(companyId, email) {
        for (const user of store.users.values()) {
          if (user.companyId === companyId && user.email === email) return user;
        }
        return null;
      },
      async findAllByEmail(email) {
        return [...store.users.values()].filter((user) => user.email === email);
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
      async updateProfile(id, fields) {
        const user = store.users.get(id);
        if (user) {
          Object.assign(user, fields);
          user.updatedAt = new Date().toISOString();
          store.users.set(id, user);
        }
        return user;
      },
      async listForCompany(companyId, includeAll) {
        return [...store.users.values()].filter((user) => includeAll || user.companyId === companyId);
      },
    };

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function publicUser(user) {
  return {
    id: user.id,
    companyId: user.companyId,
    email: user.email,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    phone: user.phone ?? null,
    roles: user.roles,
    active: user.active,
    emailVerified: Boolean(user.emailVerifiedAt),
    emailVerifiedAt: iso(user.emailVerifiedAt),
    signupSource: user.signupSource ?? null,
    signupOfferSlug: user.signupOfferSlug ?? null,
    signupAudience: user.signupAudience ?? null,
    serviceCity: user.serviceCity ?? null,
    serviceZip: user.serviceZip ?? null,
    serviceArea: user.serviceArea ?? null,
    serviceAreaStatus: user.serviceAreaStatus ?? null,
    createdAt: iso(user.createdAt),
  };
}

function canGrantStaffRoles(req) {
  const roles = req.user?.roles || [];
  return req.authMode === 'jwt' && (roles.includes(ROLES.PLATFORM_ADMIN) || roles.includes(ROLES.COMPANY_OWNER));
}

router.post('/auth/register', optionalAuthenticate, async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid registration', details: parsed.error.flatten() });
    }
    const { email, password, firstName, lastName, phone } = parsed.data;
    const requestedRole = parsed.data.role ?? ROLES.CUSTOMER;

    if (!PUBLIC_SELF_SERVE_ROLES.includes(requestedRole) && !canGrantStaffRoles(req)) {
      return res.status(403).json({
        error: 'Staff and provider accounts are created by an administrator',
        hint: 'Customers and marketing-platform professionals (advertiser, marketing manager, developer) can self-register; staff and provider roles are granted by an administrator.',
      });
    }

    // Accounts normally live on the platform tenant. An administrator may
    // create an account inside another company (provider accounts for the
    // Tech App); anyone else asking for a foreign companyId is refused.
    let companyId = PLATFORM_COMPANY_ID;
    if (parsed.data.companyId && parsed.data.companyId !== PLATFORM_COMPANY_ID) {
      if (!canGrantStaffRoles(req)) {
        return res.status(403).json({
          error: 'Only an administrator can create accounts for another company',
        });
      }
      if (DATABASE_ENABLED) {
        const company = await db().company.findUnique({ where: { id: parsed.data.companyId } });
        if (!company) {
          return res.status(400).json({ error: 'Unknown companyId' });
        }
      }
      companyId = parsed.data.companyId;
    }
    // Legal gate: a public signup must arrive WITH a signed acceptance
    // of both current legal documents — no acceptance, no account.
    // Administrator-created accounts (staff / provider accounts an admin
    // provisions) are the one exception: they carry no customer
    // signature, so their holder signs at first app entry instead,
    // where the same gate blocks access until POST /auth/accept-terms.
    const adminCreated = canGrantStaffRoles(req);
    let validatedTerms = null;
    if (!adminCreated) {
      validatedTerms = validateTermsAcceptance(parsed.data.termsAcceptance);
      if (!validatedTerms.ok) {
        return res.status(422).json({
          error: validatedTerms.error,
          code: 'TERMS_ACCEPTANCE_REQUIRED',
          documents: LEGAL_DOCUMENTS,
        });
      }
    } else if (parsed.data.termsAcceptance) {
      validatedTerms = validateTermsAcceptance(parsed.data.termsAcceptance);
      if (!validatedTerms.ok) {
        return res.status(422).json({ error: validatedTerms.error, code: 'TERMS_ACCEPTANCE_INVALID', documents: LEGAL_DOCUMENTS });
      }
    }

    if (await usersRepo.findByEmail(companyId, email)) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Offer attribution: a known offer slug marks the account as an
    // offer sign-up and pins its audience from the catalog.
    const offer = parsed.data.offerSlug ? getOffer(parsed.data.offerSlug) : null;
    const signupSource = offer ? 'OFFER_PAGE' : 'ACCOUNT_SIGNUP';
    const signupOfferSlug = offer ? offer.slug : null;
    const signupAudience = offer ? OFFER_SIGNUP_TYPES[offer.signupType].audience : null;

    const draft = {
      id: createId(),
      companyId,
      email,
      passwordHash: await hashPassword(password),
      firstName: firstName ?? null,
      lastName: lastName ?? null,
      phone: phone ?? null,
      roles: [requestedRole],
      active: true,
      emailVerifiedAt: null,
      signupSource,
      signupOfferSlug,
      signupAudience,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    let user;
    try {
      // With a signed acceptance, the account and its TermsAcceptance
      // rows are written in one transaction — never one without the other.
      user = validatedTerms ? await createUserWithTerms(draft, validatedTerms) : await usersRepo.create(draft);
    } catch (error) {
      // Prisma unique violation on (companyId, email) — a registration race.
      if (error?.code === 'P2002') {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }
      throw error;
    }

    // A customer account also gets a linked Customer record so bookings, the
    // garage, and referrals have a person to attach to. In database mode the
    // Prisma Customer model requires phone/city/zip, which a fresh signup may
    // not have yet — there the record is created at profile completion or
    // first booking (the bookings route already creates full records).
    if (requestedRole === ROLES.CUSTOMER && !DATABASE_ENABLED) {
      const customerRecord = {
        id: createId(),
        companyId,
        userId: user.id,
        name: [firstName, lastName].filter(Boolean).join(' ') || email,
        email,
        phone: phone ?? null,
        source: signupSource,
        createdAt: new Date().toISOString(),
      };
      store.customers.set(customerRecord.id, customerRecord);
    }

    // Unified notifications: welcome email for the new account holder
    // + an instant staff alert. Notification queueing must never fail
    // a registration, so it is guarded.
    try {
      notifyAccountCreated(user, 'ACCOUNT_SIGNUP');
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'account-created notification failed', error: String(error?.message || error) }));
    }

    // Email verification: EVERY new account gets a single-use
    // verification link through the outbox (services/
    // emailVerification.js). Guarded exactly like the welcome
    // notification — queueing trouble never fails a registration,
    // and the account works fully while unverified (soft prompt).
    try {
      await issueEmailVerification(user, signupSource);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', message: 'email verification issue failed', error: String(error?.message || error) }));
    }

    const terms = await termsStatusForUser(user.id);
    return res.status(201).json({ user: publicUser(user), emailVerification: emailVerificationState(user), terms, termsStatus: terms, ...signAccessToken(user) });
  } catch (error) {
    return next(error);
  }
});

router.post('/auth/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid login', details: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;
    // Accounts are unique per (companyId, email): the same email can exist
    // in more than one company (platform staff, a provider's techs,
    // customers), so login checks every account with this email and the
    // password picks the match.
    const candidates = await usersRepo.findAllByEmail(email);
    if (!candidates.length) {
      // Verify against a dummy hash when the account does not exist so the
      // response time does not reveal which emails are registered.
      await verifyPassword(password, await DUMMY_HASH_PROMISE);
      return res.status(401).json({ error: 'Email or password is incorrect' });
    }
    let user = null;
    for (const candidate of candidates) {
      if (await verifyPassword(password, candidate.passwordHash)) { user = candidate; break; }
    }
    if (!user) {
      return res.status(401).json({ error: 'Email or password is incorrect' });
    }
    if (!user.active) {
      return res.status(403).json({ error: 'This account is inactive' });
    }

    const terms = await termsStatusForUser(user.id);
    return res.json({ user: publicUser(user), terms, termsStatus: terms, ...signAccessToken(user) });
  } catch (error) {
    return next(error);
  }
});

router.get('/auth/me', authenticate, async (req, res, next) => {
  try {
    const user = await usersRepo.findById(req.user.id);
    if (user) {
      const terms = await termsStatusForUser(user.id);
      return res.json({ user: publicUser(user), terms, termsStatus: terms, authMode: req.authMode });
    }
    // Token is valid but the account is not in the store (e.g. demo context).
    const terms = await termsStatusForUser(req.user.id);
    return res.json({ user: { id: req.user.id, companyId: req.user.companyId, email: req.user.email, roles: req.user.roles }, terms, termsStatus: terms, authMode: req.authMode });
  } catch (error) {
    return next(error);
  }
});

// The current legal documents + versions (public: the signup forms and
// the /legal page links read their checkbox labels from the same source).
router.get('/auth/terms', (req, res) => {
  return res.json({ required: true, documents: LEGAL_DOCUMENTS });
});

// Existing accounts sign here: records the typed-name acceptance of both
// current documents and returns the cleared terms status the app gates
// wait on. A version bump makes this necessary again on its own.
router.post('/auth/accept-terms', authenticate, async (req, res, next) => {
  try {
    const user = await usersRepo.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    const parsed = acceptTermsSchema.safeParse(req.body?.termsAcceptance ?? req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid terms acceptance', details: parsed.error.flatten() });
    }
    const validated = validateTermsAcceptance(parsed.data);
    if (!validated.ok) {
      return res.status(422).json({ error: validated.error, code: 'TERMS_ACCEPTANCE_REQUIRED', documents: LEGAL_DOCUMENTS });
    }
    const terms = await recordTermsAcceptance(user.id, validated);
    return res.json({ ok: true, terms, termsStatus: terms });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Offers catalog (public): the web offer pages and the index render
// from the same source of truth the register attribution validates
// against — config/offers.js.
// ---------------------------------------------------------------------------
router.get('/offers', (req, res) => {
  return res.json({ data: OFFERS.map(publicOffer), count: OFFERS.length });
});

// ---------------------------------------------------------------------------
// Email verification: the /verify-email page exchanges the emailed
// token here. Success marks the account verified and names the app
// the account belongs in (portal separation by signup audience).
// Verification is a soft state — nothing else in the platform waits
// on it.
// ---------------------------------------------------------------------------
const verifyEmailSchema = z.object({ token: z.string().trim().min(10).max(200) });

function appPathForUser(user) {
  if (user.signupAudience) return appPathForAudience(user.signupAudience);
  if ((user.roles || []).some((role) => MARKETING_ROLES.includes(role))) return '/advertiser';
  return '/app';
}

router.post('/auth/verify-email', async (req, res, next) => {
  try {
    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid verification link', details: parsed.error.flatten() });
    }
    const user = await consumeEmailVerification(parsed.data.token);
    return res.json({
      ok: true,
      emailVerification: 'verified',
      user: publicUser(user),
      appPath: appPathForUser(user),
      offerSlug: user.signupOfferSlug ?? null,
    });
  } catch (error) {
    if (error?.status) {
      return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
    return next(error);
  }
});

// Resend: signed-in, issues a fresh token (superseding any live one)
// and queues a fresh email. Already-verified accounts get their true
// status back instead of a pointless email.
router.post('/auth/email-verification/resend', authenticate, async (req, res, next) => {
  try {
    const user = await usersRepo.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    if (user.emailVerifiedAt) {
      return res.json({ ok: true, emailVerification: 'verified', emailVerifiedAt: iso(user.emailVerifiedAt) });
    }
    await issueEmailVerification(user, 'RESEND');
    return res.json({ ok: true, emailVerification: 'pending', note: 'A fresh verification link is on its way to your account email. It works once and expires in 24 hours.' });
  } catch (error) {
    return next(error);
  }
});

// ---------------------------------------------------------------------------
// Profile completion: phone confirm, the service address (resolved
// through the Service Book area model), and optionally the first
// appliance. Everything lands on the same account records the apps
// and the CRM 360 already read — the Customer record is created here
// in database mode when the signup did not carry enough data for one
// (see the register handler's note), and the garage appliance joins
// store.appliances like any Connect garage entry. Skippable by
// design: the offer pages offer "finish later in your account".
// ---------------------------------------------------------------------------
const profileSchema = z.object({
  phone: z.string().trim().min(7).max(30).optional(),
  serviceAddress: z.object({
    street: z.string().trim().max(160).optional(),
    city: z.string().trim().max(80).optional(),
    zip: z.string().trim().max(12).optional(),
  }).optional(),
  appliance: z.object({
    type: z.string().trim().min(1).max(60),
    brand: z.string().trim().max(60).optional(),
    model: z.string().trim().max(80).optional(),
  }).optional(),
});

function areaMessageFor(user) {
  switch (user.serviceAreaStatus) {
    case 'IN_AREA':
      return `You're in our ${user.serviceArea} service area — bookings from this address route to your local team.`;
    case 'AREA_REVIEW':
      return 'Your ZIP spans more than one of our service areas — when you book, a Service Setter confirms the exact area for your address. Nothing else is needed from you.';
    case 'OUT_OF_AREA':
      return "Your address is outside the 12 areas we serve today. Your account and profile are saved either way, and having your address on file is how new areas get picked — but we haven't promised service at this address.";
    default:
      return null;
  }
}

router.post('/auth/profile', authenticate, async (req, res, next) => {
  try {
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid profile', details: parsed.error.flatten() });
    }
    const user = await usersRepo.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });

    const fields = {};
    if (parsed.data.phone) fields.phone = parsed.data.phone;
    const address = parsed.data.serviceAddress;
    if (address && (address.city || address.zip || address.street)) {
      const resolved = resolveArea({ city: address.city, zip: address.zip });
      fields.serviceStreet = address.street ?? user.serviceStreet ?? null;
      fields.serviceCity = address.city ?? user.serviceCity ?? null;
      fields.serviceZip = address.zip ?? user.serviceZip ?? null;
      fields.serviceArea = resolved.area;
      fields.serviceAreaStatus = resolved.areaStatus;
    }
    const updated = Object.keys(fields).length ? await usersRepo.updateProfile(user.id, fields) : user;

    // Sync the CRM Customer record: update the linked one, or create
    // it when the profile finally carries what the record requires
    // (name + phone + city + zip). Insufficient data is not an
    // error — the record is created at first booking instead.
    let customer = [...store.customers.values()].find((record) => record.userId === user.id) || null;
    const name = [updated.firstName, updated.lastName].filter(Boolean).join(' ') || updated.email;
    const city = updated.serviceCity || customer?.city || null;
    const zip = updated.serviceZip || customer?.zip || null;
    const phone = updated.phone || customer?.phone || null;
    if (customer) {
      customer.name = name;
      customer.email = updated.email;
      if (phone) customer.phone = phone;
      if (updated.serviceStreet) customer.address = updated.serviceStreet;
      if (city) customer.city = city;
      if (zip) customer.zip = zip;
      store.customers.set(customer.id, customer);
      await persistCustomer(customer).catch(() => {});
    } else if (phone && city && zip) {
      customer = {
        id: createId(),
        companyId: updated.companyId,
        userId: updated.id,
        name,
        email: updated.email,
        phone,
        address: updated.serviceStreet ?? null,
        city,
        zip,
        source: updated.signupSource || 'ACCOUNT_SIGNUP',
        createdAt: new Date().toISOString(),
      };
      store.customers.set(customer.id, customer);
      await persistCustomer(customer).catch(() => {});
    }

    let applianceSaved = false;
    if (parsed.data.appliance) {
      const appliance = {
        id: createId(),
        userId: updated.id,
        type: parsed.data.appliance.type,
        brand: parsed.data.appliance.brand ?? null,
        model: parsed.data.appliance.model ?? null,
        serial: null,
        year: null,
        notes: null,
        createdAt: new Date().toISOString(),
      };
      store.appliances.set(appliance.id, appliance);
      await persistAppliance(appliance).catch(() => {});
      applianceSaved = true;
    }

    return res.json({
      user: publicUser(updated),
      emailVerification: emailVerificationState(updated),
      profile: {
        complete: Boolean(updated.serviceCity && updated.serviceZip),
        area: updated.serviceArea ?? null,
        areaStatus: updated.serviceAreaStatus ?? null,
        areaMessage: areaMessageFor(updated),
      },
      customerId: customer?.id ?? null,
      applianceSaved,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/auth/change-password', authenticate, async (req, res, next) => {
  try {
    if (req.authMode !== 'jwt') {
      return res.status(400).json({ error: 'Sign in with your password to change it' });
    }
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid password change', details: parsed.error.flatten() });
    }
    const user = await usersRepo.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });

    const currentOk = await verifyPassword(parsed.data.currentPassword, user.passwordHash);
    if (!currentOk) return res.status(401).json({ error: 'Current password is incorrect' });
    if (parsed.data.newPassword === parsed.data.currentPassword) {
      return res.status(400).json({ error: 'New password must be different from the current password' });
    }

    await usersRepo.updatePassword(user.id, await hashPassword(parsed.data.newPassword));
    return res.json({ ok: true, note: 'Password updated. Other signed-in sessions keep their token until it expires.' });
  } catch (error) {
    return next(error);
  }
});

router.post('/auth/logout', authenticate, (req, res) => {
  // Access tokens are stateless HS256 JWTs; there is nothing server-side to
  // revoke yet. The client discards the token. (Server-side refresh sessions
  // arrive with the database stage.)
  return res.json({ ok: true, note: 'Discard your access token to complete sign-out.' });
});

router.get('/auth/users', authenticate, requireRole(ROLES.PLATFORM_ADMIN, ROLES.COMPANY_OWNER), async (req, res, next) => {
  try {
    const includeAll = req.user.roles.includes(ROLES.PLATFORM_ADMIN);
    const users = await usersRepo.listForCompany(req.user.companyId, includeAll);
    return res.json({ data: users.map(publicUser), count: users.length });
  } catch (error) {
    return next(error);
  }
});


// ---------------------------------------------------------------------------
// Google sign-in (OAuth 2.0). Built dark: the routes activate only when the
// Google client id and secret are present in the environment. Until then
// /auth/google/status reports configured:false and the start route answers
// 501, so the apps can show an honest "being connected" note instead of a
// dead button.
// ---------------------------------------------------------------------------
const googleEnv = (suffix) => process.env['GOOGLE_' + suffix] || '';
const googleClientId = () => googleEnv('CLIENT_ID');
const googleClientSecret = () => googleEnv('CLIENT_' + 'SECRET');
const googleRedirectUri = () =>
  googleEnv('REDIRECT_URI') || 'https://top-speed-service-os.vercel.app/api/v1/auth/google/callback';
const webOrigin = () => googleEnv('WEB_ORIGIN') || 'https://topspeedserviceos.com';
const GOOGLE_NEXT_WHITELIST = ['/appliance-pro', '/connect-pro-app', '/app'];
function googleNext(raw) {
  return GOOGLE_NEXT_WHITELIST.includes(raw) ? raw : '/app';
}

router.get('/auth/google/status', (req, res) =>
  res.json({ configured: Boolean(googleClientId() && googleClientSecret()) })
);

router.get('/auth/google', (req, res) => {
  if (!googleClientId() || !googleClientSecret()) {
    return res.status(501).json({ error: 'Google sign-in is not connected yet' });
  }
  const state = Buffer.from(JSON.stringify({ next: googleNext(req.query.next) })).toString('base64url');
  const params = new URLSearchParams({
    client_id: googleClientId(),
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

router.get('/auth/google/callback', async (req, res, next) => {
  try {
    if (!googleClientId() || !googleClientSecret()) {
      return res.status(501).json({ error: 'Google sign-in is not connected yet' });
    }
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: 'Missing authorization code' });
    let nextPath = '/app';
    try {
      nextPath = googleNext(JSON.parse(Buffer.from(String(req.query.state || ''), 'base64url').toString('utf8')).next);
    } catch { /* default next */ }
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: googleClientId(),
        client_secret: googleClientSecret(),
        redirect_uri: googleRedirectUri(),
        grant_type: 'authorization_code',
      }),
    });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenJson.access_token) {
      return res.status(502).json({ error: 'Google sign-in failed at token exchange' });
    }
    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + tokenJson.access_token },
    });
    const info = await infoRes.json().catch(() => ({}));
    if (!infoRes.ok || !info.email || info.email_verified === false) {
      return res.status(502).json({ error: 'Google account email not verified' });
    }
    const email = String(info.email).trim().toLowerCase();
    const existing = await usersRepo.findAllByEmail(email);
    let user = (existing || []).find((u) => u.active) || null;
    if (!user) {
      const draft = {
        id: createId(),
        companyId: PLATFORM_COMPANY_ID,
        email,
        passwordHash: await hashPassword(createId() + ':' + createId()),
        firstName: info.given_name || null,
        lastName: info.family_name || null,
        phone: null,
        roles: [ROLES.CUSTOMER],
        active: true,
        // Google already verified this email at sign-in (the callback
        // refuses unverified Google emails), so the account starts
        // verified — no outbox link needed.
        emailVerifiedAt: new Date().toISOString(),
        signupSource: 'GOOGLE_SIGNIN',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      user = await usersRepo.create(draft);
      // Same alert matrix as the register route: a Google-created
      // account is still a sign-up — welcome email + staff alert.
      // (The email starts verified, so no verification email follows.)
      notifyAccountCreated(user, 'GOOGLE_SIGNUP');
    }
    const issued = signAccessToken(user);
    const dest = new URL(webOrigin() + nextPath);
    dest.searchParams.set('token', issued.token);
    return res.redirect(dest.toString());
  } catch (error) {
    return next(error);
  }
});

export default router;
