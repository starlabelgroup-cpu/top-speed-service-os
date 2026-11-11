# Top Speed Mobile Apps (Capacitor)

Native iOS + Android wraps of the Service OS web apps, built with
[Capacitor](https://capacitorjs.com) 8.6. The apps bundle the same pages
that run on the website and call the same production API
(`https://top-speed-service-os.vercel.app/api/v1`), so every working
function on the web — accounts, booking, equipment registry, service
history — works in the apps.

| App | Folder | Bundle ID | Web source |
| --- | --- | --- | --- |
| Appliance Pro (commercial accounts) | `appliance-pro/` | `net.topspeedappliance.appliancepro` | `apps/web/appliance-pro` |
| Appliance Connect Pro (homeowners + property managers) | `connect-pro/` | `net.topspeedappliance.connectpro` | `apps/web/connect-pro-app` |

## What is native

- **Push notifications** (`@capacitor/push-notifications`) — permission is
  requested on first launch; the device token is kept on-device and
  broadcast as a `tsos:push-token` event (see `www/native-bridge.js`).
- **GPS** (`@capacitor/geolocation`) — exposed as
  `window.TSOSNative.getLocation()` / `watchLocation()` for Track My Tech.
- **Camera** (`@capacitor/camera`) — `window.TSOSNative.takePhoto()`
  returns a base64 photo for Speedy photo diagnosis.
- **In-app browser** (`@capacitor/browser`) — links out to other Service
  OS pages open in an in-app browser sheet instead of leaving the app.
- Branded icons + splash screens generated from the checkered-flag app
  icon; navy `#0A265C` theme throughout.
- The API allows the Capacitor WebView origins (`capacitor://localhost`,
  `https://localhost`) in its CORS allowlist (server.js).

## Folder layout (per app)

- `www/` — the bundled web app (copied from the web source page, plus
  `native-bridge.js`). **When a source page changes, re-copy it here and
  re-inject the `<script src="/native-bridge.js">` tag before `</body>`.**
  Binary assets (`flag.jpg`, the icon PNGs) are deliberately not committed;
  the cloud build fetches them from the live site before syncing.
- `capacitor.config.json`, `package.json`, `package-lock.json`
- `codemagic.yaml` — cloud build definitions (see below).
- The generated `android/` and `ios/` folders are **not committed** (the
  Gradle wrapper is a binary); cloud builds generate them with
  `npx cap add android` / `npx cap add ios` and then `npx cap sync`.

## Building (no Mac required)

Builds run on [Codemagic](https://codemagic.io) — see each app's
`codemagic.yaml`. Android builds produce an `.aab` for Google Play; iOS
builds produce an `.ipa` for App Store Connect / TestFlight.

## Store accounts — Ramone's steps (identity-verified to the LLC)

1. **D-U-N-S number** for Top Speed Appliance LLC (free, Dun & Bradstreet).
   One number serves both stores.
2. **Apple Developer Program** — $99/year, enroll as an *organization*.
3. **Google Play Console** — $25 one-time, register as an *organization*
   (organization accounts are exempt from the 12-tester / 14-day closed
   testing rule that applies to personal accounts).
4. In Codemagic: connect the GitHub repo, add one app per
   `codemagic.yaml`, connect the Apple Developer integration for signing,
   and generate an Android upload keystore.
5. Privacy policy URL for both listings: `https://topspeedserviceos.com/privacy`

## Honest status / next backend steps

- Push tokens are captured on-device but **not yet sent to the API** —
  the follow-up is a `POST /devices/push-token` endpoint plus the send
  pipeline (booking confirmations, job offers).
- GPS helpers are ready; Track My Tech live position needs the
  `POST /technicians/location` endpoint (the Tech App side) to consume
  them.
- App icons are generated from the current 512px PWA icon upscaled to
  1024px; replace with original 1024px art when available.
