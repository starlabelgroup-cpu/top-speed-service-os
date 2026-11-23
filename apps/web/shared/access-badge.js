/* Top Speed Service OS — Access badge + restricted screen (2026-11-18).
   Ramone's customer-lockout audit: every flagship staff console shows
   WHO may enter (OWNER ONLY / MANAGER ONLY / STAFF ONLY), and a signed-in
   account without the gate role gets a clean restricted screen instead
   of a raw error or a half-rendered console.

   The table below is DERIVED from the real server gates (apps/api/src/
   routes/*.js + each page's own sign-in gate) — see the audit in
   apps/api/test/access-badges.test.mjs, which fails if this table and
   the accessLabel/accessRoles fields in apps/api/src/data/systemMap.js
   ever drift apart, or if a listed gate changes shape.

   Academy is deliberately NOT in the table: its page gates on the
   TRAINEE read (STAFF_ROLES + PROVIDER_TECH + PROVIDER_OWNER +
   TECHNICIAN + MARKETING_MANAGER), which fits none of the three
   labels, so it keeps its own trainee gate screen and no badge.

   Rendering discipline: the label text is set with textContent; the
   only markup built from strings is this file's own static chrome
   (the lock SVG). */
(function () {
  if (window.__tsosAccessBadgeLoaded) return;
  window.__tsosAccessBadgeLoaded = true;

  var CONSOLE_ACCESS = {
    '/work-time-access': { label: 'OWNER ONLY', roles: ['COMPANY_OWNER'] },
    '/turbo-boss': { label: 'MANAGER ONLY', roles: ['COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/navigator': { label: 'STAFF ONLY', roles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/pepper': { label: 'STAFF ONLY', roles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/interconnect': { label: 'STAFF ONLY', roles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/crm': { label: 'STAFF ONLY', roles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/book-os': { label: 'STAFF ONLY', roles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/pro-booking': { label: 'STAFF ONLY', roles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/applianceman': { label: 'MANAGER ONLY', roles: ['COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/oversight': { label: 'MANAGER ONLY', roles: ['COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/dispatch-dashboard': { label: 'STAFF ONLY', roles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/service-setters-dispatch': { label: 'STAFF ONLY', roles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/notifications': { label: 'STAFF ONLY', roles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/link-center': { label: 'STAFF ONLY', roles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/insights': { label: 'STAFF ONLY', roles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN', 'MARKETING_MANAGER', 'AD_SPECIALIST'] },
    '/ad-studio': { label: 'STAFF ONLY', roles: ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/manager': { label: 'MANAGER ONLY', roles: ['COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/finance': { label: 'MANAGER ONLY', roles: ['COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/media': { label: 'STAFF ONLY', roles: ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/chats': { label: 'STAFF ONLY', roles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/track-console': { label: 'STAFF ONLY', roles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/parts': { label: 'STAFF ONLY', roles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/cococane-express': { label: 'STAFF ONLY', roles: ['DISPATCHER', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/marketing-os': { label: 'STAFF ONLY', roles: ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/marketing-os/studio': { label: 'STAFF ONLY', roles: ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/marketing-os/seo': { label: 'STAFF ONLY', roles: ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] },
    '/marketing-os/google-accounts': { label: 'STAFF ONLY', roles: ['MARKETING_MANAGER', 'AD_SPECIALIST', 'COMPANY_ADMIN', 'COMPANY_OWNER', 'PLATFORM_ADMIN'] }
  };

  function entryFor(path) {
    var best = null;
    for (var prefix in CONSOLE_ACCESS) {
      if (!Object.prototype.hasOwnProperty.call(CONSOLE_ACCESS, prefix)) continue;
      if (path === prefix || path.indexOf(prefix + '/') === 0) {
        if (!best || prefix.length > best.length) best = prefix;
      }
    }
    return best ? CONSOLE_ACCESS[best] : null;
  }

  function hasToken() {
    try {
      if (window.TSOSVault && typeof window.TSOSVault.token === 'function' && window.TSOSVault.token()) return true;
    } catch (e) {}
    try { return Boolean(localStorage.getItem('tsos_token') || localStorage.getItem('tsos_crm_token') || localStorage.getItem('tsos_studio_token')); } catch (e) { return false; }
  }

  var LOCK_SVG = '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="#E94E5C" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.2" r="1.3" fill="#E94E5C" stroke="none"/></svg>';

  function showRestricted(label) {
    var entry = entryFor(window.location.pathname || '');
    var text = label || (entry && entry.label) || 'STAFF ONLY';
    var homeHref = hasToken() ? '/app' : '/portal';

    var body = document.body;
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);
    body.className = '';

    var style = document.createElement('style');
    style.textContent =
      '.tsos-restricted{min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#0C162B;font-family:Inter,system-ui,sans-serif;padding:24px;box-sizing:border-box}' +
      '.tsos-restricted .card{background:#fff;border-radius:20px;max-width:440px;width:100%;padding:34px 30px;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.45)}' +
      '.tsos-restricted h1{font-size:24px;margin:14px 0 8px;color:#0C162B}' +
      '.tsos-restricted p{font-size:15px;line-height:1.55;color:#44536E;margin:0 0 22px}' +
      '.tsos-restricted .row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}' +
      '.tsos-restricted a{display:inline-block;border-radius:999px;padding:11px 20px;font-weight:800;font-size:14px;text-decoration:none}' +
      '.tsos-restricted a.primary{background:#E94E5C;color:#fff}' +
      '.tsos-restricted a.ghost{background:#EEF2F9;color:#0C162B;border:1.5px solid #D8E1F0}';
    body.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'tsos-restricted';
    wrap.setAttribute('role', 'alert');
    var card = document.createElement('div');
    card.className = 'card';
    var icon = document.createElement('div');
    icon.innerHTML = LOCK_SVG;
    var h = document.createElement('h1');
    h.textContent = 'Restricted area';
    var p = document.createElement('p');
    p.textContent = "This area is " + text + " — your account doesn't have access.";
    var row = document.createElement('div');
    row.className = 'row';
    var home = document.createElement('a');
    home.className = 'primary';
    home.href = homeHref;
    home.textContent = 'Go to my home';
    var portal = document.createElement('a');
    portal.className = 'ghost';
    portal.href = '/portal';
    portal.textContent = 'Service OS Portal';
    row.appendChild(home);
    row.appendChild(portal);
    card.appendChild(icon);
    card.appendChild(h);
    card.appendChild(p);
    card.appendChild(row);
    wrap.appendChild(card);
    body.appendChild(wrap);
  }

  function renderBadge() {
    var entry = entryFor(window.location.pathname || '');
    if (!entry) return;
    if (document.querySelector('[data-tsos-access-badge]')) return;
    var style = document.createElement('style');
    style.textContent =
      '.tsos-access-badge{display:inline-flex;align-items:center;gap:6px;background:#0C162B;color:#fff;border:1.5px solid #E94E5C;border-radius:999px;padding:5px 12px;font:800 11px Inter,system-ui,sans-serif;letter-spacing:.12em;white-space:nowrap;vertical-align:middle;margin-left:10px}' +
      '.tsos-access-badge.fixed{position:fixed;top:10px;right:12px;z-index:9994;margin-left:0;box-shadow:0 8px 24px rgba(6,15,35,.4)}';
    document.head.appendChild(style);
    var chip = document.createElement('span');
    chip.className = 'tsos-access-badge';
    chip.setAttribute('data-tsos-access-badge', entry.label);
    chip.textContent = entry.label;
    var header = document.querySelector('header');
    if (header) {
      header.appendChild(chip);
    } else {
      chip.className += ' fixed';
      document.body.appendChild(chip);
    }
  }

  window.TSOSAccess = { table: CONSOLE_ACCESS, showRestricted: showRestricted };
  window.CONSOLE_ACCESS = CONSOLE_ACCESS;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderBadge);
  } else {
    renderBadge();
  }
})();
