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
    req.user = {
      id: payload.sub,
      companyId: payload.companyId,
      email: payload.email,
      roles: Array.isArray(payload.roles) ? payload.roles : [],
    };
    req.authMode = 'jwt';
    return next();
  } catch (error) {
    return res.status(401).json({ error: error.message });
  }
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
