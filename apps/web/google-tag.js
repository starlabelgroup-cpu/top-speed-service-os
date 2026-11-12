/*
 * Top Speed Service OS — Google integrations: THE single config point.
 * =====================================================================
 * Every Google tag/key for topspeedserviceos.com lives in the ONE object
 * below. All 65 flagship pages load this file from <head>. To activate a
 * service, paste its real value here and redeploy — nothing else changes.
 * While a value is empty, that service makes NO requests and loads
 * NOTHING: this file is an honest off-switch, not a placeholder tracker.
 *
 * Values come from the Google-side setup (Search Console / GA4 / Google
 * Cloud console), never invented here:
 *
 *   GA4_MEASUREMENT_ID — GA4 Admin > Data Streams > Web stream, looks
 *     like "G-XXXXXXXXXX". Setting it turns on GA4 on every flagship
 *     page (public pages, both customer apps, /software, staff consoles).
 *
 *   GSC_VERIFICATION — Search Console "HTML tag" content value for the
 *     topspeedserviceos.com property. This injects the meta tag as a
 *     best-effort fallback; the GUARANTEED verification routes are
 *     (a) the HTML file method — drop the issued google*.html file in
 *     apps/web/ root, it serves at topspeedserviceos.com/google*.html, or
 *     (b) the ready meta slot in apps/web/index.html <head>.
 *
 *   MAPS_EMBED_API_KEY — Google Maps Platform browser key (Maps Embed
 *     API enabled, restricted by HTTP referrer to topspeedserviceos.com).
 *     Setting it upgrades /track: the technician's live location renders
 *     as an embedded map at the en-route stage. Empty = today's behavior
 *     (an outbound "See your technician on the map" link) — nothing breaks.
 */
window.TSOS_GOOGLE = {
  GA4_MEASUREMENT_ID: 'G-30WFYN49DP',
  GSC_VERIFICATION: 'HDBE_Kqlk0bhAY9WYE-56uhiOHahYhf7mFgPN3mlof0',
  MAPS_EMBED_API_KEY: ''
};

/* Read by /track (locLine) for the config-gated live-map embed. */
window.TSOS_MAPS_EMBED_KEY = window.TSOS_GOOGLE.MAPS_EMBED_API_KEY;

(function () {
  var cfg = window.TSOS_GOOGLE || {};

  /* Search Console meta tag — fallback only (see header notes). */
  if (cfg.GSC_VERIFICATION) {
    var m = document.createElement('meta');
    m.name = 'google-site-verification';
    m.content = cfg.GSC_VERIFICATION;
    document.head.appendChild(m);
  }

  /* GA4 (gtag.js) — loads only when a real Measurement ID is set. */
  if (!cfg.GA4_MEASUREMENT_ID) return;
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(cfg.GA4_MEASUREMENT_ID);
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', cfg.GA4_MEASUREMENT_ID);
})();
