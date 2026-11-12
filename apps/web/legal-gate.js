/* Legal gate — shared signing block + sign-to-continue overlay.
 *
 * One implementation for every signup form and app gate on the flagship:
 * two agreement checkboxes (one per current legal document) plus a
 * typed full name as the signature. The documents and versions mirror
 * apps/api/src/services/legalTerms.js (both v1.0, effective 2026-11-12);
 * the API re-validates every acceptance server-side, so this file only
 * shapes the payload and keeps Create buttons disabled until complete.
 */
(function () {
  var DOCS = [
    { document: 'SERVICE_OS', suffix: 'Os', title: 'Top Speed Service OS — Terms & Conditions', version: '1.0', anchor: 'service-os-terms' },
    { document: 'APPLIANCE_CONNECT', suffix: 'Connect', title: 'Appliance Connect Software — Terms of Use', version: '1.0', anchor: 'appliance-connect-terms' },
  ];

  var style = document.createElement('style');
  style.textContent = [
    '.tsos-legal{border:1.5px solid #c9dcff;background:#eef4ff;border-radius:14px;padding:14px 16px;margin-top:18px;text-align:left}',
    '.tsos-legal b.t{display:block;font-size:15px;color:#0A265C;margin-bottom:4px}',
    '.tsos-legal p{font-size:13.5px;color:#42506a;line-height:1.5;margin:0 0 8px}',
    '.tsos-legal label.t{display:flex;gap:10px;align-items:flex-start;font-size:14px;font-weight:600;color:#12233f;padding:7px 0;cursor:pointer;margin:0}',
    '.tsos-legal label.t input{width:20px;height:20px;flex:none;margin-top:1px;accent-color:#0A265C}',
    '.tsos-legal label.sig{display:block;font-size:13px;font-weight:700;color:#0A265C;margin-top:8px}',
    '.tsos-legal input.sig{width:100%;padding:11px 14px;border:1.5px solid #b9cdf2;border-radius:10px;font:inherit;font-size:15px;background:#fff;color:#12233f;margin-top:5px;box-sizing:border-box}',
    '.tsos-legal .msg{font-size:13px;color:#8f1d1a;min-height:0}',
    '#tsosTermsGate{position:fixed;inset:0;z-index:99999;background:rgba(4,15,35,.72);display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:16px;padding-top:max(16px,env(safe-area-inset-top));padding-bottom:max(16px,env(safe-area-inset-bottom))}',
    '#tsosTermsGate .tg-card{background:#fff;border-radius:18px;max-width:620px;width:100%;padding:24px 22px;box-shadow:0 24px 70px rgba(0,0,0,.4);margin:auto 0}',
    '#tsosTermsGate h2{font-size:21px;color:#0A265C;margin:0 0 6px}',
    '#tsosTermsGate p{font-size:14.5px;color:#42506a;line-height:1.55}',
    '#tsosTermsGate .tg-go{width:100%;margin-top:16px;padding:14px;border:none;border-radius:999px;background:#E8322E;color:#fff;font:inherit;font-weight:800;font-size:15.5px;cursor:pointer}',
    '#tsosTermsGate .tg-go:disabled{opacity:.5;cursor:not-allowed}',
    '#tsosTermsGate .tg-err{display:none;background:#fdecec;border:1px solid #f5c2c0;color:#8f1d1a;border-radius:12px;padding:10px 12px;font-size:13.5px;margin-top:12px}',
    '@media(max-width:640px){#tsosTermsGate{padding:10px}#tsosTermsGate .tg-card{padding:20px 16px;border-radius:16px}}',
  ].join('\n');
  document.head.appendChild(style);

  function el(id) { return document.getElementById(id); }

  function complete(prefix) {
    var sig = el(prefix + 'Signature');
    return DOCS.every(function (d) { var c = el(prefix + 'Terms' + d.suffix); return c && c.checked; })
      && !!sig && sig.value.trim().length >= 2;
  }

  function acceptance(prefix) {
    if (!complete(prefix)) return null;
    return {
      signatureName: el(prefix + 'Signature').value.trim(),
      documents: DOCS.map(function (d) { return { document: d.document, version: d.version, agreed: true }; }),
    };
  }

  function mountSigning(target, prefix, opts) {
    opts = opts || {};
    var box = typeof target === 'string' ? el(target) : target;
    if (!box) return;
    box.innerHTML =
      '<div class="tsos-legal">' +
      '<b class="t">📜 Review &amp; sign — required before account access</b>' +
      '<p>Read both documents on the <a href="/legal" target="_blank" rel="noopener"><b>Legal Documents page</b></a>, check each agreement box, and type your full name as your signature. We record the versions you signed with your account.</p>' +
      DOCS.map(function (d) {
        return '<label class="t"><input type="checkbox" id="' + prefix + 'Terms' + d.suffix + '"><span>I agree to the <a href="/legal#' + d.anchor + '" target="_blank" rel="noopener">' + d.title + '</a> (v' + d.version + ')</span></label>';
      }).join('') +
      '<label class="sig" for="' + prefix + 'Signature">Type your full name as your signature</label>' +
      '<input class="sig" id="' + prefix + 'Signature" type="text" autocomplete="name" placeholder="Your full name">' +
      '<p class="msg" id="' + prefix + 'LegalMsg"></p>' +
      '</div>';
    function sync() {
      var ok = complete(prefix);
      if (opts.buttonId) { var b = el(opts.buttonId); if (b) b.disabled = !ok; }
      if (opts.onChange) opts.onChange(ok);
    }
    box.addEventListener('change', sync);
    box.addEventListener('input', sync);
    sync();
  }

  function termsComplete(terms) { return !!(terms && terms.complete); }

  function showTermsGate(opts) {
    opts = opts || {};
    if (el('tsosTermsGate')) return;
    var gate = document.createElement('div');
    gate.id = 'tsosTermsGate';
    gate.setAttribute('role', 'dialog');
    gate.setAttribute('aria-modal', 'true');
    gate.setAttribute('aria-label', 'Sign the legal documents to continue');
    gate.innerHTML =
      '<div class="tg-card">' +
      '<h2>✍️ Sign to continue</h2>' +
      '<p>Before you use this app, please review and sign the current Top Speed legal documents. This takes a moment and is recorded with your account' + (opts.reason ? ' — ' + opts.reason : '') + '.</p>' +
      '<div id="tsosGateSign"></div>' +
      '<div class="tg-err" id="tsosGateErr"></div>' +
      '<button class="tg-go" id="tsosGateGo" type="button" disabled>Sign &amp; continue</button>' +
      (opts.onSignOut ? '<button type="button" id="tsosGateOut" style="margin-top:10px;width:100%;background:none;border:none;color:#B3261E;font:inherit;font-weight:700;font-size:14px;cursor:pointer;padding:6px;">Sign out instead</button>' : '') +
      '</div>';
    document.body.appendChild(gate);
    document.body.style.overflow = 'hidden';
    mountSigning('tsosGateSign', 'gateSign', { buttonId: 'tsosGateGo' });
    if (opts.onSignOut) el('tsosGateOut').addEventListener('click', opts.onSignOut);
    el('tsosGateGo').addEventListener('click', function () {
      var payload = acceptance('gateSign');
      var err = el('tsosGateErr');
      if (!payload) { err.textContent = 'Check both agreement boxes and type your full name first.'; err.style.display = 'block'; return; }
      var btn = el('tsosGateGo'); btn.disabled = true; btn.textContent = 'Recording your signature…';
      fetch(opts.api + '/auth/accept-terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (opts.token || '') },
        body: JSON.stringify({ termsAcceptance: payload }),
      }).then(function (r) {
        return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not record your signature'); return j; });
      }).then(function (j) {
        gate.remove();
        document.body.style.overflow = '';
        if (opts.onAccepted) opts.onAccepted(j);
      }).catch(function (e) {
        err.textContent = e.message; err.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Sign & continue';
      });
    });
  }

  window.TSOSLegal = {
    docs: DOCS,
    mountSigning: mountSigning,
    complete: complete,
    acceptance: acceptance,
    termsComplete: termsComplete,
    showTermsGate: showTermsGate,
  };
})();
