import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/**
 * Password hashing with Node's built-in scrypt (no external dependency).
 *
 * Stored format (algorithm-agile, so parameters can be raised later without
 * invalidating existing hashes):
 *   scrypt$<N>$<r>$<p>$<salt base64>$<derived key base64>
 *
 * The Prisma User.passwordHash column stores this string as-is.
 */
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, PARAMS.keylen, {
    N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem: PARAMS.maxmem,
  });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (!expected.length) return false;
    const derived = await scryptAsync(password, salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// A real hash of a random throwaway password, computed once at startup.
// Login verifies against this when the email is unknown so response timing
// does not reveal whether an account exists.
export const DUMMY_HASH_PROMISE = hashPassword(randomBytes(18).toString('base64'));
