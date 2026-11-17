/**
 * Pepper Lists THREE PURPOSES — page-level verification (2026-11-17).
 *
 * Ramone's consolidation: Pepper Lists presents exactly three
 * purposes everywhere — Sell (marketplaces), Post (social media +
 * search directories, Reviews wall stays in Post), Book (booking
 * services with Speedy AI and Top Speed Service OS: classic web
 * form FIRST, Speedy AI booking below, summary-confirm gate, Track
 * My Tech + my bookings). This supersedes the 2026-11-16
 * two-category rule.
 *
 * Static checks over the shipped page sources (no server needed):
 *  - the signed-in hub has all three purpose doors + panels, and
 *    plCatShow/plWelcomeGo route 'book';
 *  - the welcome panel points at the three purposes;
 *  - Channel Connections renders the search-directory group and the
 *    client knows the three directory channels;
 *  - the public homepage presents the three purposes (hero,
 *    purposes section, how-it-works steps, channels band);
 *  - the how-it-works page frames the three purposes, maps the four
 *    promo topics in, and carries the directory channels honestly;
 *  - no stale two-category framing survives in customer copy;
 *  - the staff system map describes three purposes (no "booking is
 *    not a category" contradiction);
 *  - sibling-build markers survive (Guide, Create Account, Camera).
 *
 * Usage: node test/pepper-lists-purposes.test.mjs
 * Exit code 0 = every check passed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('../../web/pepper-lists-site/', import.meta.url));
const apiRoot = fileURLToPath(new URL('../src/', import.meta.url));
const home = readFileSync(`${webRoot}index.html`, 'utf8');
const how = readFileSync(`${webRoot}how-it-works/index.html`, 'utf8');
const systemMap = readFileSync(`${apiRoot}data/systemMap.js`, 'utf8');

let failures = 0;
function check(label, ok) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
}
const has = (text, needle) => text.includes(needle);

// ── Signed-in purpose hubs ────────────────────────────────────────
check('hub section present (#plCats)', has(home, 'id="plCats"'));
check('hub heading: Three purposes', has(home, 'Three purposes,'));
check('Sell door present', has(home, 'id="plCatBtn-sell"'));
check('Post door present', has(home, 'id="plCatBtn-post"'));
check('Book door present', has(home, 'id="plCatBtn-book"'));
check('Sell panel present', has(home, 'id="plCatPanel-sell"'));
check('Post panel present', has(home, 'id="plCatPanel-post"'));
check('Book panel present', has(home, 'id="plCatPanel-book"'));
check('plCatShow routes book', has(home, "['sell','post','book']"));
check('Book panel: web form first', has(home, 'Book a repair — web form'));
check('Book panel: Speedy AI booking', has(home, 'Book with Speedy AI'));
check('Book panel: summary-confirm gate named', has(home, 'summary-confirm gate'));
check('Book panel: Track My Tech door', has(home, 'https://topspeedserviceos.com/track'));
check('Book panel: my bookings door', has(home, 'My bookings — customer app'));
check('Post panel: directories door to channels', has(home, 'Connect posting channels &amp; directories'));
check('Post panel: camera post entry', has(home, 'Post a photo with your camera'));
check('Sell panel: camera entry intact', has(home, 'List with your camera'));

// ── Welcome panel → three purposes ────────────────────────────────
check('welcome panel present (#plWelcome)', has(home, 'id="plWelcome"'));
check('welcome names three purposes', has(home, 'Pepper Lists has three purposes'));
check('welcome Book button', has(home, "plWelcomeGo('book')"));
check('welcomeGo routes book', has(home, "dest==='book'?'book':'sell'"));
check('signup form intact (#plUpForm)', has(home, 'id="plUpForm"'));

// ── Channel Connections: search directories ───────────────────────
check('directories group grid (#plchDirs)', has(home, 'id="plchDirs"'));
check('directories group heading', has(home, 'Be found on — search directories'));
check('client knows GOOGLE_BUSINESS', has(home, 'GOOGLE_BUSINESS'));
check('client knows BING_PLACES', has(home, 'BING_PLACES'));
check('client knows SEARCH_DIRECTORIES', has(home, 'SEARCH_DIRECTORIES'));
check('loader routes directories to their group', has(home, 'PLCH_DIRECTORIES'));
check('channels section intact (#plChannels)', has(home, 'id="plChannels"'));

// ── Public homepage: three purposes ───────────────────────────────
check('hero: three purposes', has(home, 'Sell it. Post it. Book it. One app, three purposes.'));
check('purposes section heading', has(home, 'Three purposes, <span class="lime">one app</span>'));
check('public Book card present', has(home, '<h3>Pepper Lists Book</h3>'));
check('public Post card names directories', has(home, 'Be found in search:'));
check('how-it-works steps: Posting group', has(home, 'Posting — three steps to being found'));
check('channels band names Google Business Profile', has(home, 'Google Business Profile · Bing Places · more search directories'));
check('FAQ: Book is one of three purposes', has(home, "Book is one of Pepper Lists' three purposes"));

// ── How-it-works page ─────────────────────────────────────────────
check('how: purposes strip present', has(how, 'id="purposes"'));
check('how: Purpose 1 · Sell', has(how, 'Purpose 1 · Sell'));
check('how: Purpose 2 · Post', has(how, 'Purpose 2 · Post'));
check('how: Purpose 3 · Book', has(how, 'Purpose 3 · Book'));
check('how: Book states form-first', has(how, 'the classic web form first'));
check('how: directory card — Google Business Profile', has(how, '<h3>Google Business Profile</h3>'));
check('how: directory card — Bing Places', has(how, '<h3>Bing Places</h3>'));
check('how: honest box counts thirteen channels', has(how, 'all thirteen channels'));
check('how: Facebook topic intact (Sell)', has(how, 'id="facebook"'));
check('how: Marketplace topic intact (Sell)', has(how, 'id="marketplace"'));
check('how: seller app topic intact', has(how, 'id="seller-app"'));
check('how: Muse agent topic intact', has(how, 'id="agent"'));

// ── No stale two-category framing in customer copy ────────────────
check('home: no "Two categories" copy', !has(home, 'Two categories'));
check('home: no "Category 1" door label', !has(home, 'Category 1'));
check('home: no "Category 2" door label', !has(home, 'Category 2'));
check('how: no "Two categories" copy', !has(how, 'Two categories'));
check('how: no "both sides" framing', !has(how, 'both sides'));

// ── System map: three purposes, no contradiction ──────────────────
check('systemMap: pepper-lists entry says three purposes', has(systemMap, 'exactly three purposes'));
check('systemMap: no "Booking is not a Pepper Lists category"', !has(systemMap, 'Booking is not a Pepper Lists category'));
check('systemMap: channels entry names search directories', has(systemMap, 'the search directories (Google Business Profile, Bing Places'));

// ── Sibling builds intact ─────────────────────────────────────────
check('camera module include intact', has(home, '/pepper-lists-site/pl-camera.js'));
check('guide script include intact', has(home, '/speedy-guide.js'));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
