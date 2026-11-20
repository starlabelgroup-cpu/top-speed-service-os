/* Passkey (WebAuthn) browser helper — Wave 3 item F2 (2026-11-20).
 *
 * window.TSOSPasskey wraps the two ceremonies the API exposes:
 *   registerPasskey(apiBase, token, deviceLabel)
 *     — from inside a normal session; resolves with the stored
 *       credential summary the API returns.
 *   loginWithPasskey(apiBase, email)
 *     — resolves with the API's raw sign-in pipeline JSON, exactly
 *       the shapes POST /auth/login returns (session bundle, a
 *       Speedy Verify challenge, or a Layer 2 challenge), so callers
 *       feed it to the same handlers the password form uses.
 *
 * A passkey replaces the password step only. Every gate that applies
 * to the account afterwards applies exactly as before.
 */
(function () {
  function b64urlToBuf(value) {
    let s = String(value).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }
  function bufToB64url(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function api(apiBase, path, { method = 'POST', token, body } = {}) {
    const res = await fetch(apiBase + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(json.error || 'Passkey request failed');
      error.code = json.code || null;
      error.status = res.status;
      throw error;
    }
    return json;
  }

  function supported() {
    return Boolean(window.PublicKeyCredential && navigator.credentials);
  }

  async function registerPasskey(apiBase, token, deviceLabel) {
    if (!supported()) throw new Error('This device or browser does not support passkeys.');
    const { data } = await api(apiBase, '/auth/passkeys/register/options', {
      token,
      body: { deviceLabel: deviceLabel || undefined },
    });
    const options = data.options;
    options.challenge = b64urlToBuf(options.challenge);
    options.user.id = b64urlToBuf(options.user.id);
    if (Array.isArray(options.excludeCredentials)) {
      options.excludeCredentials = options.excludeCredentials.map((c) => ({ ...c, id: b64urlToBuf(c.id) }));
    }
    const cred = await navigator.credentials.create({ publicKey: options });
    if (!cred) throw new Error('Passkey setup was cancelled.');
    const response = {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: {},
      response: {
        attestationObject: bufToB64url(cred.response.attestationObject),
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
        transports: typeof cred.response.getTransports === 'function' ? cred.response.getTransports() : [],
      },
    };
    const verified = await api(apiBase, '/auth/passkeys/register/verify', {
      token,
      body: { deviceLabel: deviceLabel || undefined, response },
    });
    return verified.data;
  }

  async function loginWithPasskey(apiBase, email) {
    if (!supported()) throw new Error('This device or browser does not support passkeys.');
    const { data } = await api(apiBase, '/auth/passkeys/login/options', { body: { email } });
    const options = data.options;
    options.challenge = b64urlToBuf(options.challenge);
    if (Array.isArray(options.allowCredentials)) {
      options.allowCredentials = options.allowCredentials.map((c) => ({ ...c, id: b64urlToBuf(c.id) }));
    }
    const cred = await navigator.credentials.get({ publicKey: options });
    if (!cred) throw new Error('Passkey sign-in was cancelled.');
    const response = {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: {},
      response: {
        authenticatorData: bufToB64url(cred.response.authenticatorData),
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
        signature: bufToB64url(cred.response.signature),
        ...(cred.response.userHandle ? { userHandle: bufToB64url(cred.response.userHandle) } : {}),
      },
    };
    return api(apiBase, '/auth/passkeys/login/verify', { body: { response } });
  }

  async function listPasskeys(apiBase, token) {
    const { data } = await api(apiBase, '/auth/passkeys', { method: 'GET', token });
    return data;
  }

  async function removePasskey(apiBase, token, id) {
    const { data } = await api(apiBase, '/auth/passkeys/' + encodeURIComponent(id), { method: 'DELETE', token });
    return data;
  }

  async function listSessions(apiBase, token) {
    const { data } = await api(apiBase, '/auth/sessions', { method: 'GET', token });
    return data;
  }

  async function revokeSession(apiBase, token, id) {
    const { data } = await api(apiBase, '/auth/sessions/' + encodeURIComponent(id), { method: 'DELETE', token });
    return data;
  }

  async function revokeOtherSessions(apiBase, token) {
    const { data } = await api(apiBase, '/auth/sessions/revoke-others', { token, body: {} });
    return data;
  }

  window.TSOSPasskey = {
    supported,
    registerPasskey,
    loginWithPasskey,
    listPasskeys,
    removePasskey,
    listSessions,
    revokeSession,
    revokeOtherSessions,
  };
})();
