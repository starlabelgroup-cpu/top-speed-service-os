/*
 * Intake Shield Phase 2 — client helper (2026-11-20).
 *
 * Public signup/intake forms include this script and merge
 * TSOSIntakeShield.fields() into their submit payload. On load it
 * fetches GET /auth/form-token from the API: a signed form-timing
 * token (the server discards submissions that come back forged,
 * expired, or inhumanly fast) and the Cloudflare Turnstile SITE key.
 * While no site key is configured the Turnstile layer is dark: no
 * widget renders, no field is added, and the forms look and behave
 * exactly as before. When a site key exists, the widget renders into
 * any .tsos-turnstile-slot element on the page and fields() carries
 * its token.
 *
 * Failure discipline mirrors the server: if the token fetch fails,
 * fields() simply returns what it has (usually nothing) — a form
 * must never break because its shield helper hiccuped; the server
 * scores a missing token instead of hard-blocking it.
 */
(function () {
  var API = 'https://top-speed-service-os.vercel.app/api/v1';
  var state = {
    formToken: null,
    turnstileSiteKey: null,
    turnstileToken: null,
    turnstileLoaded: false,
    rendered: {},
  };

  function renderTurnstile() {
    if (!state.turnstileSiteKey || !window.turnstile) return;
    var slots = document.querySelectorAll('.tsos-turnstile-slot');
    for (var i = 0; i < slots.length; i += 1) {
      var el = slots[i];
      if (state.rendered[el.id || i]) continue;
      try {
        var widgetId = window.turnstile.render(el, {
          sitekey: state.turnstileSiteKey,
          callback: function (token) { state.turnstileToken = token; },
          'expired-callback': function () { state.turnstileToken = null; },
          'error-callback': function () { state.turnstileToken = null; },
        });
        state.rendered[el.id || i] = widgetId;
      } catch (e) { /* a broken widget must not break the form */ }
    }
  }

  function loadTurnstile() {
    if (state.turnstileLoaded || !state.turnstileSiteKey) return;
    state.turnstileLoaded = true;
    if (window.turnstile) { renderTurnstile(); return; }
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.defer = true;
    s.onload = renderTurnstile;
    document.head.appendChild(s);
  }

  function fetchToken() {
    fetch(API + '/auth/form-token')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var d = (j && j.data) || {};
        if (d.formToken) state.formToken = d.formToken;
        if (d.turnstileSiteKey && !state.turnstileSiteKey) {
          state.turnstileSiteKey = d.turnstileSiteKey;
          loadTurnstile();
        }
      })
      .catch(function () { /* fail soft — see header */ });
  }

  window.TSOSIntakeShield = {
    /* Merge into a submit payload: TSOSIntakeShield.fields() */
    fields: function () {
      var out = {};
      if (state.formToken) out.formToken = state.formToken;
      if (state.turnstileSiteKey) out.turnstileToken = state.turnstileToken || '';
      return out;
    },
    /* Re-issue the timing token (SPA views that open a form late). */
    refresh: fetchToken,
    /* Render Turnstile into slots added after page load (SPAs). */
    render: renderTurnstile,
  };

  fetchToken();
  // Slots can appear after load on view-driven pages; watch briefly.
  if (window.MutationObserver && document.documentElement) {
    var observer = new MutationObserver(function () { renderTurnstile(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(function () { observer.disconnect(); }, 60000);
  }
})();
