/* Top Speed — Honest Cost-Structure Estimator (A4, 2026-11-20).
 *
 * A picker for the flagship service pages: choose an appliance, a
 * service type, and home-or-business, and the panel shows the LOCKED
 * Launch Pack price structure — the same figures the booking wizard's
 * "What it costs — before you confirm" panel carries:
 *   $99 residential diagnostic (collected at booking, credited in
 *   full toward an approved repair, still due if you decline),
 *   $210 flat repair labor, $150 flat installation labor, and parts &
 *   materials priced on the written quote.
 * It NEVER computes a total and NEVER shows a range: parts are the
 * only variable, and they are priced in writing before work begins.
 * Commercial work is custom-quoted — the commercial panel carries no
 * prices at all. Every panel ends at the classic booking form (/book),
 * the form-first path.
 *
 * Mount: <div data-cost-estimator></div> + this script (defer).
 * The pure renderer is exposed as window.TSCostEstimator.render(sel)
 * for the verification harness.
 */
(function () {
  'use strict';

  var APPLIANCES = [
    'Refrigerator',
    'Washer',
    'Dryer',
    'Oven & Range',
    'Dishwasher',
    'Freezer & Ice Maker',
    'Microwave',
    'Garbage Disposal',
  ];

  function rowsFor(sel) {
    if (sel.customer === 'business') return [];
    if (sel.service === 'install') {
      return [
        { label: 'Installation labor', detail: 'Flat rate — the same for every home install', amount: '$150' },
        { label: 'Parts & materials', detail: 'Priced on your written quote, never a surprise', amount: 'On quote' },
        { label: 'Written quote', detail: 'No work starts without your approved written quote', amount: 'Always' },
        { label: 'Warranty', detail: 'Parts & labor warranty, in writing', amount: '90 days' },
      ];
    }
    return [
      { label: 'Diagnostic', detail: 'Collected at booking; credited in full toward an approved repair; still due if you decline the repair', amount: '$99' },
      { label: 'Repair labor', detail: 'Flat rate, no hourly meter', amount: '$210' },
      { label: 'Parts & materials', detail: 'Priced on your written quote, never a surprise', amount: 'On quote' },
      { label: 'Written quote', detail: 'No work starts without your approved written quote', amount: 'Always' },
      { label: 'Warranty', detail: 'Parts & labor warranty, in writing', amount: '90 days' },
    ];
  }

  function render(sel) {
    sel = sel || {};
    var appliance = APPLIANCES.indexOf(sel.appliance) >= 0 ? sel.appliance : APPLIANCES[0];
    var service = sel.service === 'install' ? 'install' : 'repair';
    var customer = sel.customer === 'business' ? 'business' : 'home';
    var h = '';
    if (customer === 'business') {
      h += '<div class="tsest-head">Commercial pricing — custom quote</div>';
      h += '<p class="tsest-note">Commercial service is priced by <b>custom quote</b>. Every commercial job is scoped first, and you get the full price in a written quote before any work begins — the price you approve is the price you pay. One account covers every location you run.</p>';
      h += '<div class="tsest-cta"><a class="tsest-btn" href="/book">Request a commercial quote</a>';
      h += '<a class="tsest-call" href="tel:+18444607038">or call (844) 460-7038</a></div>';
      return h;
    }
    var rows = rowsFor({ appliance: appliance, service: service, customer: customer });
    h += '<div class="tsest-head">What ' + (service === 'install' ? 'installing' : 'repairing') + ' your ' + appliance.toLowerCase() + ' costs — the full structure, before you book</div>';
    h += '<div class="tsest-rows">';
    for (var i = 0; i < rows.length; i++) {
      h += '<div class="tsest-row"><span><b>' + rows[i].label + '</b> — ' + rows[i].detail + '</span><b class="tsest-amt">' + rows[i].amount + '</b></div>';
    }
    h += '</div>';
    h += '<p class="tsest-note">No hidden total and no surprises: parts are the only variable, and they are priced in writing before any work begins. '
      + (service === 'install'
        ? 'Booking a repair instead? Switch the service type above — repairs run on the diagnostic + flat labor structure.'
        : 'Your Service Setter confirms the appointment by phone before dispatch, and you follow the visit live in Track My Tech.')
      + '</p>';
    h += '<div class="tsest-cta"><a class="tsest-btn" href="/book">Book a service visit</a>';
    h += '<a class="tsest-call" href="tel:+18444607038">or call (844) 460-7038</a></div>';
    return h;
  }

  var CSS = ''
    + '.tsest{font-family:inherit;color:var(--navy,#0C162B)}'
    + '.tsest-pick{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(170px,100%),1fr));gap:10px;margin-bottom:14px}'
    + '.tsest-pick label{display:block;font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--muted,#5A6B84);margin-bottom:5px}'
    + '.tsest-pick select{width:100%;padding:11px 12px;border:1.5px solid var(--line,#D7DEE9);border-radius:10px;font-size:15px;background:#fff;color:var(--navy,#0C162B);box-sizing:border-box}'
    + '.tsest-out{border:1.5px solid var(--line,#D7DEE9);border-radius:14px;padding:18px;background:var(--card,#fff)}'
    + '.tsest-head{font-weight:800;font-size:17px;line-height:1.35;margin-bottom:10px}'
    + '.tsest-rows{display:grid;gap:0}'
    + '.tsest-row{display:flex;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid var(--line,#E4EAF2);font-size:14.5px;line-height:1.45}'
    + '.tsest-row:last-child{border-bottom:0}'
    + '.tsest-amt{white-space:nowrap;color:var(--navy,#0C162B)}'
    + '.tsest-note{font-size:13.5px;color:var(--muted,#5A6B84);line-height:1.55;margin:12px 0 0}'
    + '.tsest-cta{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:16px}'
    + '.tsest-btn{display:inline-block;background:var(--red,#E94E5C);color:#fff;font-weight:800;font-size:15px;padding:12px 20px;border-radius:999px;text-decoration:none}'
    + '.tsest-call{font-weight:700;font-size:14px;color:var(--blue,#2563EB);text-decoration:none}';

  function pickerHtml() {
    var opts = '';
    for (var i = 0; i < APPLIANCES.length; i++) opts += '<option>' + APPLIANCES[i] + '</option>';
    return '<div class="tsest-pick">'
      + '<div><label>Appliance</label><select data-tsest="appliance">' + opts + '</select></div>'
      + '<div><label>Service type</label><select data-tsest="service"><option value="repair">Repair</option><option value="install">Installation</option></select></div>'
      + '<div><label>Home or business</label><select data-tsest="customer"><option value="home">Home (residential)</option><option value="business">Business (commercial)</option></select></div>'
      + '</div><div class="tsest-out" data-tsest-out></div>';
  }

  function mount(el) {
    if (el.getAttribute('data-tsest-mounted')) return;
    el.setAttribute('data-tsest-mounted', '1');
    el.className = (el.className ? el.className + ' ' : '') + 'tsest';
    el.innerHTML = pickerHtml();
    var out = el.querySelector('[data-tsest-out]');
    var sel = { appliance: APPLIANCES[0], service: 'repair', customer: 'home' };
    var draw = function () { out.innerHTML = render(sel); };
    var selects = el.querySelectorAll('select[data-tsest]');
    for (var i = 0; i < selects.length; i++) {
      selects[i].addEventListener('change', function (ev) {
        sel[ev.target.getAttribute('data-tsest')] = ev.target.value;
        draw();
      });
    }
    draw();
  }

  var api = { render: render, rowsFor: rowsFor, APPLIANCES: APPLIANCES };
  if (typeof window !== 'undefined') window.TSCostEstimator = api;

  if (typeof document !== 'undefined' && document.querySelectorAll) {
    if (!document.getElementById('tsest-css')) {
      var style = document.createElement('style');
      style.id = 'tsest-css';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    var start = function () {
      var mounts = document.querySelectorAll('[data-cost-estimator]');
      for (var i = 0; i < mounts.length; i++) mount(mounts[i]);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})();
