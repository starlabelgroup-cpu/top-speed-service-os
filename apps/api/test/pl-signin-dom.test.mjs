/**
 * Pepper Lists sign-in DOM drills (2026-11-22) — local only.
 * Runs the REAL gate <script> block from pepper-lists-site/index.html
 * in a vm with a stub DOM/localStorage/fetch and proves:
 *  S1 valid session (tsos_token)      → app opens, top bar signed-in, no wall
 *  S2 valid session (vault only)      → token adopted, app opens (the bug case)
 *  S3 no session                      → public page, login options on top, wall only on entry tap, no chip data
 *  S4 invalid token (401)             → cleared from keys AND vault, no chip, fresh sign-in possible
 *  S5 stalled session check           → nothing cleared, no wall, recheck recovers into the app
 *  S6 login page render + validation  → view shows, bad input blocked client-side, no fetch fired
 *  S7 wrong password on login page    → honest 401 message, exactly one fetch (never retried)
 *  S8 network stall on login page     → exactly two fetches, "Connection stalled" message
 *  S9 Layer 2 handoff from login page → TSOSLayer2.run receives the challenge
 *  S10 sign out                       → keys + vault session both cleared
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { fileURLToPath } from 'node:url';
const HTML_PATH = process.env.PL_HTML || fileURLToPath(new URL('../../web/pepper-lists-site/index.html', import.meta.url));
const html = readFileSync(HTML_PATH, 'utf8');
const gateSrc = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes('function plBoot'));
if (!gateSrc) { console.error('gate script not found'); process.exit(2); }
const htmlIds = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS ${name}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 5)); };

function makeEl(id) {
  return {
    id, style: {}, textContent: '', innerHTML: '', className: '', value: '', disabled: false,
    children: [],
    addEventListener() {}, removeEventListener() {}, focus() {}, scrollIntoView() {},
    setAttribute() {}, getAttribute() { return null; }, appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return false; },
  };
}

function makeWorld({ storage = {}, vaultSeed = null, fetchImpl }) {
  const store = new Map(Object.entries(storage));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const vault = { accounts: {}, active: null, calls: [] };
  if (vaultSeed) { vault.accounts[vaultSeed.user.id] = { user: vaultSeed.user, token: vaultSeed.token, savedAt: 1 }; vault.active = vaultSeed.user.id; }
  const TSOSVault = {
    add(user, token) { vault.calls.push(['add', user && user.id]); vault.accounts[user.id] = { user, token, savedAt: Date.now() }; vault.active = user.id; },
    active() { const a = vault.active ? vault.accounts[vault.active] : null; return a ? { user: a.user, token: a.token, savedAt: a.savedAt } : null; },
    list() { return Object.keys(vault.accounts).map((id) => ({ user: vault.accounts[id].user, savedAt: vault.accounts[id].savedAt, active: id === vault.active })); },
    remove(userId) { vault.calls.push(['remove', userId]); const was = vault.active === userId; delete vault.accounts[userId]; if (was) vault.active = null; },
    expireActive() {
      vault.calls.push(['expireActive']);
      const legacy = localStorage.getItem('tsos_token');
      let dropped = false;
      for (const id of Object.keys(vault.accounts)) {
        if (id === vault.active || (legacy && vault.accounts[id].token === legacy)) { delete vault.accounts[id]; dropped = true; }
      }
      if (dropped) { if (vault.active && !vault.accounts[vault.active]) vault.active = null; }
      else if (legacy) { localStorage.removeItem('tsos_token'); localStorage.removeItem('tsos_cust_token'); dropped = true; }
      return dropped;
    },
  };
  const els = new Map();
  const listeners = {};
  const document = {
    getElementById(id) {
      if (!htmlIds.has(id)) return null;
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    createElement() { return makeEl('dyn'); },
    body: makeEl('body'),
  };
  // Initial inline display states from the markup that matter.
  const el = (id) => document.getElementById(id);
  const l2 = { runs: [] };
  const sandbox = {
    console, URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    document, localStorage, fetch: fetchImpl,
    location: { search: '', hash: '', pathname: '/', reload() { sandbox.__reloaded = true; } },
    scrollTo() {},
    TSOSVault,
    TSOSLayer2: { run(j, opts) { l2.runs.push({ challenge: j && j.challenge, hasOpts: Boolean(opts) }); return true; }, isChallenge: (j) => Boolean(j && j.layer2Required) },
  };
  sandbox.window = sandbox;
  sandbox.window.scrollTo = () => {};
  vm.createContext(sandbox);
  vm.runInContext(gateSrc, sandbox, { filename: 'pl-gate.js' });
  return { sandbox, el, vault, TSOSVault, l2, store, fireDCL: () => (listeners.DOMContentLoaded || []).forEach((fn) => fn()) };
}

const USER = { id: 'u-eric', email: 'eric@drill.test', firstName: 'Eric', lastName: 'Smith', roles: ['CUSTOMER'] };
const okMe = async () => ({ ok: true, status: 200, json: async () => ({ user: USER }) });

// S1 — valid session via tsos_token
{
  console.log('S1 valid session (tsos_token)');
  const w = makeWorld({ storage: { tsos_token: 'tokA' }, fetchImpl: okMe });
  w.fireDCL(); await flush();
  check('gate stays hidden', w.el('plGate').style.display === 'none');
  check('account bar shown', w.el('plAcctBar').style.display === '');
  check('top bar signed-in shown', w.el('plTopIn').style.display === '' && w.el('plTopOut').style.display === 'none');
  check('top bar names the account', w.el('plTopWho').textContent === 'Eric Smith');
  check('vault captured the verified session', w.vault.calls.some((c) => c[0] === 'add' && c[1] === 'u-eric'));
  check('login view hidden', w.el('plLogin').style.display === 'none');
}
// S2 — valid session via vault only (Ramone's screenshot case)
{
  console.log('S2 valid session (vault only — the bug case)');
  const w = makeWorld({ vaultSeed: { user: USER, token: 'tokV' }, fetchImpl: okMe });
  w.fireDCL(); await flush();
  check('vault token adopted into tsos_token', w.store.get('tsos_token') === 'tokV');
  check('app opened (account bar shown)', w.el('plAcctBar').style.display === '');
  check('gate stays hidden', w.el('plGate').style.display === 'none');
  check('app entry returns true (no wall)', w.sandbox.plOpenApp({ preventDefault() {} }) === true);
}
// S3 — no session
{
  console.log('S3 no session');
  const w = makeWorld({ fetchImpl: okMe });
  w.fireDCL(); await flush();
  check('top bar shows Log in / Create account', w.el('plTopOut').style.display === '' && w.el('plTopIn').style.display === 'none');
  check('account bar hidden', w.el('plAcctBar').style.display === 'none');
  check('no chip data (vault empty)', w.TSOSVault.list().length === 0);
  check('entry tap opens the wall', w.sandbox.plOpenApp({ preventDefault() {} }) === false && w.el('plGate').style.display === '');
}
// S4 — invalid token → cleared everywhere
{
  console.log('S4 invalid token (401)');
  const w = makeWorld({
    storage: { tsos_token: 'tokDead', tsos_cust_token: 'tokDead' },
    vaultSeed: { user: USER, token: 'tokDead' },
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'Session expired' }) }),
  });
  w.fireDCL(); await flush();
  check('tsos_token cleared', !w.store.has('tsos_token') && !w.store.has('tsos_cust_token'));
  check('vault session dropped (no chip)', w.TSOSVault.list().length === 0, JSON.stringify(w.vault.calls));
  check('top bar signed-out', w.el('plTopOut').style.display === '' && w.el('plTopIn').style.display === 'none');
  check('fresh sign-in possible (wall opens on tap)', w.sandbox.plOpenApp({ preventDefault() {} }) === false && w.el('plGate').style.display === '');
}
// S5 — stalled session check → nothing cleared, recovery on recheck
{
  console.log('S5 stalled session check');
  let mode = 'down';
  const w = makeWorld({
    storage: { tsos_token: 'tokA' },
    vaultSeed: { user: USER, token: 'tokA' },
    fetchImpl: async () => { if (mode === 'down') throw new Error('network down'); return okMe(); },
  });
  w.fireDCL(); await flush();
  check('boot state is unknown (not out)', w.sandbox.plBootState === 'unknown', w.sandbox.plBootState);
  check('token kept', w.store.get('tsos_token') === 'tokA');
  check('vault kept (chip and page agree)', w.TSOSVault.list().length === 1);
  check('entry tap does NOT open the wall while unverified', w.sandbox.plOpenApp({ preventDefault() {} }) === false && w.el('plGate').style.display === 'none');
  mode = 'up'; await flush();
  check('recheck recovers into the app', w.el('plAcctBar').style.display === '' && w.sandbox.plUser && w.sandbox.plUser.id === 'u-eric');
}
// S6 — login page render + validation
{
  console.log('S6 login page render + validation');
  let fetches = 0;
  const w = makeWorld({ fetchImpl: async () => { fetches += 1; return okMe(); } });
  w.fireDCL(); await flush();
  w.sandbox.plShowLogin();
  check('login view visible', w.el('plLogin').style.display === '');
  check('app pitch hidden behind it', w.el('plApp').style.display === 'none');
  w.el('plLgEmail').value = 'not-an-email'; w.el('plLgPass').value = '';
  w.sandbox.plPageLogin();
  check('bad email blocked with a message', /valid email/.test(w.el('plLgMsg').textContent) && fetches === 0);
  w.el('plLgEmail').value = 'eric@drill.test'; w.el('plLgPass').value = '';
  w.sandbox.plPageLogin();
  check('empty password blocked with a message', /enter your password/i.test(w.el('plLgMsg').textContent) && fetches === 0);
}
// S7 — wrong password: honest error, exactly one fetch
{
  console.log('S7 wrong password on the login page');
  let fetches = 0;
  const w = makeWorld({ fetchImpl: async () => { fetches += 1; return { ok: false, status: 401, json: async () => ({ error: 'Invalid email or password' }) }; } });
  w.fireDCL(); await flush();
  w.el('plLgEmail').value = 'eric@drill.test'; w.el('plLgPass').value = 'wrong-password';
  w.sandbox.plPageLogin(); await flush();
  check('honest 401 message shown', w.el('plLgMsg').textContent === 'Invalid email or password', w.el('plLgMsg').textContent);
  check('401 never retried (exactly 1 fetch)', fetches === 1, String(fetches));
}
// S8 — network stall: one retry, then the stalled message
{
  console.log('S8 network stall on the login page');
  let fetches = 0;
  const w = makeWorld({ fetchImpl: async () => { fetches += 1; throw new Error('offline'); } });
  w.fireDCL(); await flush();
  w.el('plLgEmail').value = 'eric@drill.test'; w.el('plLgPass').value = 'some-password';
  w.sandbox.plPageLogin(); await flush();
  check('exactly 2 fetches (one retry)', fetches === 2, String(fetches));
  check('stalled message shown', /Connection stalled/.test(w.el('plLgMsg').textContent), w.el('plLgMsg').textContent);
}
// S9 — Layer 2 handoff from the login page
{
  console.log('S9 Layer 2 handoff');
  const w = makeWorld({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ layer2Required: true, challenge: 'ch-123', channels: [{ channel: 'EMAIL', available: true }] }) }) });
  w.fireDCL(); await flush();
  w.el('plLgEmail').value = 'eric@drill.test'; w.el('plLgPass').value = 'some-password';
  w.sandbox.plPageLogin(); await flush();
  check('TSOSLayer2.run received the challenge', w.l2.runs.length === 1 && w.l2.runs[0].challenge === 'ch-123');
}
// S10 — sign out clears keys + vault
{
  console.log('S10 sign out');
  const w = makeWorld({ storage: { tsos_token: 'tokA' }, fetchImpl: okMe });
  w.fireDCL(); await flush();
  w.sandbox.plSignOut();
  check('keys cleared', !w.store.has('tsos_token'));
  check('vault session removed', w.TSOSVault.list().length === 0, JSON.stringify(w.vault.calls));
  check('page reloaded', w.sandbox.__reloaded === true);
}

console.log(`\nDOM DRILLS: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
