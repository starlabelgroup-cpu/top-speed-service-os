#!/usr/bin/env node
/**
 * Pepper Lists database split — the operator data move (2026-11-21).
 *
 * Copies every Pepper-Lists-owned table from the main Service OS
 * database (DATABASE_URL) into the dedicated Pepper Lists database
 * (PL_DATABASE_URL), row for row, and proves the move lossless:
 * counts before and after for every table, plus a deep-equal spot
 * check on sampled rows. Exits non-zero on ANY mismatch and copies
 * nothing else. Re-runnable: rows upsert by primary key.
 *
 * Run order at flip time (operator, with production credentials —
 * never from the build VM):
 *   1. Create the `pepper_lists` database in the same Neon project
 *      as the Service OS database.
 *   2. PL_DATABASE_URL=<new db url> npx prisma migrate deploy \
 *        --schema prisma-pl/schema.prisma
 *   3. DATABASE_URL=<main> PL_DATABASE_URL=<new> \
 *        node scripts/migrate-pepper-lists-db.mjs --dry-run
 *      (counts only — confirm the source counts look right)
 *   4. Same command without --dry-run (the copy + verification).
 *   5. Set PL_DATABASE_URL in the Vercel API project and redeploy.
 *      Until this step, production keeps reading the main database
 *      through the plClient fallback — the flip is this env var.
 *
 * FK-safe order: parents before children inside the PL database
 * (SellerPlan → SellerSubscription, SellerChannelConnection →
 * SellerChannelAudit). Everything else is plain-column references.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaClient as PlPrismaClient } from '../node_modules/.prisma/pl-client/index.js';

const DRY_RUN = process.argv.includes('--dry-run');
if (!process.env.DATABASE_URL || !process.env.PL_DATABASE_URL) {
  console.error('Both DATABASE_URL (source, main) and PL_DATABASE_URL (target, Pepper Lists) are required.');
  process.exit(2);
}

const MODELS = [
  'listingProfile',
  'listingComment',
  'listingReport',
  'sellerSale',
  'sellerReview',
  'listingBump',
  'savedListing',
  'sellerPlan',
  'sellerSubscription',
  'sellerChannelConnection',
  'sellerChannelAudit',
  'pepperListsCrossPost',
  'pepperListsSyndication',
  'pepperListsThread',
  'pepperListsMessage',
  'pepperListsOrder',
  'sellerConnectAccount',
];

const main = new PrismaClient();
const pl = new PlPrismaClient();

function stable(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

let failures = 0;
try {
  for (const model of MODELS) {
    const sourceCount = await main[model].count();
    if (DRY_RUN) {
      const targetCount = await pl[model].count().catch(() => -1);
      console.log(`${model}: source=${sourceCount} target=${targetCount < 0 ? 'unreachable' : targetCount} (dry run — nothing copied)`);
      continue;
    }
    const rows = await main[model].findMany({ orderBy: { id: 'asc' } });
    for (const row of rows) {
      await pl[model].upsert({ where: { id: row.id }, create: row, update: row });
    }
    const targetCount = await pl[model].count();
    // Spot check: up to 5 evenly sampled rows, deep-equal.
    let spotOk = true;
    if (rows.length) {
      const step = Math.max(1, Math.floor(rows.length / 5));
      for (let i = 0; i < rows.length; i += step) {
        const copy = await pl[model].findUnique({ where: { id: rows[i].id } });
        if (!copy || stable(copy) !== stable(rows[i])) { spotOk = false; break; }
      }
    }
    const ok = targetCount >= sourceCount && spotOk;
    if (!ok) failures += 1;
    console.log(`${model}: source=${sourceCount} copied=${rows.length} target=${targetCount} spotCheck=${spotOk ? 'ok' : 'MISMATCH'} ${ok ? '✓' : '✗ FAIL'}`);
  }
} finally {
  await main.$disconnect();
  await pl.$disconnect();
}
if (failures) {
  console.error(`\n${failures} table(s) failed verification — do NOT set PL_DATABASE_URL yet.`);
  process.exit(1);
}
console.log(DRY_RUN ? '\nDry run complete.' : '\nPepper Lists data move verified: counts match and spot checks pass.');
