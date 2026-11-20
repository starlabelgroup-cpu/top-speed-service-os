/**
 * Pepper Lists Trust & Growth — static page checks (2026-11-20).
 *
 * The API drills live in pepper-lists-trust.test.mjs; this suite only
 * reads the shipped pages and asserts the trust surfaces exist with
 * the honest copy the build promised:
 *  - pepper-lists-site: public listings panel + detail containers,
 *    the Safety & Security center (verified accounts, 2-step,
 *    reporting, the gift-card/wire anti-scam line, real booking
 *    terms), seller dashboard + plans containers, Book panel service
 *    reviews + Sell cross-promo, Sell panel Book cross-promo, the
 *    featured upsell hook, footer Safety link, and the JS wiring to
 *    the real endpoints (no endpoint invented in the page that the
 *    API does not serve);
 *  - ad-studio: the Pepper Lists seller plans admin section wired to
 *    the /pepper-lists/admin endpoints.
 *
 * No server, no database. Exit code 0 = every check passed.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

let passed = 0; let failed = 0;
function check(label, cond) {
  if (cond) passed += 1; else failed += 1;
  console.log(`${cond ? '  ok ' : '  FAIL'} ${label}`);
}

const site = await readFile(fileURLToPath(new URL('../../web/pepper-lists-site/index.html', import.meta.url)), 'utf8');
const studio = await readFile(fileURLToPath(new URL('../../web/ad-studio/index.html', import.meta.url)), 'utf8');

console.log('\n[pepper-lists-site: listings + trust]');
check('listings section exists', site.includes('id="listings"'));
check('feed container exists', site.includes('id="pltFeed"'));
check('honest empty-feed state exists', site.includes('id="pltFeedEmpty"') && site.includes('No listings are live right now'));
check('detail container exists', site.includes('id="pltDetail"'));
check('feed reads the public listings endpoint', site.includes('/pepper-lists/listings/public'));
check('comments post to the real endpoint', site.includes('/comments') && site.includes('pltPostComment'));
check('report flow wired', site.includes('pltReport()') && site.includes('/report'));
check('seller badges render conditionally (email verified)', site.includes('Email verified') && site.includes('b.emailVerified'));
check('seller badges render conditionally (2-step)', site.includes('2-step on') && site.includes('b.twoStepOn'));
check('member-since badge wired', site.includes('Member since'));
check('zero-review honest state on seller view', site.includes('No reviews yet for this seller'));
check('safety panel anti-scam line on detail', site.includes('Pepper Lists will never ask you to pay by gift card or wire transfer'));
check('storefront opener wired', site.includes('pltOpenStorefront'));

console.log('\n[pepper-lists-site: safety center]');
check('safety section exists', site.includes('id="safety"'));
check('safety explains verified accounts', site.includes('Verified accounts'));
check('safety explains 2-step sign-in', site.includes('2-step sign-in'));
check('safety explains reporting', site.includes('Reporting works'));
check('safety carries the gift-card/wire warning', (site.match(/gift card or wire/g) || []).length >= 2);
check('safety states real booking terms ($99 diagnostic)', site.includes('residential diagnostic is $99'));
check('safety states flat labor/install truth', site.includes('flat $210') && site.includes('flat $150'));
check('safety never promises escrow', !/escrow/i.test(site));
check('footer links Safety & Security', site.includes('href="#safety"'));

console.log('\n[pepper-lists-site: book panel + cross-promotion]');
check('book panel service reviews container', site.includes('id="pltBookReviews"'));
check('book reviews read the real reviews store', site.includes('/pepper-lists/reviews/public'));
check('book reviews honest empty line', site.includes('No reviews yet — real reviews from real repairs'));
check('book -> sell cross-promo present', site.includes('Sell your old appliance'));
check('sell -> book cross-promo present', site.includes('Need it repaired instead? Book a service visit'));
check('cross-promo links the real booking form', site.includes('https://topspeedserviceos.com/book'));

console.log('\n[pepper-lists-site: seller dashboard + plans]');
check('seller dashboard section exists', site.includes('id="plSeller"'));
check('my listings container', site.includes('id="pltMine"'));
check('reviewable sales container', site.includes('id="pltReviewable"'));
check('analytics container', site.includes('id="pltAnalytics"'));
check('plans container', site.includes('id="pltPlans"'));
check('plans read the real endpoint', site.includes('/pepper-lists/plans'));
check('unpriced plans say pricing coming soon', site.includes('Pricing coming soon — ask us'));
check('checkout wired', site.includes('/pepper-lists/plans/checkout'));
check('mark-sold wired', site.includes('/sold'));
check('featured upsell hook on the success box', site.includes('plt-upsell') && site.includes('plSellDone'));
check('dashboard never fabricates a price', !site.includes('pltMoney(p.priceCents)'));

console.log('\n[ad-studio: seller plans admin]');
check('seller plans section exists', studio.includes('Pepper Lists seller plans'));
check('seller plans rows container', studio.includes('id="sellerPlansRows"'));
check('admin reads /pepper-lists/admin/plans', studio.includes('/pepper-lists/admin/plans'));
check('admin price route wired', studio.includes('/price'));
check('admin grant wired', studio.includes('/pepper-lists/admin/seller-subscriptions/grant'));
check('admin revoke wired', studio.includes('/pepper-lists/admin/seller-subscriptions/revoke'));
check('admin loads with the studio', studio.includes('loadSellerPlansAdmin()'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
