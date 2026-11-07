# Top Speed App — PWA + Download Page + App Distribution API

The Top Speed app ships **today as a Progressive Web App (PWA)**. There are
no Apple App Store or Google Play listings yet — see "Store status" below
for exactly what is and isn't published, and what publishing later takes.

Everything here follows the Phase 1 skeleton rules: the API is in-memory,
notifications are simulated, and nothing in this layer talks to Apple,
Google, Twilio, or Resend.

---

## 1. The PWA (apps/web)

| File | What it does |
| --- | --- |
| `apps/web/manifest.webmanifest` | Web app manifest: name **Top Speed**, `short_name` "Top Speed", `display: standalone`, `start_url: "/"`, `scope: "/"`, `theme_color` and `background_color` in brand navy **#0A265C**. |
| `apps/web/icons/icon-192.png` | 192×192 app icon. |
| `apps/web/icons/icon-512.png` | 512×512 app icon (`purpose: any`). |
| `apps/web/icons/icon-maskable-512.png` | 512×512 maskable icon (art kept inside the safe zone). |
| `apps/web/sw.js` | Service worker (see behavior below). |
| `apps/web/install.js` | Install-prompt helper + install attribution (see below). |
| `apps/web/index.html` | The existing Ecosystem landing page, now with the manifest link, theme-color, Apple touch icon, `install.js`, and the service-worker registration snippet. The page content is unchanged. |

### Icons

The icons are generated programmatically from the real brand assets: the
checkered-flag crop comes from `apps/web/assets/flag.jpg`, over the brand
navy field with a white "TS" monogram and the red divider from the brand
palette. They are production-usable; if final icon artwork is produced
later, drop the replacement PNGs at the same paths/sizes — no code changes
needed.

### Service worker behavior (`sw.js`)

- **Cache name is versioned**: `top-speed-shell-v1` (+ a runtime cache).
  Bump `CACHE_VERSION` in `sw.js` whenever the shell changes; on
  `activate`, all older caches are deleted, and the worker calls
  `skipWaiting()` + `clients.claim()` so updates take over immediately.
- **Static shell — cache-first.** HTML/CSS/JS/images/manifest are served
  from cache first (instant opens, offline shell), and fresh network
  responses are written back into the shell cache.
- **API (`/api/…`) — network-first.** API responses are only served from
  cache when the network fails, so bookings/dispatch data is never stale
  while the device is online. Non-GET requests are never intercepted.
- **Navigations — network-first**, falling back to the cached
  `/index.html` shell when offline.
- The precache list covers `/`, the manifest, `install.js`, the brand
  images, all three icons, and the `/download/` page.

Registration happens in `index.html` (and on the download page) on window
`load`, scoped to `/`. A PWA requires **HTTPS** in production (localhost
is exempt for development).

### Install helper (`install.js`)

Exposes `window.TopSpeedInstall`:

- `canPrompt()` — true after the browser fires `beforeinstallprompt`
  (Chrome/Edge on Android and desktop). The event is captured and
  deferred so an "Install the app" button can trigger it from a real
  user gesture.
- `promptInstall()` — shows the native prompt; resolves to
  `'accepted' | 'dismissed' | 'unavailable'`.
- On **`appinstalled`**, it reports the install:
  `POST /api/v1/app/track-download` with `{ platform, deviceType, src }`.
  `src` is read from the page URL's `?src=` query parameter — the same
  attribution tag flyers, QR codes, and ads already carry (`?src=flyer`).
- `trackInstall(extra)` is also exposed for manual reports (the download
  page uses it to record `download_page_view` attribution).
- **API base**: same-origin by default. During local development the API
  runs on :4000 — set `window.TOP_SPEED_API_BASE` before the script, or
  open the page once with `?api=http://localhost:4000` and the base is
  kept in `sessionStorage` for the tab.

iOS Safari has no `beforeinstallprompt`/`appinstalled` — iPhone users
install via Share → Add to Home Screen (the download page walks them
through it), so iOS installs are undercounted until/if a native app
ships. That is a platform limit, not a bug.

---

## 2. The download page (apps/web/download/)

Self-contained static page (plain HTML/CSS/JS, no build step):

- **Platform detection** from the user agent, shown as a "We detected: …"
  line (iPhone / iPad / Android / desktop), with the matching instruction
  card highlighted.
- **iOS steps**: Safari → Share → Add to Home Screen → Add.
- **Android steps**: the page's **Install the Top Speed App** button
  (shown when `beforeinstallprompt` is available) or Chrome's ⋮ menu →
  Install app.
- **Desktop QR panel**: a real QR code drawn in the browser by the
  vendored `qrcode.js` (qrcode-generator by Kazuhiko Arase, MIT — see the
  header inside that file). It encodes **the current page URL, including
  any `?src=` tag**, so a flyer QR's attribution survives the trip to the
  phone. If the script fails, the page falls back to the static
  `qr-download.png` (a pre-generated QR for
  `https://topspeedappliance.net/download`). A **Copy download link**
  button sits under the code.
- **Store section**: Apple App Store and Google Play are shown as
  **"Coming soon — install the web app today"**. There are no store
  buttons, links, ratings, or download counts, because the listings do
  not exist.
- **Attribution**: on load, the page reads `?src=` and reports a
  `download_page_view` via the tracking endpoint; an actual install is
  reported by `install.js` on `appinstalled`.

---

## 3. API endpoints (src/routes/app.js)

Base: `/api/v1`. Public endpoints need no auth (a browser that just
installed the app has no staff session; they expose/accept attribution
only, no personal data). Staff endpoints use the existing
`authenticate → requireCompany → requireRole(DISPATCHER, PLATFORM_ADMIN)`
chain, demo-able locally with `ALLOW_DEMO_AUTH=true`.

### GET /app/current-version — public

```bash
curl http://localhost:4000/api/v1/app/current-version
```

```json
{
  "data": {
    "appName": "Top Speed",
    "platformName": "Top Speed Service OS",
    "version": "1.0.0",
    "releaseNotes": "Initial PWA release",
    "distribution": "PWA",
    "installPage": "/download",
    "publisher": "Top Speed Appliance LLC",
    "storeListings": [
      { "store": "apple",  "name": "Apple App Store", "status": "NOT_YET_PUBLISHED", "url": null, "note": "…" },
      { "store": "google", "name": "Google Play",     "status": "NOT_YET_PUBLISHED", "url": null, "note": "…" },
      { "store": "web",    "name": "Web app (PWA)",   "status": "PUBLISHED",         "url": "/download", "note": "…" }
    ],
    "generatedAt": "…"
  }
}
```

### GET /app/stores — public

```bash
curl http://localhost:4000/api/v1/app/stores
```

Returns the same `storeListings` array on its own, for the download page
and admin surfaces.

### POST /app/track-download — public

```bash
curl -X POST http://localhost:4000/api/v1/app/track-download \
  -H 'Content-Type: application/json' \
  -d '{"platform":"android","deviceType":"phone","src":"flyer"}'
# → 201 { "data": { "id": "…", "platform": "android", "deviceType": "phone",
#                   "src": "flyer", "event": "installed", "at": "…" } }
```

Body: `platform` (`ios | android | web`, required), `deviceType`
(optional), `src` (optional free-form attribution tag, ≤64 chars),
`event` (`installed` default, or `download_page_view`). Each call appends
an `APP_INSTALL_TRACKED` entry to the platform event feed
(`GET /api/v1/platform/events`). Invalid platform/event → 400.

### GET /app/installs — staff

```bash
curl http://localhost:4000/api/v1/app/installs \
  -H 'Authorization: Bearer local-demo'   # with ALLOW_DEMO_AUTH=true
```

```json
{
  "data": {
    "installs": 1,
    "downloadPageViews": 1,
    "byPlatform": { "ios": 0, "android": 1, "web": 0 },
    "bySrc": { "flyer": 1 },
    "recent": [ "…last 50 raw events…" ]
  }
}
```

Only real `installed` events count as installs — page views never inflate
the numbers, and installs with no `src` are bucketed as `direct`.

### Flywheel metrics

`GET /api/v1/flywheel/metrics` now also returns **`appInstalls`** (the
count of real installs) alongside the existing attract/book/serve/review/
refer stages. The response shape is otherwise unchanged.

---

## 4. Store status — the honest picture

| Channel | Status |
| --- | --- |
| Web app (PWA) | **Published** — installable today from `/download`. |
| Apple App Store | **Not published.** No listing, no URL, no counts. |
| Google Play | **Not published.** No listing, no URL, no counts. |

Nothing customer-facing may claim store availability, ratings, or
download numbers until a listing is actually live.

### What publishing later requires (gates — Ramone's accounts to open)

1. **Apple Developer Program** account held by Top Speed Appliance LLC
   (Apple charges an annual fee; identity/D-U-N-S verification can take
   days). Needed before App Store Connect can create a listing.
2. **Google Play Console** developer account held by the business
   (one-time registration fee; identity verification required).
3. A native wrapper or native build to submit (the PWA is the product
   today; a wrapper such as a TWA for Play or a Capacitor build for iOS
   is a later engineering step, not an account setting).
4. Store listing assets: screenshots, descriptions, privacy policy URL,
   and review responses — prepared at submission time, with **real**
   numbers only.

Until gates 1–2 are done by Ramone, the correct customer message is the
one the download page already shows: **"Coming soon — install the web app
today."**
