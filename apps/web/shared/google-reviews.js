/* Google reviews display (recommendations A2, 2026-11-20).
 *
 * Mounts on any page carrying a [data-google-reviews] element and
 * renders the REAL Google Business Profile reviews served by
 * GET /api/v1/google-reviews — reviewer name, star rating, text and
 * date, plus Review/AggregateRating structured data injected only
 * when reviews actually render.
 *
 * Honest absence: while the Business Profile connection does not
 * exist (or Google returns no reviews), the endpoint answers
 * available:false and this component renders NOTHING — the mount
 * stays empty, no placeholder, no stars, no layout shift. Reviewer
 * text is only ever inserted via textContent, never as HTML.
 */
(function () {
  var API = 'https://top-speed-service-os.vercel.app/api/v1';
  var MAX_SHOWN = 6;
  var STAR_PATH = 'M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z';

  var STYLE = [
    '.tsgr{max-width:1120px;margin:28px auto 0;padding:0 16px}',
    '.tsgr-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px 16px;margin-bottom:14px}',
    '.tsgr-head h3{font-size:24px;margin:0;color:#0C162B}',
    '.tsgr-agg{display:flex;align-items:center;gap:8px;color:#0C162B}',
    '.tsgr-agg b{font-size:20px}',
    '.tsgr-stars{display:inline-flex;gap:2px;color:#E94E5C}',
    '.tsgr-stars svg{width:18px;height:18px}',
    '.tsgr-stars .off{color:#C9CED6}',
    '.tsgr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}',
    '.tsgr-card{background:#fff;border:1px solid #E2E6EC;border-radius:14px;padding:16px}',
    '.tsgr-card .who{display:flex;justify-content:space-between;gap:10px;align-items:baseline}',
    '.tsgr-card .name{font-weight:700;color:#0C162B}',
    '.tsgr-card .date{font-size:13px;color:#5B6572;white-space:nowrap}',
    '.tsgr-card p{margin:10px 0 0;color:#2A3442;line-height:1.5}',
    '.tsgr-src{margin-top:12px;font-size:13px;color:#5B6572}',
    '@media (max-width:480px){.tsgr-head h3{font-size:20px}}',
  ].join('\n');

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function stars(rating) {
    var wrap = el('span', 'tsgr-stars');
    wrap.setAttribute('aria-label', rating + ' out of 5 stars');
    for (var i = 1; i <= 5; i += 1) {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'currentColor');
      svg.setAttribute('aria-hidden', 'true');
      if (i > Math.round(rating)) svg.setAttribute('class', 'off');
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', STAR_PATH);
      svg.appendChild(path);
      wrap.appendChild(svg);
    }
    return wrap;
  }

  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function injectJsonLd(data) {
    if (document.querySelector('script[data-tsgr-jsonld]')) return;
    var ld = {
      '@context': 'https://schema.org',
      '@type': 'LocalBusiness',
      name: 'Top Speed Appliance',
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: data.aggregate.average,
        reviewCount: data.aggregate.count,
      },
      review: data.reviews.slice(0, MAX_SHOWN).map(function (r) {
        return {
          '@type': 'Review',
          author: { '@type': 'Person', name: r.authorName },
          reviewRating: { '@type': 'Rating', ratingValue: r.rating },
          reviewBody: r.text || '',
          datePublished: (r.createdAt || '').slice(0, 10),
        };
      }),
    };
    var script = document.createElement('script');
    script.type = 'application/ld+json';
    script.setAttribute('data-tsgr-jsonld', '1');
    script.textContent = JSON.stringify(ld);
    document.head.appendChild(script);
  }

  function render(mount, data) {
    if (!document.querySelector('style[data-tsgr-style]')) {
      var style = document.createElement('style');
      style.setAttribute('data-tsgr-style', '1');
      style.textContent = STYLE;
      document.head.appendChild(style);
    }
    var section = el('section', 'tsgr');
    var head = el('div', 'tsgr-head');
    head.appendChild(el('h3', null, 'What customers say on Google'));
    var agg = el('div', 'tsgr-agg');
    agg.appendChild(el('b', null, String(data.aggregate.average)));
    agg.appendChild(stars(data.aggregate.average));
    agg.appendChild(el('span', null, data.aggregate.count + (data.aggregate.count === 1 ? ' review' : ' reviews')));
    head.appendChild(agg);
    section.appendChild(head);

    var grid = el('div', 'tsgr-grid');
    data.reviews.slice(0, MAX_SHOWN).forEach(function (r) {
      var card = el('article', 'tsgr-card');
      var who = el('div', 'who');
      who.appendChild(el('span', 'name', r.authorName));
      who.appendChild(el('span', 'date', formatDate(r.createdAt)));
      card.appendChild(who);
      card.appendChild(stars(r.rating));
      if (r.text) card.appendChild(el('p', null, r.text));
      grid.appendChild(card);
    });
    section.appendChild(grid);
    section.appendChild(el('p', 'tsgr-src', 'Reviews posted on Google by Top Speed Appliance customers.'));
    mount.appendChild(section);
  }

  function init() {
    var mounts = document.querySelectorAll('[data-google-reviews]');
    if (!mounts.length) return;
    fetch(API + '/google-reviews')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (json) {
        var data = json && json.data;
        if (!data || !data.available || !Array.isArray(data.reviews) || !data.reviews.length || !data.aggregate) {
          return; // honest absence: render nothing
        }
        for (var i = 0; i < mounts.length; i += 1) render(mounts[i], data);
        injectJsonLd(data);
      })
      .catch(function () { /* render nothing */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
