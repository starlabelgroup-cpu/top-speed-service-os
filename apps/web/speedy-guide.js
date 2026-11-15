/* Speedy Guide — pop-notification tour guide / inner-linking system.
   NOT chat: no input, no messages. Small Speedy pops + sitelink panel.
   Chat opens ONLY from the explicit "Talk to Speedy — chat" tap in the panel. */
(function () {
  'use strict';

  var path = location.pathname.replace(/\/+$/, '') || '/';
  var seg = path.split('/')[1] || '';

  /* ---- Self-disable on staff / internal / provider / tech surfaces ---- */
  var EXCLUDED = {
    'manager': 1, 'service': 1, 'book-os': 1, 'admin': 1, 'ad-studio': 1,
    'marketing-os': 1, 'publish-center': 1, 'local': 1, 'parts': 1, 'tech': 1,
    'crm': 1, 'finance': 1, 'portal': 1, 'service-setters': 1,
    'service-setters-dispatch': 1, 'track-console': 1, 'provider': 1,
    'technician': 1, 'chats': 1, 'flywheel': 1, 'academy': 1, 'advertiser': 1,
    'ads': 1, 'media': 1, 'notifications': 1, 'pro': 1, 'pro-booking': 1,
    'network': 1, 'network-business': 1, 'service-network': 1,
    'provider-join': 1, 'appliance-plug-app': 1, 'social': 1
  };
  if (EXCLUDED[seg]) return;

  /* ---- Session storage (guarded) ---- */
  function sget(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function sset(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var CALL = { label: 'Call 954-931-7997', href: 'tel:+19549317997' };

  /* ---- Main routes: the highway. Book + Call are ALWAYS here. ---- */
  var MAIN_ROUTES = [
    { label: 'Book a Repair', href: '/book' },
    { label: 'Track My Tech', href: '/track' },
    { label: 'My Garage', href: '/app' },
    { label: 'Photo Diagnosis', href: '/speedy' },
    { label: 'Offers & Rewards', href: '/offers-rewards' },
    { label: 'Refer & Earn', href: '/refer' },
    { label: 'Service Areas', href: '/service-areas-directory' },
    { label: 'Property Managers', href: '/property-managers' },
    { label: 'Commercial', href: '/commercial' },
    CALL
  ];

  /* ---- Contexts: where am I + the 3 nearest exits ---- */
  var L = {
    book: { label: 'Book a Repair', href: '/book' },
    track: { label: 'Track My Tech', href: '/track' },
    garage: { label: 'My Garage', href: '/app' },
    speedy: { label: 'Photo Diagnosis', href: '/speedy' },
    offers: { label: 'Offers & Rewards', href: '/offers-rewards' },
    refer: { label: 'Refer & Earn', href: '/refer' },
    areas: { label: 'Service Areas', href: '/service-areas-directory' },
    pm: { label: 'Property Managers', href: '/property-managers' },
    commercial: { label: 'Commercial', href: '/commercial' },
    cpapp: { label: 'Connect Pro App', href: '/connect-pro-app' },
    call: CALL
  };

  var CONTEXTS = {
    home:       { here: "You're on the home page", exits: [L.book, L.speedy, L.track] },
    app:        { here: "You're in the Appliance Connect customer app", exits: [L.book, L.track, L.offers] },
    book:       { here: "You're booking a repair", exits: [L.speedy, L.track, L.call] },
    track:      { here: "You're tracking your technician", exits: [L.book, L.garage, L.call] },
    cpapp:      { here: "You're in the Appliance Connect Pro app", exits: [L.book, L.track, L.pm] },
    cpsite:     { here: "You're on Appliance Connect Pro", exits: [L.cpapp, L.pm, L.book] },
    refer:      { here: "You're on Refer & Earn", exits: [L.offers, L.book, L.garage] },
    offers:     { here: "You're browsing Offers & Rewards", exits: [L.book, L.refer, L.garage] },
    areas:      { here: "You're in the Service Areas directory", exits: [L.book, L.speedy, L.track] },
    speedy:     { here: "You're on Photo Diagnosis with Speedy", exits: [L.book, L.track, L.garage] },
    commercial: { here: "You're on Commercial service", exits: [L.book, L.pm, L.call] },
    pm:         { here: "You're on Property Managers", exits: [L.cpapp, L.book, L.call] },
    garage:     { here: "You're in your garage", exits: [L.book, L.track, L.offers] },
    signup:     { here: "You're creating your account", exits: [L.book, L.garage, L.offers] },
    generic:    { here: "You're on Top Speed Appliance", exits: [L.book, L.track, L.garage] }
  };

  function contextFor() {
    if (path === '/') return CONTEXTS.home;
    if (path === '/app') return CONTEXTS.app;
    if (path === '/book' || path === '/smart-booking') return CONTEXTS.book;
    if (path === '/track') return CONTEXTS.track;
    if (path === '/connect-pro-app') return CONTEXTS.cpapp;
    if (path === '/connect-pro-site' || path === '/connect-pro') return CONTEXTS.cpsite;
    if (path === '/refer') return CONTEXTS.refer;
    if (path === '/offers-rewards' || seg === 'offers') return CONTEXTS.offers;
    if (path === '/service-areas-directory') return CONTEXTS.areas;
    if (path === '/speedy' || path === '/speedy-ai') return CONTEXTS.speedy;
    if (path === '/commercial' || path === '/appliance-pro' || path === '/appliance-pro-app' || path === '/appliance-pro-site') return CONTEXTS.commercial;
    if (path === '/property-managers') return CONTEXTS.pm;
    if (path === '/garage' || path === '/customer-accounts' || path === '/connect') return CONTEXTS.garage;
    if (path === '/signup') return CONTEXTS.signup;
    return CONTEXTS.generic;
  }

  var ctx = contextFor();
  var ctxKey = 'sg-' + (path === '/' ? 'home' : seg + path.replace(/\//g, '-'));

  /* ---- Tour stops ---- */
  var TOUR = [
    { title: 'Book a Repair', href: '/book', line: 'Book a real repair in about a minute — pick your appliance, the problem, and a time window that suits you.' },
    { title: 'Photo Diagnosis', href: '/speedy', line: 'Snap a photo of the problem and Speedy gives you a read on what is likely wrong before the tech arrives.' },
    { title: 'Track My Tech', href: '/track', line: 'Follow your job live through all eight stages, from request received to repair completed.' },
    { title: 'My Garage', href: '/app', line: 'Your appliances and their full service history live in your garage in the customer app.' },
    { title: 'Offers & Refer & Earn', href: '/offers-rewards', line: 'See your offers and rewards, and earn service credit when friends book through Refer & Earn.' },
    { title: 'Service Areas', href: '/service-areas-directory', line: 'We cover 65 cities across Broward, Palm Beach, and Miami-Dade — with a page for every service.' }
  ];

  /* ---- Styles ---- */
  var CSS = [
    '#sg-root{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#0d1b2e;-webkit-text-size-adjust:100%}',
    '#sg-root *{box-sizing:border-box}',
    '.sg-btn{position:fixed;left:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:9980;display:flex;align-items:center;gap:8px;background:#0A265C;color:#fff;border:2px solid #1280FF;border-radius:999px;padding:11px 18px;font:700 14px Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 10px 30px rgba(6,20,45,.45)}',
    '.sg-btn svg{width:19px;height:19px;flex:none}',
    '.sg-btn:focus-visible,.sg-x:focus-visible,.sg-link:focus-visible,.sg-act:focus-visible,.sg-tile:focus-visible{outline:3px solid #1280FF;outline-offset:2px}',
    '.sg-card{position:fixed;left:14px;bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:9981;width:min(332px,calc(100vw - 28px));background:#fff;border-radius:20px;box-shadow:0 24px 60px rgba(6,20,45,.5);opacity:0;visibility:hidden;pointer-events:none;transform:translateY(10px);transition:opacity .25s ease,transform .25s ease,visibility 0s linear .25s}',
    '.sg-card.sg-on{opacity:1;visibility:visible;pointer-events:auto;transform:translateY(0);transition:opacity .25s ease,transform .25s ease}',
    '#sg-root.sg-up .sg-btn{bottom:calc(100px + env(safe-area-inset-bottom,0px))}',
    '#sg-root.sg-up .sg-card{bottom:calc(170px + env(safe-area-inset-bottom,0px))}',
    /* pop */
    '.sg-pop-in{display:flex;gap:12px;padding:16px 16px 14px;align-items:flex-start}',
    '.sg-pop.sg-on .sg-pop-in{animation:sg-in .55s cubic-bezier(.34,1.35,.64,1) both}',
    '@keyframes sg-in{0%{opacity:0;transform:translateY(18px) scale(.72)}55%{opacity:1;transform:translateY(-3px) scale(1.05)}78%{transform:translateY(1px) scale(.99)}100%{opacity:1;transform:translateY(0) scale(1)}}',
    '.sg-avatar{position:relative;flex:none;width:54px;height:54px;animation:sg-bob 3.2s ease-in-out .8s infinite}',
    '.sg-avatar svg{width:54px;height:54px;display:block;filter:drop-shadow(0 6px 14px rgba(10,38,92,.35))}',
    '.sg-avatar::after{content:"";position:absolute;inset:-4px;border-radius:50%;border:2px solid rgba(18,128,255,.55);animation:sg-ring 2.6s ease-out infinite;pointer-events:none}',
    '@keyframes sg-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}',
    '@keyframes sg-ring{0%{transform:scale(.86);opacity:.85}70%{transform:scale(1.2);opacity:0}100%{transform:scale(1.2);opacity:0}}',
    '.sg-bubble{position:relative;flex:1;background:#F2F7FF;border:1px solid #DBE7FA;border-radius:14px;padding:11px 13px 12px}',
    '.sg-bubble::before{content:"";position:absolute;left:-6px;top:22px;width:12px;height:12px;background:#F2F7FF;border-left:1px solid #DBE7FA;border-bottom:1px solid #DBE7FA;transform:rotate(45deg)}',
    '.sg-q{font-size:15px;font-weight:700;line-height:1.35;margin:0 22px 3px 0}',
    '.sg-ctx{font-size:12.5px;color:#4A5D7E;line-height:1.4;margin:0 0 11px}',
    '.sg-row{display:flex;gap:8px;flex-wrap:wrap}',
    '.sg-act{border:none;border-radius:999px;padding:9px 15px;font:700 13.5px Inter,system-ui,sans-serif;cursor:pointer}',
    '.sg-act-yes{background:#E8322E;color:#fff;box-shadow:0 6px 16px rgba(232,50,46,.35)}',
    '.sg-act-no{background:#fff;color:#0A265C;border:1.5px solid #C9D6EA}',
    '.sg-x{position:absolute;top:8px;right:10px;background:none;border:none;font-size:19px;line-height:1;color:#8496B3;cursor:pointer;padding:2px 4px}',
    /* panel */
    '.sg-panel{padding:0;overflow:hidden;display:flex;flex-direction:column;max-height:min(68vh,600px)}',
    '.sg-panel.sg-on .sg-panel-body{animation:sg-up-in .3s ease both}',
    '@keyframes sg-up-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}',
    '.sg-head{display:flex;align-items:center;gap:9px;background:#0A265C;color:#fff;padding:13px 16px;flex:none}',
    '.sg-head svg{width:21px;height:21px}',
    '.sg-head b{font-size:15.5px;letter-spacing:.2px}',
    '.sg-head .sg-x{position:static;color:#BFD2F2;margin-left:auto;font-size:21px}',
    '.sg-panel-body{overflow-y:auto;padding:14px 16px 16px}',
    '.sg-here{display:flex;gap:8px;align-items:flex-start;background:#F2F7FF;border:1px solid #DBE7FA;border-radius:12px;padding:10px 12px;font-size:13.5px;font-weight:600;color:#0A265C;line-height:1.4}',
    '.sg-here svg{width:16px;height:16px;flex:none;margin-top:1px}',
    '.sg-sec{font-size:11.5px;font-weight:800;letter-spacing:.9px;text-transform:uppercase;color:#8496B3;margin:16px 0 8px}',
    '.sg-link{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:#fff;border:1.5px solid #D9E3F2;border-radius:12px;padding:11px 13px;margin:0 0 8px;font:700 14px Inter,system-ui,sans-serif;color:#0A265C;cursor:pointer;text-decoration:none}',
    '.sg-link:hover{border-color:#1280FF;background:#F2F7FF}',
    '.sg-link .sg-arrow{margin-left:auto;color:#1280FF;font-weight:800}',
    '.sg-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '.sg-tile{display:block;background:#0A265C;color:#fff;border-radius:12px;padding:11px 12px;font:700 13.5px Inter,system-ui,sans-serif;text-decoration:none;line-height:1.3}',
    '.sg-tile:hover{background:#1280FF}',
    '.sg-tile.sg-call{background:#E8322E}',
    '.sg-tour-btn{width:100%;background:#fff;border:1.5px dashed #1280FF;color:#0A265C;border-radius:12px;padding:11px 13px;font:800 14px Inter,system-ui,sans-serif;cursor:pointer;margin-top:14px}',
    '.sg-chat{width:100%;background:#fff;border:1.5px solid #0A265C;color:#0A265C;border-radius:12px;padding:11px 13px;font:800 14px Inter,system-ui,sans-serif;cursor:pointer;margin-top:10px;display:flex;align-items:center;justify-content:center;gap:8px}',
    '.sg-chat svg{width:17px;height:17px}',
    '.sg-note{font-size:11.5px;color:#8496B3;text-align:center;margin:9px 0 0;line-height:1.45}',
    /* tour */
    '.sg-tour{padding:16px}',
    '.sg-tour .sg-step{font-size:11.5px;font-weight:800;letter-spacing:.9px;text-transform:uppercase;color:#1280FF;margin:0 0 5px}',
    '.sg-tour h3{font-size:17px;margin:0 24px 6px 0;color:#0A265C}',
    '.sg-tour p{font-size:13.5px;line-height:1.5;color:#33475F;margin:0 0 13px}',
    '.sg-act-go{background:#0A265C;color:#fff}',
    '.sg-act-next{background:#E8322E;color:#fff}',
    '.sg-act-end{background:#fff;color:#4A5D7E;border:1.5px solid #C9D6EA}',
    '@media (prefers-reduced-motion: reduce){.sg-pop.sg-on .sg-pop-in,.sg-panel.sg-on .sg-panel-body{animation:none}.sg-avatar{animation:none}.sg-avatar::after{animation:none;display:none}.sg-card{transition:opacity .2s ease,visibility 0s linear .2s}.sg-card.sg-on{transition:opacity .2s ease}}'
  ].join('');

  var SPARK = '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="#0A265C"/><circle cx="24" cy="24" r="21" fill="none" stroke="#1280FF" stroke-width="2"/><path d="M24 7l3.7 11.8L39.5 22.5l-11.8 3.7L24 38l-3.7-11.8L8.5 22.5l11.8-3.7z" fill="#fff"/><circle cx="24" cy="22.5" r="2.4" fill="#E8322E"/></svg>';
  var COMPASS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2.1 4.9-4.9 2.1 2.1-4.9z" fill="currentColor" stroke="none"/></svg>';
  var PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="#E8322E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6.5-5.4-6.5-10.4A6.5 6.5 0 0 1 12 4a6.5 6.5 0 0 1 6.5 6.6C18.5 15.6 12 21 12 21z"/><circle cx="12" cy="10.6" r="2.3"/></svg>';
  var CHATICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A1.8 1.8 0 0 1 5.8 3.7h12.4A1.8 1.8 0 0 1 20 5.5v8.3a1.8 1.8 0 0 1-1.8 1.8H13l-4.6 3.9v-3.9H5.8A1.8 1.8 0 0 1 4 13.8z"/><path d="M7.6 9.3h.01M12 9.3h.01M16.4 9.3h.01" stroke-width="2.6"/></svg>';

  function linkRow(item) {
    return '<a class="sg-link" href="' + esc(item.href) + '">' + esc(item.label) + '<span class="sg-arrow" aria-hidden="true">&rarr;</span></a>';
  }
  function tile(item) {
    var cls = item.href.indexOf('tel:') === 0 ? 'sg-tile sg-call' : 'sg-tile';
    return '<a class="' + cls + '" href="' + esc(item.href) + '">' + esc(item.label) + '</a>';
  }

  /* ---- Build DOM ---- */
  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  var root = document.createElement('div');
  root.id = 'sg-root';

  var btn = document.createElement('button');
  btn.className = 'sg-btn';
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = COMPASS + '<span>Guide</span>';

  var pop = document.createElement('div');
  pop.className = 'sg-card sg-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Speedy Guide');
  pop.innerHTML =
    '<div class="sg-pop-in">' +
      '<div class="sg-avatar">' + SPARK + '</div>' +
      '<div class="sg-bubble">' +
        '<button class="sg-x" type="button" aria-label="Close">&times;</button>' +
        '<p class="sg-q">Hi, I&rsquo;m Speedy &mdash; need help with anything?</p>' +
        '<p class="sg-ctx">' + esc(ctx.here) + '. I can show you around.</p>' +
        '<div class="sg-row">' +
          '<button class="sg-act sg-act-yes" type="button">Yes &mdash; show me</button>' +
          '<button class="sg-act sg-act-no" type="button">Not now</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  var panel = document.createElement('div');
  panel.className = 'sg-card sg-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Speedy Guide — go anywhere');
  panel.innerHTML =
    '<div class="sg-head">' + SPARK + '<b>Speedy Guide</b>' +
      '<button class="sg-x" type="button" aria-label="Close guide">&times;</button></div>' +
    '<div class="sg-panel-body">' +
      '<div class="sg-here">' + PIN + '<span>You are here: ' + esc(ctx.here.replace(/^You're |^You are /, '')) + '</span></div>' +
      '<div class="sg-sec">Exits from here</div>' +
      ctx.exits.map(linkRow).join('') +
      '<div class="sg-sec">Main routes</div>' +
      '<div class="sg-grid">' + MAIN_ROUTES.map(tile).join('') + '</div>' +
      '<button class="sg-tour-btn" type="button">Take the tour</button>' +
      '<button class="sg-chat" type="button">' + CHATICON + '<span>Talk to Speedy &mdash; chat</span></button>' +
      '<p class="sg-note">The guide is links only. Chat opens only if you tap Talk to Speedy.</p>' +
    '</div>';

  var tour = document.createElement('div');
  tour.className = 'sg-card sg-tour';
  tour.setAttribute('role', 'dialog');
  tour.setAttribute('aria-label', 'Speedy Guide tour');

  root.appendChild(btn);
  root.appendChild(pop);
  root.appendChild(panel);
  root.appendChild(tour);
  document.body.appendChild(root);

  /* ---- Raise above bottom bars/navs (homepage sticky bar, app bottom nav) ---- */
  function detectRaise() {
    var up = false;
    if (document.querySelector('.bnav')) up = true;
    var sb = document.querySelector('.stickybar');
    if (sb && window.getComputedStyle(sb).display !== 'none') up = true;
    root.classList.toggle('sg-up', up);
  }
  detectRaise();
  var rzT;
  window.addEventListener('resize', function () { clearTimeout(rzT); rzT = setTimeout(detectRaise, 150); });

  /* ---- State / timers ---- */
  var popVisible = false, panelOpen = false, tourIdx = -1;
  var fadeTimer = null, idleTimer = null, lastAct = Date.now();

  function showPop() {
    if (sget('sg-nonag')) return;
    hidePanel(); stopTour();
    pop.classList.add('sg-on');
    popVisible = true;
    sset('sg-pop-' + ctxKey, '1');
    startFadeTimer();
  }
  function hidePop() {
    pop.classList.remove('sg-on');
    popVisible = false;
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  }
  function startFadeTimer() {
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(function () {
      if (!popVisible) return;
      hidePop();
      if (!sget('sg-act-' + ctxKey)) sset('sg-act-' + ctxKey, 'fade');
    }, 14000);
  }
  pop.addEventListener('pointerenter', function () { if (fadeTimer) clearTimeout(fadeTimer); });
  pop.addEventListener('pointerleave', function () { if (popVisible) startFadeTimer(); });
  pop.addEventListener('pointerdown', function () { if (fadeTimer) clearTimeout(fadeTimer); });

  function openPanel() {
    hidePop(); stopTour();
    panel.classList.add('sg-on');
    panelOpen = true;
    btn.setAttribute('aria-expanded', 'true');
  }
  function hidePanel() {
    panel.classList.remove('sg-on');
    panelOpen = false;
    btn.setAttribute('aria-expanded', 'false');
  }

  /* ---- Chat: ONLY from the explicit tap, via the page's own mechanism ---- */
  function openChat() {
    hidePanel(); hidePop(); stopTour();
    if (typeof window.TSOpenSpeedy === 'function') { window.TSOpenSpeedy(); return; }
    var tswBtn = document.querySelector('.tsw-btn');
    if (tswBtn) { tswBtn.click(); return; }
    if (typeof window.toggleSpeedy === 'function') { window.toggleSpeedy(); return; }
    location.href = '/speedy';
  }

  /* ---- Tour ---- */
  function renderTour() {
    var s = TOUR[tourIdx];
    var last = tourIdx === TOUR.length - 1;
    tour.innerHTML =
      '<button class="sg-x" type="button" aria-label="End tour">&times;</button>' +
      '<p class="sg-step">Tour &middot; Stop ' + (tourIdx + 1) + ' of ' + TOUR.length + '</p>' +
      '<h3>' + esc(s.title) + '</h3>' +
      '<p>' + esc(s.line) + '</p>' +
      '<div class="sg-row">' +
        '<button class="sg-act sg-act-go" type="button">Go there</button>' +
        '<button class="sg-act sg-act-next" type="button">' + (last ? 'Finish' : 'Next') + '</button>' +
        '<button class="sg-act sg-act-end" type="button">End tour</button>' +
      '</div>';
    tour.querySelector('.sg-x').addEventListener('click', stopTour);
    var acts = tour.querySelectorAll('.sg-act');
    acts[0].addEventListener('click', function () { location.href = s.href; });
    acts[1].addEventListener('click', function () {
      if (last) { stopTour(); } else { tourIdx++; renderTour(); }
    });
    acts[2].addEventListener('click', stopTour);
  }
  function startTour() {
    hidePanel(); hidePop();
    tourIdx = 0;
    renderTour();
    tour.classList.add('sg-on');
  }
  function stopTour() {
    tour.classList.remove('sg-on');
    tourIdx = -1;
  }

  /* ---- Wire up ---- */
  btn.addEventListener('click', function () {
    if (panelOpen) { hidePanel(); } else { openPanel(); }
  });
  pop.querySelector('.sg-x').addEventListener('click', function () {
    sset('sg-act-' + ctxKey, 'close');
    hidePop();
  });
  pop.querySelector('.sg-act-no').addEventListener('click', function () {
    sset('sg-nonag', '1');           /* Not now = no more pops this session */
    sset('sg-act-' + ctxKey, 'notnow');
    hidePop();
  });
  pop.querySelector('.sg-act-yes').addEventListener('click', function () {
    sset('sg-act-' + ctxKey, 'yes');
    openPanel();                     /* Guide panel only — never chat */
  });
  panel.querySelector('.sg-head .sg-x').addEventListener('click', hidePanel);
  panel.querySelector('.sg-tour-btn').addEventListener('click', startTour);
  panel.querySelector('.sg-chat').addEventListener('click', openChat);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { hidePanel(); hidePop(); stopTour(); }
  });

  /* ---- Arrival pop (~2s), once per context per session ---- */
  function tryArrival() {
    if (document.hidden) {
      document.addEventListener('visibilitychange', function h() {
        if (!document.hidden) { document.removeEventListener('visibilitychange', h); tryArrival(); }
      });
      return;
    }
    if (!sget('sg-nonag') && !sget('sg-pop-' + ctxKey)) showPop();
  }
  setTimeout(tryArrival, 2000);

  /* ---- Idle pop (~45s, once per context, only if the first pop faded untouched) ---- */
  ['pointerdown', 'keydown', 'scroll', 'touchstart', 'wheel'].forEach(function (ev) {
    window.addEventListener(ev, function () { lastAct = Date.now(); }, { passive: true });
  });
  idleTimer = setInterval(function () {
    if (document.hidden || popVisible || panelOpen || tourIdx >= 0) return;
    if (sget('sg-nonag') || sget('sg-idle-' + ctxKey)) return;
    if (sget('sg-act-' + ctxKey) !== 'fade') return;
    if (Date.now() - lastAct >= 45000) {
      sset('sg-idle-' + ctxKey, '1');
      showPop();
    }
  }, 5000);
})();
