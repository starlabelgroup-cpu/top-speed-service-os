/**
 * Staff alert deep-link drills (2026-11-23, Rule 1 completion).
 *
 * Every staff alert email (STAFF_SUBMISSION_ALERT to the business
 * inbox) used to end with "Review it here:" pointing at a bare
 * console home (/book-os, /crm, /portal, /notifications,
 * /cococane-express). Rule 1 (Ramone, 2026-11-22): a link lands on
 * the page for THAT record. The fix lives in
 * services/notifications.js: notifyStaffAlert emits its management
 * report first (same event key, deduped) and composes the link via
 * staffAlertConsoleLink — per-record console views where they exist
 * (Book OS job detail / intake / video / referrals, CRM pipeline,
 * Notifications outbox entry, CocoCane order card), and the report's
 * own detail view in the Manager feed where no per-record console
 * view exists (provider applications, PM leads, advertiser/agency
 * intakes, account registrations, PM batch requests).
 *
 * These drills run at the service level in SKELETON MODE (no
 * DATABASE_URL): they call the real notify entry points with
 * fixtures and read the queued outbox entries + department reports
 * back from the in-memory store. No email is sent (providers are
 * unconfigured; entries stay in the outbox with their payloads).
 *
 * Usage: node test/staff-alert-links.test.mjs
 * Exit code 0 = every check passed.
 */
import { store } from '../src/data/store.js';
import {
  STAFF_ALERT_EMAIL,
  notifyStaffAlert,
  notifySubmission,
  notifyNewBooking,
  notifyAccountCreated,
  staffAlertConsoleLink,
} from '../src/services/notifications.js';

let passed = 0;
let failed = 0;
function check(name, condition, extra = '') {
  if (condition) { passed += 1; console.log(`  ok — ${name}`); }
  else { failed += 1; console.log(`  FAIL — ${name}${extra ? ` (${extra})` : ''}`); }
}

function staffEmailFor(eventKeyBase) {
  return store.notificationOutbox.find(
    (e) => e.template === 'STAFF_SUBMISSION_ALERT' && e.channel === 'email' && e.eventKey === `${eventKeyBase}:staff:email`,
  );
}
function linkOf(entry) {
  const match = /Review it here: (\S+)/.exec(entry?.payload?.message || '');
  return match ? match[1] : null;
}
function reportFor(eventKeyBase) {
  return store.departmentReports.find((r) => r.eventKey === `${eventKeyBase}:report`);
}

/* 1 — New booking: Book OS job record view. */
const booking = {
  id: 'bk-test-1',
  referenceCode: 'TS-DRLBK1',
  customer: { name: 'Drill Customer', phone: '9545550100', email: 'drill@example.com' },
  appliance: 'Refrigerator',
  issue: 'Not cooling',
  city: 'Lauderhill',
  status: 'PENDING_DISPATCH',
  preferredWindow: 'Morning',
  attribution: { page: '/book', via: null, utmSource: null },
};
notifyNewBooking(booking, 'DRILL');
const bookingMail = staffEmailFor('booking:bk-test-1');
check('booking alert queued to the business inbox', !!bookingMail && bookingMail.to === STAFF_ALERT_EMAIL);
check('booking alert subject unchanged', bookingMail?.payload?.subject === 'New booking — TS-DRLBK1', bookingMail?.payload?.subject);
check('booking link opens the Book OS job record', linkOf(bookingMail) === 'https://topspeedserviceos.com/book-os?booking=TS-DRLBK1', linkOf(bookingMail));

/* 2 — Terminal payment reconciliation: same booking view. */
notifyStaffAlert({
  kind: 'TERMINAL_PAYMENT', kindLabel: 'tap-to-pay payment needing reconciliation',
  reference: 'TS-DRLBK1', consolePath: '/book-os', source: 'DRILL', eventKeyBase: 'drill:terminal',
});
check('terminal payment link opens the booking', linkOf(staffEmailFor('drill:terminal')) === 'https://topspeedserviceos.com/book-os?booking=TS-DRLBK1', linkOf(staffEmailFor('drill:terminal')));

/* 3 — Voicemail: the Notifications outbox entry itself. */
notifyStaffAlert({
  kind: 'VOICEMAIL', kindLabel: 'voicemail', reference: 'VM-DRL1234',
  consolePath: '/notifications', source: 'DRILL', eventKeyBase: 'drill:voicemail',
});
check('voicemail link opens the outbox entry', linkOf(staffEmailFor('drill:voicemail')) === 'https://topspeedserviceos.com/notifications?ref=VM-DRL1234', linkOf(staffEmailFor('drill:voicemail')));

/* 4 — After-hours message: Book OS intake record. */
notifyStaffAlert({
  kind: 'AFTER_HOURS_MESSAGE', kindLabel: 'after-hours phone message', reference: 'TS-DRLAH1',
  consolePath: '/book-os', source: 'DRILL', eventKeyBase: 'drill:afterhours',
});
check('after-hours link opens the intake record', linkOf(staffEmailFor('drill:afterhours')) === 'https://topspeedserviceos.com/book-os?intake=TS-DRLAH1', linkOf(staffEmailFor('drill:afterhours')));

/* 5 — Referral reward: Book OS referrals queue (was /portal). */
notifyStaffAlert({
  kind: 'REFERRAL_REWARD', kindLabel: 'referral reward pending approval', reference: 'TS-DRLBK1',
  consolePath: '/portal', source: 'DRILL', eventKeyBase: 'drill:referral',
});
check('referral reward link opens Book OS referrals', linkOf(staffEmailFor('drill:referral')) === 'https://topspeedserviceos.com/book-os?ref=TS-DRLBK1', linkOf(staffEmailFor('drill:referral')));

/* 6 — Account registration: the report detail (no per-account
      console view exists for a new signup; /portal was a sign-in
      door). The link must carry the emitted report's own id. */
const user = { id: 'user-drill-1', email: 'newdrill@example.com', phone: '9545550101', firstName: 'New', lastName: 'Drill', roles: ['CUSTOMER'] };
notifyAccountCreated(user, 'DRILL');
const regMail = staffEmailFor('account:user-drill-1');
const regReport = reportFor('account:user-drill-1');
check('registration emitted exactly one report', !!regReport);
check('registration link opens that report', !!regReport && linkOf(regMail) === `https://topspeedserviceos.com/manager?report=${regReport.id}`, linkOf(regMail));

/* 7 — Submission kinds through notifySubmission. */
function submissionMail(kind, reference) {
  notifySubmission({ kind, reference, submitter: { name: 'Drill Submitter', phone: '9545550102', email: 'sub@example.com' }, lines: ['Drill line'], source: 'DRILL' });
  return staffEmailFor(`submission:${reference}`);
}
check('service request link opens the CRM pipeline card',
  linkOf(submissionMail('SERVICE_REQUEST', 'TS-DRLSR1')) === 'https://topspeedserviceos.com/crm?ref=TS-DRLSR1');
check('commercial work order link opens the CRM pipeline card',
  linkOf(submissionMail('COMMERCIAL_WORK_ORDER', 'TS-DRLCW1')) === 'https://topspeedserviceos.com/crm?ref=TS-DRLCW1');
check('PM walkthrough link opens the CRM pipeline card',
  linkOf(submissionMail('PM_WALKTHROUGH_REQUEST', 'TS-DRLPW1')) === 'https://topspeedserviceos.com/crm?ref=TS-DRLPW1');
check('Pepper Lists scan link opens the CRM pipeline card',
  linkOf(submissionMail('PEPPER_LISTS_SCAN', 'TS-DRLPS1')) === 'https://topspeedserviceos.com/crm?ref=TS-DRLPS1');
check('Pepper Lists listing link opens the Book OS intake record',
  linkOf(submissionMail('PEPPER_LISTS_SELL', 'TS-DRLPL1')) === 'https://topspeedserviceos.com/book-os?intake=TS-DRLPL1');
check('video request link opens the Book OS video panel item',
  linkOf(submissionMail('VIDEO_REQUEST', 'vid-drill-1')) === 'https://topspeedserviceos.com/book-os?video=vid-drill-1');
check('CocoCane order link opens the order card',
  linkOf(submissionMail('COCOCANE_ORDER', 'TS-DRLCC1')) === 'https://topspeedserviceos.com/cococane-express?order=TS-DRLCC1');
check('CocoCane wholesale link opens the order card',
  linkOf(submissionMail('COCOCANE_WHOLESALE', 'TS-DRLCC2')) === 'https://topspeedserviceos.com/cococane-express?order=TS-DRLCC2');

/* 8 — Report-linked submission kinds: the link carries the id of
      the report the same event emitted. */
for (const [kind, reference] of [
  ['PROVIDER_APPLICATION', 'TS-DRLPA1'],
  ['PM_LEAD', 'TS-DRLPM1'],
  ['ADVERTISER_CONTACT', 'TS-DRLAD1'],
  ['MARKETING_AGENCY_INTAKE', 'TS-DRLMA1'],
  ['PM_SERVICE_REQUEST', 'TS-DRLBT1'],
]) {
  const mail = submissionMail(kind, reference);
  const report = reportFor(`submission:${reference}`);
  check(`${kind} emitted its report`, !!report);
  check(`${kind} link opens that report in Manager`, !!report && linkOf(mail) === `https://topspeedserviceos.com/manager?report=${report.id}`, linkOf(mail));
}

/* 9 — Free-form submission kind (public intake accepts any type):
      the record is a connection, listed in Book OS intake. */
check('unknown submission kind link opens the intake record',
  linkOf(submissionMail('GENERAL_INQUIRY', 'TS-DRLGI1')) === 'https://topspeedserviceos.com/book-os?intake=TS-DRLGI1');

/* 10 — One event, one report, stable link: re-firing the same
       event key must not mint a second report. */
const before = store.departmentReports.filter((r) => r.eventKey === 'submission:TS-DRLSR1:report').length;
notifySubmission({ kind: 'SERVICE_REQUEST', reference: 'TS-DRLSR1', submitter: { name: 'Drill Submitter' }, source: 'DRILL' });
const after = store.departmentReports.filter((r) => r.eventKey === 'submission:TS-DRLSR1:report').length;
check('re-fired event reuses its report (no duplicate)', before === 1 && after === 1, `${before} -> ${after}`);

/* 11 — Link builder edges: no reference and no report keeps the
       caller's console path (previous behavior as last resort). */
check('builder falls back to consolePath when nothing is known',
  staffAlertConsoleLink({ kind: 'BOOKING', reference: null, consolePath: '/book-os', reportId: null }) === '/book-os');
check('builder falls back to the report when a kind has no record view and no reference',
  staffAlertConsoleLink({ kind: 'PROVIDER_APPLICATION', reference: null, consolePath: '/crm', reportId: 'rep-1' }) === '/manager?report=rep-1');
check('builder encodes the reference',
  staffAlertConsoleLink({ kind: 'BOOKING', reference: 'TS A/1', consolePath: '/book-os', reportId: null }) === '/book-os?booking=TS%20A%2F1');

console.log(`\nstaff-alert-links: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
