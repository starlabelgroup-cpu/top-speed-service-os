/*
 * Temporary passwords — forced password change (2026-11-17).
 *
 * When a sign-in completes with an office-issued TEMPORARY password,
 * the API never issues a session. After the usual gates (Speedy
 * Verify, then Layer 2) it answers with a restricted change-only
 * state: { mustChangePassword: true, changeToken }. Every sign-in
 * surface hands that state to this helper, which stashes the
 * single-use change token in sessionStorage and routes to the one
 * shared change page, /set-password/ — the same pattern layer2.js
 * uses for its overlay, so the flow behaves identically in the
 * customer app, Speedy Pro, Connect Pro, the Plug and every console.
 *
 * The token lives in sessionStorage only (never localStorage, never
 * a URL), and the change page clears it the moment the new password
 * is set. The session token the change page returns is stored by the
 * change page itself under the keys the surfaces read.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'tsos_change_token';
  var RETURN_KEY = 'tsos_change_return';

  function isChangeState(j) {
    return Boolean(j && j.mustChangePassword === true && typeof j.changeToken === 'string' && j.changeToken);
  }

  // Stash the change token and go set a password. returnTo is where
  // the user lands, signed in, once the change completes.
  function begin(j, returnTo) {
    try {
      sessionStorage.setItem(TOKEN_KEY, j.changeToken);
      sessionStorage.setItem(RETURN_KEY, returnTo || window.location.pathname || '/');
    } catch (e) { /* storage unavailable: the change page explains */ }
    window.location.assign('/set-password/');
  }

  window.TSOSTempPassword = {
    isChangeState: isChangeState,
    begin: begin,
    TOKEN_KEY: TOKEN_KEY,
    RETURN_KEY: RETURN_KEY,
  };
})();
