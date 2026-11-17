/* Layer 2 — 2-step sign-in overlay (2026-11-16).
 *
 * Shared by every sign-in surface on the flagship. When the API
 * answers a sign-in (password login, register, or the Speedy Verify
 * exchange) with { layer2Required: true, challenge, channels }, the
 * surface calls TSOSLayer2.run(challengeJson, { onSession, onCancel })
 * and this overlay walks the user through the second step: choose
 * email or text, receive the 6-digit code, enter it. On success the
 * API's session JSON is handed to onSession — the surface stores the
 * token exactly as it would have for a direct sign-in.
 *
 * Google sign-in lands back on the app with ?layer2=<challenge> in
 * the URL; TSOSLayer2.bootFromUrl({ onSession }) picks it up.
 * ?authError=<message> (a gate the redirect flow cannot complete,
 * e.g. Speedy Verify) is surfaced via TSOSLayer2.popAuthError().
 *
 * Plain DOM + inline styles, no dependencies. Icons are inline SVG
 * (the platform icon rule — never emoji). Everything dynamic is
 * escaped before it touches innerHTML.
 */
(function () {
  var DEFAULT_API = 'https://top-speed-service-os.vercel.app/api/v1';
  var STYLE_ID = 'tsos-l2-style';
  var state = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var ICONS = {
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M12 3l7 2.6v5.2c0 4.6-3 8.4-7 10.2-4-1.8-7-5.6-7-10.2V5.6z"/><path d="M8.8 12l2.2 2.2 4.2-4.4"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13"/><path d="M4 6.5l8 6 8-6"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M4 5.5h16v10.5H9l-5 3.5z"/><path d="M7.5 9.5h9M7.5 12.5h5.5"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '.l2o-back{position:fixed;inset:0;background:rgba(6,12,24,.66);z-index:99990;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}' +
      '.l2o-card{background:#fff;color:#0C162B;border-radius:18px;max-width:420px;width:100%;box-sizing:border-box;padding:22px 20px 18px;box-shadow:0 18px 50px rgba(0,0,0,.35);font-family:inherit;max-height:calc(100vh - 32px);overflow:auto}' +
      '.l2o-head{display:flex;gap:12px;align-items:flex-start}' +
      '.l2o-ic{flex:0 0 40px;width:40px;height:40px;border-radius:12px;background:#0C162B;color:#fff;display:flex;align-items:center;justify-content:center}' +
      '.l2o-ic svg{width:22px;height:22px}' +
      '.l2o-card h2{margin:2px 0 4px;font-size:19px;line-height:1.25}' +
      '.l2o-card p{margin:0;font-size:14px;line-height:1.5;color:#43536B}' +
      '.l2o-x{margin-left:auto;flex:0 0 auto;background:none;border:0;color:#43536B;cursor:pointer;padding:4px}' +
      '.l2o-x svg{width:18px;height:18px;display:block}' +
      '.l2o-chans{display:flex;flex-direction:column;gap:10px;margin-top:16px}' +
      '.l2o-chan{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:#F4F7FB;border:1.5px solid #D8E1EE;border-radius:14px;padding:13px 14px;cursor:pointer;font:inherit;color:#0C162B;box-sizing:border-box}' +
      '.l2o-chan:hover{border-color:#0C162B}' +
      '.l2o-chan:disabled{opacity:.55;cursor:default}' +
      '.l2o-chan .l2o-ic{flex-basis:36px;width:36px;height:36px;border-radius:10px;background:#fff;color:#0C162B;border:1px solid #D8E1EE}' +
      '.l2o-chan .l2o-ic svg{width:19px;height:19px}' +
      '.l2o-chan b{display:block;font-size:15px}' +
      '.l2o-chan span{font-size:13px;color:#43536B}' +
      '.l2o-code{width:100%;box-sizing:border-box;font-size:24px;letter-spacing:8px;text-align:center;padding:12px 10px;border:1.5px solid #D8E1EE;border-radius:14px;margin-top:14px;font:inherit;font-weight:700;color:#0C162B}' +
      '.l2o-code:focus{outline:none;border-color:#0C162B}' +
      '.l2o-go{width:100%;margin-top:12px;background:#E94E5C;color:#fff;border:0;border-radius:999px;padding:13px 18px;font:inherit;font-weight:800;font-size:15px;cursor:pointer}' +
      '.l2o-go:disabled{opacity:.6;cursor:default}' +
      '.l2o-err{display:none;background:#FDECEA;border:1px solid #F3C1BC;color:#8F1D16;border-radius:12px;padding:10px 12px;font-size:13.5px;line-height:1.45;margin-top:14px}' +
      '.l2o-note{font-size:13px;color:#43536B;margin-top:12px;line-height:1.5}' +
      '.l2o-link{background:none;border:0;color:#0C162B;font:inherit;font-size:13.5px;font-weight:700;cursor:pointer;text-decoration:underline;padding:0}' +
      '.l2o-link:disabled{color:#8A97A8;cursor:default;text-decoration:none}';
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function post(api, path, body) {
    return fetch(api + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    });
  }

  function close() {
    if (state && state.timer) clearInterval(state.timer);
    if (state && state.el && state.el.parentNode) state.el.parentNode.removeChild(state.el);
    state = null;
  }

  function showError(msg) {
    if (!state) return;
    var e = state.el.querySelector('.l2o-err');
    e.textContent = msg;
    e.style.display = 'block';
  }

  function channelRow(ch) {
    var isEmail = ch.channel === 'EMAIL';
    var label = isEmail ? 'Email a code' : 'Text a code';
    var dest = ch.destination ? ' to ' + ch.destination : (isEmail ? '' : ' to the phone on your account');
    var dis = ch.available === false ? ' disabled' : '';
    return '<button type="button" class="l2o-chan" data-chan="' + esc(ch.channel) + '"' + dis + '>' +
      '<span class="l2o-ic">' + (isEmail ? ICONS.mail : ICONS.chat) + '</span>' +
      '<span><b>' + label + '</b><span>' + esc(isEmail ? ('Send to' + dest) : ('Send by text' + dest)) + '</span></span></button>';
  }

  function renderChoose() {
    var s = state;
    var chans = (s.channels && s.channels.length) ? s.channels : [
      { channel: 'EMAIL', available: true },
      { channel: 'SMS', available: true }
    ];
    s.el.querySelector('.l2o-body').innerHTML =
      '<p>Your password checked out' + (s.email ? ' for <b>' + esc(s.email) + '</b>' : '') +
      '. To finish signing in, get a one-time 6-digit code:</p>' +
      '<div class="l2o-chans">' + chans.map(channelRow).join('') + '</div>' +
      '<div class="l2o-err"></div>' +
      '<p class="l2o-note">The code expires in 10 minutes and works once. Email is always available; text needs a phone number on your account.</p>';
    var buttons = s.el.querySelectorAll('.l2o-chan');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].addEventListener('click', function (ev) {
        sendCode(ev.currentTarget.getAttribute('data-chan'));
      });
    }
  }

  function renderVerify(sent) {
    var s = state;
    s.sent = sent;
    var via = sent.channel === 'SMS' ? 'text' : 'email';
    s.el.querySelector('.l2o-body').innerHTML =
      '<p>We sent a 6-digit code by ' + via + (sent.destination ? ' to <b>' + esc(sent.destination) + '</b>' : '') +
      '. Enter it here — it expires in 10 minutes.</p>' +
      '<form class="l2o-form"><input class="l2o-code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="••••••" aria-label="6-digit code">' +
      '<button type="submit" class="l2o-go">Verify &amp; sign in</button></form>' +
      '<div class="l2o-err"></div>' +
      '<p class="l2o-note"><button type="button" class="l2o-link l2o-resend" disabled>Send a new code</button>' +
      ' &nbsp;·&nbsp; <button type="button" class="l2o-link l2o-back2">Use a different way</button></p>';
    var form = s.el.querySelector('.l2o-form');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      verifyCode();
    });
    s.el.querySelector('.l2o-back2').addEventListener('click', function () { renderChoose(); });
    startCooldown(sent.resendCooldownSeconds || 60);
    var input = s.el.querySelector('.l2o-code');
    if (input) input.focus();
  }

  function startCooldown(seconds) {
    var s = state;
    var btn = s.el.querySelector('.l2o-resend');
    if (!btn) return;
    var left = seconds;
    btn.disabled = true;
    btn.textContent = 'Send a new code (' + left + 's)';
    if (s.timer) clearInterval(s.timer);
    s.timer = setInterval(function () {
      if (!state || state !== s) return;
      left -= 1;
      if (left <= 0) {
        clearInterval(s.timer);
        btn.disabled = false;
        btn.textContent = 'Send a new code';
        return;
      }
      btn.textContent = 'Send a new code (' + left + 's)';
    }, 1000);
    btn.onclick = function () {
      if (s.sent) sendCode(s.sent.channel);
    };
  }

  function sendCode(channel) {
    var s = state;
    if (!s) return;
    var chans = s.el.querySelectorAll('.l2o-chan');
    for (var i = 0; i < chans.length; i += 1) chans[i].disabled = true;
    post(s.api, '/auth/layer2/send', { challenge: s.challenge, channel: channel })
      .then(function (res) {
        if (!state || state !== s) return;
        if (res.ok && res.j && res.j.sent) {
          if (Array.isArray(res.j.channels)) s.channels = res.j.channels;
          renderVerify(res.j);
          return;
        }
        if (res.j && Array.isArray(res.j.channels)) s.channels = res.j.channels;
        renderChoose();
        showError((res.j && res.j.error) || 'We could not send the code — try the other way instead.');
      })
      .catch(function () {
        if (!state || state !== s) return;
        renderChoose();
        showError('Could not reach the sign-in service — check your connection and try again.');
      });
  }

  function verifyCode() {
    var s = state;
    if (!s) return;
    var input = s.el.querySelector('.l2o-code');
    var code = (input.value || '').replace(/[\s-]/g, '');
    if (!/^\d{6}$/.test(code)) {
      showError('Enter the 6-digit code from your ' + (s.sent && s.sent.channel === 'SMS' ? 'text' : 'email') + '.');
      return;
    }
    var btn = s.el.querySelector('.l2o-go');
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    post(s.api, '/auth/layer2/verify', { challenge: s.challenge, code: code })
      .then(function (res) {
        if (!state || state !== s) return;
        if (res.ok && res.j && res.j.token) {
          var onSession = s.onSession;
          close();
          if (onSession) onSession(res.j);
          return;
        }
        btn.disabled = false;
        btn.textContent = 'Verify & sign in';
        var msg = (res.j && res.j.error) || 'That code did not work — check it and try again.';
        if (res.j && typeof res.j.attemptsRemaining === 'number') {
          msg += ' (' + res.j.attemptsRemaining + (res.j.attemptsRemaining === 1 ? ' try' : ' tries') + ' left)';
        }
        showError(msg);
        if (res.j && (res.j.code === 'LAYER2_CHALLENGE_INVALIDATED' || res.j.code === 'LAYER2_CHALLENGE_EXPIRED' || res.j.code === 'LAYER2_CHALLENGE_INVALID')) {
          var onCancel = s.onCancel;
          close();
          if (onCancel) onCancel(msg);
        }
      })
      .catch(function () {
        if (!state || state !== s) return;
        btn.disabled = false;
        btn.textContent = 'Verify & sign in';
        showError('Could not reach the sign-in service — check your connection and try again.');
      });
  }

  function run(challengeJson, opts) {
    opts = opts || {};
    if (!challengeJson || !challengeJson.challenge) return false;
    injectStyle();
    close();
    var el = document.createElement('div');
    el.className = 'l2o-back';
    el.innerHTML =
      '<div class="l2o-card" role="dialog" aria-modal="true" aria-label="2-step sign-in">' +
      '<div class="l2o-head"><span class="l2o-ic">' + ICONS.shield + '</span>' +
      '<div><h2>2-step sign-in</h2><p>One more step to keep your account safe.</p></div>' +
      '<button type="button" class="l2o-x" aria-label="Cancel sign-in">' + ICONS.x + '</button></div>' +
      '<div class="l2o-body" style="margin-top:14px"></div></div>';
    document.body.appendChild(el);
    state = {
      el: el,
      api: opts.api || DEFAULT_API,
      challenge: challengeJson.challenge,
      channels: Array.isArray(challengeJson.channels) ? challengeJson.channels : null,
      email: challengeJson.user && challengeJson.user.email ? challengeJson.user.email : (challengeJson.email || ''),
      onSession: opts.onSession || null,
      onCancel: opts.onCancel || null,
      timer: null,
      sent: null
    };
    el.querySelector('.l2o-x').addEventListener('click', function () {
      var onCancel = state && state.onCancel;
      close();
      if (onCancel) onCancel(null);
    });
    renderChoose();
    return true;
  }

  /** True when a sign-in response is a Layer 2 challenge. */
  function isChallenge(json) {
    return Boolean(json && json.layer2Required === true && typeof json.challenge === 'string');
  }

  /** Google sign-in return: ?layer2=<challenge> (+ strip it from the URL). */
  function bootFromUrl(opts) {
    opts = opts || {};
    var q;
    try { q = new URLSearchParams(window.location.search); } catch (e) { return false; }
    var challenge = q.get('layer2');
    if (!challenge) return false;
    q.delete('layer2');
    try {
      var rest = q.toString();
      window.history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : '') + window.location.hash);
    } catch (e) { /* URL cleanup is best-effort */ }
    return run({ challenge: challenge }, opts);
  }

  /** Google sign-in return: ?authError=<message> (+ strip it). */
  function popAuthError() {
    var q;
    try { q = new URLSearchParams(window.location.search); } catch (e) { return null; }
    var msg = q.get('authError');
    if (!msg) return null;
    q.delete('authError');
    try {
      var rest = q.toString();
      window.history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : '') + window.location.hash);
    } catch (e) { /* best-effort */ }
    return msg;
  }

  window.TSOSLayer2 = {
    run: run,
    isChallenge: isChallenge,
    bootFromUrl: bootFromUrl,
    popAuthError: popAuthError,
    close: close
  };
})();
