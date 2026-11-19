/* Session Vault — multi-account sign-in (2026-11-17).
 *
 * Ramone's rule: an account holder can go anywhere in the platforms
 * while staying signed in to any account — and any NUMBER of accounts
 * at the same time — with no security risks and no conflicts between
 * platforms. This module is how the browser side keeps that promise.
 *
 * The vault (localStorage key `tsos_sessions_v1`) holds one entry per
 * signed-in account: { active: <userId>, accounts: { [userId]:
 * { token, user, savedAt } } }. A session enters the vault ONLY at the
 * moment a final token is issued (after password/Google/temp-password
 * plus every applicable Speedy Verify and Layer 2 gate) — the vault
 * never sees, stores, or forwards challenge tokens.
 *
 * BACKWARD COMPATIBILITY: the ACTIVE account is continuously mirrored
 * into the legacy keys every existing page already reads —
 * `tsos_token` (and its identical twin `tsos_cust_token`) — so
 * untouched pages behave exactly as they always have. A legacy
 * write of a fresh final token is adopted into the vault (its account
 * is resolved once via /auth/me); a legacy removal of the mirrored
 * token (every existing sign-out button, every boot-time invalidation)
 * drops that account from the vault and promotes the next one, so a
 * sign-out never "resurrects" from the vault.
 *
 * Per-account isolation: API calls always ride the ACTIVE account's
 * mirrored token. Switching accounts never merges roles or data — it
 * re-mirrors and reloads so no stale per-account page state survives.
 *
 * Cross-host travel: handoffUrl() wraps a link to another platform
 * host in /auth-handoff/start.html, which mints a 60-second one-time
 * code from the active session (POST /auth/handoff) and lands on the
 * far host's /auth-handoff/ receiver — a session for the SAME account
 * only. With no session, or for a host that cannot receive yet, the
 * plain link is returned: navigation is never blocked.
 */
(function () {
  'use strict';

  var VAULT_KEY = 'tsos_sessions_v1';
  var TOKEN_KEY = 'tsos_token';
  // Every localStorage key the platform uses for its copy of the SAME
  // final session token: the main key plus the per-surface copies
  // (customer app, Speedy Pro, CRM, Marketing Studio, Advertiser).
  // Pages read and fall back between them interchangeably, so the
  // vault mirrors the ACTIVE account's token into all of them.
  var MIRROR_KEYS = [
    'tsos_token',
    'tsos_cust_token',
    'tsos_tech_token',
    'tsos_crm_token',
    'tsos_studio_token',
    'tsos_adv_token'
  ];
  var RETURN_KEY = 'tsos_login_return';
  var DEFAULT_API = 'https://top-speed-service-os.vercel.app/api/v1';

  // Every platform host a handoff may target (the start page refuses
  // anything else). Keep in step with auth-handoff/start.html.
  var HANDOFF_HOSTS = [
    'topspeedserviceos.com',
    'top-speed-service-os.vercel.app',
    'topspeedappliance.net',
    'www.topspeedappliance.net',
    'appliancepro.net',
    'www.appliancepro.net',
    'appliance-connect.vercel.app',
    'applianceconnectpro.com',
    'www.applianceconnectpro.com',
    'pepperlists.com',
    'www.pepperlists.com',
    'cleanoutvents.com',
    'www.cleanoutvents.com',
    'applianceplug.app',
    'appliancepro.app'
  ];

  // Hosts whose /auth-handoff/ receiver is actually deployed.
  // handoffUrl() only wraps links to these; the remaining
  // allowlisted hosts join as their own sites ship a receiver, so a
  // door never routes a signed-in holder to a page that does not
  // exist yet. Platform Interconnect (2026-11-19): appliancepro.net
  // and cleanoutvents.com receivers shipped and verified live;
  // topspeedappliance.net's receiver shipped to its orbit-haven
  // branch and joins this list when the owner promotes it to
  // production (the standing .net rule) — until then .net doors
  // stay plain links, exactly like every not-yet-ready host.
  var RECEIVER_READY_HOSTS = [
    'topspeedserviceos.com',
    'top-speed-service-os.vercel.app',
    'appliance-connect.vercel.app',
    'applianceconnectpro.com',
    'www.applianceconnectpro.com',
    'pepperlists.com',
    'www.pepperlists.com',
    'appliancepro.net',
    'www.appliancepro.net',
    'cleanoutvents.com',
    'www.cleanoutvents.com'
  ];

  /* ---------------- storage primitives (pre-hook originals) -------- */
  var ls = null;
  try { ls = window.localStorage; } catch (e) { ls = null; }
  var rawGet = null, rawSet = null, rawRemove = null;
  if (ls) {
    rawGet = Storage.prototype.getItem.bind(ls);
    rawSet = Storage.prototype.setItem.bind(ls);
    rawRemove = Storage.prototype.removeItem.bind(ls);
  }
  function safeGet(k) { try { return rawGet ? rawGet(k) : null; } catch (e) { return null; } }
  function safeSet(k, v) { try { if (rawSet) rawSet(k, v); } catch (e) {} }
  function safeRemove(k) { try { if (rawRemove) rawRemove(k); } catch (e) {} }

  /* ---------------- vault state ------------------------------------ */
  function read() {
    try {
      var raw = safeGet(VAULT_KEY);
      if (!raw) return { active: null, accounts: {} };
      var v = JSON.parse(raw);
      if (!v || typeof v !== 'object' || !v.accounts || typeof v.accounts !== 'object') {
        return { active: null, accounts: {} };
      }
      if (!v.active || !v.accounts[v.active]) v.active = null;
      return v;
    } catch (e) {
      return { active: null, accounts: {} };
    }
  }

  function persist(v) {
    var ids = Object.keys(v.accounts || {});
    if (!ids.length) {
      safeRemove(VAULT_KEY);
      return false;
    }
    if (!v.active || !v.accounts[v.active]) {
      v.active = ids.sort(function (a, b) {
        return (v.accounts[b].savedAt || 0) - (v.accounts[a].savedAt || 0);
      })[0];
    }
    safeSet(VAULT_KEY, JSON.stringify(v));
    return true;
  }

  function write(v) {
    if (!persist(v)) {
      MIRROR_KEYS.forEach(function (k) { safeRemove(k); });
      return;
    }
    mirror(v);
  }

  // After a legacy-removal drop (below), the surviving account is
  // promoted in the vault immediately but the mirror keys are only
  // re-written a beat later: the page that just "signed out" usually
  // removes several mirror keys in the same gesture and reloads, and
  // re-mirroring instantly would make its next removal hit the
  // promoted account's token. A fresh sign-in (add) cancels the wait.
  var mirrorTimer = null;
  function scheduleMirror() {
    if (mirrorTimer) clearTimeout(mirrorTimer);
    mirrorTimer = setTimeout(function () {
      mirrorTimer = null;
      mirror(read());
    }, 250);
  }
  function cancelScheduledMirror() {
    if (mirrorTimer) { clearTimeout(mirrorTimer); mirrorTimer = null; }
  }

  // Keep the legacy keys pointing at the ACTIVE account — this is what
  // every pre-vault page reads, so it must never drift.
  function mirror(v) {
    v = v || read();
    var acct = v.active ? v.accounts[v.active] : null;
    MIRROR_KEYS.forEach(function (k) {
      if (acct && acct.token) safeSet(k, acct.token);
      else safeRemove(k);
    });
  }

  function publicUser(user) {
    if (!user || typeof user !== 'object') return null;
    return {
      id: user.id,
      companyId: user.companyId ?? null,
      email: user.email ?? null,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      phone: user.phone ?? null,
      roles: Array.isArray(user.roles) ? user.roles : [],
      signupAudience: user.signupAudience ?? null,
      verifyRequired: user.verifyRequired === true,
      layer2Required: user.layer2Required === true
    };
  }

  /* ---------------- core API --------------------------------------- */
  function add(user, token) {
    var u = publicUser(user);
    if (!u || !u.id || !token || typeof token !== 'string') return null;
    cancelScheduledMirror();
    var v = read();
    v.accounts[u.id] = { token: token, user: u, savedAt: Date.now() };
    v.active = u.id;
    write(v);
    maybeFollowReturn();
    return v.accounts[u.id];
  }

  function active() {
    var v = read();
    if (!v.active) return null;
    var acct = v.accounts[v.active];
    return acct ? { user: acct.user, token: acct.token, savedAt: acct.savedAt } : null;
  }

  function list() {
    var v = read();
    return Object.keys(v.accounts).map(function (id) {
      var a = v.accounts[id];
      return { user: a.user, savedAt: a.savedAt, active: id === v.active };
    }).sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
  }

  function token() {
    var a = active();
    if (a && a.token) return a.token;
    return safeGet(TOKEN_KEY);
  }

  function switchTo(userId) {
    var v = read();
    if (!v.accounts[userId]) return false;
    v.active = userId;
    write(v);
    window.location.reload();
    return true;
  }

  function remove(userId, opts) {
    var v = read();
    if (!v.accounts[userId]) return false;
    var wasActive = v.active === userId;
    delete v.accounts[userId];
    if (wasActive) v.active = null; // persist() promotes the most recent remaining
    if (opts && opts.deferMirror) {
      persist(v);
      scheduleMirror();
    } else {
      write(v);
    }
    return true;
  }

  function clearAll() {
    safeRemove(VAULT_KEY);
    MIRROR_KEYS.forEach(function (k) { safeRemove(k); });
  }

  /* Expired-session recovery (2026-11-18, Ramone: "I should be able to
   * log in anywhere anytime"): when an API call answers 401, the token
   * that was mirrored is dead. Drop the account that owns that token
   * from the vault (the next account, if any, is promoted and
   * mirrored — the same semantics as a sign-out) so no page keeps
   * re-sending a dead token or parks on an "Expired JWT" error: the
   * page falls back to its normal sign-in form and the holder signs
   * straight back in from wherever they are. Returns true when a
   * vault account was dropped. */
  function expireActive() {
    var legacy = safeGet(TOKEN_KEY);
    var v = read();
    var dropped = false;
    Object.keys(v.accounts).forEach(function (id) {
      if (id === v.active || (legacy && v.accounts[id].token === legacy)) {
        delete v.accounts[id];
        dropped = true;
      }
    });
    if (dropped) {
      if (v.active && !v.accounts[v.active]) v.active = null;
      write(v);
    } else if (legacy) {
      // The mirrored token is not a vault account (pre-vault legacy
      // session): clear the mirrors directly so it cannot be retried.
      MIRROR_KEYS.forEach(function (k) { safeRemove(k); });
      dropped = true;
    }
    return dropped;
  }

  /* ---------------- ?return= after sign-in -------------------------- */
  function isRelativePath(p) {
    return typeof p === 'string' && p.charAt(0) === '/' && p.charAt(1) !== '/';
  }
  try {
    var rp = new URLSearchParams(window.location.search).get('return');
    if (rp && isRelativePath(rp)) {
      try { window.sessionStorage.setItem(RETURN_KEY, rp); } catch (e) {}
    }
  } catch (e) {}

  function maybeFollowReturn() {
    // Only dedicated sign-in surfaces opt in (window.TSOS_LOGIN_SURFACE);
    // consoles boot in place, so a vault add there must never navigate.
    if (window.TSOS_LOGIN_SURFACE !== true) return;
    var dest = null;
    try { dest = window.sessionStorage.getItem(RETURN_KEY); } catch (e) {}
    if (dest && isRelativePath(dest)) {
      try { window.sessionStorage.removeItem(RETURN_KEY); } catch (e) {}
      if (dest !== window.location.pathname) window.location.replace(dest);
    }
  }

  /* ---------------- legacy storage sync ----------------------------- */
  var adopting = {};
  function adoptToken(tok) {
    if (!tok || typeof tok !== 'string' || tok.length < 20) return;
    var v = read();
    var ids = Object.keys(v.accounts);
    for (var i = 0; i < ids.length; i += 1) {
      if (v.accounts[ids[i]].token === tok) {
        if (v.active !== ids[i]) { v.active = ids[i]; write(v); }
        return;
      }
    }
    if (adopting[tok]) return;
    adopting[tok] = true;
    var api = (typeof window.TSOS_API === 'string' && window.TSOS_API) || DEFAULT_API;
    fetch(api + '/auth/me', { headers: { Authorization: 'Bearer ' + tok } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        delete adopting[tok];
        if (j && j.user && j.user.id) add(j.user, tok);
      })
      .catch(function () { delete adopting[tok]; });
  }

  function onLegacySet(key, value) {
    if (MIRROR_KEYS.indexOf(key) === -1) return;
    if (typeof value === 'string' && value) adoptToken(value);
  }

  // A legacy sign-out removes one or MORE mirror keys in the same
  // gesture (e.g. tsos_token + tsos_cust_token together), then usually
  // reloads. The drop is keyed by the removed token VALUE and applied
  // synchronously to the vault, but the promoted account's token is
  // only mirrored a beat later (see scheduleMirror) — so the gesture's
  // remaining removals still see the OLD value, match no vault
  // account, and can never consume the promoted account too.
  function onLegacyRemove(key, previousValue) {
    if (MIRROR_KEYS.indexOf(key) === -1) return;
    if (!previousValue) return;
    var v = read();
    var ids = Object.keys(v.accounts);
    for (var i = 0; i < ids.length; i += 1) {
      if (v.accounts[ids[i]].token === previousValue) {
        remove(ids[i], { deferMirror: true });
        return;
      }
    }
  }

  if (ls && Storage.prototype.__tsosVaultHook !== true) {
    try {
      var origSet = Storage.prototype.setItem;
      var origRemove = Storage.prototype.removeItem;
      Storage.prototype.setItem = function (k, val) {
        var r = origSet.apply(this, arguments);
        try { if (this === ls) onLegacySet(k, val); } catch (e) {}
        return r;
      };
      Storage.prototype.removeItem = function (k) {
        var prev = null;
        try { if (this === ls) prev = this.getItem(k); } catch (e) {}
        var r = origRemove.apply(this, arguments);
        try { if (this === ls) onLegacyRemove(k, prev); } catch (e) {}
        return r;
      };
      Storage.prototype.__tsosVaultHook = true;
    } catch (e) { /* storage locked down: the vault still works via add() */ }
  }

  /* ---------------- cross-host handoffs ------------------------------ */
  function handoffUrl(targetUrl) {
    try {
      if (!targetUrl || typeof targetUrl !== 'string') return targetUrl;
      var u = new URL(targetUrl, window.location.href);
      if (HANDOFF_HOSTS.indexOf(u.hostname) === -1) return targetUrl;
      if (u.origin === window.location.origin) return targetUrl;
      if (RECEIVER_READY_HOSTS.indexOf(u.hostname) === -1) return targetUrl;
      if (!token()) return targetUrl;
      return window.location.origin + '/auth-handoff/start.html?to=' + encodeURIComponent(u.href);
    } catch (e) {
      return targetUrl;
    }
  }

  /* ---------------- boot --------------------------------------------- */
  function boot() {
    var v = read();
    if (Object.keys(v.accounts).length) {
      mirror(v);
    } else {
      var legacy = safeGet(TOKEN_KEY);
      if (legacy) adoptToken(legacy);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  // Another tab signed in/out: keep this tab's mirrors in step.
  window.addEventListener('storage', function (e) {
    if (e.key === VAULT_KEY) mirror(read());
  });

  window.TSOSVault = {
    add: add,
    capture: add,
    active: active,
    list: list,
    switchTo: switchTo,
    remove: remove,
    clearAll: clearAll,
    expireActive: expireActive,
    token: token,
    handoffUrl: handoffUrl,
    HANDOFF_HOSTS: HANDOFF_HOSTS,
    RECEIVER_READY_HOSTS: RECEIVER_READY_HOSTS
  };
})();
