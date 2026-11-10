export const SECURITY_DEFAULTS = {
  jwtAlgorithm: 'HS256',
  // 8 hours: a full work shift for console users (Service Setters, techs).
  // Was 900s (15 min) through the first live day (2026-11-09) — far too
  // short for an ops console. JWT_EXPIRES_IN_SECONDS still overrides.
  jwtExpiresInSeconds: Number(process.env.JWT_EXPIRES_IN_SECONDS || 28800),
  bcryptCost: Number(process.env.BCRYPT_COST || 12),
  rateLimits: {
    auth: { limit: 10, windowMs: 15 * 60 * 1000 },
    general: { limit: 200, windowMs: 15 * 60 * 1000 },
  },
};

export const ROLES = {
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  COMPANY_OWNER: 'COMPANY_OWNER',
  COMPANY_ADMIN: 'COMPANY_ADMIN',
  DISPATCHER: 'DISPATCHER',
  CUSTOMER: 'CUSTOMER',
  PROVIDER_OWNER: 'PROVIDER_OWNER',
  PROVIDER_TECH: 'PROVIDER_TECH',
  TECHNICIAN: 'TECHNICIAN',
};

/**
 * Roles that operate the platform day to day — the staff gates on Book OS,
 * video, commercial, flywheel, bookings, and integration routes. The
 * COMPANY_OWNER and COMPANY_ADMIN roles belong here: the owner runs the
 * consoles personally. (Launch bug, found 2026-11-10 from Ramone's own
 * sign-in: every staff gate listed only DISPATCHER + PLATFORM_ADMIN, so
 * the owner got "Insufficient role" from his own Book OS.)
 */
export const STAFF_ROLES = [ROLES.DISPATCHER, ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN];
