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
 *
 * Turnstile robustness (2026-11-21): the widget is customer-facing
 * plumbing, never a dead end.
 *  - If the Cloudflare script fails to load, the widget fails to
 *    render, rendering throws, or the widget reports an error (for
 *    example a site key Cloudflare rejects — its error box addresses
 *    the "Site Administrator", which a customer can do nothing
 *    about), the slot is HIDDEN and our own note appears in its
 *    place: "Security check unavailable right now — you can still
 *    create your account." fields() keeps returning the form token
 *    with an empty Turnstile token, which the server scores instead
 *    of blocking, so sign-up proceeds.
 *  - A slot inside a hidden tab/panel (the Pepper Lists sign-up tab
 *    pattern: the form starts display:none) is NOT rendered while
 *    hidden — Turnstile cannot size itself in a hidden container.
 *    Rendering is retried when the slot becomes visible
 *    (IntersectionObserver plus a bounded retry loop), so opening
 *    the tab produces a live widget instead of a dead one.
 */
(function () {
  var API = 'https://top-speed-service-os.vercel.app/api/v1';
  var NOTE_TEXT = 'Security check unavailable right now — you can still create your account.';
  var state = {
    formToken: null,
    turnstileSiteKey: null,
    turnstileToken: null,
    turnstileLoaded: false,
    turnstileFailed: false,
    records: [],
  };

  /* One record per .tsos-turnstile-slot element: the slot, the note
     element that replaces it on degradation, and the render state
     ('pending' | 'rendered' | 'degraded'). */
  function discover() {
    var slots = document.querySelectorAll('.tsos-turnstile-slot');
    for (var i = 0; i < slots.length; i += 1) {
      var el = slots[i];
      var seen = false;
      for (var j = 0; j < state.records.length; j += 1) {
        if (state.records[j].el === el) { seen = true; break; }
      }
      if (seen) continue;
      var note = document.createElement('div');
      note.className = 'tsos-turnstile-note';
      note.textContent = NOTE_TEXT;
      note.style.cssText = 'display:none;font-size:.85rem;line-height:1.45;opacity:.85;margin:6px 0;';
      if (el.parentNode) el.parentNode.insertBefore(note, el.nextSibling);
      state.records.push({ el: el, note: note, widgetId: null, status: 'pending' });
    }
  }

  /* A display:none (or otherwise layout-less) container cannot host
     the widget; treat "has layout boxes" as visible. If layout
     cannot be measured, assume visible so behavior never regresses
     on an unusual browser. */
  function isLaidOut(el) {
    try { return !!(el.getClientRects && el.getClientRects().length > 0); }
    catch (e) { return true; }
  }

  /* Hide the slot (Cloudflare's own error UI lives in an iframe
     inside it, so hiding the slot hides the error) and show our
     note instead. Idempotent and never throws: a broken widget
     must not break the form. */
  function degrade(rec) {
    if (!rec || rec.status === 'degraded') return;
    rec.status = 'degraded';
    state.turnstileToken = null;
    try {
      if (rec.widgetId != null && window.turnstile && typeof window.turnstile.remove === 'function') {
        window.turnstile.remove(rec.widgetId);
      }
    } catch (e) { /* the hide below still applies */ }
    try { rec.el.style.display = 'none'; } catch (e) { /* ignore */ }
    try { if (rec.note) rec.note.style.display = 'block'; } catch (e) { /* ignore */ }
  }

  function degradeAll() {
    discover();
    for (var i = 0; i < state.records.length; i += 1) degrade(state.records[i]);
  }

  var io = null;
  function watchVisibility(rec) {
    if (!('IntersectionObserver' in window)) return;
    try {
      if (!io) {
        io = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i += 1) {
            if (entries[i].isIntersecting) renderTurnstile();
          }
        }, { threshold: 0.01 });
      }
      io.observe(rec.el);
    } catch (e) { /* the retry loop below still covers visibility */ }
  }

  function renderSlot(rec) {
    try {
      rec.widgetId = window.turnstile.render(rec.el, {
        sitekey: state.turnstileSiteKey,
        callback: function (token) { state.turnstileToken = token; },
        'expired-callback': function () { state.turnstileToken = null; },
        'error-callback': function () {
          try { state.turnstileToken = null; degrade(rec); } catch (e) { /* never throw */ }
        },
        'timeout-callback': function () {
          try { state.turnstileToken = null; degrade(rec); } catch (e) { /* never throw */ }
        },
      });
      rec.status = 'rendered';
    } catch (e) { degrade(rec); }
  }

  function renderTurnstile() {
    if (!state.turnstileSiteKey) return;
    discover();
    if (state.turnstileFailed) { degradeAll(); return; }
    if (!window.turnstile) return;
    for (var i = 0; i < state.records.length; i += 1) {
      var rec = state.records[i];
      if (rec.status !== 'pending') continue;
      if (!isLaidOut(rec.el)) { watchVisibility(rec); continue; }
      renderSlot(rec);
    }
  }

  function onScriptFail() {
    if (state.turnstileFailed) return;
    state.turnstileFailed = true;
    degradeAll();
  }

  function loadTurnstile() {
    if (state.turnstileLoaded || !state.turnstileSiteKey) return;
    state.turnstileLoaded = true;
    if (window.turnstile) { renderTurnstile(); return; }
    var watchdog = setTimeout(function () { if (!window.turnstile) onScriptFail(); }, 8000);
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.defer = true;
    s.onload = function () {
      clearTimeout(watchdog);
      if (window.turnstile) renderTurnstile(); else onScriptFail();
    };
    s.onerror = function () { clearTimeout(watchdog); onScriptFail(); };
    document.head.appendChild(s);
  }

  /* Bounded retry: catches slots that become visible without an
     intersection event (and browsers without IntersectionObserver).
     Stops as soon as nothing is pending, and after ~55s regardless —
     the same window the MutationObserver below watches. */
  var retryTimer = null;
  function startRetry() {
    if (retryTimer) return;
    var tries = 0;
    retryTimer = setInterval(function () {
      tries += 1;
      renderTurnstile();
      var pending = false;
      for (var i = 0; i < state.records.length; i += 1) {
        if (state.records[i].status === 'pending') pending = true;
      }
      if (!pending || tries >= 55) { clearInterval(retryTimer); retryTimer = null; }
    }, 1000);
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
          startRetry();
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
  // Slots can appear after load on view-driven pages, and hidden
  // panels become visible through style/class changes (tab switches);
  // watch for both, briefly. renderTurnstile() is idempotent, so
  // extra firings are harmless no-op scans.
  if (window.MutationObserver && document.documentElement) {
    var observer = new MutationObserver(function () { renderTurnstile(); });
    observer.observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['style', 'class'],
    });
    setTimeout(function () { observer.disconnect(); }, 60000);
  }
})();
