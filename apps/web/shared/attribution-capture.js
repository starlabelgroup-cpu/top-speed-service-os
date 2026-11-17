/* Top Speed Ads — first-touch attribution capture (2026-11-17).
   When a visitor lands from an ad, the landing URL carries the
   campaign's fingerprints: utm_source / utm_medium / utm_campaign
   and the platform click ID (Google gclid, Meta fbclid, Microsoft
   msclkid). This script reads them ONCE — the first touch inside a
   30-day window wins and later plain visits never overwrite it —
   stores them in localStorage, and booking forms attach them
   (invisibly, optionally) to the booking submission, so Ad Studio
   can count which ads produced which bookings.

   Nothing here is required for booking: with no stored attribution,
   attach() is a no-op and every form behaves exactly as before.
   No fingerprinting, no cross-site tracking — only the parameters
   the ad platforms themselves put in the landing URL. */
(function () {
  if (window.TSOSAttribution) return;
  var KEY = 'tsos_attribution';
  var MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  var PARAMS = [
    ['utm_source', 'utmSource'],
    ['utm_medium', 'utmMedium'],
    ['utm_campaign', 'utmCampaign'],
    ['gclid', 'gclid'],
    ['fbclid', 'fbclid'],
    ['msclkid', 'msclkid'],
  ];
  var KEYS = ['page', 'utmSource', 'utmMedium', 'utmCampaign', 'gclid', 'fbclid', 'msclkid'];

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function capture() {
    var params;
    try { params = new URLSearchParams(window.location.search || ''); } catch (e) { return; }
    var found = {};
    var any = false;
    for (var i = 0; i < PARAMS.length; i += 1) {
      var v = params.get(PARAMS[i][0]);
      if (v) { found[PARAMS[i][1]] = String(v).slice(0, 500); any = true; }
    }
    if (!any) return;
    var existing = read();
    if (existing && existing.ts && (Date.now() - existing.ts) < MAX_AGE) return; // first touch stands
    found.page = String(window.location.href || '').split('#')[0].slice(0, 1000);
    found.ts = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(found)); } catch (e) { /* private mode: capture is best-effort */ }
  }

  window.TSOSAttribution = {
    /* The stored first-touch fields (no timestamp), or null. */
    get: function () {
      var rec = read();
      if (!rec) return null;
      var out = {};
      for (var i = 0; i < KEYS.length; i += 1) {
        if (rec[KEYS[i]]) out[KEYS[i]] = rec[KEYS[i]];
      }
      return Object.keys(out).length ? out : null;
    },
    /* Fill any attribution keys the payload does not already carry
       (values already on the payload — e.g. read from the current
       URL by the form itself — always win). Returns the payload. */
    attach: function (payload) {
      var at = window.TSOSAttribution.get();
      if (at && payload) {
        for (var k in at) {
          if (!(k in payload)) payload[k] = at[k];
        }
      }
      return payload;
    },
  };

  capture();
})();
