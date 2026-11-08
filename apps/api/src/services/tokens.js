import { createHmac } from 'node:crypto';
import { SECURITY_DEFAULTS } from '../config/security.js';

/**
 * Access-token issuing for the Service OS.
 *
 * Produces HS256 JWTs in exactly the shape middleware/auth.js verifies:
 * payload { sub, companyId, email, roles, iat, exp } signed with JWT_SECRET.
 * Tokens are stateless; logout is client-side discard until the database
 * stage adds server-side refresh sessions.
 */
function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function signAccessToken(user, { expiresInSeconds } = {}) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not configured');

  const lifetime = Number(expiresInSeconds ?? SECURITY_DEFAULTS.jwtExpiresInSeconds);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + lifetime;

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: user.id,
    companyId: user.companyId,
    email: user.email,
    roles: Array.isArray(user.roles) ? user.roles : [],
    iat: now,
    exp,
  };

  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest('base64url');
  return {
    token: `${unsigned}.${signature}`,
    tokenType: 'Bearer',
    expiresInSeconds: lifetime,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}
