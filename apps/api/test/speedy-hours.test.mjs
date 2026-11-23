/**
 * Speedy business-hours drills (2026-11-23, Step 1 structure audit
 * HIGH defect #1): "What are your hours?" was answered live with
 * "I don't have that detail" — in AI mode AND at risk in fallback
 * paraphrases.
 *
 * Root cause: the system-prompt knowledge layer
 * (services/speedyKnowledge.js) still carried the pre-publication
 * instruction set — it named business hours as an example of a detail
 * Speedy does not know, flatly stated "Top Speed has NO published
 * business hours in your knowledge: never state opening, closing, or
 * weekend hours", and repeated in the Cleanout Vents section that
 * "Top Speed's own office hours are not published". Those lines date
 * from before the owner published the hours (2026-11-14: Mon–Fri
 * 8am–7pm on every surface; "Open 24 hours" is a Google Business
 * Profile listing setting only). The retrieval pack
 * (knowledge/site.js, entry site-business-basics) already carried
 * the hours and was injected into the prompt — the explicit boundary
 * prohibition overrode it, and the model obeyed the prohibition
 * verbatim. In fallback mode the same entry answered the direct
 * question, but weekend paraphrases ("Are you open on Saturday?")
 * scored under the good-match bar and got the "can't confirm" reply.
 *
 * The fix: speedyKnowledge.js now states the published hours as a
 * grounded fact (boundary section + company section) and warns only
 * against the Google-only "24 hours"; the Cleanout Vents line states
 * each business's hours as its own; site-business-basics gained
 * weekend/open-now keywords and an explicit "closed on Saturday and
 * Sunday" so retrieval and the fallback composer land on it for
 * paraphrases too.
 *
 * Drills (SKELETON MODE — no DATABASE_URL; this VM has no postgres
 * user, so no local cluster):
 *  A. In-process: the assembled system prompt carries the hours fact
 *     and none of the three stale prohibitions; retrieval ranks
 *     site-business-basics first (score >= GOOD_MATCH_SCORE) for the
 *     direct question and both paraphrases; the fallback composer
 *     answers all three from that entry, keeps the diagnostic answer
 *     verbatim-locked, and still answers an unrelated KB question.
 *  B. HTTP, provider unconfigured: the chat route answers the hours
 *     question and the Saturday paraphrase from the knowledge
 *     fallback with the hours and the weekend closure, and the
 *     diagnostic answer keeps its locked terms.
 *  C. HTTP, stub provider: a stub Responses server that answers the
 *     hours ONLY when the fact is present in the instructions it
 *     receives proves the assembled prompt carries the fact through
 *     the real route (answeredBy 'ai'); the captured instructions
 *     contain the hours and no stale prohibition. (The live model
 *     itself is proven against production after deploy.)
 *
 * Usage: node test/speedy-hours.test.mjs
 * (Skeleton mode: DATABASE_URL must NOT be set.) Exit 0 = all pass.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { speedySystemPrompt } from '../src/services/speedy.js';
import {
  composeFallbackAnswer,
  searchKnowledge,
  GOOD_MATCH_SCORE,
} from '../src/knowledge/index.js';

if (process.env.DATABASE_URL) {
  console.error('DATABASE_URL is set — this harness runs in skeleton mode only. Unset it and re-run.');
  process.exit(2);
}

const API_DIR = fileURLToPath(new URL('..', import.meta.url));
// Assembled from fragments on purpose (AGENTS.md credential-
// expression rule for tool writes). Test-only values.
const JWT = ['hours', 'drill', 'jwt', 'secret'].join('-');
const STUB_KEY = ['stub', 'key', 'not', 'real'].join('-');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok — ${name}`); }
  else { failed++; console.log(`  FAIL — ${name}${detail ? ` :: ${detail}` : ''}`); }
}
const includes = (hay, needle) => String(hay || '').includes(needle);

/* ------------------------------ Part A -------------------------------- */
console.log('Part A — prompt, retrieval, fallback composer (in-process)');
const prompt = speedySystemPrompt();
check('A1 prompt states the published hours', includes(prompt, 'Monday–Friday, 8:00 AM–7:00 PM'));
check('A2 prompt states the weekend closure', includes(prompt, 'closed Saturday and Sunday'));
check('A3 stale prohibition #1 gone (NO published business hours)', !includes(prompt, 'NO published business hours'));
check('A4 stale prohibition #2 gone (never state opening, closing)', !includes(prompt, 'never state opening, closing'));
check('A5 stale prohibition #3 gone (office hours are not published)', !includes(prompt, 'office hours are not published'));
check('A6 prompt warns the Google 24h is not our hours', includes(prompt, 'never tell a customer we are open 24 hours'));

for (const [label, q] of [
  ['direct', 'What are your hours?'],
  ['paraphrase-open', 'When are you open?'],
  ['paraphrase-saturday', 'Are you open on Saturday?'],
]) {
  const [top] = searchKnowledge(q, 1);
  check(`A7 retrieval ${label}: top entry is site-business-basics`,
    top?.entry?.id === 'site-business-basics', `got ${top?.entry?.id} score ${top?.score}`);
  check(`A8 retrieval ${label}: score >= GOOD_MATCH_SCORE (${GOOD_MATCH_SCORE})`,
    (top?.score || 0) >= GOOD_MATCH_SCORE, `score ${top?.score}`);
}

const fbHours = composeFallbackAnswer('What are your hours?');
check('A9 fallback hours: kind match on the basics entry',
  fbHours.kind === 'match' && fbHours.entryId === 'site-business-basics', `${fbHours.kind}/${fbHours.entryId}`);
check('A10 fallback hours: states Mon–Fri 8 AM–7 PM', includes(fbHours.reply, 'Monday–Friday, 8 AM–7 PM'));
check('A11 fallback hours: states the weekend closure', includes(fbHours.reply, "we're closed on Saturday and Sunday"));

const fbSat = composeFallbackAnswer('Are you open on Saturday?');
check('A12 fallback Saturday: kind match (not the can\'t-confirm general reply)',
  fbSat.kind === 'match', `kind ${fbSat.kind}`);
check('A13 fallback Saturday: states the weekend closure', includes(fbSat.reply, 'closed on Saturday and Sunday'));
check('A14 fallback Saturday: never says the detail is unconfirmed',
  !includes(fbSat.reply, "isn't one I can confirm"));

const fbDiag = composeFallbackAnswer('How much is the diagnostic fee?');
check('A15 fallback diagnostic: match on the diagnostic entry',
  fbDiag.kind === 'match' && fbDiag.entryId === 'site-pricing-diagnostic', `${fbDiag.kind}/${fbDiag.entryId}`);
check('A16 fallback diagnostic: $99 present', includes(fbDiag.reply, '$99'));
check('A17 fallback diagnostic: credited-in-full term intact', includes(fbDiag.reply, 'credited in full toward your approved repair'));
check('A18 fallback diagnostic: still-due term intact', includes(fbDiag.reply, 'the $99 is still due for the visit'));

const fbWarranty = composeFallbackAnswer('How long is the warranty on a repair?');
check('A19 fallback unrelated KB question still answers (warranty 90-day)',
  includes(fbWarranty.reply, '90-day'), fbWarranty.reply.slice(0, 120));

/* --------------------------- server harness ---------------------------- */
const children = [];
function bootApi(port, extraEnv) {
  const env = { ...process.env, PORT: String(port), JWT_SECRET: JWT, ALLOW_DEMO_AUTH: 'false' };
  delete env.DATABASE_URL;
  delete env.DATABASE_URL_UNPOOLED;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_API_KEY_V2;
  delete env.OPENAI_API_BASE;
  delete env.OPENAI_MODEL;
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, ['src/server.js'], { cwd: API_DIR, env });
  children.push(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return { child, getLog: () => log };
}

async function waitForHealth(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function chat(port, message) {
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/speedy/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j.data || {} };
}

/* ------------------------------ Part B -------------------------------- */
console.log('Part B — HTTP, provider unconfigured (knowledge fallback)');
const PORT_B = 4621;
const bootB = bootApi(PORT_B, {});
check('B0 API boots (no provider) and /health answers', await waitForHealth(PORT_B), bootB.getLog().slice(-300));
if (failed === 0 || true) {
  const bHours = await chat(PORT_B, 'What are your hours?');
  check('B1 hours via route: 200 + knowledge-fallback', bHours.status === 200 && bHours.data.answeredBy === 'knowledge-fallback',
    `${bHours.status}/${bHours.data.answeredBy}`);
  check('B2 hours via route: states Mon–Fri 8 AM–7 PM', includes(bHours.data.reply, 'Monday–Friday, 8 AM–7 PM'), (bHours.data.reply || '').slice(0, 160));
  const bSat = await chat(PORT_B, 'Are you open on Saturday?');
  check('B3 Saturday via route: states the weekend closure', includes(bSat.data.reply, 'closed on Saturday and Sunday'),
    (bSat.data.reply || '').slice(0, 160));
  check('B4 Saturday via route: no unconfirmed-detail deflection', !includes(bSat.data.reply, "isn't one I can confirm"));
  const bDiag = await chat(PORT_B, 'How much is the diagnostic fee?');
  check('B5 diagnostic via route: locked terms intact',
    includes(bDiag.data.reply, '$99') && includes(bDiag.data.reply, 'credited in full toward your approved repair') && includes(bDiag.data.reply, 'still due'),
    (bDiag.data.reply || '').slice(0, 160));
}
bootB.child.kill('SIGKILL');

/* ------------------------------ Part C -------------------------------- */
console.log('Part C — HTTP, stub provider (AI path prompt plumbing)');
const PORT_STUB = 4623;
const PORT_C = 4622;
let capturedInstructions = '';
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
    if (typeof parsed.instructions === 'string') capturedInstructions = parsed.instructions;
    const hasFact = includes(parsed.instructions, '8:00 AM–7:00 PM');
    const text = hasFact
      ? "We're open Monday–Friday, 8:00 AM–7:00 PM, and we're closed on Saturday and Sunday."
      : "I don't have that detail.";
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_stub', model: 'stub-model', output_text: text, output: [] }));
  });
});
await new Promise((r) => stub.listen(PORT_STUB, '127.0.0.1', r));
const bootC = bootApi(PORT_C, {
  OPENAI_API_KEY_V2: STUB_KEY,
  OPENAI_API_BASE: `http://127.0.0.1:${PORT_STUB}`,
});
check('C0 API boots (stub provider) and /health answers', await waitForHealth(PORT_C), bootC.getLog().slice(-300));
const cHours = await chat(PORT_C, 'What are your hours?');
check('C1 hours via AI path: 200 + answeredBy ai', cHours.status === 200 && cHours.data.answeredBy === 'ai',
  `${cHours.status}/${cHours.data.answeredBy}`);
check('C2 hours via AI path: reply states the hours', includes(cHours.data.reply, '8:00 AM–7:00 PM'),
  (cHours.data.reply || '').slice(0, 160));
check('C3 captured instructions carry the hours fact', includes(capturedInstructions, 'Monday–Friday, 8:00 AM–7:00 PM'));
check('C4 captured instructions carry the weekend closure', includes(capturedInstructions, 'closed Saturday and Sunday'));
check('C5 captured instructions free of the stale prohibition', !includes(capturedInstructions, 'NO published business hours'));
bootC.child.kill('SIGKILL');
stub.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
