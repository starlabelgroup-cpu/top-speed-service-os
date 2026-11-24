/* Top Speed Service OS — Book by Location card (2026-11-23).
 *
 * Renders a small opt-in card into every [data-tsos-location-booking]
 * mount. The browser's location prompt appears ONLY when the customer
 * taps "Use my location" — never on page load. On a match the card
 * confirms the service area, pre-fills the booking form's city control
 * when it can, and stashes the verified location on window.TSOSGeo
 * (+ hidden inputs inside the mount) so the form's submit carries
 * geoCity/geoTier/geoLat/geoLng to the booking. The server re-derives
 * the stored values from the coordinates — this card is a convenience,
 * never an authority. Denied/unavailable quietly collapses the card:
 * no nagging, no repeat prompts, and the form is never gated on it. */
(function () {
  'use strict';
  var API = 'https://top-speed-service-os.vercel.app/api/v1';
  var STYLE_ID = 'tsos-location-booking-css';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21.2S5 15.6 5 9.9a7 7 0 0 1 14 0c0 5.7-7 11.3-7 11.3z"/><circle cx="12" cy="9.9" r="2.6" stroke="#E8322E"/><circle cx="12" cy="9.9" r=".9" fill="#E8322E" stroke="none"/></svg>';
  var CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.8l5.2 5.2L20 6.8"/></svg>';
  var PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.2 4h3.4l1.4 4.2-2.1 1.7a13.5 13.5 0 0 0 6.2 6.2l1.7-2.1L20 15.4v3.4a2 2 0 0 1-2.1 2A16.5 16.5 0 0 1 3.2 6.1 2 2 0 0 1 5.2 4z"/></svg>';

  var CSS = [
    '.tsos-loc{box-sizing:border-box;max-width:100%;border:1px solid #dbe4f0;border-radius:16px;background:#f7faff;padding:14px 16px;margin:0 0 16px;font-size:14.5px;line-height:1.5;color:#22314d}',
    '.tsos-loc *{box-sizing:border-box}',
    '.tsos-loc .tl-row{display:flex;gap:12px;align-items:flex-start}',
    '.tsos-loc .tl-ic{flex:none;width:34px;height:34px;border-radius:10px;background:#0A265C;color:#fff;display:flex;align-items:center;justify-content:center}',
    '.tsos-loc .tl-ic svg{width:20px;height:20px}',
    '.tsos-loc .tl-ic.ok{background:#177245}',
    '.tsos-loc .tl-ic.edge{background:#9a6a00}',
    '.tsos-loc .tl-ic.out{background:#8a94a6}',
    '.tsos-loc p{margin:2px 0 0}',
    '.tsos-loc .tl-btn{margin-top:10px;display:inline-flex;align-items:center;gap:8px;background:#E8322E;color:#fff;border:none;border-radius:999px;padding:10px 18px;font:inherit;font-weight:800;font-size:14.5px;cursor:pointer}',
    '.tsos-loc .tl-btn svg{width:17px;height:17px}',
    '.tsos-loc .tl-btn[disabled]{opacity:.6;cursor:wait}',
    '.tsos-loc .tl-call{display:inline-flex;align-items:center;gap:7px;margin-top:10px;background:#0A265C;color:#fff;border-radius:999px;padding:10px 16px;font-weight:800;font-size:14px;text-decoration:none}',
    '.tsos-loc .tl-call svg{width:16px;height:16px}',
    '.tsos-loc b{color:#0A265C}'
  ].join('');

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function round3(n) { return Math.round(n * 1000) / 1000; }

  /* Pre-fill the page's city control when one of its options matches
     the verified city (the web forms list the crew cities; the app
     form likewise). No match → the form is left exactly as it was. */
  function prefillCity(city) {
    var sels = document.querySelectorAll('#wCity, #cdCity');
    for (var s = 0; s < sels.length; s++) {
      var sel = sels[s];
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].text.toLowerCase() === String(city).toLowerCase() || sel.options[i].value === city) {
          sel.selectedIndex = i;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
    }
    return false;
  }

  function mount(el) {
    el.innerHTML =
      '<div class="tl-row"><div class="tl-ic">' + PIN + '</div><div>' +
      '<b>Book by location</b>' +
      '<p>Use my location \u2014 confirm you\u2019re in our service area and pre-fill your city. We use your location only for this booking; it\u2019s never shared.</p>' +
      '<button type="button" class="tl-btn">' + PIN + ' Use my location</button>' +
      '</div></div>';
    var btn = el.querySelector('.tl-btn');
    btn.addEventListener('click', function () { locate(el, btn); });
  }

  function collapse(el) { el.style.display = 'none'; }

  function renderState(el, kind, html) {
    var ic = el.querySelector('.tl-ic');
    if (ic) { ic.className = 'tl-ic ' + kind; ic.innerHTML = kind === 'ok' ? CHECK : PIN; }
    var slot = el.querySelector('.tl-body');
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'tl-body';
      el.querySelector('.tl-row > div:last-child').appendChild(slot);
    }
    slot.innerHTML = html;
  }

  function locate(el, btn) {
    if (!navigator.geolocation) { collapse(el); return; }
    btn.disabled = true;
    btn.textContent = 'Finding you\u2026';
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      fetch(API + '/geo/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: lat, lng: lng })
      }).then(function (r) { return r.json(); }).then(function (j) {
        var d = j && j.data;
        if (!d || !d.tier) { collapse(el); return; }
        var geo = {
          geoCity: d.matchedCity || undefined,
          geoTier: d.tier,
          geoLat: round3(lat),
          geoLng: round3(lng)
        };
        window.TSOSGeo = geo;
        /* Hidden inputs ride along if a surrounding form serializes. */
        el.querySelectorAll('input[type="hidden"]').forEach(function (n) { n.remove(); });
        Object.keys(geo).forEach(function (k) {
          if (geo[k] === undefined) return;
          var inp = document.createElement('input');
          inp.type = 'hidden'; inp.name = k; inp.value = String(geo[k]);
          el.appendChild(inp);
        });
        var btnHtml = '';
        var oldBtn = el.querySelector('.tl-btn');
        if (oldBtn) oldBtn.remove();
        if (d.tier === 'IN_AREA') {
          prefillCity(d.matchedCity);
          renderState(el, 'ok', '<b>You\u2019re in our service area</b><p>' + esc(d.matchedCity) + ' \u2014 we\u2019ve pre-filled your city below. Your location rides along with this booking so dispatch sees it.</p>');
        } else if (d.tier === 'AREA_REVIEW') {
          if (d.matchedCity) prefillCity(d.matchedCity);
          renderState(el, 'edge', '<b>Near the edge of our coverage</b><p>You\u2019re near ' + esc(d.matchedCity || 'the edge of our service area') + ' \u2014 we\u2019ll confirm when we call. You can book as normal below.</p>');
        } else {
          renderState(el, 'out', '<b>Outside our service area for now</b><p>Your location is outside the South Florida areas we serve today. You can still send the form and we\u2019ll keep your request on file \u2014 or reach us right away:</p><a class="tl-call" href="tel:+18444607038">' + PHONE + ' Call (844) 460-7038</a>');
        }
        void btnHtml;
      }).catch(function () { collapse(el); });
    }, function () { collapse(el); }, { timeout: 10000, maximumAge: 300000 });
  }

  function boot() {
    ensureStyle();
    document.querySelectorAll('[data-tsos-location-booking]').forEach(mount);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
