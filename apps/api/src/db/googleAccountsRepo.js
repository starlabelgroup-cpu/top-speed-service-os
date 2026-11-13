import { createId, store } from '../data/store.js';
import { GOOGLE_ACCOUNT_SEEDS } from '../data/googleAccounts.js';
import { DATABASE_ENABLED, db } from './client.js';

/**
 * Multi-account Google manager registry — persistence layer.
 *
 * The registry records which Gmail accounts run the Top Speed Google
 * presence (Business Profile, Local Services Ads, Google Ads, Search
 * Console), the role each holds, its lifecycle status, and its linked
 * assets. It is deliberately NOT a live Google connection: invites are
 * sent and accepted in Google's own screens, and a human updates the
 * status here afterwards. Nothing in this layer ever flips a status on
 * its own.
 *
 * Seed discipline: the two real accounts (data/googleAccounts.js) are
 * seeded idempotently BY EMAIL and create-only — at Prisma seed time
 * and again at boot hydration — so a redeploy can never overwrite an
 * edit the owner made in the registry, and the registry is truthful
 * from the first boot even before the seed script runs.
 */

function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toStoreLink(row) {
  return {
    id: row.id,
    email: row.email,
    label: row.label,
    role: row.role || 'MANAGER',
    status: row.status || 'INVITED',
    assets: row.assets && typeof row.assets === 'object' ? row.assets : {},
    notes: row.notes || null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function toRow(link) {
  return {
    id: link.id,
    email: link.email,
    label: link.label,
    role: link.role || 'MANAGER',
    status: link.status || 'INVITED',
    assets: link.assets && typeof link.assets === 'object' ? link.assets : {},
    notes: link.notes || null,
    createdAt: new Date(link.createdAt),
    updatedAt: new Date(link.updatedAt || link.createdAt),
  };
}

export async function persistGoogleAccountLink(link) {
  if (!DATABASE_ENABLED || !link?.id) return;
  try {
    const row = toRow(link);
    await db().googleAccountLink.upsert({ where: { id: row.id }, update: row, create: row });
  } catch (error) {
    console.error('persistGoogleAccountLink failed', error?.message || error);
  }
}

export async function deleteGoogleAccountLink(id) {
  if (!DATABASE_ENABLED || !id) return;
  try {
    await db().googleAccountLink.delete({ where: { id } });
  } catch (error) {
    console.error('deleteGoogleAccountLink failed', error?.message || error);
  }
}

/**
 * Create-only seed by email. Returns how many seed records were new.
 * Runs against the database when enabled; in skeleton mode it seeds
 * the in-memory store the same way.
 */
export async function ensureGoogleAccountSeeds() {
  let created = 0;
  if (DATABASE_ENABLED) {
    const prisma = db();
    for (const seed of GOOGLE_ACCOUNT_SEEDS) {
      const existing = await prisma.googleAccountLink.findUnique({ where: { email: seed.email } });
      if (existing) continue;
      await prisma.googleAccountLink.create({ data: { ...seed } });
      created += 1;
    }
    return created;
  }
  for (const seed of GOOGLE_ACCOUNT_SEEDS) {
    if (store.googleAccountLinks.some((link) => link.email === seed.email)) continue;
    const now = new Date().toISOString();
    store.googleAccountLinks.push({ id: createId(), ...seed, createdAt: now, updatedAt: now });
    created += 1;
  }
  return created;
}

export async function hydrateGoogleAccounts() {
  await ensureGoogleAccountSeeds();
  if (!DATABASE_ENABLED) return store.googleAccountLinks.length;
  const rows = await db().googleAccountLink.findMany({ orderBy: { createdAt: 'asc' } });
  store.googleAccountLinks = rows.map(toStoreLink);
  return rows.length;
}
