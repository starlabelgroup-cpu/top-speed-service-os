import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import authRouter from './routes/auth.js';
import bookingsRouter from './routes/bookings.js';
import integrationsRouter from './routes/integrations.js';
import bookosRouter from './routes/bookos.js';
import providerRouter from './routes/provider.js';
import flywheelRouter from './routes/flywheel.js';
import commercialRouter from './routes/commercial.js';
import speedyRouter from './routes/speedy.js';
import videoRouter from './routes/video.js';
import connectionsRouter from './routes/connections.js';
import connectRouter from './routes/connect.js';
import crmRouter from './routes/crm.js';
import bannersRouter from './routes/banners.js';
import paymentsRouter from './routes/payments.js';
import marketingRouter from './routes/marketing.js';
import appRouter from './routes/app.js';
import { authRateLimit, generalRateLimit } from './middleware/rateLimit.js';
import { DATABASE_ENABLED, databaseStatus } from './db/client.js';
import { hydrateStore } from './db/bookingsRepo.js';
import { providersStatus } from './services/senders.js';
import { speedyStatus } from './services/speedy.js';
import { SERVICE_AREAS } from './config/serviceAreas.js';

try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  // Environment variables may be supplied directly by the host instead.
}

const app = express();
const port = Number(process.env.PORT || 4000);
// CORS_ORIGIN accepts one origin or a comma-separated list (the platform
// ships two front ends — the customer/provider site and the commercial
// platform — plus local dev).
const corsOrigin = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: corsOrigin, credentials: false }));
// Photo diagnosis carries a base64 image, so that one path gets a larger
// body limit; it must be registered before the global parser.
// Stripe webhook: signature verification needs the untouched bytes,
// so this path gets a raw parser BEFORE any JSON parser runs.
app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
app.use('/api/v1/speedy/diagnose', express.json({ limit: '6mb' }));
app.use(express.json({ limit: '100kb' }));
app.use('/api/v1', generalRateLimit);
app.use('/api/v1/auth', authRateLimit);

app.get('/api/v1/health', async (req, res) => {
  const database = await databaseStatus();
  res.json({
    status: 'ok',
    service: 'Top Speed Service OS API',
    version: 'v1',
    mode: DATABASE_ENABLED ? 'database' : 'phase-1-in-memory-skeleton',
    database,
    persistence: {
      accounts: DATABASE_ENABLED ? 'database' : 'in-memory',
      bookings: DATABASE_ENABLED ? 'database' : 'in-memory',
      referralsAndNotifications: DATABASE_ENABLED ? 'database' : 'in-memory',
    },
    notifications: providersStatus(),
    speedy: speedyStatus(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/v1/service-areas', (req, res) => {
  res.json({ data: SERVICE_AREAS });
});

// Cold-start hydration: serverless instances are stateless, so the working
// store is loaded from the database once before the routers serve traffic.
// Mutations write through to the database inside the routes, so a
// cold-started instance always begins from the real data. This runs inside
// the Express pipeline (after the body parsers), NOT in a wrapper around
// the app — awaiting before the app takes the request breaks body streams
// on Vercel (see api/index.js).
let hydration = null;
app.use('/api/v1', async (req, res, next) => {
  if (!DATABASE_ENABLED) return next();
  if (!hydration) {
    hydration = hydrateStore().catch((error) => {
      // Do not cache a failed hydration — the next request retries.
      hydration = null;
      throw error;
    });
  }
  try {
    await hydration;
    return next();
  } catch (error) {
    return next(error);
  }
});

app.use('/api/v1', authRouter);
app.use('/api/v1', bookingsRouter);
app.use('/api/v1', integrationsRouter);
app.use('/api/v1', bookosRouter);
app.use('/api/v1', providerRouter);
app.use('/api/v1', flywheelRouter);
app.use('/api/v1', commercialRouter);
app.use('/api/v1', speedyRouter);
app.use('/api/v1', paymentsRouter);
app.use('/api/v1', marketingRouter);
app.use('/api/v1', videoRouter);
app.use('/api/v1', connectionsRouter);
app.use('/api/v1', connectRouter);
app.use('/api/v1', crmRouter);
app.use('/api/v1', bannersRouter);
app.use('/api/v1', appRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  if (DATABASE_ENABLED) {
    const counts = await hydrateStore();
    console.log(`Database hydrated: ${counts.bookings} bookings, ${counts.customers} customers, ${counts.assignments} assignments, ${counts.providers} providers.`);
  }
  app.listen(port, () => {
    console.log(`Top Speed Service OS API listening on http://localhost:${port}/api/v1`);
    console.log(DATABASE_ENABLED
      ? 'Storage mode: PostgreSQL via Prisma (accounts + bookings on database).'
      : 'Storage mode: in-memory Phase 1 skeleton (set DATABASE_URL for the real database).');
  });
}

export default app;
