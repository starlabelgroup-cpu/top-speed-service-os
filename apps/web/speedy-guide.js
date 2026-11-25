/* Speedy Guide — pop-notification tour guide / inner-linking system.
   NOT chat: no input, no messages. Small Speedy pops + a sitelink panel.
   Chat opens ONLY from the explicit "Talk to Speedy — chat" tap in the panel.
   Behavioral rules (Ramone): no waste customers, and respect their space —
   any dismissal silences ALL pops for the session; pops wait for a natural
   pause; max 1 standard pop per page context, max 3 pops per session;
   one calm "still lost" insight pop per session at most. Friendly, no pressure. */
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
  function snum(k) { var v = parseInt(sget(k) || '0', 10); return isNaN(v) ? 0 : v; }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var CALL = { label: 'Call 844-460-7038', href: 'tel:+18444607038' };

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

  /* ---- Full catalog: EVERY customer option in the ecosystem (Ramone,
     2026-11-17) — every platform door, app, website, and key page,
     grouped the way a customer thinks. Staff/internal surfaces are
     excluded by design (the team has the Navigator). Absolute URLs so
     the guide is correct on every host that serves it. Items flagged
     handoff:1 are receiver-ready signed-in doors — on vault-wired
     surfaces they route through TSOSVault.handoffUrl() at click time;
     everywhere else (and whenever signed out) they stay plain links. */
  var CATALOG = [
    { title: 'Book & track service', items: [
      { label: 'Book a Repair', href: 'https://topspeedserviceos.com/book', keys: 'book repair appointment schedule form' },
      { label: 'Book with Speedy Chat', href: 'https://topspeedserviceos.com/speedy', keys: 'chat speedy book ai assistant' },
      { label: 'Track My Tech', href: 'https://topspeedserviceos.com/track', keys: 'track technician job status eta stages' },
      { label: 'Services & Pricing', href: 'https://topspeedserviceos.com/home-appliance-services', keys: 'services pricing repair cost diagnostic labor installation' },
      { label: 'Warranty & Terms', href: 'https://topspeedserviceos.com/legal', keys: 'warranty guarantee terms legal 90 day' },
      { label: 'Reviews Wall', href: 'https://www.pepperlists.com', keys: 'reviews ratings wall pepper lists post verified' },
      { label: 'Service Areas — 104 Cities', href: 'https://topspeedserviceos.com/service-areas-directory', keys: 'cities areas coverage near me landing pages directory' }
    ]},
    { title: 'Platforms', items: [
      { label: 'Top Speed Service OS', href: 'https://topspeedserviceos.com/', keys: 'hub home main platform service os' },
      { label: 'Top Speed Appliance (.net)', href: 'https://topspeedappliance.net', keys: 'website flagship residential repair net' },
      { label: 'Top Speed Appliance Repair — Brand Site', href: 'https://topspeedappliancerepair.com', keys: 'brand site appliance repair broward landing page repair' },
      { label: 'Provider Network — Join Us', href: 'https://topspeedapplianceservice.com', keys: 'join provider technician network work business' },
      { label: 'Appliance Connect Pro', href: 'https://www.applianceconnectpro.com', keys: 'homeowners property managers portal connect pro', handoff: 1 },
      { label: 'Appliance Pro — Commercial', href: 'https://www.appliancepro.net', keys: 'commercial business accounts facilities pro' },
      { label: 'Cleanout Vents', href: 'https://www.cleanoutvents.com', keys: 'dryer vent cleaning vents partner' },
      { label: 'Pepper Lists — Sell · Post · Book', href: 'https://www.pepperlists.com', keys: 'pepper lists sell post book marketplace reviews', handoff: 1 },
      { label: 'Pepper Lists — How It Works', href: 'https://www.pepperlists.com/how-it-works', keys: 'pepper lists channels facebook ebay etsy walmart tiktok instagram youtube linkedin agent muse sell post book' },
      { label: 'Refer & Earn', href: 'https://appliancereferral.com', keys: 'referral credit invite friend earn refer' },
      { label: 'Advertise With Us', href: 'https://topspeedserviceos.com/advertise', keys: 'advertise flywheel business ads marketing' },
      { label: 'Parts Supply — Appliance Plus', href: 'https://applianceplus.vercel.app', keys: 'parts catalog supply plus ai trade' },
      { label: 'CocoCane', href: 'https://www.facebook.com/profile.php?id=61593313075645', keys: 'cococane coconut juice shop facebook drinks' }
    ]},
    { title: 'Apps', items: [
      { label: 'Customer App', href: 'https://topspeedserviceos.com/app', keys: 'app account garage bookings appliance connect' },
      { label: 'Appliance Connect Mobile', href: 'https://appliance-connect.vercel.app/mobile', keys: 'mobile sign in phone app connect', handoff: 1 },
      { label: 'Pepper Lists App', href: 'https://www.pepperlists.com', keys: 'pepper lists app sell post book phone' },
      { label: 'Appliance Plug — Clients Only', href: 'https://www.applianceplug.app', keys: 'appliance plug tech tool parts plate clients' },
      { label: 'Speedy Pro — Tech App', href: 'https://topspeedserviceos.com/speedy-pro', keys: 'speedy pro technician provider app jobs' },
      { label: 'Get the Apps', href: 'https://topspeedserviceos.com/download', keys: 'download install apps get' }
    ]},
    { title: 'Help & company info', items: [
      { label: 'Photo Diagnosis', href: 'https://topspeedserviceos.com/speedy', keys: 'photo diagnosis speedy problem picture' },
      { label: 'About Top Speed', href: 'https://topspeedserviceos.com/about', keys: 'about company how it works ecosystem hours' },
      { label: 'Offers & Rewards', href: 'https://topspeedserviceos.com/offers-rewards', keys: 'offers discounts programs rewards deals' },
      { label: 'Explore — Price Preview', href: 'https://topspeedserviceos.com/explore', keys: 'explore search compare estimate preview recommendations' },
      { label: 'Memberships & Plans', href: 'https://topspeedserviceos.com/memberships', keys: 'memberships maintenance plans priority' },
      { label: 'Call 844-460-7038', href: 'tel:+18444607038', keys: 'call phone contact team' }
    ]}
  ];

  /* ---- Contexts: where am I, the 3 nearest exits, and a calm insight line ---- */
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
    home:       { here: "You're on the home page",
                  exits: [L.book, L.speedy, L.track],
                  insight: "Here's what you can do from this page: book a repair, send Speedy a photo of the problem for a plain-language read, or track a job that's already booked." },
    app:        { here: "You're in the Appliance Connect customer app",
                  exits: [L.book, L.track, L.offers],
                  insight: "Here's what you can do from the app: book a repair, track your technician, and see your appliances and their service history in your garage." },
    book:       { here: "You're booking a repair",
                  exits: [L.speedy, L.track, L.call],
                  insight: "This page books your repair in a few steps — the appliance, what's happening, and a time window. Not sure what's wrong yet? A photo helps Speedy explain it first." },
    track:      { here: "You're tracking your technician",
                  exits: [L.book, L.garage, L.call],
                  insight: "This page follows your repair through all eight stages, so you always know what happens next. If you haven't booked yet, booking only takes a few steps." },
    cpapp:      { here: "You're in the Appliance Connect Pro app",
                  exits: [L.book, L.track, L.pm],
                  insight: "From here you can book service for your units, track jobs in progress, and keep every property's appliances in one place." },
    cpsite:     { here: "You're on Appliance Connect Pro",
                  exits: [L.cpapp, L.pm, L.book],
                  insight: "This page explains the Connect Pro app for homeowners and property managers — one place for every unit's appliances, bookings, and history." },
    refer:      { here: "You're on Refer & Earn",
                  exits: [L.offers, L.book, L.garage],
                  insight: "From here you can share your referral link and earn service credit when friends book — and check the offers waiting for you." },
    offers:     { here: "You're browsing Offers & Rewards",
                  exits: [L.book, L.refer, L.garage],
                  insight: "These pages hold your offers and rewards — what's available, and how each one works. When you're ready, booking a repair is one tap away." },
    areas:      { here: "You're in the Service Areas directory",
                  exits: [L.book, L.speedy, L.track],
                  insight: "This directory lists all 104 cities we cover and every service page. Pick your city to see what's available near you." },
    speedy:     { here: "You're on Photo Diagnosis with Speedy",
                  exits: [L.book, L.track, L.garage],
                  insight: "Here's what happens on this page: send a photo of the problem and Speedy explains, in plain language, what it usually means and what happens next. A technician confirms everything in person before any work." },
    commercial: { here: "You're on Commercial service",
                  exits: [L.book, L.pm, L.call],
                  insight: "This section covers commercial accounts — service for restaurants, laundromats, and facilities, priced by custom quote after we see the equipment." },
    pm:         { here: "You're on Property Managers",
                  exits: [L.cpapp, L.book, L.call],
                  insight: "This page is for property managers: one portal for every unit's appliances, bookings, and service history." },
    garage:     { here: "You're in your garage",
                  exits: [L.book, L.track, L.offers],
                  insight: "Your garage holds your appliances and their service history. From here you can book a repair for any of them, or track a job in progress." },
    signup:     { here: "You're creating your account",
                  exits: [L.book, L.garage, L.offers],
                  insight: "Creating an account keeps your appliances, bookings, and history in one place. It only takes a moment — and booking works without one, too." },
    generic:    { here: "You're on Top Speed Appliance",
                  exits: [L.book, L.track, L.garage],
                  insight: "Here's what you can do from here: book a repair, send Speedy a photo of the problem, or track a job that's already booked." }
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
  var ctxKey = path.replace(/\//g, '-').replace(/^-/, '') || 'home';

  /* Count this visit (repeat-visit "still lost" signal) */
  var visits = snum('sg-visits-' + ctxKey) + 1;
  sset('sg-visits-' + ctxKey, String(visits));

  /* ---- Tour stops — calm, plain, hospital-style explanations ---- */
  var TOUR = [
    { title: 'Book a Repair', href: '/book', line: 'Booking is a few calm steps: the appliance, what\'s happening, and a time window. You\'ll know the terms up front — a $99 diagnostic, credited in full toward your repair, and a written quote you approve before any work starts.' },
    { title: 'Photo Diagnosis', href: '/speedy', line: 'A photo can tell us a lot. Send one and Speedy explains, in plain language, what the problem usually means and what would happen next. Nothing is final from a photo — a technician confirms it in person, and every repair is backed by a 90-day warranty.' },
    { title: 'Track My Tech', href: '/track', line: 'Think of it like being kept updated during care: your repair moves through eight stages, from request received to repair completed, and you can see exactly where things stand at any moment.' },
    { title: 'My Garage', href: '/app', line: 'Your garage keeps your appliances and their full service history in one place — like a chart for your home, ready whenever you need it.' },
    { title: 'Offers & Refer & Earn', href: '/offers-rewards', line: 'See the offers and rewards waiting for you, and earn service credit when friends book through Refer & Earn.' },
    { title: 'Service Areas', href: '/service-areas-directory', line: 'We cover 104 cities across Broward, Palm Beach, and Miami-Dade — with a page for every service.' }
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
    /* pops (help + insight share the avatar/bubble layout) */
    '.sg-pop-in{display:flex;gap:12px;padding:16px 16px 14px;align-items:flex-start}',
    '.sg-anim.sg-on .sg-pop-in{animation:sg-in .55s cubic-bezier(.34,1.35,.64,1) both}',
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
    '.sg-insight-txt{font-size:13.5px;color:#33475F;line-height:1.5;margin:0 0 11px}',
    '.sg-mini{display:block;background:#fff;border:1.5px solid #D9E3F2;border-radius:10px;padding:8px 11px;margin:0 0 7px;font:700 13px Inter,system-ui,sans-serif;color:#0A265C;text-decoration:none}',
    '.sg-mini:hover{border-color:#1280FF}',
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
    /* catalog search */
    '.sg-search{width:100%;margin:14px 0 2px;padding:11px 13px;border:1.5px solid #D9E3F2;border-radius:12px;font:600 14px Inter,system-ui,sans-serif;color:#0A265C;background:#F8FAFF;-webkit-appearance:none;appearance:none}',
    '.sg-search:focus{outline:3px solid #1280FF;outline-offset:1px;border-color:#1280FF}',
    '.sg-noresults{font-size:13px;color:#4A5D7E;line-height:1.45;margin:10px 0 0}',
    /* tour */
    '.sg-tour{padding:16px}',
    '.sg-tour .sg-step{font-size:11.5px;font-weight:800;letter-spacing:.9px;text-transform:uppercase;color:#1280FF;margin:0 0 5px}',
    '.sg-tour h3{font-size:17px;margin:0 24px 6px 0;color:#0A265C}',
    '.sg-tour p{font-size:13.5px;line-height:1.5;color:#33475F;margin:0 0 13px}',
    '.sg-act-go{background:#0A265C;color:#fff}',
    '.sg-act-next{background:#E8322E;color:#fff}',
    '.sg-act-end{background:#fff;color:#4A5D7E;border:1.5px solid #C9D6EA}',
    '@media (prefers-reduced-motion: reduce){.sg-anim.sg-on .sg-pop-in,.sg-panel.sg-on .sg-panel-body{animation:none}.sg-avatar{animation:none}.sg-avatar::after{animation:none;display:none}.sg-card{transition:opacity .2s ease,visibility 0s linear .2s}.sg-card.sg-on{transition:opacity .2s ease}}'
  ].join('');

  var SPARK = '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="#0A265C"/><circle cx="24" cy="24" r="21" fill="none" stroke="#1280FF" stroke-width="2"/><path d="M24 7l3.7 11.8L39.5 22.5l-11.8 3.7L24 38l-3.7-11.8L8.5 22.5l11.8-3.7z" fill="#fff"/><circle cx="24" cy="22.5" r="2.4" fill="#E8322E"/></svg>';
  var COMPASS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2.1 4.9-4.9 2.1 2.1-4.9z" fill="currentColor" stroke="none"/></svg>';
  var PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="#E8322E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6.5-5.4-6.5-10.4A6.5 6.5 0 0 1 12 4a6.5 6.5 0 0 1 6.5 6.6C18.5 15.6 12 21 12 21z"/><circle cx="12" cy="10.6" r="2.3"/></svg>';
  var CHATICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A1.8 1.8 0 0 1 5.8 3.7h12.4A1.8 1.8 0 0 1 20 5.5v8.3a1.8 1.8 0 0 1-1.8 1.8H13l-4.6 3.9v-3.9H5.8A1.8 1.8 0 0 1 4 13.8z"/><path d="M7.6 9.3h.01M12 9.3h.01M16.4 9.3h.01" stroke-width="2.6"/></svg>';

  function linkRow(item) {
    return '<a class="sg-link" href="' + esc(item.href) + '">' + esc(item.label) + '<span class="sg-arrow" aria-hidden="true">&rarr;</span></a>';
  }
  function catLink(item) {
    var attrs = item.handoff ? ' data-handoff="1"' : '';
    var hay = (item.label + ' ' + (item.keys || '')).toLowerCase();
    return '<a class="sg-link sg-cat-link" data-keys="' + esc(hay) + '"' + attrs + ' href="' + esc(item.href) + '">' + esc(item.label) + '<span class="sg-arrow" aria-hidden="true">&rarr;</span></a>';
  }
  function catGroup(group) {
    return '<div class="sg-group"><div class="sg-sec">' + esc(group.title) + '</div>' + group.items.map(catLink).join('') + '</div>';
  }
  function tile(item) {
    var cls = item.href.indexOf('tel:') === 0 ? 'sg-tile sg-call' : 'sg-tile';
    return '<a class="' + cls + '" href="' + esc(item.href) + '">' + esc(item.label) + '</a>';
  }
  function miniLink(item) {
    return '<a class="sg-mini" href="' + esc(item.href) + '">' + esc(item.label) + '</a>';
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

  /* Standard help pop */
  var pop = document.createElement('div');
  pop.className = 'sg-card sg-pop sg-anim';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Speedy Guide');
  pop.innerHTML =
    '<div class="sg-pop-in">' +
      '<div class="sg-avatar">' + SPARK + '</div>' +
      '<div class="sg-bubble">' +
        '<button class="sg-x" type="button" aria-label="Close">&times;</button>' +
        '<p class="sg-q">Hi, I&rsquo;m Speedy, Top Speed&rsquo;s Assistant Manager &mdash; need help with anything?</p>' +
        '<p class="sg-ctx">' + esc(ctx.here) + '. I can show you around.</p>' +
        '<div class="sg-row">' +
          '<button class="sg-act sg-act-yes" type="button">Yes &mdash; show me</button>' +
          '<button class="sg-act sg-act-no" type="button">Not now</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  /* "Still lost" insight pop — informational, never pushy */
  var insight = document.createElement('div');
  insight.className = 'sg-card sg-insight sg-anim';
  insight.setAttribute('role', 'dialog');
  insight.setAttribute('aria-label', 'Speedy Guide — a few pointers');
  insight.innerHTML =
    '<div class="sg-pop-in">' +
      '<div class="sg-avatar">' + SPARK + '</div>' +
      '<div class="sg-bubble">' +
        '<button class="sg-x" type="button" aria-label="Close">&times;</button>' +
        '<p class="sg-q">Just a few pointers</p>' +
        '<p class="sg-insight-txt">' + esc(ctx.insight) + '</p>' +
        ctx.exits.map(miniLink).join('') +
        '<div class="sg-row" style="margin-top:9px">' +
          '<button class="sg-act sg-act-no" type="button">Not now</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  /* Guide panel — the highway */
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
      '<input class="sg-search" type="search" placeholder="Search all options" aria-label="Search all options in the guide">' +
      CATALOG.map(catGroup).join('') +
      '<p class="sg-noresults" hidden>No match in the guide &mdash; Book and Call are always right above, and Speedy can help in chat.</p>' +
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
  root.appendChild(insight);
  root.appendChild(panel);
  root.appendChild(tour);
  document.body.appendChild(root);

  /* ---- Bottom dock coordinator (2026-11-24 floating-stack fix) ----
     One measured geometry for every fixed bottom control on the page:
     the bar (.stickybar fixed / .bnav in-flow), the account chip
     (#tsosAccountSwitcher), this Guide, and the Speedy button
     (#speedyBtn inline or .tsw-btn widget). Before this, each layer
     hard-coded its own bottom offset: the chip rendered on top of the
     Guide in the same corner, both rendered over the bars, and pages
     reserved little or no end-of-scroll space, so the stack hid page
     content (Ramone's tablet screenshots, 2026-11-24). Now the left
     column stacks bar -> chip -> Guide, the Speedy button docks above
     the bar on the right, and the page (or the app shell's .screens
     scroller) receives exactly the end clearance the measured stack
     needs. No control's action or destination changes. */
  var dockSpacer = null, dockQueued = false;
  function dockH(el) { return (el && el.offsetHeight) ? el.offsetHeight : 0; }
  function dockLayout() {
    if (!document.body) return;
    var GAP = 8;
    /* Bar clearance = distance from the viewport bottom to the bar's top
       edge (not just its height): the /app shell centers its column at
       wide viewports, so its in-flow .bnav can float above the viewport
       bottom, and the dock must align to where the bar actually is. */
    var bar = 0;
    var sb = document.querySelector('.stickybar');
    if (sb && dockH(sb) && window.getComputedStyle(sb).display !== 'none') {
      bar = Math.max(0, window.innerHeight - Math.round(sb.getBoundingClientRect().top));
    }
    if (!bar) {
      var bn = document.querySelector('.bnav');
      if (bn && dockH(bn)) bar = Math.max(0, window.innerHeight - Math.round(bn.getBoundingClientRect().top));
    }
    /* left column: chip above the bar, Guide above the chip */
    var chip = document.getElementById('tsosAccountSwitcher');
    var chipH = dockH(chip);
    if (chip && chipH) chip.style.bottom = (bar + GAP) + 'px';
    var chipTop = chipH ? bar + GAP + chipH : 0;
    var guideBottom = chipH ? chipTop + GAP : bar + 12;
    btn.style.bottom = 'calc(' + guideBottom + 'px + env(safe-area-inset-bottom,0px))';
    var btnH = dockH(btn) || 45;
    var cards = root.querySelectorAll('.sg-card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].style.bottom = 'calc(' + (guideBottom + btnH + 10) + 'px + env(safe-area-inset-bottom,0px))';
    }
    root.classList.toggle('sg-up', bar > 0 || chipH > 0);
    /* right column: Speedy button above the bar; widget panel above it */
    var sBtn = document.getElementById('speedyBtn') || document.querySelector('.tsw-btn');
    var rightTop = 0;
    if (sBtn && dockH(sBtn)) {
      var sBottom = Math.max(14, bar + 12);
      sBtn.style.bottom = 'calc(' + sBottom + 'px + env(safe-area-inset-bottom,0px))';
      rightTop = sBottom + dockH(sBtn);
      var panel2 = document.querySelector('.tsw-panel');
      if (panel2 && window.innerWidth > 640) {
        panel2.style.bottom = 'calc(' + (sBottom + dockH(sBtn) + GAP) + 'px + env(safe-area-inset-bottom,0px))';
      }
    }
    var dockTop = Math.max(guideBottom + btnH, rightTop);
    var clear = dockTop + 12;
    /* end-of-scroll clearance: app scroller, else a measured page spacer */
    var screens = document.querySelector('.screens');
    if (screens && dockH(screens)) {
      var want = Math.max(0, dockTop - bar) + GAP;
      var cur = parseFloat(window.getComputedStyle(screens).paddingBottom) || 0;
      if (cur < want) screens.style.paddingBottom = want + 'px';
    } else {
      var reserve = 0, kids = document.body.children;
      for (var k = kids.length - 1; k >= 0; k--) {
        var el = kids[k];
        if (el === root || el === dockSpacer) continue;
        if (el.id === 'tsosAccountSwitcher' || el.id === 'sg-root') continue;
        if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'LINK') continue;
        var cs = window.getComputedStyle(el);
        if (cs.position === 'fixed' || cs.position === 'absolute') continue;
        reserve = (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.marginBottom) || 0);
        break;
      }
      var need = Math.max(0, Math.round(clear - reserve));
      if (need > 0) {
        if (!dockSpacer) {
          dockSpacer = document.createElement('div');
          dockSpacer.id = 'tsDockSpacer';
          dockSpacer.setAttribute('aria-hidden', 'true');
          document.body.appendChild(dockSpacer);
        }
        dockSpacer.style.height = need + 'px';
      } else if (dockSpacer) { dockSpacer.style.height = '0px'; }
    }
  }
  function detectRaise() {
    if (dockQueued) return;
    dockQueued = true;
    var run = function () { dockQueued = false; dockLayout(); };
    if (window.requestAnimationFrame) window.requestAnimationFrame(run); else run();
  }
  detectRaise();
  var rzT;
  window.addEventListener('resize', function () { clearTimeout(rzT); rzT = setTimeout(detectRaise, 150); });
  window.addEventListener('load', detectRaise);
  [300, 900, 2000, 4000].forEach(function (ms) { setTimeout(detectRaise, ms); });
  if (window.MutationObserver && document.body) {
    var dockObs = new MutationObserver(detectRaise);
    dockObs.observe(document.body, { childList: true });
    setTimeout(function () { dockObs.disconnect(); }, 15000);
  }

  /* ---- Activity tracking: pops only ever appear in a natural pause ---- */
  var lastAct = Date.now();
  ['pointerdown', 'keydown', 'scroll', 'touchstart', 'wheel'].forEach(function (ev) {
    window.addEventListener(ev, function () { lastAct = Date.now(); }, { passive: true });
  });

  /* Wait until the customer has paused (~1.5s without scroll/click/key),
     then run cb. If no pause comes within ~24s, run giveUp instead. */
  function whenPaused(cb, giveUp) {
    var tries = 0;
    (function check() {
      if (document.hidden) { if (giveUp) giveUp(); return; }
      if (Date.now() - lastAct >= 1500) { cb(); return; }
      if (++tries > 30) { if (giveUp) giveUp(); return; }
      setTimeout(check, 800);
    })();
  }

  /* ---- Pop state ---- */
  var popVisible = false, insightVisible = false, panelOpen = false, tourIdx = -1;
  var fadeTimer = null;

  function popCount() { return snum('sg-popcount'); }
  function countPop() { sset('sg-popcount', String(popCount() + 1)); }
  function silenced() { return !!sget('sg-quiet'); }
  function anythingOpen() { return popVisible || insightVisible || panelOpen || tourIdx >= 0; }

  function armFade(card, ms, onFade) {
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(function () { onFade(); }, ms);
    card.onpointerenter = function () { if (fadeTimer) clearTimeout(fadeTimer); };
    card.onpointerdown = function () { if (fadeTimer) clearTimeout(fadeTimer); };
    card.onpointerleave = function () {
      if (fadeTimer) clearTimeout(fadeTimer);
      fadeTimer = setTimeout(function () { onFade(); }, ms);
    };
  }

  function showPop() {
    if (silenced() || popCount() >= 3 || anythingOpen()) return;
    hidePanel(); stopTour(); hideInsight();
    pop.classList.add('sg-on');
    popVisible = true;
    countPop();
    sset('sg-pop-' + ctxKey, '1');
    armFade(pop, 14000, function () {
      hidePop();
      sset('sg-act-' + ctxKey, 'fade');   /* faded untouched — a later stall may offer pointers */
    });
  }
  function hidePop() {
    pop.classList.remove('sg-on');
    popVisible = false;
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  }

  function showInsight() {
    if (silenced() || sget('sg-insight') || popCount() >= 3 || anythingOpen()) return;
    hidePanel(); stopTour(); hidePop();
    insight.classList.add('sg-on');
    insightVisible = true;
    countPop();
    sset('sg-insight', '1');
    armFade(insight, 16000, hideInsight);
  }
  function hideInsight() {
    insight.classList.remove('sg-on');
    insightVisible = false;
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  }

  function openPanel() {
    hidePop(); hideInsight(); stopTour();
    panel.classList.add('sg-on');
    panelOpen = true;
    btn.setAttribute('aria-expanded', 'true');
  }
  function hidePanel() {
    panel.classList.remove('sg-on');
    panelOpen = false;
    btn.setAttribute('aria-expanded', 'false');
  }

  /* A dismissal — any × or "Not now", on either pop — silences ALL pops
     for the rest of the session. The Guide button stays available on demand. */
  function dismiss() {
    sset('sg-quiet', '1');
    hidePop();
    hideInsight();
  }

  /* ---- Chat: ONLY from the explicit tap, via the page's own mechanism ---- */
  function openChat() {
    hidePanel(); hidePop(); hideInsight(); stopTour();
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
    hidePanel(); hidePop(); hideInsight();
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
  pop.querySelector('.sg-x').addEventListener('click', dismiss);
  pop.querySelector('.sg-act-no').addEventListener('click', dismiss);
  pop.querySelector('.sg-act-yes').addEventListener('click', function () {
    sset('sg-act-' + ctxKey, 'yes');
    openPanel();                     /* Guide panel only — never chat */
  });
  insight.querySelector('.sg-x').addEventListener('click', dismiss);
  insight.querySelector('.sg-act-no').addEventListener('click', dismiss);
  panel.querySelector('.sg-head .sg-x').addEventListener('click', hidePanel);
  panel.querySelector('.sg-tour-btn').addEventListener('click', startTour);
  panel.querySelector('.sg-chat').addEventListener('click', openChat);

  /* ---- Catalog search: filter the full-ecosystem groups in place.
     Every word typed must appear in an item's label + keys; a group
     header hides when none of its items match. Clearing restores all. */
  var sgSearch = panel.querySelector('.sg-search');
  var sgCatLinks = panel.querySelectorAll('.sg-cat-link');
  var sgCatGroups = panel.querySelectorAll('.sg-group');
  var sgNoRes = panel.querySelector('.sg-noresults');
  sgSearch.addEventListener('input', function () {
    var words = sgSearch.value.toLowerCase().split(/\s+/).filter(function (w) { return !!w; });
    var anyVisible = false;
    for (var g = 0; g < sgCatGroups.length; g++) {
      var groupVisible = false;
      var links = sgCatGroups[g].querySelectorAll('.sg-cat-link');
      for (var i = 0; i < links.length; i++) {
        var hay = links[i].getAttribute('data-keys') || '';
        var match = true;
        for (var w = 0; w < words.length; w++) {
          if (hay.indexOf(words[w]) === -1) { match = false; break; }
        }
        links[i].style.display = match ? '' : 'none';
        if (match) groupVisible = true;
      }
      sgCatGroups[g].style.display = groupVisible ? '' : 'none';
      if (groupVisible) anyVisible = true;
    }
    sgNoRes.hidden = anyVisible || words.length === 0;
  });

  /* ---- Signed-in doors: receiver-ready cross-host catalog links ride
     the multi-account handoff when the vault is present on this
     surface and the holder is signed in. handoffUrl() no-ops in every
     other case, so signed-out visitors and non-vault surfaces simply
     keep the plain link. Rewriting at click time makes load order
     between the vault script and the guide irrelevant. */
  panel.addEventListener('click', function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a[data-handoff]') : null;
    if (!a) return;
    if (window.TSOSVault && typeof window.TSOSVault.handoffUrl === 'function') {
      a.href = window.TSOSVault.handoffUrl(a.href);
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { hidePanel(); hidePop(); hideInsight(); stopTour(); }
  });

  /* ---- Arrival (~2s, then wait for a natural pause) ----
     Standard pop: once per context. On a 3rd+ visit to the same page,
     the "still lost" insight pop may come instead. If no pause ever
     comes, we skip it — browsing customers get their space, and a
     later genuine stall can still offer the pointers. */
  setTimeout(function () {
    if (silenced() || popCount() >= 3) return;
    if (!sget('sg-pop-' + ctxKey)) {
      whenPaused(showPop, function () { sset('sg-nopause-' + ctxKey, '1'); });
    } else if (visits >= 3 && !sget('sg-insight')) {
      whenPaused(showInsight, null);
    }
  }, 2000);

  /* ---- Genuine stall (~45s with no scroll/click/key) after the standard
     pop faded untouched (or never found a pause): one insight pop. ---- */
  setInterval(function () {
    if (document.hidden || anythingOpen()) return;
    if (silenced() || sget('sg-insight') || popCount() >= 3) return;
    var faded = sget('sg-act-' + ctxKey) === 'fade';
    var noPause = !!sget('sg-nopause-' + ctxKey);
    if (!faded && !noPause) return;
    if (Date.now() - lastAct >= 45000) showInsight();
  }, 5000);
})();
