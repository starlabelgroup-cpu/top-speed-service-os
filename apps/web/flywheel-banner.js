/* Top Speed — Flywheel mini banner (2026-11-16).
   One shared slim ad bar for customer-facing surfaces. It renders the
   top ACTIVE campaign from the Flywheel display feed (Ad Studio):
   house campaigns and owner-approved advertiser campaigns alike.
   The surface may declare its category via data-category on this
   script tag; the feed prefers a matching campaign and falls back to
   any ACTIVE one.

   HONEST DARK STATE: when no campaign is ACTIVE the feed is empty and
   this script renders NOTHING — no house filler, no placeholder promo.
   The bar is in-flow (never an overlay), sits at the top of the page,
   and never covers booking forms or call/book actions. Dismissing
   hides the current campaign for the rest of the session. */
(function () {
  if (window.__fwbLoaded) return;
  window.__fwbLoaded = true;

  var script = document.currentScript;
  var API = (script && script.getAttribute('data-api')) || 'https://top-speed-service-os.vercel.app/api/v1';
  var category = (script && script.getAttribute('data-category')) || '';

  function esc(t) {
    return String(t == null ? '' : t).replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }
  function ping(bannerId, type) {
    if (!bannerId) return;
    try {
      fetch(API + '/marketing/banners/' + bannerId + '/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type }),
        keepalive: true,
      });
    } catch (e) { /* counters are best-effort */ }
  }

  var css = [
    '.fwb-bar{box-sizing:border-box;width:100%;background:#0C162B;color:#fff;font-family:Manrope,Inter,system-ui,sans-serif;border-bottom:2px solid #E94E5C}',
    '.fwb-in{max-width:1180px;margin:0 auto;padding:8px 14px;display:flex;align-items:center;gap:12px}',
    '.fwb-ad{flex:0 0 auto;font-size:9.5px;font-weight:800;letter-spacing:.14em;color:#F5C518;border:1px solid rgba(245,197,24,.55);border-radius:4px;padding:2px 5px}',
    '.fwb-txt{flex:1 1 auto;min-width:0;font-size:13.5px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.fwb-txt b{font-weight:800}',
    '.fwb-txt .fwb-off{color:#B9CFF2}',
    '.fwb-cta{flex:0 0 auto;background:#E94E5C;color:#fff;text-decoration:none;font-weight:800;font-size:13px;padding:7px 14px;border-radius:999px;white-space:nowrap}',
    '.fwb-cta:hover{background:#d63a49}',
    '.fwb-x{flex:0 0 auto;background:none;border:none;color:#B9CFF2;cursor:pointer;padding:4px;display:flex;align-items:center}',
    '.fwb-x:hover{color:#fff}',
    '@media(max-width:560px){.fwb-txt{font-size:12.5px}.fwb-cta{font-size:12px;padding:6px 11px}.fwb-in{gap:8px;padding:7px 10px}}',
  ].join('');
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  function render(ad) {
    try {
      if (sessionStorage.getItem('fwbDismissed') === ad.id) return;
    } catch (e) { /* private mode: still render */ }
    var bar = document.createElement('div');
    bar.className = 'fwb-bar';
    bar.setAttribute('role', 'complementary');
    bar.setAttribute('aria-label', 'Advertisement');
    var offering = ad.offering || ad.headline || '';
    bar.innerHTML =
      '<div class="fwb-in">' +
      '<span class="fwb-ad">AD</span>' +
      '<span class="fwb-txt"><b>' + esc(ad.advertiserName) + '</b>' +
      (offering ? ' <span class="fwb-off">— ' + esc(offering) + '</span>' : '') +
      '</span>' +
      (ad.ctaText ? '<a class="fwb-cta" href="' + esc(ad.ctaUrl) + '">' + esc(ad.ctaText) + '</a>' : '') +
      '<button class="fwb-x" type="button" aria-label="Dismiss this ad">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>' +
      '</button>' +
      '</div>';
    var cta = bar.querySelector('.fwb-cta');
    if (cta) cta.addEventListener('click', function () { ping(ad.bannerId, 'click'); });
    bar.querySelector('.fwb-x').addEventListener('click', function () {
      try { sessionStorage.setItem('fwbDismissed', ad.id); } catch (e) { /* ignore */ }
      bar.remove();
    });
    if (document.body) document.body.insertBefore(bar, document.body.firstChild);
    ping(ad.bannerId, 'impression');
  }

  function load() {
    var url = API + '/ad-studio/display' + (category ? '?category=' + encodeURIComponent(category) : '');
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var list = (j && j.data) || [];
        if (list.length) render(list[0]);
      })
      .catch(function () { /* dark on any failure — never a broken bar */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
