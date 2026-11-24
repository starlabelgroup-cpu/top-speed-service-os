/* Top Speed Service OS — Book by ZIP wizard (2026-11-23).
 *
 * The super-advanced stepped booking form: Location → Appliance →
 * Details → Schedule. It collects EXACTLY the fields the classic web
 * form collects and posts to the SAME endpoint (POST /speedy/book)
 * with the same payload shape — plus the Book by Location geo fields
 * when the customer used "Use my location". Step 1 answers from the
 * platform's own area model via GET /geo/zip + GET /geo/cities +
 * POST /geo/match, so the form can never promise an area the backend
 * would not resolve the same way; the backend's resolveArea stays
 * authoritative at submit. Honesty rules: no review counts, no star
 * ratings, no warranty-plan question (Top Speed has no such program).
 * Form-first: the wizard IS the form; the pages' Ask Speedy option
 * stays below it as the secondary path. Mounts: [data-tsos-zip-booking]
 * (data-photo="1" adds the homepage's Speedy photo read to Step 2). */
(function () {
  'use strict';
  var API = 'https://top-speed-service-os.vercel.app/api/v1';
  var STYLE_ID = 'tsos-zip-booking-css';
  var STAGES = ['Location', 'Appliance', 'Details', 'Schedule'];
  var CORE_FALLBACK = ['Lauderhill', 'Plantation', 'Sunrise', 'Tamarac', 'Fort Lauderdale', 'Lauderdale Lakes', 'North Lauderdale', 'Davie', 'Coral Springs', 'Pompano Beach', 'Oakland Park', 'Margate'];
  var WINDOWS = [
    { v: '08-10', label: '8\u201310 AM' }, { v: '10-12', label: '10 AM\u201312 PM' },
    { v: '12-14', label: '12\u20132 PM' }, { v: '14-16', label: '2\u20134 PM' },
    { v: '16-18', label: '4\u20136 PM' }
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function svgIcon(inner) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }
  var PIN = svgIcon('<path d="M12 21.2S5 15.6 5 9.9a7 7 0 0 1 14 0c0 5.7-7 11.3-7 11.3z"/><circle cx="12" cy="9.9" r="2.6" stroke="#E8322E"/><circle cx="12" cy="9.9" r=".9" fill="#E8322E" stroke="none"/>');
  var CHECK = svgIcon('<path d="M4 12.8l5.2 5.2L20 6.8"/>');
  var PHONE = svgIcon('<path d="M5.2 4h3.4l1.4 4.2-2.1 1.7a13.5 13.5 0 0 0 6.2 6.2l1.7-2.1L20 15.4v3.4a2 2 0 0 1-2.1 2A16.5 16.5 0 0 1 3.2 6.1 2 2 0 0 1 5.2 4z"/>');
  var CAMERA = svgIcon('<rect x="3" y="7" width="18" height="13" rx="2.5"/><circle cx="12" cy="13.5" r="3.4"/><path d="M8.6 7l1.2-2.3h4.4L15.4 7" stroke="#E8322E"/>');
  /* The platform's designed appliance icons — the same set the
     classic form's tiles carry. */
  var APPLIANCES = [
    { v: 'Refrigerator', icon: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M5 9.5h14" stroke="#E8322E"/><path d="M8 6.2v1M8 12.6v3.2" stroke-width="2.2"/>' },
    { v: 'Washer', icon: '<path d="M12 12a2 2 0 1 1 2 2 4 4 0 1 1-4-4 6.2 6.2 0 1 1 6.2 6.2" stroke="#E8322E"/><circle cx="12" cy="12" r=".9" fill="#E8322E" stroke="none"/>' },
    { v: 'Dryer', icon: '<path d="M8.5 4L3.8 7l1.7 3.2 2-1v11h9v-11l2 1L20.2 7 15.5 4a3.5 3.5 0 0 1-7 0z"/><path d="M9.8 13.2h4.4" stroke="#E8322E"/>' },
    { v: 'Oven / Range', icon: '<path d="M12 3.5c.8 3-1.6 4.6-2.9 6.1C7.7 11.2 7 12.6 7 14.2A5 5 0 0 0 17 14.2c0-1.2-.5-2.3-1.1-3.3-.5 1-1.2 1.7-2.1 2.1.3-2.7-.4-6.4-1.8-9.5z"/><path d="M12 20.2a2.6 2.6 0 0 1-2.6-2.6c0-1 .5-1.8 1.1-2.5.5-.6 1-1.2 1.5-2 .5.8.9 1.4 1.4 2 .6.7 1.1 1.5 1.1 2.5A2.6 2.6 0 0 1 12 20.2z" stroke="#E8322E"/>' },
    { v: 'Dishwasher', icon: '<path d="M6.5 3.5v6M4.2 3.5v3.4a2.3 2.3 0 0 0 4.6 0V3.5M6.5 9.5V20.5" transform="translate(.4 0)"/><path d="M17.2 3.5c1.8 1.4 2.6 3.8 2.6 6 0 2-1 3-2.6 3v8" stroke="#E8322E"/>' },
    { v: 'Freezer / Ice Maker', icon: '<path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9M12 3l-2 2.2M12 3l2 2.2M12 21l-2-2.2M12 21l2-2.2" stroke="#E8322E"/>' },
    { v: 'Microwave', icon: '<path d="M7 20.5c-1.4-2.3 1.4-3.6 0-5.9M12 20.5c-1.4-2.3 1.4-3.6 0-5.9M17 20.5c-1.4-2.3 1.4-3.6 0-5.9" stroke="#E8322E"/><path d="M8.2 9.6c-1-1.8.8-2.8.4-4.6M12.4 9.6c-1-1.8.8-2.8.4-4.6M16.6 9.6c-1-1.8.8-2.8.4-4.6" opacity=".75"/>' },
    { v: 'Garbage Disposal', icon: '<path d="M4.5 6.5h15M9.5 6V4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 6.5l1 13a2 2 0 0 0 2 1.8h5a2 2 0 0 0 2-1.8l1-13"/><path d="M10 10.5v6M14 10.5v6" stroke="#E8322E"/>' },
    { v: 'Installation', icon: '<path d="M14.7 6.3a4.4 4.4 0 0 1 5.9-4L18 4.9l2.3 2.3 2.7-2.6a4.4 4.4 0 0 1-5.9 5.2L8 18.9a2 2 0 0 1-2.9 0l-1.2-1.2a2 2 0 0 1 0-2.9z" transform="translate(-1.2 .6) scale(.94)"/>' }
  ];

  var CSS = [
    '.zbw{box-sizing:border-box;max-width:100%;background:#fff;border:1px solid #dbe4f0;border-radius:18px;padding:20px;color:#0d1b2e;font-size:15px;line-height:1.5;text-align:left}',
    '.zbw *{box-sizing:border-box}',
    '.zbw-stages{display:flex;gap:6px;margin:0 0 6px;padding:0;list-style:none}',
    '.zbw-stages li{flex:1;min-width:0}',
    '.zbw-stages .bar{height:5px;border-radius:99px;background:#e3eaf4;margin-bottom:7px}',
    '.zbw-stages li.done .bar{background:#177245}',
    '.zbw-stages li.now .bar{background:#E8322E}',
    '.zbw-stages .lab{display:flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:#8fa1bb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.zbw-stages li.now .lab{color:#0A265C}',
    '.zbw-stages li.done .lab{color:#177245}',
    '.zbw-stages .lab svg{width:13px;height:13px;flex:none}',
    '.zbw h3{font-size:21px;margin:12px 0 4px;color:#0A265C;line-height:1.25}',
    '.zbw .sub{color:#5b6b87;margin:0 0 14px;font-size:14.5px}',
    '.zbw label{display:block;font-weight:700;font-size:13.5px;color:#0A265C;margin:14px 0 6px}',
    '.zbw input[type="text"],.zbw input[type="tel"],.zbw input[type="email"],.zbw input[type="date"],.zbw select,.zbw textarea{width:100%;padding:12px 13px;border:1.5px solid #dbe4f0;border-radius:12px;font:inherit;font-size:15px;background:#fff;color:#0d1b2e}',
    '.zbw textarea{min-height:84px;resize:vertical}',
    '.zbw input:focus,.zbw select:focus,.zbw textarea:focus{outline:2px solid #19A7FF;outline-offset:1px;border-color:#19A7FF}',
    '.zbw .zb-locbtn{display:inline-flex;align-items:center;gap:8px;margin-top:12px;background:#0A265C;color:#fff;border:none;border-radius:999px;padding:11px 18px;font:inherit;font-weight:800;font-size:14.5px;cursor:pointer}',
    '.zbw .zb-locbtn svg{width:17px;height:17px}',
    '.zbw .zb-locbtn[disabled]{opacity:.6;cursor:wait}',
    '.zbw .zb-skip{display:inline-block;margin-top:12px;background:none;border:none;font:inherit;font-size:14px;font-weight:700;color:#0A265C;text-decoration:underline;cursor:pointer;padding:4px 2px}',
    '.zbw .zb-note{border-radius:12px;padding:12px 14px;margin-top:14px;font-size:14.5px;display:none}',
    '.zbw .zb-note.show{display:block}',
    '.zbw .zb-note.ok{background:#eef7f1;border:1px solid #bfe3cd;color:#14532d}',
    '.zbw .zb-note.warn{background:#fdf6e3;border:1px solid #ecd9a0;color:#5f4b00}',
    '.zbw .zb-note.out{background:#f2f5fa;border:1px solid #dbe4f0;color:#33465e}',
    '.zbw .zb-note b{color:inherit}',
    '.zbw .zb-call{display:inline-flex;align-items:center;gap:7px;margin-top:10px;background:#E8322E;color:#fff;border-radius:999px;padding:10px 16px;font-weight:800;font-size:14px;text-decoration:none}',
    '.zbw .zb-call svg{width:16px;height:16px}',
    '.zbw .zb-pick{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}',
    '.zbw .zb-pick button{border:1.5px solid #0A265C;background:#fff;color:#0A265C;border-radius:999px;padding:8px 14px;font:inherit;font-weight:700;font-size:14px;cursor:pointer}',
    '.zbw .zb-pick button.on{background:#0A265C;color:#fff}',
    '.zbw .zb-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:6px}',
    '.zbw .zb-tile{display:flex;flex-direction:column;align-items:center;gap:5px;padding:13px 6px;border:1.5px solid #dbe4f0;border-radius:13px;background:#fff;font:inherit;font-size:13.5px;font-weight:700;color:#0A265C;cursor:pointer;text-align:center}',
    '.zbw .zb-tile svg{width:26px;height:26px}',
    '.zbw .zb-tile.on{border-color:#E8322E;background:#fdf0ef;box-shadow:0 0 0 1px #E8322E inset}',
    '@media(max-width:380px){.zbw .zb-tiles{grid-template-columns:repeat(2,1fr)}}',
    '.zbw .zb-wins{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin-top:6px}',
    '.zbw .zb-wins label{margin:0;font-weight:600}',
    '.zbw .zb-wins input{position:absolute;opacity:0;pointer-events:none}',
    '.zbw .zb-wins .wc{display:block;text-align:center;padding:11px 4px;border:1.5px solid #dbe4f0;border-radius:12px;font-size:13.5px;font-weight:700;color:#0A265C;cursor:pointer}',
    '.zbw .zb-wins input:checked + .wc{border-color:#E8322E;background:#fdf0ef;box-shadow:0 0 0 1px #E8322E inset}',
    '.zbw .zb-wins input:disabled + .wc{opacity:.45;cursor:not-allowed;text-decoration:line-through}',
    '.zbw .zb-avail{color:#5b6b87;font-size:13px;margin:6px 0 0}',
    '.zbw .zb-review{border:1px solid #dbe4f0;border-radius:12px;padding:6px 14px;margin-top:12px}',
    '.zbw .zb-review .rrow{display:flex;justify-content:space-between;gap:14px;padding:8px 0;border-bottom:1px solid #eef2f8;font-size:14.5px}',
    '.zbw .zb-review .rrow:last-child{border-bottom:none}',
    '.zbw .zb-review .rk{color:#5b6b87;flex:none}',
    '.zbw .zb-review .rv{font-weight:700;color:#0A265C;text-align:right;overflow-wrap:anywhere}',
    '.zbw .zb-price{background:#f2f6fd;border:1px solid #dbe4f0;border-radius:12px;padding:11px 14px;font-size:13.5px;color:#42557a;margin-top:14px;line-height:1.55}',
    '.zbw .zb-price b{color:#0A265C}',
    '.zbw .zb-err{display:none;background:#fdecec;border:1px solid #f3c2c0;color:#8f1d1a;border-radius:12px;padding:11px 14px;margin-top:14px;font-size:14.5px}',
    '.zbw .zb-err.show{display:block}',
    '.zbw .zb-nav{display:flex;gap:10px;margin-top:18px;align-items:stretch}',
    '.zbw .zb-back{background:#fff;border:1.5px solid #dbe4f0;color:#0A265C;border-radius:999px;padding:13px 20px;font:inherit;font-weight:800;font-size:15px;cursor:pointer}',
    '.zbw .zb-next{flex:1;background:#E8322E;color:#fff;border:none;border-radius:999px;padding:14px 22px;font:inherit;font-weight:800;font-size:16.5px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:9px}',
    '.zbw .zb-next svg{width:19px;height:19px}',
    '.zbw .zb-next[disabled]{opacity:.6;cursor:wait}',
    '.zbw .zb-done{text-align:center;padding:10px 4px}',
    '.zbw .zb-done .dic{width:58px;height:58px;border-radius:50%;background:#eef7f1;color:#177245;display:flex;align-items:center;justify-content:center;margin:6px auto 10px}',
    '.zbw .zb-done .dic svg{width:30px;height:30px}',
    '.zbw .zb-done .dic.out{background:#f2f5fa;color:#5b6b87}',
    '.zbw .zb-ref{font-size:29px;font-weight:700;color:#0A265C;letter-spacing:1px;margin:6px 0}',
    '.zbw .zb-donebtns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:14px}',
    '.zbw .zb-donebtns a{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:12px 20px;font-weight:800;font-size:14.5px;text-decoration:none}',
    '.zbw .zb-donebtns a svg{width:17px;height:17px}',
    '.zbw .zb-photo{margin-top:14px;border:1px dashed #c4d2e6;border-radius:12px;padding:13px 14px}',
    '.zbw .zb-photo p{margin:0 0 10px;font-size:13.5px;color:#5b6b87}',
    '.zbw .zb-photobtn{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1.5px solid #0A265C;color:#0A265C;border-radius:999px;padding:10px 16px;font:inherit;font-weight:800;font-size:14px;cursor:pointer}',
    '.zbw .zb-photobtn svg{width:17px;height:17px}',
    '.zbw .zb-photorun{display:none;margin-top:10px;background:#0A265C;color:#fff;border:none;border-radius:999px;padding:10px 16px;font:inherit;font-weight:800;font-size:14px;cursor:pointer}',
    '.zbw .zb-photores{display:none;margin-top:10px;background:#f2f6fd;border:1px solid #dbe4f0;border-radius:12px;padding:11px 13px;font-size:14px}',
    '.zbw .zb-photores p{margin:4px 0 0;color:#33465e}',
    '.zbw .zb-fine{font-size:12.5px;color:#8fa1bb;margin-top:6px;line-height:1.45}'
  ].join('');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function round3(n) { return Math.round(n * 1000) / 1000; }
  function dstr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function dayLabel(v) { try { return new Date(v + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); } catch (e) { return v; } }

  var uidSeq = 0;

  function createWizard(root) {
    var uid = 'zb' + (++uidSeq);
    var withPhoto = root.getAttribute('data-photo') === '1';
    var state = {
      step: 1,
      zip: '', city: '', cityOther: '', areaMode: '', zipAreas: [],
      outside: false, /* honest out-of-area state (geo OUT or city-not-listed) */
      geo: null,
      appliance: '', issue: '', photoDiag: null,
      name: '', phone: '', email: '', address: '', note: '', website: '',
      date: dstr(new Date()), win: '',
      done: null
    };
    var cities = null; /* [{name, county, core}] from /geo/cities */
    var photoData = null, photoBusy = false, zipTimer = null, busy = false;

    function q(sel) { return root.querySelector(sel); }
    function qa(sel) { return [].slice.call(root.querySelectorAll(sel)); }

    function cityOptions(selected, includeOther) {
      var html = '<option value="">Choose your city</option>';
      if (cities) {
        var byCounty = {};
        cities.forEach(function (c) { (byCounty[c.county] = byCounty[c.county] || []).push(c.name); });
        Object.keys(byCounty).sort().forEach(function (county) {
          html += '<optgroup label="' + esc(county) + ' County">';
          byCounty[county].forEach(function (n) {
            html += '<option' + (n === selected ? ' selected' : '') + '>' + esc(n) + '</option>';
          });
          html += '</optgroup>';
        });
      } else {
        CORE_FALLBACK.forEach(function (n) {
          html += '<option' + (n === selected ? ' selected' : '') + '>' + esc(n) + '</option>';
        });
      }
      if (includeOther) html += '<option value="__other__"' + (selected === '__other__' ? ' selected' : '') + '>My city isn\u2019t listed</option>';
      return html;
    }

    function stepperHtml() {
      var html = '<ol class="zbw-stages">';
      STAGES.forEach(function (name, i) {
        var n = i + 1;
        var cls = state.step > n ? 'done' : state.step === n ? 'now' : '';
        html += '<li class="' + cls + '"><div class="bar"></div><div class="lab">' +
          (state.step > n ? CHECK : '') + esc(name) + '</div></li>';
      });
      return html + '</ol>';
    }

    /* ---------- Step 1: Location ---------- */
    function step1Html() {
      var h = '<h3>Tell us where you\u2019re located</h3>' +
        '<p class="sub">Enter your ZIP and we\u2019ll confirm your service area right away.</p>' +
        '<label for="' + uid + '-zip">ZIP code</label>' +
        '<input type="text" id="' + uid + '-zip" data-f="zip" inputmode="numeric" autocomplete="postal-code" placeholder="e.g. 33313" maxlength="5" value="' + esc(state.zip) + '">' +
        '<div><button type="button" class="zb-locbtn" data-act="locate">' + PIN + ' Use my location</button></div>' +
        '<div class="zb-note" data-note></div>' +
        '<div data-cityslot></div>' +
        '<button type="button" class="zb-skip" data-act="skip">Continue without ZIP</button>';
      return h;
    }

    function citySlotHtml() {
      if (state.areaMode === 'PICK') {
        var h = '<label>Your ZIP covers a few of our areas \u2014 pick your city</label><div class="zb-pick">';
        state.zipAreas.forEach(function (a) {
          h += '<button type="button" data-pick="' + esc(a) + '"' + (state.city === a ? ' class="on"' : '') + '>' + esc(a) + '</button>';
        });
        return h + '</div>';
      }
      if (state.areaMode === 'CITY' || state.areaMode === 'MANUAL') {
        return '<label for="' + uid + '-city1">Your city</label>' +
          '<select id="' + uid + '-city1" data-f="citySel">' + cityOptions(state.city === '__other__' ? '__other__' : state.city, true) + '</select>' +
          (state.city === '__other__'
            ? '<label for="' + uid + '-cityo1">City name</label><input type="text" id="' + uid + '-cityo1" data-f="cityOther" placeholder="Your city" value="' + esc(state.cityOther) + '">'
            : '');
      }
      return '';
    }

    function setNote(kind, html) {
      var note = q('[data-note]');
      if (!note) return;
      if (!kind) { note.className = 'zb-note'; note.innerHTML = ''; return; }
      note.className = 'zb-note show ' + kind;
      note.innerHTML = html;
    }

    function refreshAreaUI() {
      var slot = q('[data-cityslot]');
      if (slot) slot.innerHTML = citySlotHtml();
      if (state.outside) {
        setNote('out', '<b>We\u2019re not in your area yet.</b> Top Speed serves 65 cities across Broward, Palm Beach and Miami-Dade. You can still send your details and we\u2019ll record your request \u2014 we just can\u2019t promise service or an appointment window outside our area.' +
          '<br><a class="zb-call" href="tel:+18444607038">' + PHONE + ' Call (844) 460-7038</a>');
      } else if (state.areaMode === 'IN' && state.city) {
        setNote('ok', '<b>We serve your area \u2014 ' + esc(state.city) + '.</b>' +
          (state.geo ? ' Location-verified from your device.' : ''));
      } else if (state.areaMode === 'PICK') {
        setNote('warn', '<b>Almost there.</b> ZIP ' + esc(state.zip) + ' is shared by a few of our service areas \u2014 pick your city below and we\u2019ll confirm coverage.');
      } else if (state.areaMode === 'CITY') {
        setNote('warn', '<b>That ZIP isn\u2019t in our core map.</b> Pick your city below \u2014 if it\u2019s one of the 65 cities we serve, you\u2019re covered.');
      } else if (state.areaMode === 'EDGE') {
        setNote('warn', '<b>You\u2019re near the edge of our coverage</b> \u2014 we\u2019ll confirm when we call. You can book as normal.');
      } else if (state.areaMode === 'MANUAL') {
        setNote('', '');
      }
    }

    function checkZip() {
      var zip = state.zip;
      if (!/^\d{5}$/.test(zip)) return;
      fetch(API + '/geo/zip?zip=' + encodeURIComponent(zip))
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (state.zip !== zip) return; /* the customer kept typing */
          var areas = (j && j.data && j.data.areas) || [];
          state.zipAreas = areas;
          if (areas.length === 1) {
            state.areaMode = 'IN'; state.outside = false;
            if (!state.geo) state.city = areas[0];
            else if (areas.indexOf(state.city) === -1) state.city = areas[0];
          } else if (areas.length > 1) {
            state.areaMode = 'PICK'; state.outside = false;
            if (areas.indexOf(state.city) === -1) state.city = '';
          } else {
            state.areaMode = 'CITY';
          }
          refreshAreaUI();
        })
        .catch(function () { /* offline: Step 3 still collects city + ZIP */ });
    }

    function useLocation() {
      var btn = q('[data-act="locate"]');
      if (!navigator.geolocation) { setNote('warn', 'Location isn\u2019t available on this device \u2014 type your ZIP instead.'); return; }
      if (btn) { btn.disabled = true; btn.innerHTML = PIN + ' Finding you\u2026'; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        var lat = pos.coords.latitude, lng = pos.coords.longitude;
        var geoDone = fetch(API + '/geo/match', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lat: lat, lng: lng })
        }).then(function (r) { return r.json(); }).then(function (j) {
          var d = j && j.data;
          if (!d || !d.tier) return;
          state.geo = {
            geoCity: d.matchedCity || undefined,
            geoTier: d.tier,
            geoLat: round3(lat),
            geoLng: round3(lng)
          };
          window.TSOSGeo = state.geo;
          if (d.tier === 'IN_AREA' && d.matchedCity) { state.city = d.matchedCity; state.areaMode = 'IN'; state.outside = false; }
          else if (d.tier === 'AREA_REVIEW') { if (d.matchedCity) state.city = d.matchedCity; state.areaMode = 'EDGE'; }
          else { state.outside = true; }
        }).catch(function () { /* the ZIP path still works */ });
        var zipDone = fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' + lat + '&lon=' + lng)
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var pc = ((j && j.address && j.address.postcode) || '').slice(0, 5);
            if (/^\d{5}$/.test(pc)) {
              state.zip = pc;
              var zi = q('[data-f="zip"]'); if (zi) zi.value = pc;
            }
          }).catch(function () { /* ZIP can be typed */ });
        Promise.all([geoDone, zipDone]).then(function () {
          if (btn) { btn.disabled = false; btn.innerHTML = PIN + ' Use my location'; }
          /* If the geo tier left the area undecided, let the ZIP speak. */
          if (!state.outside && /^\d{5}$/.test(state.zip) && state.areaMode !== 'IN') checkZip();
          refreshAreaUI();
        });
      }, function () {
        if (btn) { btn.disabled = false; btn.innerHTML = PIN + ' Use my location'; }
        setNote('warn', 'No problem \u2014 location wasn\u2019t shared. Type your ZIP above and we\u2019ll check your area that way.');
      }, { timeout: 10000, maximumAge: 300000 });
    }

    /* ---------- Step 2: Appliance ---------- */
    function step2Html() {
      var h = '<h3>What needs repair?</h3>' +
        '<p class="sub">First, choose your appliance.</p>' +
        '<div class="zb-tiles" role="radiogroup" aria-label="Appliance">';
      APPLIANCES.forEach(function (a) {
        h += '<button type="button" class="zb-tile' + (state.appliance === a.v ? ' on' : '') + '" data-appliance="' + esc(a.v) + '" role="radio" aria-checked="' + (state.appliance === a.v) + '">' + svgIcon(a.icon) + esc(a.v) + '</button>';
      });
      h += '</div>' +
        '<label for="' + uid + '-issue">What\u2019s it doing (or not doing)?</label>' +
        '<textarea id="' + uid + '-issue" data-f="issue" placeholder="e.g. Fridge is warm and the ice maker stopped, started two days ago\u2026">' + esc(state.issue) + '</textarea>';
      if (withPhoto) {
        h += '<div class="zb-photo"><label style="margin-top:0">Add a photo of the problem <span style="font-weight:600;color:#8fa1bb">(optional)</span></label>' +
          '<p>Speedy pre-diagnoses it for your tech: pick a photo and Speedy gives you a live read right here. Speedy\u2019s written read rides along with your booking notes \u2014 the photo itself isn\u2019t stored.</p>' +
          '<button type="button" class="zb-photobtn" data-act="photopick">' + CAMERA + ' Choose a photo</button>' +
          '<input type="file" data-f="photo" accept="image/*" style="display:none">' +
          '<div><button type="button" class="zb-photorun" data-act="photorun">Get Speedy\u2019s read on this photo</button></div>' +
          '<div class="zb-photores" data-photores></div></div>';
      }
      return h;
    }

    function runPhoto() {
      if (photoBusy || !photoData) return;
      photoBusy = true;
      var btn = q('[data-act="photorun"]');
      var box = q('[data-photores]');
      if (btn) { btn.disabled = true; btn.textContent = 'Speedy is reading your photo\u2026'; }
      if (box) { box.style.display = 'block'; box.innerHTML = '<b>Reading your photo\u2026</b><p>Speedy is reviewing it with what you told us. This takes a few seconds.</p>'; }
      var body = { imageDataUrl: photoData, note: (state.appliance + ': ' + state.issue).slice(0, 480), source: 'web-form-wizard' };
      if (state.name) body.customerName = state.name;
      if (state.phone) body.phone = state.phone;
      if (state.email) body.email = state.email;
      fetch(API + '/speedy/diagnose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var reply = j && j.data && (j.data.reply || j.data.message || j.data.diagnosis);
          if (!reply) throw new Error('no reply');
          state.photoDiag = String(reply).slice(0, 700);
          if (box) box.innerHTML = '<b>Speedy\u2019s preliminary read</b><p>' + esc(reply) + '</p><div class="zb-fine">Preliminary read from your photo \u2014 a technician confirms the diagnosis in person. This written read is attached to your booking notes for your tech; the photo itself isn\u2019t stored.</div>';
        })
        .catch(function () {
          state.photoDiag = null;
          if (box) box.innerHTML = '<b>Speedy could not read that photo</b><p>Try a clearer, well-lit photo \u2014 or just finish booking: the $99 diagnostic (credited toward your repair) has the technician diagnose it in person.</p>';
        })
        .finally(function () {
          photoBusy = false;
          if (btn) { btn.disabled = false; btn.textContent = 'Get Speedy\u2019s read on this photo'; }
        });
    }

    /* ---------- Step 3: Details ---------- */
    function step3Html() {
      var cityVal = state.city;
      var h = '<h3>Your details</h3>' +
        '<p class="sub">Where the tech is going, and how we reach you.</p>' +
        '<label for="' + uid + '-name">Full name</label>' +
        '<input type="text" id="' + uid + '-name" data-f="name" autocomplete="name" placeholder="Your name" value="' + esc(state.name) + '">' +
        '<label for="' + uid + '-phone">Mobile phone</label>' +
        '<input type="tel" id="' + uid + '-phone" data-f="phone" autocomplete="tel" placeholder="(954) 000-0000" value="' + esc(state.phone) + '">' +
        '<label for="' + uid + '-email">Email (for your confirmation)</label>' +
        '<input type="email" id="' + uid + '-email" data-f="email" autocomplete="email" placeholder="you@example.com" value="' + esc(state.email) + '">' +
        '<label for="' + uid + '-addr">Street address</label>' +
        '<input type="text" id="' + uid + '-addr" data-f="address" autocomplete="street-address" placeholder="Service address" value="' + esc(state.address) + '">' +
        '<label for="' + uid + '-city">City</label>' +
        '<select id="' + uid + '-city" data-f="citySel">' + cityOptions(cityVal, true) + '</select>' +
        (cityVal === '__other__'
          ? '<label for="' + uid + '-cityo">City name</label><input type="text" id="' + uid + '-cityo" data-f="cityOther" placeholder="Your city" value="' + esc(state.cityOther) + '">'
          : '') +
        '<label for="' + uid + '-zip3">ZIP code</label>' +
        '<input type="text" id="' + uid + '-zip3" data-f="zip" inputmode="numeric" autocomplete="postal-code" placeholder="ZIP code" maxlength="5" value="' + esc(state.zip) + '">' +
        '<label for="' + uid + '-note">Anything else? (optional)</label>' +
        '<input type="text" id="' + uid + '-note" data-f="note" placeholder="Gate code, parking, pets\u2026" value="' + esc(state.note) + '">' +
        /* Intake shield honeypot — invisible to humans, exactly as the
           classic form carries it. */
        '<div aria-hidden="true" style="position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden"><label>Company website<input type="text" data-f="website" name="companyWebsite" tabindex="-1" autocomplete="off" value="' + esc(state.website) + '"></label></div>';
      return h;
    }

    /* ---------- Step 4: Schedule & review ---------- */
    function finalCity() {
      return state.city === '__other__' ? state.cityOther.trim() : state.city;
    }
    function step4Html() {
      var h = '<h3>Schedule &amp; review</h3>' +
        '<p class="sub">Two-hour arrival windows. Your Service Setter confirms the exact appointment by text before dispatch.</p>' +
        '<label for="' + uid + '-date">Preferred day</label>' +
        '<input type="date" id="' + uid + '-date" data-f="date" min="' + dstr(new Date()) + '" value="' + esc(state.date) + '">' +
        '<p class="zb-avail" data-avail></p>' +
        '<div class="zb-wins" role="radiogroup" aria-label="Arrival window">';
      WINDOWS.forEach(function (w) {
        h += '<label><input type="radio" name="' + uid + '-win" data-win="' + w.v + '" value="' + w.v + '"' + (state.win === w.v ? ' checked' : '') + '><span class="wc">' + w.label + '</span></label>';
      });
      h += '</div><div class="zb-review">';
      var rows = [
        ['Name', state.name], ['Phone', state.phone],
        ['Address', state.address], ['City', finalCity() + (state.zip ? ', ' + state.zip : '')],
        ['Appliance', state.appliance], ['Issue', state.issue || '\u2014'],
        ['When', dayLabel(state.date) + (state.win ? ' \u00b7 ' + state.win : '')]
      ];
      if (state.geo && state.geo.geoCity) rows.push(['Location-verified', state.geo.geoCity + ' \u00b7 ' + state.geo.geoTier]);
      rows.forEach(function (r) {
        h += '<div class="rrow"><span class="rk">' + esc(r[0]) + '</span><span class="rv">' + esc(r[1]) + '</span></div>';
      });
      h += '</div>';
      if (state.outside) {
        h += '<div class="zb-note out show"><b>Outside our service area.</b> Sending this records your request and contact details \u2014 no appointment is confirmed and no service terms apply outside our area. We\u2019ll reach out if coverage opens near you.</div>';
      }
      h += '<div class="zb-price">The <b>$99 diagnostic</b> is collected at booking and <b>credited in full toward your repair</b>. Flat rates, no surprises: <b>repair labor is a flat $210</b> and <b>installation is a flat $150</b>. Parts and materials are priced in your written quote \u2014 and no work ever starts without your approved written quote.</div>';
      return h;
    }

    function doneHtml() {
      var d = state.done;
      if (d.areaStatus === 'OUT_OF_AREA') {
        return '<div class="zb-done"><div class="dic out">' + PIN + '</div>' +
          '<h3 style="text-align:center">Thanks \u2014 we\u2019ve recorded your request</h3>' +
          '<div class="zb-ref">' + esc(d.ref) + '</div>' +
          '<p class="sub" style="text-align:center">' + esc(d.areaMessage || 'You\u2019re outside our current service area, so no appointment is confirmed. We\u2019ve kept your request on file and will reach out if coverage opens near you.') + '</p>' +
          '<div class="zb-donebtns"><a href="tel:+18444607038" style="background:#E8322E;color:#fff">' + PHONE + ' Call (844) 460-7038</a></div></div>';
      }
      return '<div class="zb-done"><div class="dic">' + CHECK + '</div>' +
        '<h3 style="text-align:center">You\u2019re on the board!</h3>' +
        '<p class="sub" style="text-align:center;margin-bottom:0">Your booking reference:</p>' +
        '<div class="zb-ref">' + esc(d.ref) + '</div>' +
        '<p class="sub" style="text-align:center">Your request is in the Service Setters dispatch queue and your confirmation is on its way by text/email. A setter confirms your window shortly.</p>' +
        '<div class="zb-donebtns"><a href="/track" style="background:#0A265C;color:#fff">' + PIN + ' Track this job</a>' +
        '<a href="tel:+18444607038" style="background:#E8322E;color:#fff">' + PHONE + ' Call (844) 460-7038</a></div></div>';
    }

    /* ---------- Validation (the classic form's rules + messages) ---------- */
    function validateStep(n) {
      if (n === 1) {
        if (state.zip && !/^\d{5}$/.test(state.zip)) return 'Enter the full 5-digit ZIP \u2014 or tap Continue without ZIP.';
        return '';
      }
      if (n === 2) {
        if (!state.appliance) return 'Pick the appliance \u2014 it routes your job to the right tech.';
        return '';
      }
      if (n === 3) {
        if (state.name.trim().length < 2) return 'Add your name so the setter can confirm with you.';
        if (state.phone.replace(/\D/g, '').length < 10) return 'Add a valid mobile number for text updates.';
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(state.email.trim())) return 'Add your email so we can send the confirmation.';
        if (state.address.trim().length < 4) return 'Add the street address for the visit.';
        if (!state.city) return 'Choose your city \u2014 we serve 65 cities across Broward, Palm Beach & Miami-Dade.';
        if (state.city === '__other__' && state.cityOther.trim().length < 2) return 'Type your city name so we have it on the request.';
        if (!/^\d{5}$/.test(state.zip)) return 'Add the 5-digit ZIP.';
        return '';
      }
      if (n === 4) {
        if (!state.date) return 'Pick a preferred day.';
        if (!state.win) return 'Pick an arrival window.';
        return '';
      }
      return '';
    }

    function setErr(msg) {
      var e = q('[data-err]');
      if (!e) return;
      e.textContent = msg || '';
      e.className = 'zb-err' + (msg ? ' show' : '');
    }

    /* ---------- Availability (same live read as the classic form) ---------- */
    function loadAvail() {
      if (!state.date) return;
      fetch(API + '/speedy/availability?date=' + encodeURIComponent(state.date))
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.data || !j.data.windows) return;
          var byId = {};
          j.data.windows.forEach(function (w) { byId[w.id] = w; });
          qa('[data-win]').forEach(function (inp) {
            var w = byId[inp.value];
            if (!w) return;
            var card = inp.nextElementSibling;
            if (w.status === 'CLOSED') {
              inp.disabled = true;
              if (inp.checked) { inp.checked = false; state.win = ''; }
              card.textContent = w.label + (w.reason === 'FULL' ? ' \u2014 Full' : ' \u2014 Passed');
            } else {
              inp.disabled = false;
              card.textContent = w.label;
            }
          });
          var note = q('[data-avail]');
          if (note) note.textContent = j.data.capacityConfigured
            ? 'Live availability for the day you picked \u2014 full and passed windows are closed.'
            : 'Pick a day and window \u2014 your Service Setter confirms the exact appointment by text.';
        })
        .catch(function () { /* every window stays pickable */ });
    }

    /* ---------- Payload + submit (the classic form's exact shape) ---------- */
    function buildPayload() {
      var issueFull = state.issue.trim();
      if (state.photoDiag) issueFull += '\n\nSpeedy photo read: ' + state.photoDiag;
      if (state.note.trim()) issueFull += '\n\nNote: ' + state.note.trim();
      var payload = {
        customer: { name: state.name.trim(), phone: state.phone.trim(), address: state.address.trim() },
        city: finalCity(),
        zip: state.zip,
        appliance: state.appliance,
        issue: issueFull,
        preferredWindow: state.win,
        preferredDate: state.date,
        source: 'WEB_FORM',
        companyWebsite: state.website || ''
      };
      var em = state.email.trim();
      if (em) payload.customer.email = em;
      try {
        var rc = sessionStorage.getItem('tsos_ref_code') || '';
        if (rc) payload.referralCode = rc;
      } catch (e) { /* private mode */ }
      try {
        var qs = new URLSearchParams(location.search);
        if (qs.get('src')) payload.source = qs.get('src');
        if (qs.get('via')) payload.via = qs.get('via');
        if (qs.get('page')) payload.landingPage = qs.get('page');
        ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) {
          if (qs.get(k)) payload[k] = qs.get(k);
        });
      } catch (e) { /* no query string */ }
      try { if (window.TSOSAttribution) window.TSOSAttribution.attach(payload); } catch (e) { /* attribution is best-effort */ }
      if (state.geo) {
        payload.geoCity = state.geo.geoCity;
        payload.geoTier = state.geo.geoTier;
        payload.geoLat = state.geo.geoLat;
        payload.geoLng = state.geo.geoLng;
      }
      return payload;
    }

    function submit() {
      if (busy) return;
      var v = validateStep(4);
      if (v) { setErr(v); return; }
      busy = true;
      var btn = q('[data-act="next"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Sending\u2026'; }
      fetch(API + '/speedy/book', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload())
      }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, j: j }; });
      }).then(function (x) {
        if (!x.ok || !x.j || !x.j.data || !x.j.data.referenceCode) {
          throw new Error((x.j && x.j.error) || 'Something went wrong sending that.');
        }
        state.done = {
          ref: x.j.data.referenceCode,
          areaStatus: x.j.data.areaStatus || '',
          areaMessage: x.j.data.areaMessage || ''
        };
        try { if (window.TSOSBookingSubmitted) window.TSOSBookingSubmitted(x.j.data.referenceCode); } catch (e) { /* tracking is best-effort */ }
        render();
      }).catch(function (e) {
        setErr(e.message + ' You can also book by chat \u2014 tap Ask Speedy below \u2014 or call 844-460-7038.');
      }).finally(function () {
        busy = false;
        var b = q('[data-act="next"]');
        if (b) { b.disabled = false; b.innerHTML = CHECK + ' Confirm booking'; }
      });
    }

    /* ---------- Render + events ---------- */
    function render() {
      if (state.done) { root.innerHTML = '<div class="zbw">' + doneHtml() + '</div>'; return; }
      var pane = state.step === 1 ? step1Html() : state.step === 2 ? step2Html() : state.step === 3 ? step3Html() : step4Html();
      root.innerHTML = '<div class="zbw">' + stepperHtml() + pane +
        '<div class="zb-err" data-err></div>' +
        '<div class="zb-nav">' +
        (state.step > 1 ? '<button type="button" class="zb-back" data-act="back">Back</button>' : '') +
        '<button type="button" class="zb-next" data-act="next">' +
        (state.step === 4 ? CHECK + ' Confirm booking' : 'Continue') + '</button></div></div>';
      if (state.step === 1) refreshAreaUI();
      if (state.step === 4) loadAvail();
      if (state.step === 2 && state.photoDiag) {
        var box = q('[data-photores]');
        if (box) { box.style.display = 'block'; box.innerHTML = '<b>Speedy\u2019s preliminary read</b><p>' + esc(state.photoDiag) + '</p>'; }
        var run = q('[data-act="photorun"]'); if (run && photoData) run.style.display = 'inline-block';
      }
    }

    root.addEventListener('input', function (ev) {
      var f = ev.target.getAttribute && ev.target.getAttribute('data-f');
      if (!f) return;
      if (f === 'zip') {
        state.zip = ev.target.value.replace(/\D/g, '').slice(0, 5);
        if (ev.target.value !== state.zip) ev.target.value = state.zip;
        if (state.step === 1) {
          if (zipTimer) clearTimeout(zipTimer);
          if (/^\d{5}$/.test(state.zip)) zipTimer = setTimeout(checkZip, 350);
          else if (state.areaMode !== 'MANUAL') { state.areaMode = ''; state.zipAreas = []; refreshAreaUI(); }
        }
      } else if (f === 'cityOther') { state.cityOther = ev.target.value; }
      else if (f === 'photo') { /* handled on change */ }
      else if (state[f] !== undefined) { state[f] = ev.target.value; }
    });

    root.addEventListener('change', function (ev) {
      var t = ev.target;
      var f = t.getAttribute && t.getAttribute('data-f');
      if (f === 'citySel') {
        state.city = t.value;
        if (state.city === '__other__') state.outside = true;
        else if (state.city) { state.outside = false; if (state.step === 1) state.areaMode = 'IN'; }
        render();
        return;
      }
      if (f === 'date') { state.date = t.value; loadAvail(); return; }
      if (t.hasAttribute && t.hasAttribute('data-win')) { state.win = t.value; return; }
      if (f === 'photo') {
        var file = t.files && t.files[0];
        if (!file) return;
        var rd = new FileReader();
        rd.onload = function () {
          var img = new Image();
          img.onload = function () {
            try {
              var max = 1280, w = img.width, h = img.height;
              var sc = Math.min(1, max / Math.max(w, h));
              var cv = document.createElement('canvas');
              cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);
              cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
              photoData = cv.toDataURL('image/jpeg', 0.85);
            } catch (e) { photoData = rd.result; }
            var run = q('[data-act="photorun"]'); if (run) run.style.display = 'inline-block';
          };
          img.src = rd.result;
        };
        rd.readAsDataURL(file);
      }
    });

    root.addEventListener('click', function (ev) {
      var t = ev.target.closest ? ev.target.closest('[data-act],[data-pick],[data-appliance]') : null;
      if (!t) return;
      if (t.hasAttribute('data-appliance')) {
        state.appliance = t.getAttribute('data-appliance');
        qa('[data-appliance]').forEach(function (b) {
          var on = b.getAttribute('data-appliance') === state.appliance;
          b.classList.toggle('on', on);
          b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        return;
      }
      if (t.hasAttribute('data-pick')) {
        state.city = t.getAttribute('data-pick');
        state.areaMode = 'IN';
        state.outside = false;
        refreshAreaUI();
        return;
      }
      var act = t.getAttribute('data-act');
      if (act === 'locate') useLocation();
      else if (act === 'skip') { state.areaMode = 'MANUAL'; refreshAreaUI(); }
      else if (act === 'photopick') { var fi = q('[data-f="photo"]'); if (fi) fi.click(); }
      else if (act === 'photorun') runPhoto();
      else if (act === 'back') { if (state.step > 1) { state.step -= 1; render(); } }
      else if (act === 'next') {
        if (state.step < 4) {
          var v = validateStep(state.step);
          if (v) { setErr(v); return; }
          state.step += 1;
          render();
        } else { submit(); }
      }
    });

    /* The published-city list comes from the area model itself. */
    fetch(API + '/geo/cities')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.data && Array.isArray(j.data.cities) && j.data.cities.length) {
          cities = j.data.cities;
          if (state.step === 1) refreshAreaUI();
          else if (state.step === 3) render();
        }
      })
      .catch(function () { /* the 12-city fallback stays */ });

    render();
    return { root: root, getState: function () { return state; }, buildPayload: buildPayload };
  }

  function boot() {
    ensureStyle();
    window.TSOSZipBookingMounts = [];
    document.querySelectorAll('[data-tsos-zip-booking]').forEach(function (el) {
      window.TSOSZipBookingMounts.push(createWizard(el));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
