/**
 * PLCamera v2 — verification harness (camera upgrade, 2026-11-20).
 *
 * Three layers, all local (no database, no network):
 *  1. PURE LOGIC — pl-camera.js loaded through a vm module shim (the
 *     repo is type:module, so the file's CommonJS export hook is
 *     exercised exactly the way the v1 harness did it): the v1
 *     decision functions unchanged, the constraint ladder (highest
 *     honest rung first, bare {video:true} last), encode preference
 *     (WebP then JPEG), the bounded offline-queue admission, the
 *     frame-guide rects, and the data-URL byte math.
 *  2. DOM SMOKE — the same file loaded against a minimal DOM stub
 *     with NO getUserMedia, NO BarcodeDetector, NO torch: the camera
 *     must open onto the file-mode rung without throwing (the
 *     feature-absence path every unsupported browser takes), expose
 *     window.PLCamera v2, and close cleanly. Device-only features
 *     (live torch/focus/scan) cannot run headless — they are
 *     feature-detected in code and covered by layer 3 markers.
 *  3. MARKERS — the shipped files carry the v2 wiring: BarcodeDetector
 *     + torch + IndexedDB queue in pl-camera.js, the Pepper photo
 *     button + window.PepperChatPhoto in the shared chat bar, the
 *     plate guide + offline queue sink in /tech and /tech-network,
 *     the real-mime plate data URL in Pepper Lists, and the camera
 *     script on Book OS (so its Pepper bar gets the photo button).
 *
 * Usage: node test/plcamera-v2.test.mjs   (exit 0 = all checks pass)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const WEB = fileURLToPath(new URL('../../web/', import.meta.url));
const CAMERA_SRC = readFileSync(fileURLToPath(new URL('../../web/pepper-lists-site/pl-camera.js', import.meta.url)), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

/* ------------------------- 1. pure logic ------------------------- */
function loadPure() {
  const mod = { exports: {} };
  vm.compileFunction(CAMERA_SRC, ['module', 'exports'], { filename: 'pl-camera.js' })(mod, mod.exports);
  return mod.exports;
}
const api = loadPure();

check('version is 2', api.version, 2);
// v1 contract intact
check('choosePath start + gum', api.choosePath('start', { gumSupported: true }), 'live');
check('choosePath start no gum', api.choosePath('start', { gumSupported: false }), 'capture');
check('choosePath gum-failed', api.choosePath('gum-failed', {}), 'capture');
check('nextFacing', api.nextFacing('environment'), 'user');
check('clampDims v1 default edge', JSON.stringify(api.clampDims(3200, 2400)), JSON.stringify({ width: 1600, height: 1200 }));
check('pickRecorderMime webm first', api.pickRecorderMime((m) => m === 'video/webm'), 'video/webm');
// v2 ladder
const ladder = api.constraintLadder('environment');
check('ladder has 5 rungs', ladder.length, 5);
check('ladder rung 1 faces rear', ladder[0].video.facingMode.ideal, 'environment');
check('ladder rung 1 asks 4K width', ladder[0].video.width.ideal, 3840);
check('ladder rung 1 asks 4K height', ladder[0].video.height.ideal, 2160);
check('ladder rung 2 asks 1080p', ladder[1].video.width.ideal, 1920);
check('ladder last rung is bare video', ladder[4].video, true);
check('ladder is audio-free throughout', ladder.every((r) => r.audio === false), true);
check('ladder user facing', api.constraintLadder('user')[0].video.facingMode.ideal, 'user');
check('ladder garbage facing falls to rear', api.constraintLadder('sideways')[0].video.facingMode.ideal, 'environment');
// v2 encode + sizing
check('encode prefers WebP', api.pickEncodeType((t) => t === 'image/webp' || t === 'image/jpeg'), 'image/webp');
check('encode falls to JPEG', api.pickEncodeType((t) => t === 'image/jpeg'), 'image/jpeg');
check('encode survives a throwing probe', api.pickEncodeType(() => { throw new Error('nope'); }), 'image/jpeg');
check('MAX_EDGE is 2048', api.MAX_EDGE, 2048);
check('clampDims at v2 edge', JSON.stringify(api.clampDims(4000, 3000, api.MAX_EDGE)), JSON.stringify({ width: 2048, height: 1536 }));
check('dataUrlBytes math', api.dataUrlBytes('data:image/jpeg;base64,AAAAAAAA'), 6);
check('dataUrlBytes empty', api.dataUrlBytes(''), 0);
// v2 guide
check('guide plate rect width', api.guideRect('plate').w, 0.9);
check('guide document rect exists', typeof api.guideRect('document'), 'object');
check('guide unknown kind is null', api.guideRect('selfie'), null);
// v2 queue admission
const item = { dataUrl: 'data:image/jpeg;base64,AAAA' };
check('queue accepts under cap', api.clampQueue([], item).accepted, true);
const full = Array.from({ length: api.QUEUE_MAX_ITEMS }, () => ({ ...item }));
const refused = api.clampQueue(full, item);
check('queue refuses when full', refused.accepted, false);
check('queue refusal reason is honest', refused.reason, 'full');
check('queue refusal keeps existing items', refused.items.length, api.QUEUE_MAX_ITEMS);
const huge = { dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(Math.ceil((api.QUEUE_MAX_BYTES + 1024) * 4 / 3)) };
check('queue refuses an oversized item', api.clampQueue([], huge).accepted, false);

/* ------------------------- 2. DOM smoke -------------------------- */
function fakeEl() {
  return {
    children: [], style: {}, className: '', textContent: '', value: '', id: '',
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    click() {}, remove() {},
  };
}
function loadDom() {
  const win = { addEventListener() {} };
  const doc = {
    createElement: () => fakeEl(),
    head: fakeEl(),
    body: fakeEl(),
    querySelector: () => null,
  };
  const mod = { exports: {} };
  const sandbox = {
    module: mod, exports: mod.exports,
    window: win, document: doc, navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console, URL, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(CAMERA_SRC, sandbox, { filename: 'pl-camera.js' });
  return win.PLCamera;
}
const domApi = loadDom();
checkTrue('DOM load exposes window.PLCamera', domApi && typeof domApi.open === 'function');
check('DOM PLCamera version', domApi && domApi.version, 2);
let openThrew = false;
try { domApi.open({ title: 'Smoke' }); } catch { openThrew = true; }
check('open() survives a no-camera environment (file rung)', openThrew, false);
let closeThrew = false;
try { domApi.close(); } catch { closeThrew = true; }
check('close() is clean after file-mode open', closeThrew, false);
check('queueCount resolves 0 with no storage', await domApi.queueCount(), 0);
const flush = await domApi.flushQueue();
check('flushQueue with no uploader is a no-op', flush.sent, 0);

/* -------------------------- 3. markers --------------------------- */
const read = (rel) => readFileSync(WEB + rel, 'utf8');
const cam = CAMERA_SRC;
checkTrue('camera: BarcodeDetector scan mode present', cam.includes('BarcodeDetector'));
checkTrue('camera: torch capability gate present', cam.includes('caps.torch'));
checkTrue('camera: pointsOfInterest focus present', cam.includes('pointsOfInterest'));
checkTrue('camera: IndexedDB queue present', cam.includes('indexedDB'));
checkTrue('camera: constraint ladder used for live start', cam.includes('constraintLadder(s.facing)'));
checkTrue('camera: orientation decode present', cam.includes("imageOrientation: 'from-image'"));
checkTrue('camera: pending chip present', cam.includes('plc-queue-chip'));

const bar = read('shared/pepper-chat.js');
checkTrue('pepper bar: photo button present', bar.includes("class=\"cam\"") || bar.includes('pcb-input .cam'));
checkTrue('pepper bar: posts to /pepper/photo', bar.includes("API + '/pepper/photo'"));
checkTrue('pepper bar: exposes window.PepperChatPhoto', bar.includes('window.PepperChatPhoto'));
checkTrue('pepper bar: plate draft line labeled unsaved', bar.includes('Plate draft — nothing was saved'));

for (const page of ['tech/index.html', 'tech-network/index.html']) {
  const html = read(page);
  checkTrue(`${page}: Ask Pepper with a photo button`, html.includes('Ask Pepper with a photo'));
  checkTrue(`${page}: plug camera uses the plate guide`, html.includes("guide:'plate'"));
  checkTrue(`${page}: offline queue sink registered`, html.includes('PLCamera.setUploader'));
  checkTrue(`${page}: offline save path queues job photos`, html.includes("kind:'job-photo'"));
}

const pl = read('pepper-lists-site/index.html');
checkTrue('pepper lists: plate read sends the blob real mime', pl.includes("(plbPlateBlob.type||'image/jpeg')"));
checkTrue('pepper lists: plate camera uses the guide', pl.includes("guide:'plate'"));

const bookOs = read('book-os/index.html');
checkTrue('book os: camera platform loaded for the Pepper bar', bookOs.includes('/pepper-lists-site/pl-camera.js'));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures ? 1 : 0);
