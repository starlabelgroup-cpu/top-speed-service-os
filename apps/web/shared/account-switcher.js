/* Account Switcher — multi-account sign-in (2026-11-17).
 *
 * The visible half of the Session Vault (shared/session-vault.js,
 * which must load first). Renders only when the vault holds at least
 * one account: a compact chip, fixed bottom-left, that names the
 * ACTIVE account and opens a menu of every signed-in account.
 *
 *   - Tap another account  → TSOSVault.switchTo (re-mirror + reload;
 *                            roles and data never merge)
 *   - Add another account  → /add-account/ (the existing accounts stay
 *                            signed in; the new one is ADDED)
 *   - Sign out of this account / Sign out of all accounts
 *
 * On a dedicated sign-in surface (window.TSOS_LOGIN_SURFACE) with a
 * login form present, it also fills any [data-vault-note] slot with
 * the add-mode note: your existing accounts stay signed in.
 *
 * Designed SVG icons only (platform icon rule — never emoji). The
 * chip and menu are fluid and fit a 320px screen without overflow.
 */
(function () {
  'use strict';

  var STYLE_ID = 'tsos-switcher-style';
  var ROOT_ID = 'tsosAccountSwitcher';

  var ICONS = {
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M5 19.5c1.2-3.2 3.8-4.8 7-4.8s5.8 1.6 7 4.8"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M14 4h5v16h-5"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h11"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M6 14l6-6 6 6"/></svg>'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function displayName(user) {
    if (!user) return 'Account';
    var name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
    return name || user.email || 'Account';
  }

  function roleLabel(user) {
    if (!user) return 'Account';
    if (user.signupAudience === 'commercial') return 'Business — Connect Pro';
    if (user.signupAudience === 'property-manager') return 'Property Manager — Connect Pro';
    var roles = Array.isArray(user.roles) ? user.roles : [];
    if (roles.indexOf('COMPANY_OWNER') !== -1) return 'Owner';
    if (roles.indexOf('PLATFORM_ADMIN') !== -1) return 'Platform Admin';
    if (roles.indexOf('COMPANY_ADMIN') !== -1) return 'Manager';
    if (roles.indexOf('DISPATCHER') !== -1) return 'Service Setter';
    if (roles.indexOf('MARKETING_MANAGER') !== -1) return 'Flywheel Marketing Manager';
    if (roles.indexOf('ADVERTISER') !== -1) return 'Advertiser — Flywheel';
    if (roles.indexOf('PROVIDER_OWNER') !== -1) return 'Provider';
    if (roles.indexOf('PROVIDER_TECH') !== -1 || roles.indexOf('TECHNICIAN') !== -1) return 'Technician — Speedy Pro';
    if (roles.indexOf('CUSTOMER') !== -1) return 'Customer';
    return roles.length ? roles[0].replace(/_/g, ' ') : 'Account';
  }

  function initial(user) {
    var n = displayName(user);
    return esc((n.charAt(0) || 'A').toUpperCase());
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '#' + ROOT_ID + '{position:fixed;left:10px;bottom:10px;z-index:99970;font-family:inherit;max-width:calc(100vw - 20px)}' +
      '.tsw-chip{display:flex;align-items:center;gap:9px;background:#0C162B;color:#fff;border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:6px 12px 6px 6px;cursor:pointer;font:inherit;box-shadow:0 8px 26px rgba(6,12,24,.35);max-width:calc(100vw - 20px)}' +
      '.tsw-av{flex:0 0 30px;width:30px;height:30px;border-radius:50%;background:#E94E5C;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px}' +
      '.tsw-who{min-width:0;text-align:left;line-height:1.15}' +
      '.tsw-who b{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px}' +
      '.tsw-who span{display:block;font-size:11px;opacity:.78;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px}' +
      '.tsw-chev{flex:0 0 16px;width:16px;height:16px;opacity:.85}.tsw-chev svg{width:16px;height:16px;display:block}' +
      '.tsw-menu{position:absolute;left:0;bottom:calc(100% + 8px);width:300px;max-width:calc(100vw - 20px);background:#fff;color:#0C162B;border-radius:16px;box-shadow:0 18px 50px rgba(6,12,24,.4);border:1px solid #D8E1EE;overflow:hidden;display:none}' +
      '.tsw-menu.open{display:block}' +
      '.tsw-head{padding:12px 14px 8px;font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#5A6B84}' +
      '.tsw-acct{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:0;border-top:1px solid #EDF1F7;padding:11px 14px;cursor:pointer;font:inherit;color:#0C162B;box-sizing:border-box}' +
      '.tsw-acct:hover{background:#F4F7FB}' +
      '.tsw-acct .tsw-av{flex-basis:34px;width:34px;height:34px;font-size:15px}' +
      '.tsw-acct .tsw-who b{font-size:14px;max-width:180px}.tsw-acct .tsw-who span{max-width:180px;color:#5A6B84;opacity:1}' +
      '.tsw-on{margin-left:auto;flex:0 0 auto;color:#1E9E6A;display:flex;align-items:center;gap:4px;font-size:11.5px;font-weight:700}.tsw-on svg{width:14px;height:14px}' +
      '.tsw-act{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:0;border-top:1px solid #EDF1F7;padding:12px 14px;cursor:pointer;font:inherit;font-size:14px;font-weight:600;color:#0C162B;box-sizing:border-box;text-decoration:none}' +
      '.tsw-act:hover{background:#F4F7FB}.tsw-act svg{width:18px;height:18px;flex:0 0 18px}' +
      '.tsw-act.danger{color:#B3261E}';
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function fillLoginNote() {
    if (!window.TSOSVault) return;
    var slots = document.querySelectorAll('[data-vault-note]');
    if (!slots.length) return;
    var accounts = window.TSOSVault.list();
    if (!accounts.length) return;
    var a = accounts[0];
    var msg = 'You are signed in as <b>' + esc(displayName(a.user)) + '</b> (' + esc(roleLabel(a.user)) + '). ' +
      'Signing in with another account adds it — ' + esc(displayName(a.user)) + ' stays signed in, and you can switch any time from the account chip.';
    for (var i = 0; i < slots.length; i += 1) {
      slots[i].innerHTML = msg;
      slots[i].style.display = 'block';
    }
  }

  function render() {
    if (!window.TSOSVault) return;
    var accounts = window.TSOSVault.list();
    var old = document.getElementById(ROOT_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (!accounts.length) { fillLoginNote(); return; }
    injectStyle();
    var activeAcct = accounts.filter(function (a) { return a.active; })[0] || accounts[0];

    var root = document.createElement('div');
    root.id = ROOT_ID;

    var rows = accounts.map(function (a) {
      return '<button type="button" class="tsw-acct" data-switch="' + esc(a.user.id) + '">' +
        '<span class="tsw-av">' + initial(a.user) + '</span>' +
        '<span class="tsw-who"><b>' + esc(displayName(a.user)) + '</b><span>' + esc(roleLabel(a.user)) + (a.user.email ? ' · ' + esc(a.user.email) : '') + '</span></span>' +
        (a.active ? '<span class="tsw-on">' + ICONS.check + 'Active</span>' : '') +
        '</button>';
    }).join('');

    root.innerHTML =
      '<div class="tsw-menu" role="menu">' +
        '<div class="tsw-head">Signed-in accounts</div>' +
        rows +
        '<a class="tsw-act" href="/add-account/?return=' + encodeURIComponent(window.location.pathname + window.location.search) + '">' + ICONS.plus + 'Add another account</a>' +
        '<button type="button" class="tsw-act" data-signout-one>' + ICONS.out + 'Sign out of this account</button>' +
        '<button type="button" class="tsw-act danger" data-signout-all>' + ICONS.out + 'Sign out of all accounts</button>' +
      '</div>' +
      '<button type="button" class="tsw-chip" aria-haspopup="true">' +
        '<span class="tsw-av">' + initial(activeAcct.user) + '</span>' +
        '<span class="tsw-who"><b>' + esc(displayName(activeAcct.user)) + '</b><span>' + esc(roleLabel(activeAcct.user)) + '</span></span>' +
        '<span class="tsw-chev">' + ICONS.chev + '</span>' +
      '</button>';

    document.body.appendChild(root);

    var menu = root.querySelector('.tsw-menu');
    root.querySelector('.tsw-chip').addEventListener('click', function (ev) {
      ev.stopPropagation();
      menu.classList.toggle('open');
    });
    document.addEventListener('click', function (ev) {
      if (!root.contains(ev.target)) menu.classList.remove('open');
    });
    root.addEventListener('click', function (ev) {
      var sw = ev.target.closest ? ev.target.closest('[data-switch]') : null;
      if (sw) {
        var id = sw.getAttribute('data-switch');
        var acct = accounts.filter(function (a) { return a.user.id === id; })[0];
        if (acct && !acct.active) window.TSOSVault.switchTo(id);
        return;
      }
      if (ev.target.closest && ev.target.closest('[data-signout-one]')) {
        window.TSOSVault.remove(activeAcct.user.id);
        window.location.reload();
        return;
      }
      if (ev.target.closest && ev.target.closest('[data-signout-all]')) {
        window.TSOSVault.clearAll();
        window.location.reload();
      }
    });
    fillLoginNote();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
  // The vault can gain an account after load (legacy token adoption,
  // a completed sign-in): re-render when it changes.
  window.addEventListener('storage', function (e) {
    if (e.key === 'tsos_sessions_v1') render();
  });
})();
