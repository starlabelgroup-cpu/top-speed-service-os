/* Top Speed Ads Library — streaming embed (2026-11-24).
   The drop-in half of the Flywheel Ads Library: any Top Speed web
   surface adds
     <div data-ts-ad data-slot="home" data-platform="flagship"></div>
     <script src="/ads-stream.js" defer></script>
   and the slot fills with the next house creative from the managed
   library (GET /api/v1/ads-os/slot) — service/city matched, fairly
   rotated, impression counted server-side on serve, clicks routed
   through the library's counted redirect to the creative's own
   destination (booking intent lands on /book).

   Slot attributes:
     data-slot      slot name recorded with the click (required-ish)
     data-platform  surface name recorded with the click
     data-service   service slug (refrigerator, washer, …)
     data-city      city slug (no city-tagged creatives exist yet;
                    general creatives serve)
     data-format    "landscape" (default) or "square"
     data-service-from="#id"  read the service from a <select> on
                    the page (the /service triage picker) and
                    re-fill the slot whenever the picker changes
     data-api       API origin override (satellite surfaces)

   Honesty + safety: an empty or failed slot renders NOTHING (the
   div stays empty and takes no space) — never a filler, never a
   fake ad, never a broken layout. All copy comes from the library
   and is escaped before it touches the DOM. */
(function () {
  var API = 'https://top-speed-service-os.vercel.app/api/v1';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var SERVICE_SLUGS = {
    refrigerator: 'refrigerator', fridge: 'refrigerator',
    washer: 'washer', 'washing machine': 'washer',
    dryer: 'dryer',
    oven: 'oven-range', range: 'oven-range', stove: 'oven-range', 'oven/range': 'oven-range',
    dishwasher: 'dishwasher',
    freezer: 'freezer-ice-maker', 'ice maker': 'freezer-ice-maker', 'freezer/ice maker': 'freezer-ice-maker',
    microwave: 'microwave',
    'garbage disposal': 'garbage-disposal', disposal: 'garbage-disposal',
    installation: 'installation', install: 'installation',
  };

  function serviceFromSelect(el, fallback) {
    if (!el) return fallback || '';
    var raw = '';
    if (el.tagName === 'SELECT') {
      var opt = el.options[el.selectedIndex];
      raw = (opt && (opt.value || opt.text)) || el.value || '';
    } else {
      raw = el.value || el.textContent || '';
    }
    var key = String(raw).trim().toLowerCase();
    return SERVICE_SLUGS[key] || fallback || '';
  }

  function render(box, ad) {
    if (!ad) { box.innerHTML = ''; return; }
    var inner = '';
    if (ad.kind === 'TEXT') {
      inner =
        '<div style="padding:16px 18px">' +
          '<div style="font-weight:800;font-size:19px;line-height:1.25;color:#fff">' + esc(ad.headline || ad.title) + '</div>' +
          (ad.subline ? '<p style="margin:8px 0 0;color:#c8d2e0;font-size:14.5px;line-height:1.5">' + esc(ad.subline) + '</p>' : '') +
          '<span style="display:inline-block;margin-top:12px;background:#e63946;color:#fff;font-weight:700;font-size:14px;padding:9px 16px;border-radius:999px">' + esc(ad.ctaText || 'Learn more') + '</span>' +
        '</div>';
    } else if (ad.imageUrl) {
      inner =
        '<img src="' + esc(ad.imageUrl) + '" alt="' + esc(ad.imageAlt || ad.title || 'Top Speed Appliance') + '"' +
        (ad.width ? ' width="' + esc(ad.width) + '"' : '') + (ad.height ? ' height="' + esc(ad.height) + '"' : '') +
        ' loading="lazy" style="display:block;width:100%;height:auto" />' +
        '<span style="position:absolute;left:12px;bottom:12px;background:rgba(6,16,32,.82);color:#fff;font-weight:700;font-size:13.5px;padding:8px 14px;border-radius:999px">' + esc(ad.ctaText || 'Book a repair') + ' →</span>';
    } else {
      box.innerHTML = '';
      return;
    }
    box.innerHTML =
      '<a href="' + esc(ad.clickUrl) + '" target="_top" rel="noopener" aria-label="' + esc(ad.title || 'Top Speed Appliance') + '"' +
      ' style="position:relative;display:block;border-radius:16px;overflow:hidden;background:#0a1a33;border:1px solid rgba(255,255,255,.08);text-decoration:none;box-shadow:0 10px 30px rgba(2,8,23,.35)">' +
      inner + '</a>';
  }

  function fill(box) {
    var api = box.getAttribute('data-api') || API;
    var fromSel = box.getAttribute('data-service-from');
    var service = box.getAttribute('data-service') || '';
    if (fromSel) {
      var src = document.querySelector(fromSel);
      service = serviceFromSelect(src, service);
    }
    var qs = new URLSearchParams({
      slot: box.getAttribute('data-slot') || 'slot',
      platform: box.getAttribute('data-platform') || 'web',
      format: box.getAttribute('data-format') || 'landscape',
    });
    if (service) qs.set('service', service);
    var city = box.getAttribute('data-city');
    if (city) qs.set('city', city);
    fetch(api + '/ads-os/slot?' + qs.toString(), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) { render(box, body && body.data ? body.data : null); })
      .catch(function () { /* dark on failure — the slot stays empty */ });
  }

  function init() {
    var boxes = document.querySelectorAll('[data-ts-ad]');
    boxes.forEach(function (box) {
      fill(box);
      var fromSel = box.getAttribute('data-service-from');
      if (fromSel) {
        var src = document.querySelector(fromSel);
        if (src) src.addEventListener('change', function () { fill(box); });
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
