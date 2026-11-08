import { PrismaClient } from '@prisma/client';

/**
 * Database access for the Service OS.
 *
 * When DATABASE_URL is set, the API runs on the real PostgreSQL database
 * (Prisma). When it is not set, the API stays in the Phase-1 in-memory
 * skeleton mode so the flow can be exercised locally without a database.
 * Routes pick their repository from here instead of branching everywhere.
 */
export const DATABASE_ENABLED = Boolean(process.env.DATABASE_URL);

let prisma = null;
export function db() {
  if (!DATABASE_ENABLED) return null;
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

export async function databaseStatus() {
  if (!DATABASE_ENABLED) return 'not-connected-in-skeleton';
  try {
    await db().$queryRaw`SELECT 1`;
    return 'connected';
  } catch {
    return 'connection-failed';
  }
}
