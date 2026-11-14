/* Email-verification soft prompt for the signed-in app surfaces.
 *
 * If the signed-in account's email is not verified yet, a slim bar
 * appears at the top of the app: the account works fully (booking is
 * never blocked) — this only explains, honestly, that confirmations
 * go to email and offers a resend for the verification link. The
 * state comes from GET /auth/me (emailVerified), never guessed.
 * Dismissal is per-session; verification removes it for good.
 */
(function () {
  var API = 'https://top-speed-service-os.vercel.app/api/v1';
  var token = '';
  try { token = localStorage.getItem('tsos_token') || localStorage.getItem('tsos_cust_token') || ''; } catch (e) {}
  if (!token) return;
  try { if (sessionStorage.getItem('tsos_verify_notice_dismissed')) return; } catch (e) {}

  function api(path, opts) {
    opts = opts || {};
    return fetch(API + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
  }

  api('/auth/me').then(function (x) {
    if (!x.ok || !x.j.user || x.j.user.emailVerified !== false) return;
    var bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'background:#fff8e1;border-bottom:2px solid #f3d27a;color:#5c4a12;padding:10px 16px;font:14px/1.5 Inter,Arial,sans-serif;display:flex;gap:12px;align-items:center;flex-wrap:wrap;position:relative;z-index:60';
    bar.innerHTML = '<span><svg class="fxi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12.5" rx="2.2"/><path d="M3.8 7.4L12 13l8.2-5.6" stroke="#E8322E"/></svg> <b>Your email isn\u2019t verified yet.</b> Your account works fully — but booking confirmations and receipts go to your email, so verify it with the link we sent you.</span>';
    var resend = document.createElement('button');
    resend.type = 'button';
    resend.textContent = 'Resend verification email';
    resend.style.cssText = 'background:#0A265C;color:#fff;border:none;border-radius:999px;padding:8px 14px;font:inherit;font-weight:700;cursor:pointer';
    resend.addEventListener('click', function () {
      resend.disabled = true; resend.textContent = 'Sending…';
      api('/auth/email-verification/resend', { method: 'POST', body: {} }).then(function (y) {
        if (!y.ok) throw new Error((y.j && y.j.error) || 'Resend did not go through.');
        resend.innerHTML = y.j.emailVerification === 'verified' ? 'Already verified <svg class="fxi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.8l5.2 5.2L20 6.8"/><circle cx="19" cy="17.5" r="1.15" fill="#E8322E" stroke="none"/></svg>' : 'Sent — check your inbox';
      }).catch(function () {
        resend.disabled = false; resend.textContent = 'Resend verification email';
      });
    });
    var close = document.createElement('button');
    close.type = 'button';
    close.innerHTML = '<svg class="fxi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/><path d="M4 4h3M4 4v3M20 20h-3M20 20v-3" stroke="#E8322E"/></svg>';
    close.setAttribute('aria-label', 'Dismiss');
    close.style.cssText = 'background:none;border:none;font:inherit;cursor:pointer;color:#5c4a12;margin-left:auto;padding:4px 6px';
    close.addEventListener('click', function () {
      try { sessionStorage.setItem('tsos_verify_notice_dismissed', '1'); } catch (e) {}
      bar.remove();
    });
    bar.appendChild(resend);
    bar.appendChild(close);
    document.body.insertBefore(bar, document.body.firstChild);
  }).catch(function () { /* a quiet surface beats a broken one */ });
})();
