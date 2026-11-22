import { DATABASE_ENABLED, db } from './client.js';

/**
 * Pepper Lists database access (2026-11-21, Ramone's directive:
 * "Pepperlists should have own database on Top Speed service OS
 * server").
 *
 * Pepper-Lists-owned tables (prisma-pl/schema.prisma) live in their
 * own database on the same server infrastructure, reached through
 * PL_DATABASE_URL and a second, generated Prisma client
 * (node_modules/.prisma/pl-client — generated at build time by
 * `prisma generate --schema prisma-pl/schema.prisma`, never
 * committed).
 *
 * THE FLIP IS ENV-DRIVEN AND SAFE BY DEFAULT: until PL_DATABASE_URL
 * is set, plDb() returns the MAIN database client, so every Pepper
 * Lists repository behaves exactly as it did before the split and
 * deploying this code changes nothing in production. Once the env
 * var lands (and the operator has run the PL migrations + the
 * data-copy script, scripts/migrate-pepper-lists-db.mjs), the same
 * repositories read and write the Pepper Lists database. Accounts
 * and auth NEVER move — they stay in the main database, and PL rows
 * reference user ids as plain columns.
 *
 * The generated client is imported lazily and defensively: in
 * skeleton mode (no databases at all) the module may not exist yet,
 * and the API must still boot.
 */

let PlPrismaClient = null;
try {
  // eslint-disable-next-line import/no-unresolved
  ({ PrismaClient: PlPrismaClient } = await import('../../node_modules/.prisma/pl-client/index.js'));
} catch {
  PlPrismaClient = null;
}

export const PL_DATABASE_ENABLED = Boolean(process.env.PL_DATABASE_URL) && Boolean(PlPrismaClient);

// Mirrors DATABASE_ENABLED for the Pepper Lists repositories: true
// when Pepper Lists rows can be read from A database (their own, or
// the main one through the pre-flip fallback).
export const PL_DB_AVAILABLE = PL_DATABASE_ENABLED || DATABASE_ENABLED;

let plPrisma = null;
export function plDb() {
  if (PL_DATABASE_ENABLED) {
    if (!plPrisma) {
      plPrisma = new PlPrismaClient();
    }
    return plPrisma;
  }
  return db();
}

export async function plDatabaseStatus() {
  if (!PL_DB_AVAILABLE) return 'not-connected-in-skeleton';
  if (!PL_DATABASE_ENABLED) return 'fallback-main-database';
  try {
    await plDb().$queryRaw`SELECT 1`;
    return 'connected';
  } catch {
    return 'connection-failed';
  }
}
