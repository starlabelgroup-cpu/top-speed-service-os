/**
 * Satellite CORS origins (2026-11-20) — Ramone hit "Failed to fetch"
 * creating a Pepper Lists account from pepperlists.com: the API was
 * healthy and the register endpoint answered direct probes, but the
 * browser blocked every call because the satellite serving origins
 * were not in the API CORS allowlist (the preflight came back with no
 * Access-Control-Allow-Origin). The satellite pages call this API at
 * its absolute origin, so each platform-owned serving origin must be
 * allowed — and nothing else may be.
 *
 * Drills, against a LOCAL test database only:
 *  - Every satellite origin added in server.js gets an exact-match
 *    Access-Control-Allow-Origin on preflight AND on an actual
 *    request.
 *  - The previously allowed origins (the configured CORS_ORIGIN list,
 *    the native-app origins, Field Pro) are unchanged.
 *  - The list stays CLOSED: an unknown origin, a lookalike suffix
 *    domain, a subdomain of an allowed domain, and the http:// scheme
 *    variant of an allowed https origin all get NO allow header.
 *  - A request with no Origin header is unaffected (server-to-server).
 *  - The register endpoint's own behavior is unchanged ({} still
 *    earns the same 400 validation shape, now readable cross-origin).
 *
 * Usage: DATABASE_URL=<local test db> node test/cors-satellite-origins.test.mjs
 * Exit code 0 = every check passed.
 */
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at a local TEST database).');
  process.exit(2);
}
process.env.DATABASE_URL_UNPOOLED ||= process.env.DATABASE_URL;

const PORT = Number(process.env.TEST_PORT || 4481);
const HOST = '127.0.0.1';

// The origins this fix adds (server.js always-allowed satellite list).
const SATELLITE_ORIGINS = [
  'https://pepperlists.com',
  'https://www.pepperlists.com',
  'https://applianceplug.app',
  'https://www.applianceplug.app',
  'https://cleanoutvents.com',
  'https://www.cleanoutvents.com',
  'https://appliancepro.app',
  'https://www.appliancepro.app',
  'https://applianceconnectpro.com',
  'https://www.applianceconnectpro.com',
  'https://appliance-connect.vercel.app',
  'https://topspeedrepairs.com',
  'https://www.topspeedrepairs.com',
  'https://fixmyappliancefl.com',
  'https://www.fixmyappliancefl.com',
  'https://browardappliancepros.com',
  'https://www.browardappliancepros.com',
];

// Origins allowed before this fix: the runner supplies the configured
// CORS_ORIGIN list (the production members), plus the code-level
// always-allowed origins and the local-dev default.
const CONFIGURED_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const PREEXISTING_ORIGINS = [
  ...CONFIGURED_ORIGINS,
  'capacitor://localhost',
  'https://localhost',
  'https://top-speed-field-pro.vercel.app',
];

const REJECTED_ORIGINS = [
  'https://evil.example.com',
  'https://pepperlists.com.evil.com',
  'https://sub.pepperlists.com',
  'http://pepperlists.com',
  'https://topspeedserviceos.com.evil.com',
];

let server = null;
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

function raw({ method, path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port: PORT, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const preflight = (origin, path = '/api/v1/auth/register') => raw({
  method: 'OPTIONS',
  path,
  headers: {
    Origin: origin,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  },
});

const acao = (res) => res.headers['access-control-allow-origin'] || null;

function startServer() {
  const proc = spawn('node', ['src/server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[api] ${d}`));
  return proc;
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await raw({ method: 'GET', path: '/api/v1/health' });
      if (res.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up');
}

server = startServer();
try {
  await waitForServer();

  for (const origin of SATELLITE_ORIGINS) {
    const pre = await preflight(origin);
    check(`preflight ACAO for satellite ${origin}`, acao(pre), origin);
    const actual = await raw({ method: 'GET', path: '/api/v1/health', headers: { Origin: origin } });
    check(`actual-request ACAO for satellite ${origin}`, acao(actual), origin);
  }

  for (const origin of PREEXISTING_ORIGINS) {
    const pre = await preflight(origin);
    check(`preflight ACAO unchanged for ${origin}`, acao(pre), origin);
  }

  for (const origin of REJECTED_ORIGINS) {
    const pre = await preflight(origin);
    check(`preflight ACAO absent for ${origin}`, acao(pre), null);
    const actual = await raw({ method: 'GET', path: '/api/v1/health', headers: { Origin: origin } });
    check(`actual-request ACAO absent for ${origin}`, acao(actual), null);
  }

  // The exact failure Ramone hit: register from the Pepper Lists
  // serving origin must now return the endpoint's real JSON (400 for
  // an empty body), readable by the browser.
  for (const origin of ['https://www.pepperlists.com', 'https://www.applianceplug.app', 'https://appliance-connect.vercel.app']) {
    const res = await raw({
      method: 'POST',
      path: '/api/v1/auth/register',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{}',
    });
    check(`register {} status from ${origin}`, res.status, 400);
    check(`register {} ACAO from ${origin}`, acao(res), origin);
    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch { /* asserted below */ }
    check(`register {} JSON error shape from ${origin}`, typeof parsed?.error, 'string');
  }

  const noOrigin = await raw({ method: 'GET', path: '/api/v1/health' });
  check('no-Origin health request still 200', noOrigin.status, 200);
} finally {
  if (server) server.kill('SIGTERM');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
