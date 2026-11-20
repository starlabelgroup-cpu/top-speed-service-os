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

/**
 * Mint one access token.
 *
 * @param {{ expiresInSeconds?: number, speedyVerified?: boolean, sessionId?: string, emailLink?: boolean }} [options]
 *   speedyVerified is set only by the Speedy Verify code-step exchange;
 *   emailLink is set only by the email sign-in link exchange
 *   (services/emailSignIn.js) — /auth/me accepts either as proof the
 *   sign-in gate was satisfied, because the link door replaces the
 *   code step (Ramone's approved verification method, 2026-11-20).
 */
export function signAccessToken(user, { expiresInSeconds, speedyVerified, sessionId, emailLink } = {}) {
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
    // Speedy Verify (2026-11-16): set ONLY by the code-step exchange —
    // a session that passed the Master's access-code check carries
    // sv: true; /auth/me requires it for activated accounts.
    ...(speedyVerified ? { sv: true } : {}),
    // Email sign-in link (2026-11-20): set ONLY by the email-link
    // exchange — a session whose holder proved control of the
    // account's mailbox with a one-time link carries el: true;
    // /auth/me accepts it in place of the Speedy Verify code step
    // for activated accounts (the link is the verification method
    // Ramone approved; the password and code steps do not apply
    // to this door).
    ...(emailLink ? { el: true } : {}),
    // Device sessions (2026-11-20, F3): the UserSession row this
    // sign-in created, when the minting route recorded one (see
    // services/sessions.js). The session guard in server.js refuses a
    // token whose sid has been revoked by the account holder. Tokens
    // without an sid (everything minted before this system, and any
    // path that does not record a session) are never checked — the
    // password path and every gate stay exactly as they were, so no
    // account, the Master above all, can be locked out by this layer.
    ...(sessionId ? { sid: sessionId } : {}),
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
