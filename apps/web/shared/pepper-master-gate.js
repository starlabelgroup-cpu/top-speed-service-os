/* Top Speed — Pepper Master Gate (2026-11-20).
   Ramone's directive: "every time I'm logged in app you must be
   there to assist me always with anything due your title and the
   builder of the system."

   The Ask Pepper bar (shared/pepper-chat.js) rides the staff
   consoles, where a signed-in staff session is the norm. On
   surfaces whose signed-in users are NOT staff — the customer app
   (/app), the Pepper Lists account area, the Advertiser Console —
   Pepper must still be on duty for the Master, and for nobody
   else: customers, sellers and advertisers keep exactly the
   surface they have today, and signed-out visitors get nothing at
   all. This gate is how those surfaces get the bar: it renders
   nothing itself and loads pepper-chat.js ONLY after the role
   check passes.

   How the gate works:
   1. Find the surface's session token. Default keys are the ones
      the customer / Pepper Lists shells use (tsos_token,
      tsos_cust_token, tsos_tech_token); a surface whose session
      lives under its own key (the Advertiser Console's
      tsos_adv_token) names its keys via
      window.PEPPER_MASTER_TOKEN_KEYS before this script loads.
      The shared session vault's active token is tried too. No
      token → stop: nothing is fetched, nothing is shown.
   2. Ask the API who this session is (GET /auth/me). Only a user
      whose roles ARRAY contains COMPANY_OWNER passes. Any error,
      any other role → stop, silently.
   3. On a pass, load /shared/pepper-chat.js unchanged. Its own
      token lookup (vault first, then the legacy keys) resolves
      the same session — on Advertiser sign-ins the vault adopts
      the console's token write automatically, so the bar chats as
      the Master with no extra bookkeeping here.

   Host pages with a session-applied hook call
   window.PepperMasterGate.checkUser(user) when a sign-in lands
   (/app wraps custApplyUser, Pepper Lists wraps plEnterApp, the
   Advertiser Console wraps showConsole — the same wrap pattern
   those pages already use), so an in-page sign-in brings Pepper
   up without waiting for a reload; the load-time check below
   covers sessions restored on page load. */
(function () {
  if (window.__pepperMasterGateLoaded) return;
  window.__pepperMasterGateLoaded = true;

  var API = 'https://top-speed-service-os.vercel.app/api/v1';
  var mounted = false;
  var checking = false;

  function isMaster(user) {
    return Boolean(user) && Array.isArray(user.roles) && user.roles.indexOf('COMPANY_OWNER') !== -1;
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    if (window.__pepperChatLoaded || document.getElementById('pepperChatBar')) return;
    var s = document.createElement('script');
    s.src = '/shared/pepper-chat.js';
    (document.body || document.documentElement).appendChild(s);
  }

  function candidateTokens() {
    var out = [];
    function push(v) { if (v && out.indexOf(v) === -1) out.push(v); }
    var keys = (window.PEPPER_MASTER_TOKEN_KEYS && window.PEPPER_MASTER_TOKEN_KEYS.length)
      ? window.PEPPER_MASTER_TOKEN_KEYS
      : ['tsos_token', 'tsos_cust_token', 'tsos_tech_token'];
    try {
      for (var i = 0; i < keys.length; i += 1) push(localStorage.getItem(keys[i]));
    } catch (e) {}
    try {
      if (window.TSOSVault && typeof window.TSOSVault.token === 'function') push(window.TSOSVault.token());
    } catch (e) {}
    return out;
  }

  function check() {
    if (mounted || checking) return;
    var tokens = candidateTokens();
    if (!tokens.length) return;
    checking = true;
    var i = 0;
    (function next() {
      if (mounted || i >= tokens.length) { checking = false; return; }
      var t = tokens[i];
      i += 1;
      fetch(API + '/auth/me', { headers: { Authorization: 'Bearer ' + t } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          var user = j && (j.user || j.data || null);
          if (isMaster(user)) { checking = false; mount(); return; }
          next();
        })
        .catch(function () { next(); });
    })();
  }

  window.PepperMasterGate = {
    isMaster: isMaster,
    checkUser: function (user) { if (isMaster(user)) mount(); },
    check: check,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', check);
  } else {
    check();
  }
})();
