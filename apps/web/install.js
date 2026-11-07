/**
 * Top Speed PWA install helper.
 *
 * - Captures Chrome/Edge's `beforeinstallprompt` so any "Install the app"
 *   button can trigger the native prompt via
 *   window.TopSpeedInstall.promptInstall() (returns a Promise resolving
 *   to 'accepted' | 'dismissed' | 'unavailable').
 * - On `appinstalled`, reports the install to the Service OS so flywheel
 *   attribution knows which campaign produced it:
 *     POST /api/v1/app/track-download { platform, deviceType, src }
 *   `src` is read from the current page's ?src= query parameter (the same
 *   parameter flyers, QR codes, and ads carry), e.g. ?src=flyer.
 *
 * API base: same origin by default. During local development the API runs
 * on :4000 — set window.TOP_SPEED_API_BASE before loading this script, or
 * add ?api=http://localhost:4000 to the page URL once and it is kept in
 * sessionStorage for the tab.
 */
(function () {
  var deferredPrompt = null;

  function apiBase() {
    if (window.TOP_SPEED_API_BASE) return window.TOP_SPEED_API_BASE;
    try {
      var fromQuery = new URLSearchParams(window.location.search).get('api');
      if (fromQuery) {
        sessionStorage.setItem('ts-api-base', fromQuery);
        return fromQuery;
      }
      var stored = sessionStorage.getItem('ts-api-base');
      if (stored) return stored;
    } catch (e) {
      /* sessionStorage unavailable — fall through to same-origin */
    }
    return '';
  }

  function queryParam(name) {
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (e) {
      return null;
    }
  }

  function detectPlatform() {
    var ua = navigator.userAgent || '';
    if (/android/i.test(ua)) return 'android';
    if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
    return 'web';
  }

  function detectDeviceType() {
    var ua = navigator.userAgent || '';
    if (/ipad|tablet/i.test(ua)) return 'tablet';
    if (/mobi|iphone|android.*mobile/i.test(ua)) return 'phone';
    return 'desktop';
  }

  function trackInstall(extra) {
    var payload = {
      platform: detectPlatform(),
      deviceType: detectDeviceType(),
      src: queryParam('src') || undefined,
    };
    if (extra) {
      Object.keys(extra).forEach(function (key) {
        payload[key] = extra[key];
      });
    }
    try {
      return fetch(apiBase() + '/api/v1/app/track-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () {
        /* Tracking must never block the install flow. */
      });
    } catch (e) {
      return Promise.resolve();
    }
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    document.dispatchEvent(new CustomEvent('topspeed:install-available'));
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    trackInstall();
    document.dispatchEvent(new CustomEvent('topspeed:installed'));
  });

  window.TopSpeedInstall = {
    /** True once the browser has offered a native install prompt. */
    canPrompt: function () {
      return deferredPrompt !== null;
    },
    /** Show the native install prompt (must be called from a user gesture). */
    promptInstall: function () {
      if (!deferredPrompt) return Promise.resolve('unavailable');
      var promptEvent = deferredPrompt;
      deferredPrompt = null;
      return promptEvent.prompt().then(function () {
        return promptEvent.userChoice.then(function (choice) {
          return choice.outcome; // 'accepted' | 'dismissed'
        });
      });
    },
    /** Manual attribution report (e.g. after iOS Add to Home Screen steps). */
    trackInstall: trackInstall,
    detectPlatform: detectPlatform,
  };
})();
