// IndexNow — tells Bing/Yandex (and other IndexNow participants) that a URL
// changed, so new/updated pages enter the AI-search-feeding indexes fast.
// Fail-soft by design: a failed ping must never break a publish. Callers get
// a result object, never a throw.
//
// Key file must be hosted at https://<host>/<key>.txt (flagship: apps/web).
export const INDEXNOW_KEY = 'eae4e48cf0fc8affa4154be5f851e286';
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

export async function notifyIndexNow(urls, { host = 'topspeedserviceos.com', key = INDEXNOW_KEY } = {}) {
  const list = [...new Set((urls || []).filter((u) => typeof u === 'string' && u.startsWith('https://')))];
  if (!list.length) return { ok: false, skipped: true, reason: 'no_urls' };
  try {
    const response = await fetch(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host,
        key,
        keyLocation: `https://${host}/${key}.txt`,
        urlList: list.slice(0, 10000),
      }),
    });
    // IndexNow answers 200 (received) or 202 (accepted, key validation pending).
    return { ok: response.status === 200 || response.status === 202, status: response.status, submitted: list.length };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), submitted: list.length };
  }
}

// Fire-and-forget wrapper for publish paths — never awaited by the response.
export function fireIndexNow(urls, options) {
  notifyIndexNow(urls, options)
    .then((r) => {
      if (!r.ok && !r.skipped) console.warn('[indexnow] ping not accepted:', JSON.stringify(r));
    })
    .catch(() => {});
}
