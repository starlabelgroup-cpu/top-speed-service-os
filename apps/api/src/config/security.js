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
  ADVERTISER: 'ADVERTISER',
  MARKETING_MANAGER: 'MARKETING_MANAGER',
  DEVELOPER: 'DEVELOPER',
  AD_SPECIALIST: 'AD_SPECIALIST',
  CONTENT_CREATOR: 'CONTENT_CREATOR',
};

/**
 * Media OS Content Creator / Publisher accounts (2026-11-19, Ramone's
 * order): an EXTERNAL account family like advertisers and business/PM
 * accounts — never staff. A creator works only inside the Media OS
 * creator workspace (routes/mediaOs.js /media-os/creator/*), on their
 * OWN content items; publishing stays with the Media OS admin flow.
 * Two standing security rules ride on the role itself, not on
 * per-account toggles: Speedy Verify coverage (the account starts
 * unverified and waits for the Master's code — services/
 * speedyVerify.js) and MANDATORY Layer 2 at every sign-in (services/
 * layer2.js layer2Applies — the per-account switch cannot turn it
 * off for this role). The role is NOT self-serve: POST /auth/register
 * refuses it like every staff/provider role; accounts are created by
 * the office (Work Time Access) or through the scoped creator
 * application endpoint (routes/creatorSignup.js), which lands the
 * account PENDING until the Master activates it.
 */
export const CREATOR_ROLES = [ROLES.CONTENT_CREATOR];

/**
 * Marketing-platform roles (Advertiser Console, added 2026-11-10): the
 * advertising industry accounts Ramone opens the flywheel to — advertisers
 * who run campaigns with Top Speed, marketing managers, and developers.
 * These roles are SELF-SERVE at signup (like CUSTOMER): they grant access
 * to the holder's own console and channel connections only, never to staff
 * operations, bookings, or other accounts.
 */
export const MARKETING_ROLES = [ROLES.ADVERTISER, ROLES.MARKETING_MANAGER, ROLES.DEVELOPER];

/** Roles anyone may self-register for (no admin needed). */
export const PUBLIC_SELF_SERVE_ROLES = [ROLES.CUSTOMER, ...MARKETING_ROLES];

/**
 * Roles that operate the platform day to day — the staff gates on Book OS,
 * video, commercial, flywheel, bookings, and integration routes. The
 * COMPANY_OWNER and COMPANY_ADMIN roles belong here: the owner runs the
 * consoles personally. (Launch bug, found 2026-11-10 from Ramone's own
 * sign-in: every staff gate listed only DISPATCHER + PLATFORM_ADMIN, so
 * the owner got "Insufficient role" from his own Book OS.)
 */
export const STAFF_ROLES = [ROLES.DISPATCHER, ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN];

/**
 * Manager tier (2026-11-18, Ramone's order): ApplianceMan, Finance,
 * Oversight and the Remote Manager are MANAGER ONLY — Service Setters
 * (DISPATCHER) no longer enter them. This set mirrors the Turbo Boss
 * page gate exactly (MANAGERS in apps/web/turbo-boss/index.html:
 * COMPANY_ADMIN, COMPANY_OWNER, PLATFORM_ADMIN) so every manager
 * console enforces one identical gate. Rule Zero holds: the owner is
 * in the set, so the Master is never locked out.
 */
export const MANAGER_ROLES = [ROLES.COMPANY_ADMIN, ROLES.COMPANY_OWNER, ROLES.PLATFORM_ADMIN];

/**
 * Ad Specialist (2026-11-19, Ramone's directive): the staff-class
 * account for Top Speed's own ad specialists — the people who RUN the
 * advertising (Google Search/Display/retargeting, Facebook ads, SEO,
 * and the in-house Flywheel system) from the marketing workstations:
 * Marketing OS / Top Speed Local OS, Ad Studio (Top Speed Ads),
 * Page Studio, Media OS admin and Insights.
 *
 * Deliberately in NONE of the sets above:
 * - NOT in MARKETING_ROLES / PUBLIC_SELF_SERVE_ROLES — those are the
 *   advertiser marketplace's self-serve accounts; a specialist is
 *   never self-registered (POST /auth/register refuses the role; the
 *   doors are Work Time Access and the pending /ad-specialist apply).
 * - NOT in STAFF_ROLES — that set opens Book OS, CRM, Dispatch, the
 *   Pepper console and every operations console. Specialists are
 *   admitted to the marketing workstations by naming AD_SPECIALIST in
 *   those routes' existing marketing gate lists, and nowhere else.
 * - NOT in MANAGER_ROLES — no ApplianceMan, Finance, Oversight,
 *   Turbo Boss or Manager.
 * Campaign approval stays owner-only, exactly as before.
 */
