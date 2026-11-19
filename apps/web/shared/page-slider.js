/* Top Speed — Page Slider (up/down fast-scroll rail, 2026-11-18).
   Ordered by Ramone Williams: a slim up/down slider on every page of
   the flagship and all satellite platforms so visitors can jump or
   fast-scroll long pages without hunting for the scrollbar.

   Placement is deliberate: fixed at the RIGHT edge, vertically
   CENTERED — never bottom-right (the Ask Speedy pill lives there),
   never along the bottom (the Pepper staff bar sits there), never
   bottom-left (the account switcher lives there). z-index 900 sits
   above page content but below modals and chat panels. Pointer
   events land only on the rail itself.

   Behaviour:
   - Click the up chevron   -> smooth-scroll to the very top.
   - Click the down chevron -> smooth-scroll to the very bottom.
   - Press-and-hold either chevron -> continuous fast scroll until
     the pointer is released.
   - Drag the thumb -> scroll proportionally through the page.
   - The thumb's position and size track the visible scroll
     fraction, updated through a requestAnimationFrame throttle.
   - The rail shows ONLY when the page is actually scrollable
     (scrollHeight > innerHeight + 40) and re-checks on resize,
     load and DOM changes.
   - prefers-reduced-motion -> instant jumps, no smooth/fast motion.

   Safety: no framework, no dynamic innerHTML (the only markup is
   this file's own static SVG icons, set once), no external assets.
   Safe to defer-load on any page; a second include is a no-op. */
(function () {
  if (window.__pageSliderLoaded) return;
  window.__pageSliderLoaded = true;
  if (document.getElementById('tsPageSlider')) return;

  var SVG_UP = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 14 12 7 19 14"></polyline></svg>';
  var SVG_DOWN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 10 12 17 19 10"></polyline></svg>';

  var css = [
    '.tps-rail{position:fixed;right:6px;top:50%;transform:translateY(-50%);z-index:900;width:32px;height:248px;display:none;flex-direction:column;align-items:center;gap:4px;padding:6px 0;box-sizing:border-box;background:rgba(12,22,43,.62);border:1px solid rgba(255,255,255,.22);border-radius:999px;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);box-shadow:0 6px 20px rgba(6,15,35,.35);font-family:system-ui,sans-serif;pointer-events:auto;touch-action:none}',
    '.tps-rail.on{display:flex}',
    '.tps-btn{flex:none;width:32px;height:40px;min-height:40px;display:flex;align-items:center;justify-content:center;background:none;border:none;color:#fff;cursor:pointer;padding:0;border-radius:999px;-webkit-tap-highlight-color:transparent}',
    '.tps-btn:hover{background:rgba(255,255,255,.16)}',
    '.tps-btn:active{background:rgba(255,255,255,.28)}',
    '.tps-btn:focus-visible{outline:2px solid #7FB2FF;outline-offset:-2px}',
    '.tps-track{position:relative;flex:1 1 auto;width:32px;cursor:pointer}',
    '.tps-thumb{position:absolute;left:50%;transform:translateX(-50%);width:20px;min-height:26px;border-radius:999px;background:rgba(255,255,255,.88);box-shadow:inset 0 0 0 1px rgba(12,22,43,.18);cursor:grab}',
    '.tps-thumb:active{cursor:grabbing;background:#fff}',
    '@media (prefers-reduced-motion:reduce){.tps-rail{backdrop-filter:none;-webkit-backdrop-filter:none}}'
  ].join('\n');

  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (e) { return false; }
  }
  function docEl() { return document.documentElement; }
  function scrollableHeight() { return Math.max(0, docEl().scrollHeight - window.innerHeight); }
  function isScrollable() { return docEl().scrollHeight > window.innerHeight + 40; }

  function build() {
    var style = document.createElement('style');
    style.id = 'tsPageSliderStyle';
    style.textContent = css;
    document.head.appendChild(style);

    var rail = document.createElement('div');
    rail.className = 'tps-rail';
    rail.id = 'tsPageSlider';
    rail.setAttribute('role', 'navigation');
    rail.setAttribute('aria-label', 'Page scroll');

    var up = document.createElement('button');
    up.type = 'button';
    up.className = 'tps-btn';
    up.id = 'tsPageSliderUp';
    up.setAttribute('aria-label', 'Scroll to top');
    up.title = 'Top';
    up.innerHTML = SVG_UP;

    var track = document.createElement('div');
    track.className = 'tps-track';
    track.id = 'tsPageSliderTrack';

    var thumb = document.createElement('div');
    thumb.className = 'tps-thumb';
    thumb.id = 'tsPageSliderThumb';
    thumb.setAttribute('role', 'slider');
    thumb.setAttribute('aria-label', 'Scroll position');
    thumb.setAttribute('aria-valuemin', '0');
    thumb.setAttribute('aria-valuemax', '100');
    track.appendChild(thumb);

    var down = document.createElement('button');
    down.type = 'button';
    down.className = 'tps-btn';
    down.id = 'tsPageSliderDown';
    down.setAttribute('aria-label', 'Scroll to bottom');
    down.title = 'Bottom';
    down.innerHTML = SVG_DOWN;

    rail.appendChild(up);
    rail.appendChild(track);
    rail.appendChild(down);
    document.body.appendChild(rail);
    return { rail: rail, up: up, down: down, track: track, thumb: thumb };
  }

  function start() {
    if (!document.body) { setTimeout(start, 50); return; }
    var ui = build();
    var rail = ui.rail, up = ui.up, down = ui.down, track = ui.track, thumb = ui.thumb;
    var rafPending = false;

    function updateThumb() {
      rafPending = false;
      var max = scrollableHeight();
      var trackH = track.clientHeight;
      if (max <= 0 || trackH <= 0) return;
      var viewFrac = Math.min(1, window.innerHeight / Math.max(1, docEl().scrollHeight));
      var thumbH = Math.max(26, Math.round(trackH * viewFrac));
      thumbH = Math.min(trackH, thumbH);
      thumb.style.height = thumbH + 'px';
      var frac = Math.min(1, Math.max(0, window.scrollY / max));
      var travel = trackH - thumbH;
      thumb.style.top = Math.round(frac * travel) + 'px';
      thumb.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    }
    function scheduleUpdate() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(updateThumb);
    }
    function refresh() {
      rail.classList.toggle('on', isScrollable());
      scheduleUpdate();
    }

    function jumpTo(target) {
      window.scrollTo({ top: target, left: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    }

    /* Press-and-hold: a quick tap jumps to the end; holding past
       280ms switches to continuous fast scrolling until release. */
    function wireHold(btn, dir) {
      var holdTimer = null, rafId = null, held = false, downAt = 0;
      function step() {
        window.scrollBy(0, dir * 30);
        rafId = requestAnimationFrame(step);
      }
      function stop(e) {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        var wasHeld = held;
        held = false;
        if (e && e.type === 'pointerup' && !wasHeld && (Date.now() - downAt) < 600) {
          jumpTo(dir < 0 ? 0 : scrollableHeight());
        }
      }
      btn.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        downAt = Date.now();
        held = false;
        if (reducedMotion()) return; /* tap only; click-equivalent jump on release */
        holdTimer = setTimeout(function () { held = true; rafId = requestAnimationFrame(step); }, 280);
      });
      btn.addEventListener('pointerup', stop);
      btn.addEventListener('pointercancel', function () { stop(null); });
      btn.addEventListener('pointerleave', function () {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        held = false;
      });
      /* Keyboard: Enter/Space on a focused button fires click. */
      btn.addEventListener('click', function (e) {
        /* Pointer taps are handled on pointerup; only honour
           keyboard / programmatic clicks (detail === 0). */
        if (e.detail === 0) jumpTo(dir < 0 ? 0 : scrollableHeight());
      });
    }
    wireHold(up, -1);
    wireHold(down, 1);

    /* Drag the thumb (or tap the track) to scroll proportionally. */
    var dragging = false;
    function scrollFromPointer(clientY) {
      var rect = track.getBoundingClientRect();
      var thumbH = thumb.offsetHeight || 26;
      var travel = Math.max(1, rect.height - thumbH);
      var frac = (clientY - rect.top - thumbH / 2) / travel;
      frac = Math.min(1, Math.max(0, frac));
      window.scrollTo({ top: frac * scrollableHeight(), left: 0, behavior: 'auto' });
    }
    function onDragStart(e) {
      dragging = true;
      try { track.setPointerCapture(e.pointerId); } catch (err) {}
      scrollFromPointer(e.clientY);
      e.preventDefault();
    }
    track.addEventListener('pointerdown', onDragStart);
    thumb.addEventListener('pointerdown', function (e) { e.stopPropagation(); onDragStart(e); });
    track.addEventListener('pointermove', function (e) { if (dragging) scrollFromPointer(e.clientY); });
    function endDrag() { dragging = false; }
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);

    window.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', refresh);
    window.addEventListener('load', refresh);
    if (window.MutationObserver && document.body) {
      var mo = new MutationObserver(function () { refresh(); });
      mo.observe(document.body, { childList: true, subtree: true, attributes: false });
      /* Stop observing after 10s; resize/load/scroll keep it fresh. */
      setTimeout(function () { try { mo.disconnect(); } catch (e) {} }, 10000);
    }
    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
