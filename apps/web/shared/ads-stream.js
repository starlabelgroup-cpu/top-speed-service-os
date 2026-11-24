/* Top Speed Ads — public attraction stream (2026-11-23).
 *
 * One shared include for every Service OS surface: drop
 *   <div data-tsos-ads-stream></div>
 *   <script src="/shared/ads-stream.js" defer></script>
 * (satellite hosts use the absolute flagship URL for the script)
 * and the block renders the Top Speed Ads stream from
 * GET /api/v1/ads-os/stream: the ads-style posts actually published
 * on the official Facebook Page (POSTED ad-format records only, each
 * card linking to the real Facebook post — Rule 1) alongside the
 * standing offer cards (the published flat rate card and the
 * referral rewards terms, served by the API as data).
 *
 * Honesty rules baked in, same as the Facebook feed include:
 *  - the stream serves POSTED records only — posts Pepper actually
 *    published behind Ramone's approval, recorded with their real
 *    facebook.com URLs;
 *  - when no ad post has been posted yet, this renders NOTHING
 *    (no section, no placeholder, no invented posts);
 *  - the offer cards state only the platform's published terms.
 */
(function () {
  var API = 'https://top-speed-service-os.vercel.app/api/v1/ads-os/stream';
  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function render(container, stream) {
    var posts = (stream && stream.posts) || [];
    if (!posts.length) return; // honest empty: no section at all
    var limit = Number(container.getAttribute('data-limit') || 3);
    posts = posts.slice(0, Math.max(1, limit));
    var offers = (stream.offers || []).map(function (o) {
      var lines = (o.lines || []).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
      return '<article class="tsas-offer">'
        + (o.visual ? '<img class="tsas-visual" src="' + esc(o.visual) + '" alt="" loading="lazy">' : '')
        + '<span class="tsas-kicker">Top Speed offer</span>'
        + '<h3 class="tsas-title">' + esc(o.title) + '</h3>'
        + '<ul class="tsas-lines">' + lines + '</ul>'
        + (o.cta ? '<a class="tsas-cta" href="' + esc(o.cta.url) + '">' + esc(o.cta.label) + '</a>' : '')
        + '</article>';
    }).join('');
    var cards = posts.map(function (p) {
      var excerpt = String(p.copy || '').replace(/\s+/g, ' ').trim();
      if (excerpt.length > 220) excerpt = excerpt.slice(0, 217) + '…';
      var date = '';
      try { date = new Date(p.postedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { /* keep blank */ }
      // A real recorded graphic (mediaUrl) always wins; the Pepper
      // visual is the designed fallback so every card carries a
      // graphic (Pepper visuals on every in-house ad, 2026-11-23).
      var media = p.mediaUrl || p.visual;
      return '<article class="tsas-card">'
        + (media ? '<a class="tsas-media" href="' + esc(p.url) + '" target="_blank" rel="noopener"><img src="' + esc(media) + '" alt="" loading="lazy"></a>' : '')
        + '<div class="tsas-body"><span class="tsas-kicker">Top Speed Ads' + (date ? ' · ' + esc(date) : '') + '</span>'
        + '<h3 class="tsas-title">' + esc(p.title) + '</h3>'
        + '<p class="tsas-copy">' + esc(excerpt) + '</p>'
        + '<a class="tsas-link" href="' + esc(p.url) + '" target="_blank" rel="noopener">See it on Facebook</a></div></article>';
    }).join('');
    container.innerHTML = '<section class="tsas" aria-label="Top Speed Ads — offers and latest ads">'
      + '<div class="tsas-head"><h2>Top Speed Ads — straight offers, real posts</h2>'
      + '<a class="tsas-page" href="' + esc((stream.page && stream.page.url) || 'https://www.facebook.com/profile.php?id=61596590488055') + '" target="_blank" rel="noopener">Follow Top Speed Appliance on Facebook</a></div>'
      + '<div class="tsas-grid">' + offers + cards + '</div></section>';
  }
  function boot() {
    var containers = document.querySelectorAll('[data-tsos-ads-stream]');
    if (!containers.length) return;
    if (!document.getElementById('tsas-style')) {
      var style = document.createElement('style');
      style.id = 'tsas-style';
      style.textContent = '.tsas{max-width:1120px;margin:34px auto;padding:0 20px}'
        + '.tsas-head{display:flex;justify-content:space-between;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:14px}'
        + '.tsas-head h2{font-size:24px;color:#071f4f;margin:0}'
        + '.tsas-page{font-weight:700;color:#1473ff;font-size:14.5px}'
        + '.tsas-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}'
        + '.tsas-card,.tsas-offer{background:#fff;border:1px solid #d8e2f2;border-radius:14px;overflow:hidden;display:flex;flex-direction:column}'
        + '.tsas-offer{border-color:#f0c4c6;background:#fff8f8;padding:16px;gap:8px}'
        + '.tsas-media img{width:100%;height:auto;display:block}'
        + '.tsas-visual{width:100%;height:auto;display:block;border-radius:10px}'
        + '.tsas-body{padding:16px;display:flex;flex-direction:column;gap:8px}'
        + '.tsas-kicker{font-size:11.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#5a6b82}'
        + '.tsas-offer .tsas-kicker{color:#b02020}'
        + '.tsas-title{font-size:17px;color:#071f4f;margin:0;line-height:1.35}'
        + '.tsas-copy{font-size:14.5px;color:#43536b;line-height:1.55;margin:0}'
        + '.tsas-lines{margin:0;padding-left:18px;font-size:14.5px;color:#43536b;line-height:1.6}'
        + '.tsas-link{font-weight:700;color:#e01a22;font-size:14.5px;margin-top:auto}'
        + '.tsas-cta{font-weight:800;color:#fff;background:#e01a22;border-radius:10px;padding:10px 14px;text-align:center;margin-top:auto;text-decoration:none}';
      document.head.appendChild(style);
    }
    fetch(API + '?limit=10', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.data) return;
        Array.prototype.forEach.call(containers, function (c) { render(c, j.data); });
      })
      .catch(function () { /* stream unreachable: render nothing */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
