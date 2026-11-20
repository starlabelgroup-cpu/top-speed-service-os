/* Language toggle — English ⇄ Spanish (2026-11-20, A5).
 *
 * Spanish lives on /es/ twins of the flagship homepage, the booking
 * page, and the service page. This script renders an EN | ES pill
 * into every [data-lang-toggle] element on those pages, remembers
 * the visitor's choice in localStorage (tsos_lang), and — once per
 * session — sends a returning visitor straight to their language's
 * twin. Pages outside the twin map are untouched: no element, no
 * redirect. English remains the default everywhere.
 */
(function () {
  var TWINS = {
    '/': '/es/',
    '/es/': '/',
    '/book': '/es/book',
    '/es/book': '/book',
    '/service': '/es/service',
    '/es/service': '/service',
  };
  var KEY = 'tsos_lang';
  var GUARD = 'tsos_lang_redirected';

  function norm(path) {
    if (path.length > 1 && path.charAt(path.length - 1) === '/') return path.slice(0, -1) || '/';
    return path;
  }
  function langOf(path) {
    return path === '/es' || path.indexOf('/es/') === 0 ? 'es' : 'en';
  }
  function stored() {
    try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function store(lang) {
    try { window.localStorage.setItem(KEY, lang); } catch (e) { /* private mode */ }
  }

  var path = norm(window.location.pathname);
  var twin = TWINS[path];
  var here = langOf(path);

  // Stored-preference redirect — twin pages only, once per session so
  // a manual switch is never fought.
  if (twin) {
    var pref = stored();
    var guarded = false;
    try { guarded = window.sessionStorage.getItem(GUARD) === '1'; } catch (e) { /* ignore */ }
    if (pref && pref !== here && !guarded) {
      try { window.sessionStorage.setItem(GUARD, '1'); } catch (e) { /* ignore */ }
      window.location.replace(twin + window.location.search + window.location.hash);
      return;
    }
  }

  function render() {
    var hosts = document.querySelectorAll('[data-lang-toggle]');
    if (!hosts.length) return;
    if (!document.getElementById('tsos-lang-style')) {
      var style = document.createElement('style');
      style.id = 'tsos-lang-style';
      style.textContent =
        '.tsos-lang{display:inline-flex;align-items:center;gap:2px;background:rgba(10,22,40,.85);border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:3px;font-family:inherit}' +
        '.tsos-lang a,.tsos-lang span{padding:5px 11px;border-radius:999px;font-size:12.5px;font-weight:800;letter-spacing:.4px;line-height:1;text-decoration:none}' +
        '.tsos-lang span{background:#E8322E;color:#fff}' +
        '.tsos-lang a{color:#dce8fb}' +
        '.tsos-lang a:hover{color:#fff}';
      document.head.appendChild(style);
    }
    for (var i = 0; i < hosts.length; i += 1) {
      var host = hosts[i];
      host.innerHTML = '';
      var pill = document.createElement('span');
      pill.className = 'tsos-lang';
      pill.setAttribute('role', 'group');
      pill.setAttribute('aria-label', here === 'es' ? 'Idioma / Language' : 'Language / Idioma');
      ['en', 'es'].forEach(function (lang) {
        var label = lang === 'en' ? 'EN' : 'ES';
        var full = lang === 'en' ? 'English' : 'Español';
        if (lang === here || !twin) {
          var current = document.createElement('span');
          current.textContent = label;
          current.title = full;
          current.setAttribute('aria-current', 'true');
          pill.appendChild(current);
        } else {
          var link = document.createElement('a');
          link.textContent = label;
          link.title = full;
          link.href = twin + window.location.search + window.location.hash;
          link.setAttribute('hreflang', lang);
          link.addEventListener('click', function () { store(lang); });
          pill.appendChild(link);
        }
      });
      host.appendChild(pill);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
