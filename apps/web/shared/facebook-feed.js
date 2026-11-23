/* Top Speed Facebook OS — public latest-posts feed (2026-11-23).
 *
 * One shared include for every Service OS surface: drop
 *   <div data-tsos-fb-feed></div>
 *   <script src="/shared/facebook-feed.js" defer></script>
 * (satellite hosts use the absolute flagship URL for the script)
 * and the block renders the official Facebook Page's latest REAL
 * posts from GET /api/v1/facebook-os/feed.
 *
 * Honesty rules baked in:
 *  - the feed serves POSTED records only — posts Pepper actually
 *    published behind Ramone's approval, recorded with their real
 *    facebook.com URLs;
 *  - when nothing has posted yet, this renders NOTHING (no section,
 *    no placeholder, no invented posts);
 *  - every card links to the post itself on Facebook (Rule 1),
 *    never to a homepage.
 */
(function () {
  var API = 'https://top-speed-service-os.vercel.app/api/v1/facebook-os/feed';
  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtLabel(f) {
    return ({
      REPAIR_SPOTLIGHT: 'Repair Spotlight', SPEEDY_TIP: 'Speedy Tip',
      REWARDS_SAVINGS: 'Rewards & Savings', CITY_SPOTLIGHT: 'City Spotlight',
      QUICK_TIP: 'Quick Tip', REVIEW_INVITE: 'From our customers',
      AD_IDEA: 'Top Speed', ANNOUNCEMENT: 'Announcement', CUSTOM: 'Top Speed',
    })[f] || 'Top Speed';
  }
  function render(container, feed) {
    var posts = (feed && feed.posts) || [];
    if (!posts.length) return; // honest empty: no section at all
    var limit = Number(container.getAttribute('data-limit') || 3);
    posts = posts.slice(0, Math.max(1, limit));
    var cards = posts.map(function (p) {
      var excerpt = String(p.copy || '').replace(/\s+/g, ' ').trim();
      if (excerpt.length > 220) excerpt = excerpt.slice(0, 217) + '…';
      var date = '';
      try { date = new Date(p.postedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { /* keep blank */ }
      return '<article class="tsfb-card">'
        + (p.mediaUrl ? '<a class="tsfb-media" href="' + esc(p.url) + '" target="_blank" rel="noopener"><img src="' + esc(p.mediaUrl) + '" alt="" loading="lazy"></a>' : '')
        + '<div class="tsfb-body"><span class="tsfb-kicker">' + esc(fmtLabel(p.format)) + (date ? ' · ' + esc(date) : '') + '</span>'
        + '<h3 class="tsfb-title">' + esc(p.title) + '</h3>'
        + '<p class="tsfb-copy">' + esc(excerpt) + '</p>'
        + '<a class="tsfb-link" href="' + esc(p.url) + '" target="_blank" rel="noopener">See it on Facebook</a></div></article>';
    }).join('');
    container.innerHTML = '<section class="tsfb" aria-label="Latest from Top Speed Posts by Pepper">'
      + '<div class="tsfb-head"><h2>Latest from Top Speed Posts by Pepper</h2>'
      + '<a class="tsfb-page" href="' + esc((feed.page && feed.page.url) || 'https://www.facebook.com/profile.php?id=61596590488055') + '" target="_blank" rel="noopener">Follow Top Speed Appliance on Facebook</a></div>'
      + '<div class="tsfb-grid">' + cards + '</div></section>';
  }
  function boot() {
    var containers = document.querySelectorAll('[data-tsos-fb-feed]');
    if (!containers.length) return;
    if (!document.getElementById('tsfb-style')) {
      var style = document.createElement('style');
      style.id = 'tsfb-style';
      style.textContent = '.tsfb{max-width:1120px;margin:34px auto;padding:0 20px}'
        + '.tsfb-head{display:flex;justify-content:space-between;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:14px}'
        + '.tsfb-head h2{font-size:24px;color:#071f4f;margin:0}'
        + '.tsfb-page{font-weight:700;color:#1473ff;font-size:14.5px}'
        + '.tsfb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}'
        + '.tsfb-card{background:#fff;border:1px solid #d8e2f2;border-radius:14px;overflow:hidden;display:flex;flex-direction:column}'
        + '.tsfb-media img{width:100%;height:auto;display:block}'
        + '.tsfb-body{padding:16px;display:flex;flex-direction:column;gap:8px}'
        + '.tsfb-kicker{font-size:11.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#5a6b82}'
        + '.tsfb-title{font-size:17px;color:#071f4f;margin:0;line-height:1.35}'
        + '.tsfb-copy{font-size:14.5px;color:#43536b;line-height:1.55;margin:0}'
        + '.tsfb-link{font-weight:700;color:#e01a22;font-size:14.5px;margin-top:auto}';
      document.head.appendChild(style);
    }
    fetch(API + '?limit=10', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.data) return;
        Array.prototype.forEach.call(containers, function (c) { render(c, j.data); });
      })
      .catch(function () { /* feed unreachable: render nothing */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
