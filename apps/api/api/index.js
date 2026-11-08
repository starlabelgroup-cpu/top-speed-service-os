// Vercel serverless entry for the Top Speed Service OS API.
//
// Vercel turns this file into a function (see vercel.json in apps/api,
// which rewrites every path to it). The Express app is imported from
// src/server.js — importing it does NOT start the listener (that only
// happens when server.js is run directly, e.g. local `npm start`).
//
// Serverless instances are stateless, so the working store is hydrated
// from the database once per cold start before the first request is
// served. Mutations write through to the database inside the routes, so a
// cold-started instance always begins from the real data.
import app from '../src/server.js';
import { DATABASE_ENABLED } from '../src/db/client.js';
import { hydrateStore } from '../src/db/bookingsRepo.js';

let hydration = null;

function ensureHydrated() {
  if (!DATABASE_ENABLED) return Promise.resolve();
  if (!hydration) {
    hydration = hydrateStore().catch((error) => {
      // Do not cache a failed hydration — the next request retries.
      hydration = null;
      throw error;
    });
  }
  return hydration;
}

export default async function handler(req, res) {
  await ensureHydrated();
  return app(req, res);
}
