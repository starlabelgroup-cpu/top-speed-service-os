/* Pepper Lists camera platform — PLCamera v2 (2026-11-20).
 *
 * v1 (2026-11-17) built ONE camera for every Pepper Lists flow (Sell
 * listing, Scan & Send, plate scan, review attachments), implementing
 * Ramone's camera model (2026-11-16): the device's own camera through
 * the browser first, Speedy as the AI upload assistant around it, and
 * file upload as the fallback everywhere.
 *
 * v2 (Ramone, 2026-11-20: "upgrade all to the highest level possible")
 * keeps the v1 contract — same window.PLCamera global, same open()
 * options and callbacks, same ladder — and raises the capture quality
 * to the highest level the web platform honestly supports:
 *   - getUserMedia constraint ladder: rear camera at up to 4K ideal,
 *     stepping down rung by rung when a device refuses a constraint,
 *     instead of one bare facingMode ask.
 *   - Torch/flash toggle when the live track reports the capability.
 *   - Tap-to-focus / exposure point where the track exposes
 *     pointsOfInterest or focusMode (feature-detected; silently
 *     absent everywhere else).
 *   - Capture review (retake / use) — kept from v1 — plus multi-shot
 *     batch capture via opts.onPhotos.
 *   - Orientation-corrected decode (createImageBitmap from-image
 *     where available) and a 2048px long-edge encode, WebP where the
 *     browser can encode it, JPEG otherwise.
 *   - Frame-guide overlay (opts.guide: 'plate' | 'document') for
 *     plate and document shots.
 *   - Barcode / QR scan mode (opts.scan + opts.onBarcode) on the
 *     BarcodeDetector API where the browser ships it; the button
 *     simply does not exist where it does not.
 *   - Offline capture queue: photos taken while offline (opts.
 *     queueOffline) or handed to PLCamera.queueAdd() are held in
 *     IndexedDB (localStorage fallback for small payloads), shown in
 *     a pending-count chip, and flushed through the host page's
 *     registered uploader (PLCamera.setUploader) when connectivity
 *     returns. The queue is bounded (12 items / ~24 MB) and refuses
 *     honestly when full instead of dropping shots silently.
 * Every v2 extra is feature-detected: on a browser or device without
 * the capability the control never renders and the v1 flow is
 * untouched.
 *
 * The ladder, in order:
 *   1. LIVE — navigator.mediaDevices.getUserMedia (environment
 *      camera first, flip to user-facing when a second camera
 *      exists), live preview, capture photo / record short video.
 *   2. CAPTURE INPUT — <input type=file capture="environment">,
 *      which opens the native device camera on mobile.
 *   3. FILE INPUT — a plain photo/video picker, works everywhere.
 * Every rung converges on the same preview step: Retake or
 * "Use this photo/video" — nothing leaves the camera until the
 * user taps Use, and the calling flow's own summary gate still
 * stands between the capture and any post or send.
 *
 * Usage (v1 options unchanged; v2 options marked):
 *   PLCamera.open({
 *     title: 'List with your camera',
 *     allowVideo: true,                 // offer MediaRecorder video
 *     accept: 'image/*,video/*',        // for the file rungs
 *     stayOpenAfterUse: true,           // multi-capture flows (scan)
 *     guide: 'plate',                   // v2: frame-guide overlay
 *     scan: true,                       // v2: barcode/QR scan button
 *     onBarcode: function (text, format) {},  // v2: decoded code
 *     onPhotos: function (blobs) {},    // v2: multi-shot batch (Done)
 *     queueOffline: true,               // v2: queue photos when offline
 *     queueMeta: { kind: 'job-photo' }, // v2: meta stored with queue items
 *     onPhoto: function (blob) {},      // after Use on a photo
 *     onVideo: function (blob) {},      // after Use on a video
 *   });
 *   PLCamera.close();
 *   PLCamera.setUploader(function (item) { return Promise<bool> });
 *   PLCamera.queueAdd(blobOrDataUrl, meta) -> Promise<{queued, ...}>
 *   PLCamera.queueCount() -> Promise<number>
 *   PLCamera.flushQueue() -> Promise<{sent, remaining}>
 */
(function (global) {
  'use strict';

  /* ---------------- Pure decision logic (unit-tested) ---------------- */

  // Which rung of the ladder a phase lands on.
  function choosePath(phase, env) {
    var gumSupported = !!(env && env.gumSupported);
    if (phase === 'start') return gumSupported ? 'live' : 'capture';
    if (phase === 'gum-failed') return 'capture';
    if (phase === 'capture-cancelled') return 'file';
    return 'file';
  }

  // Long-edge clamp used for captured photos.
  function clampDims(w, h, max) {
    w = Math.round(Number(w) || 0);
    h = Math.round(Number(h) || 0);
    if (!(w > 0)) w = 640;
    if (!(h > 0)) h = 480;
    var scale = Math.min(1, (max || 1600) / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
  }

  function nextFacing(current) {
    return current === 'environment' ? 'user' : 'environment';
  }

  // First recorder mime the browser actually supports.
  function pickRecorderMime(isSupported) {
    var candidates = ['video/webm', 'video/mp4'];
    for (var i = 0; i < candidates.length; i++) {
      try { if (isSupported(candidates[i])) return candidates[i]; } catch (e) { /* keep looking */ }
    }
    return '';
  }

  /* ------------------------- v2 pure logic --------------------------- */

  var MAX_EDGE = 2048;
  var ENCODE_TYPES = ['image/webp', 'image/jpeg'];
  var QUEUE_MAX_ITEMS = 12;
  var QUEUE_MAX_BYTES = 24 * 1024 * 1024;
  var LS_QUEUE_MAX_CHARS = 1800000;

  // The getUserMedia ladder: highest honest ask first (rear camera,
  // 4K ideal), stepping down until the bare { video: true } rung.
  // getUserMedia constraints are ideals, not demands — a device that
  // cannot do a rung rejects or satisfies it at its own best, and a
  // rejection moves to the next rung, never straight to file mode.
  function constraintLadder(facing) {
    var f = facing === 'user' ? 'user' : 'environment';
    return [
      { video: { facingMode: { ideal: f }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false },
      { video: { facingMode: { ideal: f }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
      { video: { facingMode: { ideal: f } }, audio: false },
      { video: { facingMode: f }, audio: false },
      { video: true, audio: false },
    ];
  }

  // First encodable type in preference order (WebP, then JPEG).
  function pickEncodeType(isSupported) {
    for (var i = 0; i < ENCODE_TYPES.length; i++) {
      try { if (isSupported(ENCODE_TYPES[i])) return ENCODE_TYPES[i]; } catch (e) { /* keep looking */ }
    }
    return 'image/jpeg';
  }

  // Approximate decoded byte size of a base64 data URL.
  function dataUrlBytes(dataUrl) {
    var s = String(dataUrl || '');
    var comma = s.indexOf(',');
    var b64 = comma >= 0 ? s.slice(comma + 1) : s;
    return Math.floor(b64.length * 3 / 4);
  }

  // Bounded-queue admission: refuse honestly when full or oversized
  // rather than silently dropping an older shot.
  function clampQueue(items, item) {
    var list = (items || []).slice();
    var total = 0;
    for (var i = 0; i < list.length; i++) total += dataUrlBytes(list[i] && list[i].dataUrl);
    var size = dataUrlBytes(item && item.dataUrl);
    if (list.length >= QUEUE_MAX_ITEMS) return { items: list, accepted: false, reason: 'full' };
    if (total + size > QUEUE_MAX_BYTES) return { items: list, accepted: false, reason: 'too-large' };
    list.push(item);
    return { items: list, accepted: true, reason: '' };
  }

  // Frame-guide rectangle (fractions of the stage) per guide kind.
  function guideRect(kind) {
    if (kind === 'plate' || kind === 'document') return { x: 0.05, y: 0.30, w: 0.90, h: 0.40 };
    return null;
  }

  var api = {
    version: 2,
    choosePath: choosePath,
    clampDims: clampDims,
    nextFacing: nextFacing,
    pickRecorderMime: pickRecorderMime,
    constraintLadder: constraintLadder,
    pickEncodeType: pickEncodeType,
    dataUrlBytes: dataUrlBytes,
    clampQueue: clampQueue,
    guideRect: guideRect,
    MAX_EDGE: MAX_EDGE,
    QUEUE_MAX_ITEMS: QUEUE_MAX_ITEMS,
    QUEUE_MAX_BYTES: QUEUE_MAX_BYTES,
    open: function () { throw new Error('PLCamera.open needs a browser'); },
    close: function () {},
    setUploader: function () {},
    queueAdd: function () { return Promise.resolve({ queued: false, reason: 'no-browser' }); },
    queueCount: function () { return Promise.resolve(0); },
    flushQueue: function () { return Promise.resolve({ sent: 0, remaining: 0 }); },
    _test: {
      choosePath: choosePath, clampDims: clampDims, nextFacing: nextFacing, pickRecorderMime: pickRecorderMime,
      constraintLadder: constraintLadder, pickEncodeType: pickEncodeType, dataUrlBytes: dataUrlBytes,
      clampQueue: clampQueue, guideRect: guideRect,
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!global || typeof document === 'undefined') return;
  global.PLCamera = api;

  /* ---------------- Browser implementation ---------------- */

  var CAMERA_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" style="width:17px;height:17px;vertical-align:-3px;margin-right:6px"><path d="M3 8 L8 8 L10 5 L14 5 L16 8 L21 8 L21 19 L3 19 Z"/><circle cx="12" cy="13" r="3.2"/></svg>';
  var FLIP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" style="width:17px;height:17px;vertical-align:-3px;margin-right:6px"><path d="M4 9 a8 8 0 0 1 13.6-3.4 L20 8"/><path d="M20 3.5 L20 8 L15.5 8"/><path d="M20 15 a8 8 0 0 1-13.6 3.4 L4 16"/><path d="M4 20.5 L4 16 L8.5 16"/></svg>';
  var VIDEO_MAX_MS = 20000;

  var CSS = [
    '.plc-cam-overlay{position:fixed;inset:0;z-index:99990;background:rgba(5,9,6,.84);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:18px 12px}',
    '.plc-cam-sheet{background:#101a13;border:1.5px solid rgba(183,227,60,.4);border-radius:18px;width:min(600px,100%);padding:18px;color:var(--ink,#EDF5E9);font:inherit;box-shadow:0 18px 50px rgba(0,0,0,.5)}',
    '.plc-cam-head{display:flex;align-items:center;gap:10px;margin-bottom:12px}',
    '.plc-cam-title{font-size:17px;font-weight:800;flex:1;line-height:1.3}',
    '.plc-cam-x{background:transparent;border:1.5px solid #2c4232;color:var(--ink,#EDF5E9);border-radius:50%;width:34px;height:34px;font-size:17px;line-height:1;cursor:pointer;flex:none}',
    '.plc-cam-stage{background:#000;border:1px solid #2c4232;border-radius:13px;overflow:hidden}',
    '.plc-cam-stage{position:relative}',
    '.plc-cam-stage video,.plc-cam-stage img{width:100%;max-height:52vh;display:block;object-fit:contain;background:#000}',
    '.plc-cam-guide{position:absolute;border:2px solid var(--lime,#B7E33C);border-radius:10px;box-shadow:0 0 0 999px rgba(0,0,0,.32);display:none;pointer-events:none;z-index:3}',
    '.plc-cam-guide span{position:absolute;top:-25px;left:0;color:var(--lime,#B7E33C);font-size:12.5px;font-weight:700;white-space:nowrap;text-shadow:0 1px 4px rgba(0,0,0,.8)}',
    '.plc-cam-focus{position:absolute;width:54px;height:54px;border:2px solid var(--lime,#B7E33C);border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;opacity:0;transition:opacity .18s ease;z-index:4}',
    '.plc-cam-focus.on{opacity:1}',
    '.plc-cam-msg{font-size:13.5px;line-height:1.5;min-height:18px;color:var(--amber,#F9BA47);margin:10px 0 4px}',
    '.plc-cam-msg.err{color:#ff9a8a}',
    '.plc-cam-row{display:flex;gap:9px;flex-wrap:wrap;margin-top:10px}',
    '.plc-cam-btn{background:#22331f;color:var(--ink,#EDF5E9);border:1.5px solid #2c4232;border-radius:11px;padding:11px 15px;font:inherit;font-size:14.5px;font-weight:700;cursor:pointer}',
    '.plc-cam-btn.primary{background:var(--lime,#B7E33C);border-color:var(--lime,#B7E33C);color:#0C130E}',
    '.plc-cam-btn.rec{border-color:#ff9a8a;color:#ff9a8a}',
    '.plc-cam-filemode{display:none;padding:8px 2px 2px}',
    '.plc-cam-filemode p{color:var(--muted,#9DB89A);font-size:14px;line-height:1.6;margin-bottom:6px}',
    '.plc-queue-chip{position:fixed;left:14px;bottom:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:99980;background:#101a13;color:var(--ink,#EDF5E9);border:1.5px solid rgba(183,227,60,.55);border-radius:999px;padding:8px 8px 8px 14px;font:600 13px Inter,system-ui,sans-serif;display:none;align-items:center;gap:9px;box-shadow:0 10px 26px rgba(0,0,0,.45)}',
    '.plc-queue-chip button{background:var(--lime,#B7E33C);color:#0C130E;border:none;border-radius:999px;padding:6px 12px;font:700 12.5px Inter,system-ui,sans-serif;cursor:pointer}',
    '@media(max-width:560px){.plc-cam-sheet{padding:15px 13px}.plc-cam-stage video,.plc-cam-stage img{max-height:46vh}}',
  ].join('\n');

  var els = null;      // overlay DOM, built once
  var session = null;  // active session state
  var chip = null;     // offline-queue pending chip
  var chipText = null;
  var uploader = null; // host-registered queue uploader

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildDom() {
    if (els) return els;
    var style = document.createElement('style');
    style.id = 'plcCamStyles';
    style.textContent = CSS;
    document.head.appendChild(style);

    var overlay = el('div', 'plc-cam-overlay');
    overlay.id = 'plcCamOverlay';
    overlay.style.display = 'none';
    var sheet = el('div', 'plc-cam-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Camera');

    var head = el('div', 'plc-cam-head');
    var title = el('span', 'plc-cam-title');
    var x = el('button', 'plc-cam-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close camera');
    x.addEventListener('click', function () { api.close(); });
    head.appendChild(title);
    head.appendChild(x);

    var stage = el('div', 'plc-cam-stage');
    var video = document.createElement('video');
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.addEventListener('click', function (ev) { onVideoTap(ev); });
    var pimg = document.createElement('img');
    pimg.alt = 'Captured photo';
    pimg.style.display = 'none';
    var pvid = document.createElement('video');
    pvid.setAttribute('controls', '');
    pvid.setAttribute('playsinline', '');
    pvid.style.display = 'none';
    var guide = el('div', 'plc-cam-guide');
    var guideLabel = el('span');
    guide.appendChild(guideLabel);
    var focusRing = el('div', 'plc-cam-focus');
    stage.appendChild(video);
    stage.appendChild(pimg);
    stage.appendChild(pvid);
    stage.appendChild(guide);
    stage.appendChild(focusRing);

    var filemode = el('div', 'plc-cam-filemode');
    var fp = el('p', null, 'The live camera is not available here — no problem. Your device camera or a photo from your files works just as well, and Speedy still helps with the upload.');
    filemode.appendChild(fp);

    var msg = el('p', 'plc-cam-msg');
    msg.setAttribute('role', 'status');

    var row = el('div', 'plc-cam-row');
    function mkBtn(act, label, cls, svg) {
      var b = el('button', 'plc-cam-btn' + (cls ? ' ' + cls : ''));
      b.type = 'button';
      b.setAttribute('data-act', act);
      if (svg) b.innerHTML = svg + label; else b.textContent = label;
      b.addEventListener('click', function () { onAction(act); });
      row.appendChild(b);
      return b;
    }
    var btns = {
      capture: mkBtn('capture', 'Capture photo', 'primary', CAMERA_SVG),
      record: mkBtn('record', 'Record video', '', null),
      flip: mkBtn('flip', 'Flip camera', '', FLIP_SVG),
      torch: mkBtn('torch', 'Torch', '', null),
      scan: mkBtn('scan', 'Scan code', '', null),
      done: mkBtn('done', 'Done', 'primary', null),
      upload: mkBtn('upload', 'Upload instead', '', null),
      retake: mkBtn('retake', 'Retake', '', null),
      use: mkBtn('use', 'Use this photo', 'primary', null),
      devcam: mkBtn('devcam', 'Open device camera', 'primary', CAMERA_SVG),
      pickfile: mkBtn('pickfile', 'Choose a file', '', null),
      close: mkBtn('close', 'Close', '', null),
    };

    var capInput = document.createElement('input');
    capInput.type = 'file';
    capInput.setAttribute('capture', 'environment');
    capInput.style.display = 'none';
    capInput.addEventListener('change', function () { onFilePicked(capInput); });
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', function () { onFilePicked(fileInput); });

    sheet.appendChild(head);
    sheet.appendChild(stage);
    sheet.appendChild(filemode);
    sheet.appendChild(msg);
    sheet.appendChild(row);
    overlay.appendChild(sheet);
    overlay.appendChild(capInput);
    overlay.appendChild(fileInput);
    document.body.appendChild(overlay);

    els = { overlay: overlay, title: title, stage: stage, video: video, pimg: pimg, pvid: pvid, guide: guide, guideLabel: guideLabel, focusRing: focusRing, filemode: filemode, msg: msg, btns: btns, capInput: capInput, fileInput: fileInput };
    return els;
  }

  function msg(text, isErr) {
    if (!els) return;
    els.msg.textContent = text || '';
    els.msg.className = 'plc-cam-msg' + (isErr ? ' err' : '');
  }

  function showOnly(names) {
    Object.keys(els.btns).forEach(function (k) {
      els.btns[k].style.display = names.indexOf(k) >= 0 ? '' : 'none';
    });
  }

  function detectorSupported() {
    return typeof window !== 'undefined' && 'BarcodeDetector' in window;
  }

  function updateDoneLabel() {
    if (!session) return;
    var n = session.shots ? session.shots.length : 0;
    els.btns.done.textContent = n > 0 ? 'Done (' + n + ')' : 'Done';
  }

  // The live-mode button set, recomputed from REAL feature detection:
  // a control appears only when this device/browser actually has the
  // capability behind it.
  function refreshLiveButtons() {
    var s = session;
    if (!s) return;
    var names = ['capture', 'upload', 'close'];
    if (s.opts.allowVideo && window.MediaRecorder) names.push('record');
    if (s.cameraCount > 1) names.push('flip');
    if (s.caps && s.caps.torch) names.push('torch');
    if (s.opts.scan && detectorSupported()) names.push('scan');
    if (s.opts.onPhotos) names.push('done');
    showOnly(names);
    els.btns.torch.className = 'plc-cam-btn' + (s.torchOn ? ' primary' : '');
    els.btns.scan.textContent = s.scanning ? 'Stop scanning' : 'Scan code';
    updateDoneLabel();
  }

  function showGuide() {
    var s = session;
    if (!s || !els) return;
    var rect = guideRect(s.opts.guide);
    if (!rect || s.mode !== 'live') { els.guide.style.display = 'none'; return; }
    els.guide.style.left = (rect.x * 100) + '%';
    els.guide.style.top = (rect.y * 100) + '%';
    els.guide.style.width = (rect.w * 100) + '%';
    els.guide.style.height = (rect.h * 100) + '%';
    els.guideLabel.textContent = s.opts.guideLabel || (s.opts.guide === 'plate' ? 'Fit the rating plate inside the frame' : 'Fit the document inside the frame');
    els.guide.style.display = 'block';
  }

  function hideGuide() {
    if (els) els.guide.style.display = 'none';
  }

  function stopStream() {
    if (session && session.stream) {
      session.stream.getTracks().forEach(function (t) { t.stop(); });
      session.stream = null;
    }
    if (session) { session.track = null; session.caps = null; session.torchOn = false; }
    if (els && els.video) els.video.srcObject = null;
  }

  function stopRecorder(discard) {
    if (!session) return;
    if (session.timer) { clearInterval(session.timer); session.timer = null; }
    if (session.maxTimer) { clearTimeout(session.maxTimer); session.maxTimer = null; }
    if (session.recorder && session.recorder.state !== 'inactive') {
      if (discard) session.recorder.ondataavailable = null, session.recorder.onstop = null;
      try { session.recorder.stop(); } catch (e) { /* already stopped */ }
    }
    session.recorder = null;
    session.recording = false;
  }

  function stopScan() {
    if (!session) return;
    session.scanning = false;
    if (session.scanTimer) { clearTimeout(session.scanTimer); session.scanTimer = null; }
  }

  function clearPreview() {
    if (!session) return;
    if (session.previewUrl) { URL.revokeObjectURL(session.previewUrl); session.previewUrl = null; }
    session.previewBlob = null;
    session.previewKind = null;
    els.pimg.style.display = 'none';
    els.pvid.style.display = 'none';
    els.pvid.removeAttribute('src');
  }

  function startLive() {
    var s = session;
    s.mode = 'live';
    stopStream();
    stopScan();
    els.filemode.style.display = 'none';
    els.stage.style.display = '';
    els.video.style.display = '';
    refreshLiveButtons();
    msg('Starting your camera…');
    var ladder = constraintLadder(s.facing);
    var attempt = function (i) {
      if (session !== s) return;
      if (i >= ladder.length) {
        if (s.flipGuard) {
          // A flip asked for a camera that does not answer — go back
          // to the one that was working instead of dropping to files.
          s.flipGuard = false;
          s.facing = nextFacing(s.facing);
          msg('That camera is not available — staying on the current one.', true);
          startLive();
          return;
        }
        enterFileMode('The camera was denied or is unavailable.');
        return;
      }
      navigator.mediaDevices.getUserMedia(ladder[i])
        .then(function (stream) {
          if (session !== s) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
          s.stream = stream;
          var track = null;
          if (stream.getVideoTracks) { var tracks = stream.getVideoTracks(); track = tracks && tracks[0] ? tracks[0] : null; }
          s.track = track;
          s.caps = null;
          if (track && track.getCapabilities) {
            try { s.caps = track.getCapabilities() || null; } catch (e) { s.caps = null; }
          }
          els.video.srcObject = stream;
          msg('Camera is on — line up the shot, then capture.');
          refreshLiveButtons();
          showGuide();
          // Flip only makes sense with a second camera; ask the
          // device list now that permission is granted.
          if (navigator.mediaDevices.enumerateDevices) {
            navigator.mediaDevices.enumerateDevices().then(function (devs) {
              if (session !== s) return;
              var cams = devs.filter(function (d) { return d.kind === 'videoinput'; });
              s.cameraCount = cams.length;
              refreshLiveButtons();
            }).catch(function () { /* flip stays hidden */ });
          }
          if (s.opts.allowVideo && !(window.MediaRecorder)) {
            msg('Camera is on. Video recording is not supported in this browser — you can still upload a video file instead.');
            els.btns.record.style.display = 'none';
          }
        })
        .catch(function () { attempt(i + 1); });
    };
    attempt(0);
  }

  function enterFileMode(reason) {
    if (session) session.mode = 'file';
    stopStream();
    stopRecorder(true);
    stopScan();
    hideGuide();
    els.stage.style.display = 'none';
    els.filemode.style.display = 'block';
    showOnly(['devcam', 'pickfile', 'close']);
    msg((reason ? reason + ' ' : '') + 'Use your device camera or pick a file — both work.', true);
  }

  /* Tap-to-focus / exposure: only where the track's capabilities
   * actually expose a focus control — otherwise the tap does
   * nothing at all (silently absent, never faked). */
  function onVideoTap(ev) {
    var s = session;
    if (!s || s.mode !== 'live' || !s.track || !s.caps) return;
    var caps = s.caps;
    var hasPoI = 'pointsOfInterest' in caps;
    var hasFocus = !!(caps.focusMode && caps.focusMode.length);
    if (!hasPoI && !hasFocus) return;
    var stageRect = els.stage.getBoundingClientRect();
    var videoRect = els.video.getBoundingClientRect();
    if (!videoRect.width || !videoRect.height) return;
    var x = (ev.clientX - videoRect.left) / videoRect.width;
    var y = (ev.clientY - videoRect.top) / videoRect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    var adv = {};
    if (hasPoI) adv.pointsOfInterest = [{ x: x, y: y }];
    if (hasFocus) adv.focusMode = caps.focusMode.indexOf('single-shot') >= 0 ? 'single-shot' : caps.focusMode[0];
    s.track.applyConstraints({ advanced: [adv] }).then(function () {
      if (session !== s) return;
      var ring = els.focusRing;
      ring.style.left = (ev.clientX - stageRect.left) + 'px';
      ring.style.top = (ev.clientY - stageRect.top) + 'px';
      ring.classList.add('on');
      setTimeout(function () { ring.classList.remove('on'); }, 650);
    }).catch(function () { /* focus control refused — nothing shown */ });
  }

  function startScan() {
    var s = session;
    if (!s || !detectorSupported()) return;
    if (!s.detector) {
      try {
        s.detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'pdf417', 'data_matrix', 'aztec', 'itf'] });
      } catch (e) {
        try { s.detector = new window.BarcodeDetector(); } catch (e2) { s.detector = null; }
      }
      if (!s.detector) return;
    }
    s.scanning = true;
    refreshLiveButtons();
    msg('Scanning — hold the barcode or QR code inside the frame.');
    var tick = function () {
      if (!session || session !== s || !s.scanning) return;
      if (els.video.readyState >= 2 && s.detector) {
        s.detector.detect(els.video).then(function (codes) {
          if (!session || session !== s || !s.scanning) return;
          if (codes && codes.length && codes[0].rawValue) {
            var val = String(codes[0].rawValue);
            var fmt = codes[0].format || '';
            stopScan();
            refreshLiveButtons();
            msg('Code read: ' + val);
            if (s.opts.onBarcode) { try { s.opts.onBarcode(val, fmt); } catch (e) { /* caller owns its draft field */ } }
            return;
          }
          s.scanTimer = setTimeout(tick, 450);
        }).catch(function () {
          if (session === s && s.scanning) s.scanTimer = setTimeout(tick, 650);
        });
      } else {
        s.scanTimer = setTimeout(tick, 300);
      }
    };
    tick();
  }

  // Synchronous WebP-encode probe (the classic canvas data-URL test).
  function webpSupported() {
    try {
      var c = document.createElement('canvas');
      return c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (e) { return false; }
  }

  // Encode a canvas at the v2 quality bar: WebP where encodable,
  // JPEG otherwise — verified against the blob the browser actually
  // returns, never assumed.
  function encodeCanvas(c, cb) {
    var first = pickEncodeType(function (t) {
      return t === 'image/jpeg' || (t === 'image/webp' && webpSupported());
    });
    var attemptType = function (type) {
      c.toBlob(function (b) {
        if (b && b.type === type) { cb(b); return; }
        if (type !== 'image/jpeg') { attemptType('image/jpeg'); return; }
        cb(b || null);
      }, type, 0.85);
    };
    attemptType(first);
  }

  function snapPhoto() {
    var s = session;
    var v = els.video;
    if (!v.videoWidth) { msg('The camera is still warming up — give it a second and capture again.', true); return; }
    var dims = clampDims(v.videoWidth, v.videoHeight, MAX_EDGE);
    var c = document.createElement('canvas');
    c.width = dims.width;
    c.height = dims.height;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    encodeCanvas(c, function (b) {
      if (session !== s) return;
      if (!b) { msg('The camera did not return a photo — try again, or upload one instead.', true); return; }
      showPreview('photo', b);
    });
  }

  function toggleRecord() {
    var s = session;
    if (s.recording) { if (s.recorder) s.recorder.stop(); return; }
    if (!s.stream) { msg('The camera is not on yet.', true); return; }
    if (!window.MediaRecorder) { msg('Video recording is not supported in this browser — you can still upload a video file instead.', true); return; }
    var mime = pickRecorderMime(function (m) { return window.MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m); });
    var rec;
    try { rec = new MediaRecorder(s.stream, mime ? { mimeType: mime } : undefined); }
    catch (e) { msg('Video recording is not supported in this browser — you can still upload a video file instead.', true); return; }
    s.recorder = rec;
    s.chunks = [];
    rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) s.chunks.push(ev.data); };
    rec.onstop = function () {
      if (session !== s) return;
      s.recording = false;
      if (s.timer) { clearInterval(s.timer); s.timer = null; }
      if (s.maxTimer) { clearTimeout(s.maxTimer); s.maxTimer = null; }
      els.btns.record.textContent = 'Record video';
      els.btns.record.className = 'plc-cam-btn';
      var blob = new Blob(s.chunks, { type: rec.mimeType || 'video/webm' });
      if (blob.size) showPreview('video', blob);
      else msg('That recording came back empty — try again, or upload a video file.', true);
    };
    rec.start();
    s.recording = true;
    var started = Date.now();
    els.btns.record.textContent = 'Stop recording (0:00)';
    els.btns.record.className = 'plc-cam-btn rec';
    msg('Recording — tap Stop when you are done (20 seconds max).');
    s.timer = setInterval(function () {
      var sec = Math.floor((Date.now() - started) / 1000);
      els.btns.record.textContent = 'Stop recording (0:' + (sec < 10 ? '0' : '') + sec + ')';
    }, 250);
    s.maxTimer = setTimeout(function () { if (session === s && s.recording && s.recorder) s.recorder.stop(); }, VIDEO_MAX_MS);
  }

  function showPreview(kind, blob) {
    var s = session;
    clearPreview();
    stopScan();
    hideGuide();
    s.previewKind = kind;
    s.previewBlob = blob;
    s.previewUrl = URL.createObjectURL(blob);
    stopRecorder(true);
    els.video.style.display = 'none';
    els.filemode.style.display = 'none';
    els.stage.style.display = '';
    if (kind === 'photo') {
      els.pimg.src = s.previewUrl;
      els.pimg.style.display = '';
      els.btns.use.textContent = 'Use this photo';
    } else {
      els.pvid.src = s.previewUrl;
      els.pvid.style.display = '';
      els.btns.use.textContent = 'Use this video';
    }
    showOnly(['retake', 'use', 'close']);
    msg(kind === 'photo' ? 'Here is your photo — use it, or retake.' : 'Here is your video — use it, or retake.');
  }

  // Decode a picked file with its EXIF orientation applied where the
  // platform supports it (createImageBitmap from-image), falling
  // back to a plain <img> decode everywhere else.
  function loadOriented(file) {
    return new Promise(function (resolve) {
      var viaImg = function () {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          resolve({ src: img, width: img.naturalWidth, height: img.naturalHeight, done: function () { URL.revokeObjectURL(url); } });
        };
        img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
      };
      if (typeof window !== 'undefined' && window.createImageBitmap) {
        try {
          window.createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
            resolve({ src: bmp, width: bmp.width, height: bmp.height, done: function () { if (bmp.close) bmp.close(); } });
          }).catch(function () {
            window.createImageBitmap(file).then(function (bmp) {
              resolve({ src: bmp, width: bmp.width, height: bmp.height, done: function () { if (bmp.close) bmp.close(); } });
            }).catch(viaImg);
          });
          return;
        } catch (e) { /* fall through to the <img> decode */ }
      }
      viaImg();
    });
  }

  function downscalePhotoFile(file) {
    return new Promise(function (resolve) {
      if (!/^image\//.test(file.type || '')) { resolve(file); return; }
      loadOriented(file).then(function (loaded) {
        if (!loaded) { resolve(file); return; }
        var dims = clampDims(loaded.width, loaded.height, MAX_EDGE);
        if (dims.width === loaded.width && dims.height === loaded.height && file.size <= 6 * 1024 * 1024) {
          loaded.done();
          resolve(file);
          return;
        }
        var c = document.createElement('canvas');
        c.width = dims.width;
        c.height = dims.height;
        c.getContext('2d').drawImage(loaded.src, 0, 0, c.width, c.height);
        loaded.done();
        encodeCanvas(c, function (b) { resolve(b || file); });
      });
    });
  }

  function onFilePicked(input) {
    var s = session;
    var f = input.files && input.files[0];
    input.value = '';
    if (!s) return;
    if (!f) { // picker cancelled — stay in file mode with both rungs offered
      if (els.filemode.style.display !== 'none') msg('No file picked — open the device camera, choose a file, or close.', true);
      return;
    }
    if (/^image\//.test(f.type || '')) {
      downscalePhotoFile(f).then(function (b) { if (session === s) showPreview('photo', b); });
    } else if (/^video\//.test(f.type || '')) {
      showPreview('video', f);
    } else {
      msg('That file is not a photo or video — pick another.', true);
    }
  }

  // Return from a used/queued shot to the capture state. v1 semantics:
  // stay open only when the flow asked for it (stayOpenAfterUse) or a
  // batch is being collected (forceStay from the multi-shot path);
  // otherwise close.
  function backToCapture(forceStay) {
    var s = session;
    if (!s) return;
    if (forceStay || s.opts.stayOpenAfterUse) {
      if (s.mode === 'file') { enterFileMode(''); }
      else {
        els.pimg.style.display = 'none';
        els.pvid.style.display = 'none';
        els.video.style.display = '';
        refreshLiveButtons();
        showGuide();
        if (!s.stream) startLive();
      }
    } else {
      api.close();
    }
  }

  function onAction(act) {
    var s = session;
    if (!s) return;
    if (act === 'close') { api.close(); return; }
    if (act === 'capture') { snapPhoto(); return; }
    if (act === 'record') { toggleRecord(); return; }
    if (act === 'torch') {
      if (!s.track || !s.caps || !s.caps.torch) return;
      var want = !s.torchOn;
      s.track.applyConstraints({ advanced: [{ torch: want }] }).then(function () {
        if (session !== s) return;
        s.torchOn = want;
        refreshLiveButtons();
        msg(want ? 'Torch on.' : 'Torch off.');
      }).catch(function () {
        if (session !== s) return;
        msg('The torch is not available on this camera.', true);
      });
      return;
    }
    if (act === 'scan') {
      if (s.scanning) { stopScan(); refreshLiveButtons(); msg('Scanning stopped.'); }
      else startScan();
      return;
    }
    if (act === 'done') {
      var shots = s.shots.slice();
      var batchCb = s.opts.onPhotos;
      api.close();
      if (batchCb) batchCb(shots);
      return;
    }
    if (act === 'flip') {
      s.facing = nextFacing(s.facing);
      s.flipGuard = true;
      msg('Switching camera…');
      startLive();
      return;
    }
    if (act === 'upload') { enterFileMode(''); return; }
    if (act === 'devcam') { els.capInput.click(); return; }
    if (act === 'pickfile') { els.fileInput.click(); return; }
    if (act === 'retake') {
      clearPreview();
      if (s.mode === 'file') { enterFileMode(''); }
      else {
        els.pimg.style.display = 'none';
        els.pvid.style.display = 'none';
        els.video.style.display = '';
        refreshLiveButtons();
        showGuide();
        if (s.stream) msg('Camera is on — line up the shot, then capture.');
        else startLive();
      }
      return;
    }
    if (act === 'use') {
      var kind = s.previewKind;
      var blob = s.previewBlob;
      clearPreview();
      if (kind === 'photo' && s.opts.queueOffline && typeof navigator !== 'undefined' && navigator.onLine === false) {
        api.queueAdd(blob, s.opts.queueMeta || {}).then(function (r) {
          msg(r && r.queued
            ? 'You are offline — this photo is in the upload queue and will send when you reconnect.'
            : 'You are offline and the photo could not be queued — keep the camera open and try again when you reconnect.', !(r && r.queued));
        });
        backToCapture(false);
        return;
      }
      if (kind === 'photo' && s.opts.onPhotos) {
        s.shots.push(blob);
        updateDoneLabel();
        msg('Shot ' + s.shots.length + ' kept — keep shooting, or tap Done (' + s.shots.length + ').');
        backToCapture(true);
        return;
      }
      var cb = kind === 'video' ? s.opts.onVideo : s.opts.onPhoto;
      if (cb) cb(blob);
      if (session === s) backToCapture(false);
      return;
    }
  }

  api.open = function (opts) {
    opts = opts || {};
    if (session) api.close();
    buildDom();
    session = {
      opts: opts,
      facing: 'environment',
      stream: null,
      track: null,
      caps: null,
      torchOn: false,
      detector: null,
      scanning: false,
      scanTimer: null,
      shots: [],
      flipGuard: false,
      recorder: null,
      chunks: [],
      recording: false,
      timer: null,
      maxTimer: null,
      previewBlob: null,
      previewKind: null,
      previewUrl: null,
      cameraCount: 0,
      mode: 'live',
    };
    els.title.textContent = opts.title || 'Camera';
    var accept = opts.accept || 'image/*';
    els.capInput.accept = accept;
    els.fileInput.accept = accept;
    els.overlay.style.display = 'flex';
    els.overlay.scrollTop = 0;
    document.body.style.overflow = 'hidden';

    var path = choosePath('start', { gumSupported: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) });
    if (path === 'live') {
      startLive();
    } else {
      session.mode = 'file';
      enterFileMode('Live camera is not available in this browser.');
    }
  };

  api.close = function () {
    if (!els) { session = null; return; }
    var s = session;
    if (s) { stopScan(); stopRecorderFor(s); }
    session = null;
    stopStreamFor(s);
    if (s && s.previewUrl) URL.revokeObjectURL(s.previewUrl);
    els.overlay.style.display = 'none';
    document.body.style.overflow = '';
    if (s && s.opts && s.opts.onClose) { try { s.opts.onClose(); } catch (e) { /* flow cleanup only */ } }
  };

  function stopRecorderFor(s) {
    if (!s) return;
    if (s.timer) { clearInterval(s.timer); s.timer = null; }
    if (s.maxTimer) { clearTimeout(s.maxTimer); s.maxTimer = null; }
    if (s.recorder && s.recorder.state !== 'inactive') {
      s.recorder.ondataavailable = null;
      s.recorder.onstop = null;
      try { s.recorder.stop(); } catch (e) { /* already stopped */ }
    }
    s.recorder = null;
    s.recording = false;
  }

  function stopStreamFor(s) {
    if (s && s.stream) {
      s.stream.getTracks().forEach(function (t) { t.stop(); });
      s.stream = null;
    }
    if (els && els.video) els.video.srcObject = null;
  }

  /* --------------------- Offline capture queue ------------------------
   * IndexedDB first; localStorage fallback for small payloads when
   * IDB is missing or refuses. Items: { id, at, meta, dataUrl }.
   * The host page registers ONE uploader; the queue drains through
   * it on reconnect, on registration, and on chip Retry. An item
   * leaves the queue only when the uploader confirms the upload. */
  var IDB_NAME = 'plcamera-v2';
  var IDB_STORE = 'queue';
  var LS_KEY = 'plcQueueV1';

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (typeof window === 'undefined' || !('indexedDB' in window)) { reject(new Error('no-indexeddb')); return; }
      var req = window.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(IDB_STORE, { keyPath: 'id' }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('idb-open-failed')); };
    });
  }

  function idbAll() {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
        rq.onsuccess = function () { resolve(rq.result || []); };
        rq.onerror = function () { reject(rq.error || new Error('idb-read-failed')); };
      });
    });
  }

  function idbPut(item) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var rq = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(item);
        rq.onsuccess = function () { resolve(); };
        rq.onerror = function () { reject(rq.error || new Error('idb-write-failed')); };
      });
    });
  }

  function idbDelete(id) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var rq = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).delete(id);
        rq.onsuccess = function () { resolve(); };
        rq.onerror = function () { reject(rq.error || new Error('idb-delete-failed')); };
      });
    });
  }

  function lsAll() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  function lsSave(items) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(items)); return true; } catch (e) { return false; }
  }

  function queueAll() {
    var idbItems = idbAll().catch(function () { return []; });
    return idbItems.then(function (fromIdb) {
      var merged = fromIdb.map(function (it) { return Object.assign({}, it, { _store: 'idb' }); });
      lsAll().forEach(function (it) { merged.push(Object.assign({}, it, { _store: 'local' })); });
      merged.sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); });
      return merged;
    });
  }

  function queueRemove(item) {
    if (item._store === 'idb') return idbDelete(item.id).catch(function () {});
    var rest = lsAll().filter(function (it) { return it.id !== item.id; });
    lsSave(rest);
    return Promise.resolve();
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result || '')); };
      r.onerror = function () { reject(new Error('read-failed')); };
      r.readAsDataURL(blob);
    });
  }

  function refreshChip() {
    api.queueCount().then(function (n) {
      if (!n) { if (chip) chip.style.display = 'none'; return; }
      if (!chip) {
        chip = el('div', 'plc-queue-chip');
        chipText = el('span');
        var retry = el('button', null, 'Retry');
        retry.type = 'button';
        retry.addEventListener('click', function () { api.flushQueue().then(refreshChip); });
        chip.appendChild(chipText);
        chip.appendChild(retry);
        document.body.appendChild(chip);
      }
      chipText.textContent = n + (n === 1 ? ' photo' : ' photos') + ' waiting to upload';
      chip.style.display = 'flex';
    }).catch(function () { /* chip is best-effort chrome */ });
  }

  api.setUploader = function (fn) {
    uploader = typeof fn === 'function' ? fn : null;
    if (uploader) api.flushQueue();
  };

  api.queueAdd = function (blobOrUrl, meta) {
    var getUrl = typeof blobOrUrl === 'string' ? Promise.resolve(blobOrUrl) : blobToDataUrl(blobOrUrl);
    return getUrl.then(function (dataUrl) {
      if (!dataUrl) return { queued: false, reason: 'empty' };
      var item = {
        id: 'q' + Date.now().toString(36) + Math.floor(Math.random() * 1000000).toString(36),
        at: new Date().toISOString(),
        meta: meta || {},
        dataUrl: dataUrl,
      };
      return queueAll().then(function (existing) {
        var verdict = clampQueue(existing, item);
        if (!verdict.accepted) { refreshChip(); return { queued: false, reason: verdict.reason }; }
        return idbPut(item).then(function () {
          refreshChip();
          return { queued: true, via: 'idb' };
        }).catch(function () {
          if (dataUrl.length <= LS_QUEUE_MAX_CHARS) {
            var items = lsAll();
            items.push(item);
            if (lsSave(items)) { refreshChip(); return { queued: true, via: 'local' }; }
          }
          return { queued: false, reason: 'storage' };
        });
      });
    }).catch(function () { return { queued: false, reason: 'read-failed' }; });
  };

  api.queueCount = function () {
    return queueAll().then(function (items) { return items.length; }).catch(function () { return 0; });
  };

  api.flushQueue = function () {
    if (!uploader || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      return api.queueCount().then(function (n) { refreshChip(); return { sent: 0, remaining: n }; });
    }
    return queueAll().then(function (items) {
      var sent = 0;
      var chain = Promise.resolve();
      items.forEach(function (item) {
        chain = chain.then(function () {
          return Promise.resolve().then(function () { return uploader(item); }).then(function (ok) {
            if (ok) { sent += 1; return queueRemove(item); }
            return null;
          }).catch(function () { /* stays queued for the next flush */ });
        });
      });
      return chain.then(function () {
        return api.queueCount().then(function (n) { refreshChip(); return { sent: sent, remaining: n }; });
      });
    });
  };

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', function () { api.flushQueue(); });
  }
  refreshChip();
})(typeof window !== 'undefined' ? window : null);
