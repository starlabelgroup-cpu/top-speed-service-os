/* Pepper Lists camera platform (2026-11-17) — ONE camera for every
 * Pepper Lists flow (Sell listing, Scan & Send, plate scan, review
 * attachments), implementing Ramone's camera model (2026-11-16):
 * the device's own camera through the browser first, Speedy as the
 * AI upload assistant around it, and file upload as the fallback
 * everywhere.
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
 * Usage:
 *   PLCamera.open({
 *     title: 'List with your camera',
 *     allowVideo: true,                 // offer MediaRecorder video
 *     accept: 'image/*,video/*',        // for the file rungs
 *     stayOpenAfterUse: true,           // multi-capture flows (scan)
 *     onPhoto: function (blob) {},      // after Use on a photo
 *     onVideo: function (blob) {},      // after Use on a video
 *   });
 *   PLCamera.close();
 *
 * Photos are downscaled to a 1600px long edge as JPEG (the same
 * treatment the lanes' uploads already get) before the callback;
 * videos pass through untouched (the lanes' size caps apply).
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

  var api = {
    choosePath: choosePath,
    clampDims: clampDims,
    nextFacing: nextFacing,
    pickRecorderMime: pickRecorderMime,
    open: function () { throw new Error('PLCamera.open needs a browser'); },
    close: function () {},
    _test: { choosePath: choosePath, clampDims: clampDims, nextFacing: nextFacing, pickRecorderMime: pickRecorderMime },
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
    '.plc-cam-stage video,.plc-cam-stage img{width:100%;max-height:52vh;display:block;object-fit:contain;background:#000}',
    '.plc-cam-msg{font-size:13.5px;line-height:1.5;min-height:18px;color:var(--amber,#F9BA47);margin:10px 0 4px}',
    '.plc-cam-msg.err{color:#ff9a8a}',
    '.plc-cam-row{display:flex;gap:9px;flex-wrap:wrap;margin-top:10px}',
    '.plc-cam-btn{background:#22331f;color:var(--ink,#EDF5E9);border:1.5px solid #2c4232;border-radius:11px;padding:11px 15px;font:inherit;font-size:14.5px;font-weight:700;cursor:pointer}',
    '.plc-cam-btn.primary{background:var(--lime,#B7E33C);border-color:var(--lime,#B7E33C);color:#0C130E}',
    '.plc-cam-btn.rec{border-color:#ff9a8a;color:#ff9a8a}',
    '.plc-cam-filemode{display:none;padding:8px 2px 2px}',
    '.plc-cam-filemode p{color:var(--muted,#9DB89A);font-size:14px;line-height:1.6;margin-bottom:6px}',
    '@media(max-width:560px){.plc-cam-sheet{padding:15px 13px}.plc-cam-stage video,.plc-cam-stage img{max-height:46vh}}',
  ].join('\n');

  var els = null;      // overlay DOM, built once
  var session = null;  // active session state

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
    var pimg = document.createElement('img');
    pimg.alt = 'Captured photo';
    pimg.style.display = 'none';
    var pvid = document.createElement('video');
    pvid.setAttribute('controls', '');
    pvid.setAttribute('playsinline', '');
    pvid.style.display = 'none';
    stage.appendChild(video);
    stage.appendChild(pimg);
    stage.appendChild(pvid);

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

    els = { overlay: overlay, title: title, stage: stage, video: video, pimg: pimg, pvid: pvid, filemode: filemode, msg: msg, btns: btns, capInput: capInput, fileInput: fileInput };
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

  function stopStream() {
    if (session && session.stream) {
      session.stream.getTracks().forEach(function (t) { t.stop(); });
      session.stream = null;
    }
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
    els.filemode.style.display = 'none';
    els.stage.style.display = '';
    els.video.style.display = '';
    showOnly(['capture', 'upload', 'close']);
    if (s.opts.allowVideo) els.btns.record.style.display = '';
    msg('Starting your camera…');
    navigator.mediaDevices.getUserMedia({ video: { facingMode: s.facing }, audio: false })
      .then(function (stream) {
        if (session !== s) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        s.stream = stream;
        els.video.srcObject = stream;
        msg('Camera is on — line up the shot, then capture.');
        // Flip only makes sense with a second camera; ask the
        // device list now that permission is granted.
        if (navigator.mediaDevices.enumerateDevices) {
          navigator.mediaDevices.enumerateDevices().then(function (devs) {
            if (session !== s) return;
            var cams = devs.filter(function (d) { return d.kind === 'videoinput'; });
            s.cameraCount = cams.length;
            els.btns.flip.style.display = cams.length > 1 ? '' : 'none';
          }).catch(function () { els.btns.flip.style.display = 'none'; });
        }
        if (s.opts.allowVideo && !(window.MediaRecorder)) {
          msg('Camera is on. Video recording is not supported in this browser — you can still upload a video file instead.');
          els.btns.record.style.display = 'none';
        }
      })
      .catch(function () {
        if (session !== s) return;
        enterFileMode('The camera was denied or is unavailable.');
      });
  }

  function enterFileMode(reason) {
    if (session) session.mode = 'file';
    stopStream();
    stopRecorder(true);
    els.stage.style.display = 'none';
    els.filemode.style.display = 'block';
    showOnly(['devcam', 'pickfile', 'close']);
    msg((reason ? reason + ' ' : '') + 'Use your device camera or pick a file — both work.', true);
  }

  function snapPhoto() {
    var s = session;
    var v = els.video;
    if (!v.videoWidth) { msg('The camera is still warming up — give it a second and capture again.', true); return; }
    var dims = clampDims(v.videoWidth, v.videoHeight, 1600);
    var c = document.createElement('canvas');
    c.width = dims.width;
    c.height = dims.height;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    c.toBlob(function (b) {
      if (session !== s) return;
      if (!b) { msg('The camera did not return a photo — try again, or upload one instead.', true); return; }
      showPreview('photo', b);
    }, 'image/jpeg', 0.85);
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

  function downscalePhotoFile(file) {
    return new Promise(function (resolve) {
      if (!/^image\//.test(file.type || '')) { resolve(file); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var dims = clampDims(img.naturalWidth, img.naturalHeight, 1600);
        if (dims.width === img.naturalWidth && dims.height === img.naturalHeight && file.size <= 6 * 1024 * 1024) {
          URL.revokeObjectURL(url);
          resolve(file);
          return;
        }
        var c = document.createElement('canvas');
        c.width = dims.width;
        c.height = dims.height;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { resolve(b || file); }, 'image/jpeg', 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
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

  function onAction(act) {
    var s = session;
    if (!s) return;
    if (act === 'close') { api.close(); return; }
    if (act === 'capture') { snapPhoto(); return; }
    if (act === 'record') { toggleRecord(); return; }
    if (act === 'flip') {
      s.facing = nextFacing(s.facing);
      msg('Switching camera…');
      stopStream();
      navigator.mediaDevices.getUserMedia({ video: { facingMode: s.facing }, audio: false })
        .then(function (stream) {
          if (session !== s) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
          s.stream = stream;
          els.video.srcObject = stream;
          msg('Camera flipped — line up the shot, then capture.');
        })
        .catch(function () {
          if (session !== s) return;
          s.facing = nextFacing(s.facing);
          msg('That camera is not available — staying on the current one.', true);
          startLive();
        });
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
        showOnly(['capture', 'upload', 'close']);
        if (s.opts.allowVideo && window.MediaRecorder) els.btns.record.style.display = '';
        if (s.cameraCount > 1) els.btns.flip.style.display = '';
        if (s.stream) msg('Camera is on — line up the shot, then capture.');
        else startLive();
      }
      return;
    }
    if (act === 'use') {
      var kind = s.previewKind;
      var blob = s.previewBlob;
      var cb = kind === 'video' ? s.opts.onVideo : s.opts.onPhoto;
      clearPreview();
      if (cb) cb(blob);
      if (s.opts.stayOpenAfterUse && session === s) {
        if (s.mode === 'file') enterFileMode('');
        else {
          els.video.style.display = '';
          showOnly(['capture', 'upload', 'close']);
          if (s.opts.allowVideo && window.MediaRecorder) els.btns.record.style.display = '';
          if (s.cameraCount > 1) els.btns.flip.style.display = '';
          if (!s.stream) startLive();
        }
      } else {
        api.close();
      }
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
    session = null;
    if (s) { stopRecorder(true); }
    stopStream();
    if (s && s.previewUrl) URL.revokeObjectURL(s.previewUrl);
    els.overlay.style.display = 'none';
    document.body.style.overflow = '';
    if (s && s.opts && s.opts.onClose) { try { s.opts.onClose(); } catch (e) { /* flow cleanup only */ } }
  };
})(typeof window !== 'undefined' ? window : null);
