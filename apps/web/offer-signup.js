/* Offer pages — direct sign-up + email verification + profile setup.
 *
 * One flow for every /offers/<slug> page (the page sets
 * window.TSOS_OFFER = { slug, signupType, appPath }):
 *   1. The real register form (same contract as /signup): email,
 *      password 10+, name, phone, the shared legal signing block
 *      (legal-gate.js), role CUSTOMER, and the offer slug — the API
 *      pins the audience from its catalog and records the offer on
 *      the account.
 *   2. Success is honest: "account created — now verify your
 *      email", with a resend button. Nothing pretends the email
 *      step is done.
 *   3. Profile setup on the same page (phone, service address →
 *      area result shown verbatim from the API, optional first
 *      appliance), saved to the same account via POST /auth/profile.
 *      Skippable — "finish later in your account".
 * A visitor who is already signed in gets the same profile +
 * verification panel instead of a second registration form.
 */
(function () {
  var API = 'https://top-speed-service-os.vercel.app/api/v1';
  var OFFER = window.TSOS_OFFER || {};
  var DEST = { homeowner: '/app', business: '/appliance-pro', pm: '/connect-pro-app' };
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function token() { try { return localStorage.getItem('tsos_token') || ''; } catch (e) { return ''; } }
  function selectedType() {
    var r = document.querySelector('input[name="ofType"]:checked');
    return r ? r.value : (OFFER.signupType || 'homeowner');
  }
  function appPath() { return DEST[selectedType()] || OFFER.appPath || '/app'; }

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (opts.auth) headers.Authorization = 'Bearer ' + token();
    return fetch(API + path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); });
  }

  /* ---------------- profile block (shared by both states) ---------------- */
  function wireProfile() {
    var save = el('ofProfileSave'), skip = el('ofProfileSkip'), msg = el('ofProfileMsg');
    if (!save) return;
    save.addEventListener('click', function () {
      var body = {};
      var phone = el('ofPhone2').value.trim();
      if (phone) body.phone = phone;
      var street = el('ofStreet').value.trim(), city = el('ofCity').value.trim(), zip = el('ofZip').value.trim();
      if (street || city || zip) body.serviceAddress = { street: street, city: city, zip: zip };
      var type = el('ofApplType').value;
      if (type) {
        body.appliance = { type: type };
        var brand = el('ofApplBrand').value.trim(), model = el('ofApplModel').value.trim();
        if (brand) body.appliance.brand = brand;
        if (model) body.appliance.model = model;
      }
      save.disabled = true; save.textContent = 'Saving…';
      api('/auth/profile', { method: 'POST', auth: true, body: body }).then(function (x) {
        if (!x.ok) throw new Error((x.j && x.j.error) || 'Profile did not save.');
        var lines = ['✓ Profile saved to your account.'];
        if (x.j.profile && x.j.profile.areaMessage) lines.push(x.j.profile.areaMessage);
        if (x.j.applianceSaved) lines.push('Your appliance is in your garage.');
        msg.innerHTML = lines.map(esc).join('<br>');
        msg.style.display = 'block';
        el('ofContinue').style.display = 'inline-block';
      }).catch(function (e) {
        msg.textContent = e.message; msg.style.display = 'block';
      }).finally(function () { save.disabled = false; save.textContent = 'Save profile'; });
    });
    if (skip) skip.addEventListener('click', function () {
      el('ofProfileFields').style.display = 'none';
      msg.innerHTML = 'No problem — you can finish your profile any time inside your account.';
      msg.style.display = 'block';
      el('ofContinue').style.display = 'inline-block';
    });
    var cont = el('ofContinue');
    if (cont) cont.addEventListener('click', function () { location.href = appPath(); });
  }

  function wireResend() {
    var btn = el('ofResend');
    if (!btn) return;
    btn.addEventListener('click', function () {
      btn.disabled = true; btn.textContent = 'Sending…';
      api('/auth/email-verification/resend', { method: 'POST', auth: true, body: {} }).then(function (x) {
        if (!x.ok) throw new Error((x.j && x.j.error) || 'Resend did not go through.');
        btn.textContent = x.j.emailVerification === 'verified' ? 'Already verified ✓' : 'Sent — check your inbox';
        if (x.j.emailVerification === 'verified') { var n = el('ofVerifyNote'); if (n) n.textContent = 'Your email is verified ✓ — you are all set.'; }
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = 'Resend verification email';
        var n = el('ofVerifyNote'); if (n) n.textContent = e.message;
      });
    });
  }

  function showDone(email) {
    el('ofFormWrap').style.display = 'none';
    el('ofDone').style.display = 'block';
    var em = el('ofDoneEmail'); if (em) em.textContent = email || '';
    wireResend();
    wireProfile();
  }

  /* ---------------- already signed in ---------------- */
  function initSignedIn(user) {
    el('ofFormWrap').style.display = 'none';
    el('ofDone').style.display = 'block';
    el('ofDoneTitle').textContent = 'You\u2019re signed in';
    var note = el('ofVerifyNote');
    if (user.emailVerified) {
      note.innerHTML = 'Signed in as <b>' + esc(user.email) + '</b> — your email is verified ✓. This offer applies through your account; the team confirms eligibility at booking.';
      el('ofResend').style.display = 'none';
    } else {
      note.innerHTML = 'Signed in as <b>' + esc(user.email) + '</b> — your email isn\u2019t verified yet. We sent a verification link when you registered; it works once and lasts 24 hours.';
      el('ofResend').style.display = 'inline-block';
    }
    var em = el('ofDoneEmail'); if (em) em.textContent = user.email || '';
    var phone = el('ofPhone2'); if (phone && user.phone) phone.value = user.phone;
    var city = el('ofCity'); if (city && user.serviceCity) city.value = user.serviceCity;
    var zip = el('ofZip'); if (zip && user.serviceZip) zip.value = user.serviceZip;
    wireResend();
    wireProfile();
  }

  /* ---------------- registration ---------------- */
  function initForm() {
    if (!window.TSOSLegal || !el('ofLegal')) return;
    TSOSLegal.mountSigning('ofLegal', 'of', { buttonId: 'ofCreate' });
    el('ofForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var err = el('ofErr'); err.style.display = 'none';
      function fail(m) { err.textContent = m; err.style.display = 'block'; }
      var name = el('ofName').value.trim();
      var email = el('ofEmail').value.trim();
      var phone = el('ofPhone').value.trim();
      var pass = el('ofPass').value;
      if (name.length < 2) return fail('Please add your full name.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Please add a valid email address — it is your sign-in.');
      if (phone.replace(/\D/g, '').length < 7) return fail('Please add your phone number — booking confirmations and updates go there.');
      if (pass.length < 10) return fail('Password needs at least 10 characters.');
      var acceptance = TSOSLegal.acceptance('of');
      if (!acceptance) return fail('Please review both legal documents, check both agreement boxes, and type your full name as your signature.');
      var parts = name.split(/\s+/);
      var payload = { email: email, password: pass, firstName: parts[0], phone: phone, role: 'CUSTOMER', termsAcceptance: acceptance };
      if (parts.length > 1) payload.lastName = parts.slice(1).join(' ');
      if (OFFER.slug) payload.offerSlug = OFFER.slug;
      var btn = el('ofCreate'); btn.disabled = true; btn.textContent = 'Creating your account…';
      api('/auth/register', { method: 'POST', body: payload }).then(function (x) {
        if (!x.ok || !x.j.token) {
          var m = (x.j && x.j.error) || 'Sign-up did not go through.';
          var fe = x.j && x.j.details && x.j.details.fieldErrors;
          if (fe) { if (fe.password) m = 'Password must be at least 10 characters.'; else { var k = Object.keys(fe)[0]; if (k && fe[k][0]) m = fe[k][0]; } }
          if (/exist|already|registered/i.test(m)) m = 'That email already has a Top Speed account — sign in from the app instead.';
          throw new Error(m);
        }
        try {
          localStorage.setItem('tsos_token', x.j.token);
          localStorage.setItem('tsos_account_type', selectedType());
        } catch (ignored) {}
        var phone2 = el('ofPhone2'); if (phone2) phone2.value = phone;
        showDone(email);
      }).catch(function (ex) {
        fail(ex.message);
      }).finally(function () {
        btn.disabled = !TSOSLegal.complete('of'); btn.textContent = 'Create Account';
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!el('ofForm')) return;
    if (token()) {
      api('/auth/me', { auth: true }).then(function (x) {
        if (x.ok && x.j.user) initSignedIn(x.j.user); else initForm();
      }).catch(function () { initForm(); });
    } else {
      initForm();
    }
  });
})();
