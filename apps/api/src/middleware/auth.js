import { createHmac, timingSafeEqual } from 'node:crypto';
import { PLATFORM_COMPANY_ID } from '../data/store.js';
import { ROLES } from '../config/security.js';

const demoUser = {
  id: '90000000-0000-4000-8000-000000000001',
  companyId: PLATFORM_COMPANY_ID,
  email: 'demo@topspeedappliance.local',
  roles: [ROLES.CUSTOMER, ROLES.DISPATCHER, ROLES.PLATFORM_ADMIN],
};

function base64UrlJson(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function verifyHs256(token, secret) {
  const [headerPart, payloadPart, signaturePart] = token.split('.');
  if (!headerPart || !payloadPart || !signaturePart) throw new Error('Malformed token');

  const header = base64UrlJson(headerPart);
  if (header.alg !== 'HS256') throw new Error('Unsupported JWT algorithm');

  const expected = createHmac('sha256', secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest();
  const actual = Buffer.from(signaturePart, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('Invalid JWT signature');
  }

  const payload = base64UrlJson(payloadPart);
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('Expired JWT');
  }
  return payload;
}

/**
 * Local skeleton behavior: ALLOW_DEMO_AUTH=true injects a clearly marked demo
 * Service Setter/customer context so the flow can be exercised without a DB.
 * Production must disable demo auth and issue short-lived HS256 JWTs instead.
 */
export function authenticate(req, res, next) {
  const header = req.get('authorization');

  if (!header) {
    if (process.env.ALLOW_DEMO_AUTH === 'true') {
      req.user = demoUser;
      req.authMode = 'demo-local-only';
      return next();
    }
    return res.status(401).json({ error: 'Authentication required' });
  }

  const [, token] = header.split(' ');
  if (!token) return res.status(401).json({ error: 'Bearer token required' });

  if (token === 'local-demo' && process.env.ALLOW_DEMO_AUTH === 'true') {
    req.user = demoUser;
    req.authMode = 'demo-local-only';
    return next();
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ error: 'JWT_SECRET is not configured' });
  }

  try {
    const payload = verifyHs256(token, process.env.JWT_SECRET);
    // Sign-in challenge tokens (Speedy Verify purpose 'speedy-verify',
    // Layer 2 purpose 'layer2') are NOT sessions: they exist only to
    // be exchanged at their code-step endpoints. Refusing them here
    // means a challenge token can never call an authenticated
    // endpoint. Real session tokens never carry a purpose claim.
    if (payload.purpose) {
      return res.status(401).json({ error: 'This is a sign-in challenge, not a session — complete the verification step first.' });
    }
    req.user = {
      id: payload.sub,
      companyId: payload.companyId,
      email: payload.email,
      roles: Array.isArray(payload.roles) ? payload.roles : [],
      // Speedy Verify (2026-11-16): true only when this session passed
      // the Master's access-code step (services/speedyVerify.js).
      sv: payload.sv === true,
      // Email sign-in link (2026-11-20): true only when this session
      // was minted by the one-time email-link exchange — /auth/me
      // accepts it in place of the code step for activated accounts.
      el: payload.el === true,
    };
    // Device sessions (2026-11-20, F3): the UserSession row this token
    // was minted from, when it carries one — the session manager uses
    // it to mark "this device". Revocation itself is enforced by the
    // session guard in server.js, not here.
    req.sessionId = payload.sid || null;
    req.authMode = 'jwt';
    return next();
  } catch (error) {
    return res.status(401).json({ error: error.message });
  }
}

export function optionalAuthenticate(req, res, next) {
  const header = req.get('authorization');
  if (!header) return next();

  const [, token] = header.split(' ');
  if (!token) return next();

  // Demo tokens never attach a user here: optional auth exists so the
  // public register route can recognize a signed-in administrator, and a
  // demo context must never look like one.
  if (!process.env.JWT_SECRET) return next();

  try {
    const payload = verifyHs256(token, process.env.JWT_SECRET);
    // Challenge tokens are not sessions (see authenticate above).
    if (payload.purpose) return next();
    req.user = {
      id: payload.sub,
      companyId: payload.companyId,
      email: payload.email,
      roles: Array.isArray(payload.roles) ? payload.roles : [],
      sv: payload.sv === true,
    };
    req.sessionId = payload.sid || null;
    req.authMode = 'jwt';
  } catch {
    // Invalid or expired token: proceed as an anonymous request.
  }
  return next();
}

export function requireCompany(req, res, next) {
  if (!req.user?.companyId) {
    return res.status(403).json({ error: 'A company context is required' });
  }

  const requestedCompanyId = req.body?.companyId || req.query?.companyId;
  if (requestedCompanyId && requestedCompanyId !== req.user.companyId && !req.user.roles.includes(ROLES.PLATFORM_ADMIN)) {
    return res.status(403).json({ error: 'Cannot act for another company' });
  }

  req.companyId = req.user.companyId;
  return next();
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const roles = req.user?.roles || [];
    if (!roles.some((role) => allowedRoles.includes(role))) {
      return res.status(403).json({ error: 'Insufficient role', requiredAnyOf: allowedRoles });
    }
    return next();
  };
}
