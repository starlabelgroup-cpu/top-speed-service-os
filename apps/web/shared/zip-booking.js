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
 * (data-photo="1" adds the homepage's Speedy photo read to Step 2).
 *
 * App mode (data-mode="app", the /app Book tab, 2026-11-23): the same
 * wizard presents the customer app's booking flow and submits the
 * app's own contract — POST /bookings through the page's cFetch when
 * signed in; guests first POST /auth/register with the termsAcceptance
 * object (TSOSLegal prefix 'cd'), then book. The app-only machinery is
 * preserved verbatim: the app's appliance names, issue chips, photo
 * first-look (diagnose only — the photo never enters the payload),
 * buildDays day labels, live window availability, the cd* element IDs
 * (so custApplyUser / custLoginFromBook / custVerify keep working),
 * and the post-booking page state (booking.ref, stageIdx, FEED,
 * renderActiveJob) that feeds stage tracking. */
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
  /* App mode: the customer app's own appliance set — its names are
     the values the /app booking payload has always carried (they
     differ from the canonical web list: "Oven & Range", "Freezer",
     "Ice Maker", "Cooktop"), with the app's own icon paths. */
  var APP_APPLIANCES = [
    { v: 'Refrigerator', icon: '<path d="M8 3h8l2 2v16H6V5z"/><path d="M6 10h12M9 6.5v2M9 13v3"/>' },
    { v: 'Washer', icon: '<path d="M6 3h12l2 2v14l-2 2H6L4 19V5z"/><path d="M16.16 14.72L13.72 17.16L10.28 17.16L7.84 14.72L7.84 11.28L10.28 8.84L13.72 8.84L16.16 11.28z"/><path d="M7 6h.01M10 6h4"/>' },
    { v: 'Dryer', icon: '<path d="M6 3h12l2 2v14l-2 2H6L4 19V5z"/><path d="M16.16 14.72L13.72 17.16L10.28 17.16L7.84 14.72L7.84 11.28L10.28 8.84L13.72 8.84L16.16 11.28z"/><path d="M9.5 11.8l1.6 2 1.7-2 1.7 2M7 6h.01"/>' },
    { v: 'Oven & Range', icon: '<path d="M6 5h12l2 2v14H4V7z"/><circle cx="8.5" cy="8.5" r="1.3"/><circle cx="15.5" cy="8.5" r="1.3"/><path d="M7 12.5h10v5.5H7z"/>' },
    { v: 'Dishwasher', icon: '<path d="M6 3h12l2 2v16H4V5z"/><path d="M4 8h16M8 12v3M12 11v4M16 12v3M7 5.5h3"/>' },
    { v: 'Freezer', icon: '<path d="M8 3h8l2 2v16H6V5z"/><path d="M12 9v7M9 10.5l6 4M15 10.5l-6 4M9 6.5h.01"/><circle cx="12" cy="12.5" r="1.1" fill="currentColor" stroke="none"/>' },
    { v: 'Ice Maker', icon: '<rect x="5" y="8" width="9" height="9" rx="1.5" transform="rotate(-8 9.5 12.5)"/><rect x="12" y="5" width="8" height="8" rx="1.5" transform="rotate(10 16 9)"/>' },
    { v: 'Microwave', icon: '<path d="M5 6h14l2 2v10H3V8z"/><path d="M6 9h9v6H6z"/><path d="M18 9.5h.01M18 13h.01"/>' },
    { v: 'Cooktop', icon: '<path d="M5 7h14l2 2v9H3V9z"/><path d="M10.72 13.42L9.42 14.72L7.58 14.72L6.28 13.42L6.28 11.58L7.58 10.28L9.42 10.28L10.72 11.58z"/><path d="M17.72 13.42L16.42 14.72L14.58 14.72L13.28 13.42L13.28 11.58L14.58 10.28L16.42 10.28L17.72 11.58z"/><path d="M6 20h.01M18 20h.01"/>' }
  ];
  var ISSUE_CHIPS = ['Not cooling / not heating', 'Making noise', 'Leaking water', 'Won\u2019t start / no power', 'Error code on display', 'Something else'];
  var APP_WIN_LABELS = { '08-10': '8\u201310 AM', '10-12': '10 AM\u201312 PM', '12-14': '12\u20132 PM', '14-16': '2\u20134 PM', '16-18': '4\u20136 PM' };

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
    '.zbw input[type="text"],.zbw input[type="tel"],.zbw input[type="email"],.zbw input[type="password"],.zbw input[type="date"],.zbw select,.zbw textarea{width:100%;padding:12px 13px;border:1.5px solid #dbe4f0;border-radius:12px;font:inherit;font-size:15px;background:#fff;color:#0d1b2e}',
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
    '.zbw .zb-fine{font-size:12.5px;color:#8fa1bb;margin-top:6px;line-height:1.45}',
    /* Google Maps preview (key-gated; the wrap stays hidden without
       a browser key, so the step renders exactly as before). */
    '.zbw .zb-mapwrap{margin-top:14px}',
    '.zbw .zb-mapwrap[hidden]{display:none}',
    '.zbw .zb-map{width:100%;height:190px;border-radius:12px;border:1px solid #dbe4f0;background:#eef2f8}',
    '.pac-container{font:inherit;z-index:10000;border-radius:12px;box-shadow:0 12px 32px rgba(10,38,92,.18)}',
    '.pac-item{padding:8px 12px;cursor:pointer;font-size:14.5px}',
    /* App mode additions: issue/day/window chips, photo first-look,
       the $99 remind box, account-block controls. */
    '.zbw .zb-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}',
    '.zbw .zb-chip{border:1.5px solid #dbe4f0;background:#fff;border-radius:999px;padding:9px 14px;font:inherit;font-size:14px;font-weight:600;color:#0A265C;cursor:pointer}',
    '.zbw .zb-chip.on{border-color:#E8322E;background:#fdf0ef;box-shadow:0 0 0 1px #E8322E inset}',
    '.zbw .zb-chip[disabled]{cursor:not-allowed}',
    '.zbw .zb-photobox{border:1.5px dashed #c4d2e6;border-radius:12px;padding:16px 14px;cursor:pointer;text-align:center;color:#0A265C}',
    '.zbw .zb-photobox b{display:block;font-size:15px}',
    '.zbw .zb-photobox span{display:block;font-size:13px;color:#5b6b87;margin-top:3px}',
    '.zbw .zb-photoprev{display:none;margin-top:10px;position:relative}',
    '.zbw .zb-photoprev img{width:100%;height:auto;border-radius:12px;display:block}',
    '.zbw .zb-photoprev .pp-tag{position:absolute;left:10px;bottom:10px;background:#0A265C;color:#fff;font-size:12px;font-weight:700;border-radius:999px;padding:4px 10px}',
    '.zbw .zb-ainote{display:none;margin-top:10px;background:#f2f6fd;border:1px solid #dbe4f0;border-radius:12px;padding:11px 13px;font-size:14px;color:#33465e}',
    '.zbw .zb-remind{background:#fdf6e3;border:1px solid #ecd9a0;border-radius:12px;padding:12px 14px;font-size:13.5px;color:#5f4b00;margin-top:12px;line-height:1.55}',
    '.zbw .zb-tlink{color:#0A265C;font-weight:700}',
    '.zbw .zb-donebtns button{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:12px 20px;font:inherit;font-weight:800;font-size:14.5px;cursor:pointer;border:none}'
  ].join('');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function round3(n) { return Math.round(n * 1000) / 1000; }

  /* ---------- Google Maps Platform, browser side (2026-11-23) ----------
   * The browser key comes from GET /geo/config (the API's
   * GOOGLE_MAPS_BROWSER_KEY). No key -> nothing in this section ever
   * runs: no config-driven script tag, no map, no autocomplete, and
   * every surface renders exactly as before. The Maps script loads
   * lazily, only when a wizard step actually enhances, and any
   * Google failure quietly leaves the designed UI in place — the
   * map never blocks or gates the form. */
  var mapsCfgPromise = null;
  var mapsApiPromise = null;
  function mapsConfig() {
    if (!mapsCfgPromise) {
      mapsCfgPromise = fetch(API + '/geo/config')
        .then(function (r) { return r.json(); })
        .then(function (j) { return (j && j.data && j.data.mapsBrowserKey) || null; })
        .catch(function () { return null; });
    }
    return mapsCfgPromise;
  }
  function loadMapsApi() {
    if (window.google && window.google.maps) return Promise.resolve(window.google.maps);
    if (!mapsApiPromise) {
      mapsApiPromise = mapsConfig().then(function (key) {
        if (!key) return null;
        return new Promise(function (resolve) {
          var done = false;
          var finish = function () {
            if (done) return;
            done = true;
            resolve(window.google && window.google.maps ? window.google.maps : null);
          };
          var s = document.createElement('script');
          s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&libraries=places&v=weekly';
          s.async = true;
          s.onload = finish;
          s.onerror = finish;
          document.head.appendChild(s);
          setTimeout(finish, 8000);
        });
      });
    }
    return mapsApiPromise;
  }
  function dstr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function dayLabel(v) { try { return new Date(v + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); } catch (e) { return v; } }

  var uidSeq = 0;

  function createWizard(root) {
    var uid = 'zb' + (++uidSeq);
    var withPhoto = root.getAttribute('data-photo') === '1';
    var appMode = root.getAttribute('data-mode') === 'app';
    var TILESET = appMode ? APP_APPLIANCES : APPLIANCES;
    var state = {
      step: 1,
      zip: '', city: '', cityOther: '', areaMode: '', zipAreas: [],
      outside: false, /* honest out-of-area state (geo OUT or city-not-listed) */
      geo: null,
      appliance: '', issue: '', photoDiag: null,
      name: '', phone: '', email: '', address: '', note: '', website: '',
      date: dstr(new Date()), win: '',
      done: null,
      /* App mode only: */
      issueChip: '', photoSrc: '', photoNote: '',
      dayText: '', winLabel: '', winId: '', password: '',
      acctMode: 'create',
      legal: { os: false, connect: false, sig: '' },
      details: null, acceptance: null
    };
    if (appMode) state.date = ''; /* the app flow starts with no day picked */
    var cities = null; /* [{name, county, core}] from /geo/cities */
    var photoData = null, photoBusy = false, zipTimer = null, busy = false;
    /* Google Maps preview state (key-gated; inert without a key). */
    var mapObj = null, mapMarker = null, mapTargetKey = '', cityGeoCache = {};

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
        '<div class="zb-mapwrap" data-mapwrap hidden><div class="zb-map" data-gmap></div><p class="zb-fine" data-mapnote></p></div>' +
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
      enhanceStep1Map();
    }

    /* ---------- Google Maps: Step 1 preview + address autocomplete ----------
     * Everything here is key-gated through loadMapsApi() and fails
     * silently: no key, no script, no map — the wizard is unchanged. */

    /* What the Step 1 preview should show: the device-verified
       position when the customer used "Use my location", else the
       matched city's center (geocoded client-side, labeled
       approximate). Nothing outside a matched area is ever pinned. */
    function mapTarget() {
      if (state.geo && state.geo.geoLat != null && state.geo.geoLng != null) {
        return {
          lat: state.geo.geoLat, lng: state.geo.geoLng,
          key: 'geo:' + state.geo.geoLat + ',' + state.geo.geoLng,
          label: state.city ? 'your location, in the ' + state.city + ' area' : 'your location'
        };
      }
      if (state.city && !state.outside && (state.areaMode === 'IN' || state.areaMode === 'EDGE')) {
        return { city: state.city, key: 'city:' + state.city, label: 'the ' + state.city + ' service-area center (approximate)' };
      }
      return null;
    }

    function enhanceStep1Map() {
      var wrap = q('[data-mapwrap]');
      if (!wrap) return;
      var target = mapTarget();
      if (!target) { wrap.hidden = true; return; }
      loadMapsApi().then(function (maps) {
        if (!maps || !maps.Map) { var w0 = q('[data-mapwrap]'); if (w0) w0.hidden = true; return; }
        var wrapNow = q('[data-mapwrap]');
        if (!wrapNow || state.step !== 1) return;
        var t2 = mapTarget();
        if (!t2) { wrapNow.hidden = true; return; }
        var renderAt = function (lat, lng) {
          var div = q('[data-gmap]');
          var w = q('[data-mapwrap]');
          if (!div || !w) return;
          w.hidden = false;
          var note = q('[data-mapnote]');
          if (note) note.textContent = 'Map preview \u2014 ' + t2.label + '. Your exact service address is confirmed on the details step.';
          var center = { lat: lat, lng: lng };
          if (mapObj && mapTargetKey === t2.key) {
            mapObj.setCenter(center);
            if (mapMarker) mapMarker.setPosition(center);
            return;
          }
          mapObj = new maps.Map(div, { center: center, zoom: 12, disableDefaultUI: true, gestureHandling: 'cooperative', clickableIcons: false });
          mapMarker = new maps.Marker({ position: center, map: mapObj });
          mapTargetKey = t2.key;
        };
        if (t2.lat != null) { renderAt(t2.lat, t2.lng); return; }
        if (cityGeoCache[t2.city]) { renderAt(cityGeoCache[t2.city].lat, cityGeoCache[t2.city].lng); return; }
        new maps.Geocoder().geocode({ address: t2.city + ', FL' }, function (results, status) {
          if (status !== 'OK' || !results || !results[0] || !results[0].geometry) {
            var w2 = q('[data-mapwrap]'); if (w2) w2.hidden = true;
            return;
          }
          var loc = results[0].geometry.location;
          cityGeoCache[t2.city] = { lat: loc.lat(), lng: loc.lng() };
          if (state.step === 1) renderAt(loc.lat(), loc.lng());
        });
      }).catch(function () { /* the designed UI stands on its own */ });
    }

    /* THE Places adapter (client): the only place the Places
       Autocomplete widget is constructed — Places API (New)'s
       element swaps in behind this one function later. */
    function attachPlacesAutocomplete(maps, input) {
      var ac = new maps.places.Autocomplete(input, {
        componentRestrictions: { country: 'us' },
        fields: ['address_components', 'formatted_address', 'geometry'],
        types: ['address']
      });
      ac.addListener('place_changed', function () {
        var place = ac.getPlace();
        if (place) applyPlaceSelection(place);
      });
    }

    /* A picked address fills the details fields in place (no
       re-render, nothing typed is lost) and its coordinates ride
       the booking exactly like a location tap — the server still
       re-derives city + tier from them; the area model decides. */
    function applyPlaceSelection(place) {
      var comps = place.address_components || [];
      function comp(type) {
        for (var i = 0; i < comps.length; i++) {
          if (comps[i].types && comps[i].types.indexOf(type) !== -1) return comps[i].long_name;
        }
        return '';
      }
      var street = ((comp('street_number') + ' ' + comp('route')).trim()) || place.formatted_address || '';
      var city = comp('locality') || comp('postal_town') || comp('sublocality');
      var zip = comp('postal_code');
      if (street) {
        state.address = street;
        var ai = q('[data-f="address"]'); if (ai) ai.value = street;
      }
      if (zip && /^\d{5}$/.test(zip)) {
        state.zip = zip;
        var zi = q('[data-f="zip"]'); if (zi) zi.value = zip;
      }
      if (city) {
        state.city = city;
        var sel = q('[data-f="citySel"]');
        if (sel) {
          for (var i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === city || sel.options[i].text === city) { sel.selectedIndex = i; break; }
          }
        }
      }
      if (place.geometry && place.geometry.location) {
        state.geo = { geoLat: round3(place.geometry.location.lat()), geoLng: round3(place.geometry.location.lng()) };
        window.TSOSGeo = state.geo;
      }
    }

    function attachAddressAutocomplete() {
      var input = q('[data-f="address"]');
      if (!input || input.getAttribute('data-places') === '1') return;
      loadMapsApi().then(function (maps) {
        if (!maps || !maps.places || !maps.places.Autocomplete) return;
        var el = q('[data-f="address"]');
        if (!el || el.getAttribute('data-places') === '1' || state.step !== 3) return;
        el.setAttribute('data-places', '1');
        try { attachPlacesAutocomplete(maps, el); } catch (e) { /* typing the address always works */ }
      }).catch(function () { /* typing the address always works */ });
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
      if (d.app) {
        return '<div class="zb-done"><div class="dic">' + CHECK + '</div>' +
          '<h3 style="text-align:center">You\u2019re booked</h3>' +
          '<p class="sub" style="text-align:center;margin-bottom:0">Your reference code</p>' +
          '<div class="zb-ref" id="refCode">' + esc(d.ref) + '</div>' +
          '<p class="sub" style="text-align:center"><b style="color:#0A265C;">A Service Setter will confirm by text</b> shortly, and your tech\u2019s details land in the Track tab once matched.</p>' +
          '<div class="zb-donebtns"><button type="button" data-act="track" style="background:#0A265C;color:#fff">' + PIN + ' Track my job</button>' +
          '<button type="button" data-act="again" style="background:#fff;color:#0A265C;border:1.5px solid #dbe4f0">Book another repair</button></div></div>';
      }
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

    /* ================= App mode =================
       The /app Book contract, step by step. Validations, toasts,
       endpoints and payload are the app's own (see CONTRACT notes in
       the page surgery): the wizard is a presentation swap only. */
    function appToast(msg) {
      if (window.toast) { window.toast(msg); return; }
      setErr(msg);
    }
    function snapshotLegal() {
      var os = document.getElementById('cdTermsOs'), cn = document.getElementById('cdTermsConnect'), sig = document.getElementById('cdSignature');
      if (os) state.legal.os = os.checked;
      if (cn) state.legal.connect = cn.checked;
      if (sig) state.legal.sig = sig.value;
    }
    function mountLegal() {
      if (!window.TSOSLegal) return;
      if (!document.getElementById('cdLegal')) return;
      window.TSOSLegal.mountSigning('cdLegal', 'cd', {});
      var os = document.getElementById('cdTermsOs'), cn = document.getElementById('cdTermsConnect'), sig = document.getElementById('cdSignature');
      if (os) os.checked = !!state.legal.os;
      if (cn) cn.checked = !!state.legal.connect;
      if (sig && state.legal.sig) sig.value = state.legal.sig;
      try { if (window.TSOSIntakeShield && window.TSOSIntakeShield.render) window.TSOSIntakeShield.render(); } catch (e) { /* shield is best-effort */ }
    }

    /* Step 2 (app): appliance tiles + issue chips + photo first-look. */
    function step2AppHtml() {
      var h = '<h3>What needs repair?</h3>' +
        '<p class="sub">First, choose your appliance.</p>' +
        '<div class="zb-tiles" role="radiogroup" aria-label="Appliance">';
      TILESET.forEach(function (a) {
        h += '<button type="button" class="zb-tile' + (state.appliance === a.v ? ' on' : '') + '" data-appliance="' + esc(a.v) + '" role="radio" aria-checked="' + (state.appliance === a.v) + '">' + svgIcon(a.icon) + esc(a.v) + '</button>';
      });
      h += '</div>' +
        '<label>What\u2019s it doing?</label>' +
        '<div class="zb-chips">';
      ISSUE_CHIPS.forEach(function (c) {
        h += '<button type="button" class="zb-chip' + (state.issueChip === c ? ' on' : '') + '" data-chip="' + esc(c) + '">' + esc(c) + '</button>';
      });
      h += '</div>' +
        '<label for="' + uid + '-issue">Add details (optional)</label>' +
        '<textarea id="' + uid + '-issue" data-f="issue" rows="2" placeholder="e.g. Fridge is warm, freezer still cold. Started Tuesday.">' + esc(state.issue) + '</textarea>' +
        '<label>Photo helps us triage faster</label>' +
        (state.photoSrc ? '' : '<div class="zb-photobox" data-act="appphotopick"><b>Attach a photo</b><span>Model tag, error code, or the problem itself \u2014 Speedy AI takes a first look.</span></div>') +
        '<input type="file" data-f="appphoto" accept="image/*" hidden>' +
        '<div class="zb-photoprev" data-photoprev' + (state.photoSrc ? ' style="display:block"' : '') + '><img data-photoimg alt="Your attached appliance photo"' + (state.photoSrc ? ' src="' + state.photoSrc + '"' : '') + '><span class="pp-tag">Photo attached</span></div>' +
        '<div class="zb-ainote" data-ainote' + (state.photoNote ? ' style="display:block"' : '') + '>' + (state.photoNote || '') + '</div>';
      return h;
    }

    /* The app's real photo first look: preview + a live Speedy read.
       The photo itself never enters the booking payload — exactly as
       the app's showPhoto has always behaved. */
    function appShowPhoto(src) {
      state.photoSrc = src;
      try { if (window.booking) window.booking.photo = true; } catch (e) { /* page state is best-effort here */ }
      var pv = q('[data-photoprev]'); if (pv) pv.style.display = 'block';
      var img = q('[data-photoimg]'); if (img) img.src = src;
      var box = q('[data-act="appphotopick"]'); if (box) box.style.display = 'none';
      var note = q('[data-ainote]'); if (!note) return;
      note.style.display = 'block';
      function setNote(html) {
        state.photoNote = html;
        var n = q('[data-ainote]'); if (n) { n.style.display = 'block'; n.innerHTML = html; }
      }
      if (src.indexOf('data:image/svg') === 0) {
        setNote('<b>Speedy AI first look:</b> This is the sample photo \u2014 attach a real photo of your appliance and Speedy will read it live.');
        return;
      }
      setNote('<b>Speedy AI first look:</b> Photo received \u2014 Speedy is taking a look\u2026');
      function fire() {
        try {
          var mx = 1280, w = img.naturalWidth, h = img.naturalHeight, sc = Math.min(1, mx / Math.max(w, h));
          var cv = document.createElement('canvas'); cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          var dataUrl = cv.toDataURL('image/jpeg', 0.82);
          fetch(API + '/speedy/diagnose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageDataUrl: dataUrl, note: (state.appliance || 'Appliance') + ': ' + (state.issueChip || state.issue || 'customer photo') }) })
            .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
            .then(function (j) {
              var rep = (j.data && j.data.reply) || '';
              if (!rep) throw new Error('empty');
              setNote('<b>Speedy AI first look:</b> ' + esc(rep.slice(0, 320)) + (rep.length > 320 ? '\u2026' : ''));
            })
            .catch(function () { setNote('<b>Speedy AI first look:</b> Photo attached. Speedy could not read this one \u2014 your setter will review it, and the tech confirms the diagnosis in person.'); });
        } catch (e) { setNote('<b>Speedy AI first look:</b> Photo attached \u2014 a setter will review it with your booking.'); }
      }
      if (img.complete && img.naturalWidth) fire();
      else img.onload = fire;
    }

    /* Step 3 (app): the confirm-step details card, with the page's
       own element IDs so every surrounding behavior (custApplyUser
       prefill + signed-in note, custLoginFromBook, custVerify,
       TSOSLegal 'cd' signing) works on it verbatim. */
    function step3AppHtml() {
      var user = window.cUser || null;
      var h = '<h3>Your details</h3>' +
        '<p class="sub">Where the tech is going, and how we reach you.</p>' +
        '<b style="font-size:15px;">Your details</b>';
      if (!user) h += '<p class="sub" style="margin:4px 0 10px;">Create your free account to book \u2014 it keeps your bookings, appliances and warranty in one place.</p>';
      h += '<label for="cdName">Full name</label>' +
        '<input id="cdName" type="text" data-f="name" autocomplete="name" placeholder="Your name" value="' + esc(state.name) + '">' +
        '<label for="cdPhone">Mobile phone</label>' +
        '<input id="cdPhone" type="tel" data-f="phone" autocomplete="tel" placeholder="(954) 555-0123" value="' + esc(state.phone) + '">' +
        '<label for="cdCity">City</label>' +
        '<select id="cdCity" data-f="citySel">' + cityOptions(state.city === '__other__' ? '__other__' : state.city, true) + '</select>' +
        (state.city === '__other__'
          ? '<label for="' + uid + '-cityo">City name</label><input type="text" id="' + uid + '-cityo" data-f="cityOther" placeholder="Your city" value="' + esc(state.cityOther) + '">'
          : '') +
        '<label for="cdZip">ZIP code</label>' +
        '<input id="cdZip" type="text" data-f="zip" inputmode="numeric" autocomplete="postal-code" placeholder="33311" value="' + esc(state.zip) + '">' +
        '<label for="cdAddr">Street address (optional)</label>' +
        '<input id="cdAddr" type="text" data-f="address" autocomplete="street-address" placeholder="123 Main St, Apt 4" value="' + esc(state.address) + '">';
      if (user) {
        h += '<p class="sub" id="cdSignedIn" style="display:none; margin:8px 0 0;"></p>';
      } else {
        h += '<div id="cdNewAcct"' + (state.acctMode === 'login' ? ' style="display:none"' : '') + '>' +
          '<label for="cdEmail">Email</label>' +
          '<input id="cdEmail" type="email" data-f="email" autocomplete="email" placeholder="you@email.com" value="' + esc(state.email) + '">' +
          '<label for="cdPw">Create a password (10+ characters)</label>' +
          '<input id="cdPw" type="password" data-f="password" autocomplete="new-password" placeholder="Password" value="' + esc(state.password) + '">' +
          '<div aria-hidden="true" style="position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden"><label>Company website<input id="cdWebsite" type="text" data-f="website" name="companyWebsite" tabindex="-1" autocomplete="off" value="' + esc(state.website) + '"></label></div>' +
          '<div id="cdLegal"></div>' +
          '<div class="tsos-turnstile-slot"></div>' +
          '<p class="sub" style="margin:8px 0 0;">Already have an account? <a href="#" class="zb-tlink" data-act="acct-login">Sign in instead</a></p></div>' +
          '<div id="cdLogin"' + (state.acctMode === 'login' ? '' : ' style="display:none"') + '>' +
          '<label for="cdEmail2">Email</label>' +
          '<input id="cdEmail2" type="email" autocomplete="email" placeholder="you@email.com">' +
          '<label for="cdPw2">Password</label>' +
          '<input id="cdPw2" type="password" autocomplete="current-password" placeholder="Password">' +
          '<button type="button" class="zb-locbtn" data-act="cust-login">Sign in</button>' +
          '<div id="cdSvRow" style="display:none;margin-top:10px;"><label for="cdSvCode">Speedy Verify access code</label>' +
          '<input id="cdSvCode" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="8-digit code from the office">' +
          '<button type="button" class="zb-locbtn" data-act="cust-verify">Verify &amp; sign in</button></div>' +
          '<p class="sub" style="margin:8px 0 0;">New here? <a href="#" class="zb-tlink" data-act="acct-create">Create an account</a></p></div>' +
          '<p class="sub" id="cdSignedIn" style="display:none; margin:8px 0 0;"></p>';
      }
      return h;
    }

    /* Leaving Details (app): snapshot the cd* fields and — for guests —
       run confirmBooking's exact account validations, capturing the
       termsAcceptance object while the signing block is in the DOM.
       Nothing advances (and nothing can submit) without it. */
    function captureDetails() {
      function domVal(id, fallback) {
        var el = document.getElementById(id);
        return el ? el.value.trim() : (fallback || '');
      }
      var name = domVal('cdName', state.name);
      var phone = domVal('cdPhone', state.phone);
      var zip = domVal('cdZip', state.zip);
      var addr = domVal('cdAddr', state.address);
      var city = finalCity();
      if (name.length < 2) { appToast('Please add your full name'); return false; }
      if (phone.replace(/\D/g, '').length < 10) { appToast('Please add a valid mobile number'); return false; }
      if (!city) { appToast('Please choose your city'); return false; }
      if (!/^\d{5}$/.test(zip)) { appToast('Please add your 5-digit ZIP'); return false; }
      state.name = name; state.phone = phone; state.zip = zip; state.address = addr;
      state.details = { name: name, phone: phone, city: city, zip: zip, addr: addr };
      if (window.cUser) { state.acceptance = null; return true; }
      var email = domVal('cdEmail', state.email);
      var pwEl = document.getElementById('cdPw');
      var pw = pwEl ? pwEl.value : state.password;
      if (!/.+@.+\..+/.test(email)) { appToast('Please add your email to create your account'); return false; }
      if (pw.length < 10) { appToast('Password needs 10+ characters'); return false; }
      var acceptance = window.TSOSLegal ? window.TSOSLegal.acceptance('cd') : null;
      if (!acceptance) { appToast('Please review both legal documents, check both agreement boxes, and type your full name as your signature.'); return false; }
      state.details.email = email;
      state.details.password = pw;
      state.details.website = domVal('cdWebsite', state.website);
      state.acceptance = acceptance;
      return true;
    }

    /* Step 4 (app): the app's day/window chips + confirm summary. */
    function appDays() {
      var days = [], names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var now = new Date();
      for (var i = 0; i < 5; i++) {
        var d = new Date(now.getTime() + (i + 1) * 864e5);
        var iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        days.push({ label: (i === 0 ? 'Tomorrow \u00b7 ' : '') + names[d.getDay()] + ' ' + months[d.getMonth()] + ' ' + d.getDate(), iso: iso });
      }
      return days;
    }
    function step4AppHtml() {
      var h = '<h3>Pick a day</h3>' +
        '<p class="sub">Pick a day and a window \u2014 your tech texts when they\u2019re on the way, no waiting around all day.</p>' +
        '<label>Pick a day</label><div class="zb-chips">';
      appDays().forEach(function (dy) {
        h += '<button type="button" class="zb-chip' + (state.date === dy.iso ? ' on' : '') + '" data-daypick="' + dy.iso + '" data-daylabel="' + esc(dy.label) + '">' + esc(dy.label) + '</button>';
      });
      h += '</div><label>Pick a window</label><div class="zb-chips">';
      WINDOWS.forEach(function (w) {
        h += '<button type="button" class="zb-chip' + (state.winId === w.v ? ' on' : '') + '" data-winpick="' + w.v + '" data-winlabel="' + esc(w.label) + '">' + esc(w.label) + '</button>';
      });
      h += '</div><p class="sub" data-availnote style="margin-top:8px;"></p>' +
        '<div class="zb-review">';
      var rows = [
        ['Appliance', state.appliance || 'Not selected'],
        ['Issue', state.issueChip || state.issue || 'General diagnosis'],
        ['When', (state.dayText || '\u2014') + (state.winLabel ? ' \u00b7 ' + state.winLabel : '')],
        ['Photo', state.photoSrc ? 'Attached \u2014 AI triage queued' : 'None']
      ];
      if (state.geo && state.geo.geoCity) rows.push(['Location-verified', state.geo.geoCity + ' \u00b7 ' + state.geo.geoTier]);
      rows.push(['Diagnostic due today', '$99.00']);
      rows.push(['Credited toward repair', '\u2212$99.00']);
      rows.forEach(function (r) {
        h += '<div class="rrow"><span class="rk">' + esc(r[0]) + '</span><span class="rv">' + esc(r[1]) + '</span></div>';
      });
      h += '</div>' +
        '<div class="zb-remind"><b>How the $99 works:</b> it\u2019s collected when our Service Setters confirm your booking \u2014 no card is charged in the app \u2014 then credited in full toward the repair when you approve the fix. If you decline the repair, the $99 covers the diagnosis visit. 90-day warranty on parts &amp; labor.</div>';
      return h;
    }

    /* Live arrival-window availability — the app's loadAppAvail
       semantics: closed windows disabled + labeled, a picked window
       that closes is unpicked, and the read never blocks booking. */
    function loadAppAvail() {
      if (!state.date) return;
      fetch(API + '/speedy/availability?date=' + encodeURIComponent(state.date))
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.data || !j.data.windows) return;
          var byId = {};
          j.data.windows.forEach(function (w) { byId[w.id] = w; });
          qa('[data-winpick]').forEach(function (chip) {
            var id = chip.getAttribute('data-winpick');
            var w = byId[id];
            if (!w) return;
            var base = APP_WIN_LABELS[id] || chip.getAttribute('data-winlabel');
            if (w.status === 'CLOSED') {
              chip.disabled = true;
              chip.style.opacity = '.45';
              chip.textContent = base + (w.reason === 'FULL' ? ' \u00b7 Full' : ' \u00b7 Passed');
              if (state.winId === id) { chip.classList.remove('on'); state.winLabel = ''; state.winId = ''; state.win = ''; }
            } else {
              chip.disabled = false;
              chip.style.opacity = '';
              chip.textContent = base;
            }
          });
          var note = q('[data-availnote]');
          if (note) note.textContent = j.data.capacityConfigured ? 'Live availability for the day you picked \u2014 full and passed windows are closed.' : '';
        })
        .catch(function () { /* leave every window pickable */ });
    }

    /* The /bookings payload — field-for-field the app's
       confirmBooking body (+ geo, as wired in b014b7db). */
    function buildAppPayload() {
      var d = state.details || { name: state.name, phone: state.phone, city: finalCity(), zip: state.zip, addr: state.address };
      var issue = state.issueChip || state.issue.trim() || 'General diagnosis';
      var payload = {
        customer: { name: d.name, phone: d.phone, address: d.addr || undefined },
        city: d.city,
        zip: d.zip,
        appliance: state.appliance || 'Refrigerator',
        issue: issue,
        preferredWindow: ((state.dayText || '') + ' \u00b7 ' + (state.winLabel || '')).trim() || undefined,
        preferredDate: state.date || undefined
      };
      try { if (window.TSOSAttribution) window.TSOSAttribution.attach(payload); } catch (e) { /* attribution is best-effort */ }
      try { if (window.TSOSGeo) Object.assign(payload, window.TSOSGeo); } catch (e) { /* geo is best-effort */ }
      if (state.geo) {
        payload.geoCity = state.geo.geoCity;
        payload.geoTier = state.geo.geoTier;
        payload.geoLat = state.geo.geoLat;
        payload.geoLng = state.geo.geoLng;
      }
      return payload;
    }

    function buildRegisterBody() {
      var d = state.details || {};
      var parts = (d.name || '').split(' ');
      return Object.assign({
        email: d.email, password: d.password,
        firstName: parts[0], lastName: parts.slice(1).join(' ') || undefined,
        phone: d.phone, termsAcceptance: state.acceptance,
        companyWebsite: d.website || ''
      }, window.TSOSIntakeShield ? window.TSOSIntakeShield.fields() : {});
    }

    /* The app's confirm flow, verbatim: signed-in books directly;
       guests register first (Layer 2 challenge included), then book
       through the page's cFetch; success feeds stage tracking. */
    function submitApp() {
      if (busy) return;
      busy = true;
      var btn = q('[data-act="next"]');
      function setBtn(t, en) { if (btn) { btn.textContent = t; btn.disabled = !en; } }
      setBtn('Booking\u2026', false);
      var payload = buildAppPayload();
      var d = state.details || {};
      function doBook() {
        payload.customer.email = window.cUser ? window.cUser.email : payload.customer.email;
        window.cFetch('/bookings', { method: 'POST', body: JSON.stringify(payload) })
          .then(function (j) {
            var bk = window.booking || {};
            bk.ref = j.data.referenceCode;
            bk.id = j.data.id;
            bk.payment = j.data.payment || null;
            bk.appliance = state.appliance;
            bk.issue = payload.issue;
            bk.day = state.dayText;
            bk.window = state.winLabel;
            bk.date = state.date;
            bk.photo = !!state.photoSrc;
            try { if (window.TSOSBookingSubmitted) window.TSOSBookingSubmitted(bk.ref); } catch (e) { /* tracking is best-effort */ }
            if (window.stageForBooking) window.stageIdx = window.stageForBooking(j.data);
            if (window.FEED) window.FEED.push({ time: 'Now', text: '<b>Top Speed:</b> New booking ' + bk.ref + ' received. A Service Setter will confirm by text shortly.' });
            setBtn('Confirm booking', true);
            busy = false;
            state.done = { ref: bk.ref, app: true };
            render();
            if (window.renderActiveJob) window.renderActiveJob();
          })
          .catch(function (e) { busy = false; setBtn('Confirm booking', true); appToast('Booking failed: ' + e.message); });
      }
      if (window.cUser) { doBook(); return; }
      var email = d.email;
      var regCtrl = window.AbortController ? new AbortController() : null;
      var regHard = regCtrl ? setTimeout(function () { regCtrl.abort(); }, 25000) : null;
      var regSlow = setTimeout(function () { setBtn('Still working \u2014 slow connection\u2026', false); }, 10000);
      fetch(API + '/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: regCtrl ? regCtrl.signal : undefined, body: JSON.stringify(buildRegisterBody()) })
        .then(function (r) {
          clearTimeout(regSlow);
          if (regHard) clearTimeout(regHard);
          return r.json().then(function (j) {
            if (!r.ok) throw new Error(r.status === 409 ? 'That email already has an account \u2014 use Sign in instead above.' : ((j.details && j.details.fieldErrors && j.details.fieldErrors.password) ? 'Password must be at least 10 characters.' : (j.error || 'Could not create your account')));
            return j;
          });
        })
        .then(function (j) {
          if (window.TSOSLayer2 && window.TSOSLayer2.isChallenge(j)) {
            window.TSOSLayer2.run(j, {
              onSession: function (s) { window.setCustSession(s); payload.customer.email = email; doBook(); },
              onCancel: function () { busy = false; setBtn('Confirm booking', true); appToast('Account created \u2014 sign in above and complete the 2-step code, then confirm your booking.'); }
            });
            return;
          }
          window.setCustSession(j);
          payload.customer.email = email;
          doBook();
        })
        .catch(function (e) {
          clearTimeout(regSlow);
          if (regHard) clearTimeout(regHard);
          busy = false;
          setBtn('Confirm booking', true);
          appToast(e && e.name === 'AbortError' ? 'This is taking too long \u2014 your connection may have stalled. Check your signal and try again. If your account was created, sign in above, then confirm your booking.' : e.message);
        });
    }

    function resetApp() {
      state.step = 1;
      state.appliance = ''; state.issue = ''; state.issueChip = '';
      state.photoSrc = ''; state.photoNote = '';
      state.date = ''; state.dayText = ''; state.winLabel = ''; state.winId = ''; state.win = '';
      state.done = null; state.details = null; state.acceptance = null;
      render();
    }

    function presetAppliance(name) {
      if (name) state.appliance = name;
      if (state.done) state.done = null;
      state.step = 1;
      render();
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
      if (appMode) snapshotLegal();
      if (state.done) { root.innerHTML = '<div class="zbw">' + doneHtml() + '</div>'; return; }
      var pane = state.step === 1 ? step1Html()
        : state.step === 2 ? (appMode ? step2AppHtml() : step2Html())
        : state.step === 3 ? (appMode ? step3AppHtml() : step3Html())
        : (appMode ? step4AppHtml() : step4Html());
      root.innerHTML = '<div class="zbw">' + stepperHtml() + pane +
        '<div class="zb-err" data-err></div>' +
        '<div class="zb-nav">' +
        (state.step > 1 ? '<button type="button" class="zb-back" data-act="back">Back</button>' : '') +
        '<button type="button" class="zb-next" data-act="next">' +
        (state.step === 4 ? CHECK + ' Confirm booking' : 'Continue') + '</button></div></div>';
      if (state.step === 1) {
        /* The render just rebuilt the DOM, so any live Google Map
           instance points at a detached node — drop it; the area UI
           refresh re-creates the preview when a key is present. */
        mapObj = null; mapMarker = null; mapTargetKey = '';
        refreshAreaUI();
      }
      if (state.step === 3) attachAddressAutocomplete();
      if (state.step === 4 && !appMode) loadAvail();
      if (appMode && state.step === 3) {
        if (window.cUser) {
          try { if (window.custApplyUser) window.custApplyUser(window.cUser); } catch (e) { /* page hook is best-effort */ }
        } else {
          mountLegal();
        }
      }
      if (appMode && state.step === 4) loadAppAvail();
      if (state.step === 2 && state.photoDiag) {
        var box = q('[data-photores]');
        if (box) { box.style.display = 'block'; box.innerHTML = '<b>Speedy\u2019s preliminary read</b><p>' + esc(state.photoDiag) + '</p>'; }
        var run = q('[data-act="photorun"]'); if (run && photoData) run.style.display = 'inline-block';
      }
    }

    root.addEventListener('input', function (ev) {
      if (appMode) snapshotLegal();
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
      if (appMode) snapshotLegal();
      var f = t.getAttribute && t.getAttribute('data-f');
      if (f === 'appphoto') {
        var pfile = t.files && t.files[0];
        if (pfile && window.URL && URL.createObjectURL) appShowPhoto(URL.createObjectURL(pfile));
        return;
      }
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
      var t = ev.target.closest ? ev.target.closest('[data-act],[data-pick],[data-appliance],[data-chip],[data-daypick],[data-winpick]') : null;
      if (!t) return;
      if (t.hasAttribute('data-chip')) {
        state.issueChip = t.getAttribute('data-chip');
        qa('[data-chip]').forEach(function (c) { c.classList.toggle('on', c.getAttribute('data-chip') === state.issueChip); });
        return;
      }
      if (t.hasAttribute('data-daypick')) {
        state.date = t.getAttribute('data-daypick');
        state.dayText = t.getAttribute('data-daylabel');
        qa('[data-daypick]').forEach(function (c) { c.classList.toggle('on', c === t); });
        loadAppAvail();
        return;
      }
      if (t.hasAttribute('data-winpick')) {
        state.winId = t.getAttribute('data-winpick');
        state.winLabel = t.getAttribute('data-winlabel');
        state.win = state.winId;
        qa('[data-winpick]').forEach(function (c) { c.classList.toggle('on', c === t); });
        return;
      }
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
      else if (act === 'appphotopick') { var afi = q('[data-f="appphoto"]'); if (afi) afi.click(); }
      else if (act === 'acct-login' || act === 'acct-create') {
        ev.preventDefault();
        state.acctMode = act === 'acct-login' ? 'login' : 'create';
        var nA = document.getElementById('cdNewAcct'), lA = document.getElementById('cdLogin');
        if (nA) nA.style.display = state.acctMode === 'login' ? 'none' : '';
        if (lA) lA.style.display = state.acctMode === 'login' ? '' : 'none';
      }
      else if (act === 'cust-login') { if (window.custLoginFromBook) window.custLoginFromBook(); }
      else if (act === 'cust-verify') { if (window.custVerify) window.custVerify('cd'); }
      else if (act === 'track') { if (window.showTab) window.showTab('track'); }
      else if (act === 'again') { resetApp(); }
      else if (act === 'back') { if (state.step > 1) { state.step -= 1; render(); } }
      else if (act === 'next') {
        if (appMode && state.step === 3) {
          if (!captureDetails()) return;
          state.step = 4;
          render();
        } else if (appMode && state.step === 4) {
          var av = validateStep(4);
          if (av) { setErr(av); return; }
          submitApp();
        } else if (state.step < 4) {
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
    var handle = { root: root, getState: function () { return state; }, buildPayload: buildPayload };
    if (appMode) {
      handle.buildAppPayload = buildAppPayload;
      handle.buildRegisterBody = buildRegisterBody;
      handle.captureDetails = captureDetails;
      handle.presetAppliance = presetAppliance;
      window.TSOSAppWizard = handle;
    }
    return handle;
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
