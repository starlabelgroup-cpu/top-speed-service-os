import { Router } from 'express';
import { z } from 'zod';
import { createId, PLATFORM_COMPANY_ID, store } from '../data/store.js';
import { DATABASE_ENABLED, db } from '../db/client.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { ROLES } from '../config/security.js';
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from '../services/passwords.js';
import { signAccessToken } from '../services/tokens.js';

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
});

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
          },
        });
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
    createdAt: iso(user.createdAt),
  };
}

function canGrantStaffRoles(req) {
  const roles = req.user?.roles || [];
  return req.authMode === 'jwt' && (roles.includes(ROLES.PLATFORM_ADMIN) || roles.includes(ROLES.COMPANY_OWNER));
}

router.post('/auth/register', async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid registration', details: parsed.error.flatten() });
    }
    const { email, password, firstName, lastName, phone } = parsed.data;
    const requestedRole = parsed.data.role ?? ROLES.CUSTOMER;

    if (requestedRole !== ROLES.CUSTOMER && !canGrantStaffRoles(req)) {
      return res.status(403).json({
        error: 'Staff and provider accounts are created by an administrator',
        hint: 'Register as a customer, or sign in with an admin account to grant roles.',
      });
    }

    const companyId = PLATFORM_COMPANY_ID;
    if (await usersRepo.findByEmail(companyId, email)) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    let user;
    try {
      user = await usersRepo.create(draft);
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
        source: 'ACCOUNT_SIGNUP',
        createdAt: new Date().toISOString(),
      };
      store.customers.set(customerRecord.id, customerRecord);
    }

    return res.status(201).json({ user: publicUser(user), ...signAccessToken(user) });
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
    const user = await usersRepo.findByEmail(PLATFORM_COMPANY_ID, email);

    // Verify against a dummy hash when the account does not exist so the
    // response time does not reveal which emails are registered.
    const hashToCheck = user ? user.passwordHash : await DUMMY_HASH_PROMISE;
    const passwordOk = await verifyPassword(password, hashToCheck);
    if (!user || !passwordOk) {
      return res.status(401).json({ error: 'Email or password is incorrect' });
    }
    if (!user.active) {
      return res.status(403).json({ error: 'This account is inactive' });
    }

    return res.json({ user: publicUser(user), ...signAccessToken(user) });
  } catch (error) {
    return next(error);
  }
});

router.get('/auth/me', authenticate, async (req, res, next) => {
  try {
    const user = await usersRepo.findById(req.user.id);
    if (user) return res.json({ user: publicUser(user), authMode: req.authMode });
    // Token is valid but the account is not in the store (e.g. demo context).
    return res.json({ user: { id: req.user.id, companyId: req.user.companyId, email: req.user.email, roles: req.user.roles }, authMode: req.authMode });
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

export default router;
