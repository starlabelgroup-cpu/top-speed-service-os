/* Top Speed — Speedy Everywhere widget (Phase D+).
   One shared floating Speedy assistant for customer-facing flagship
   pages that don't carry their own panel. Same public Service OS
   endpoints as the homepage chat: /speedy/chat (OpenAI), 
   /speedy/extract-booking, /speedy/book (guest booking with confirm
   card), /speedy/diagnose (photo first look), /speedy/send-receipt
   (email receipt / SMS tracking link with truthful status).
   Voice: Web Speech API — transcripts fill the composer and flow
   through the exact same send path as typed text.
   Governance: no invented prices, no safety certification, refunds
   are human-only. Recommendations are labeled suggestions; signed-in
   derivations come only from the visitor's real records. */
(function () {
  if (window.__tswLoaded) return;
  window.__tswLoaded = true;
  if (document.getElementById('speedyBtn') || document.getElementById('speedyPanel')) return;

  var API = 'https://top-speed-service-os.vercel.app/api/v1';
  var css = [
    '.tsw-btn{position:fixed;right:18px;bottom:18px;bottom:calc(18px + env(safe-area-inset-bottom,0px));z-index:9990;background:#0A265C;color:#fff;border:2px solid #1280FF;border-radius:999px;padding:13px 20px;font:700 15px Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 10px 30px rgba(6,20,45,.45);animation:tswPulse 2.4s infinite;transition:opacity .18s ease,visibility .18s ease}',
    '@keyframes tswPulse{0%{box-shadow:0 0 0 0 rgba(18,128,255,.45)}70%{box-shadow:0 0 0 14px rgba(18,128,255,0)}100%{box-shadow:0 0 0 0 rgba(18,128,255,0)}}',
    'body:has(.tsw-panel.open) .tsw-btn{opacity:0;visibility:hidden;pointer-events:none}',
    '.tsw-panel{position:fixed;right:18px;bottom:76px;bottom:calc(76px + env(safe-area-inset-bottom,0px));z-index:9991;width:min(400px,calc(100vw - 24px));max-height:min(78vh,720px);max-height:min(720px,calc(100dvh - 108px));display:flex;flex-direction:column;background:#fff;border-radius:20px;box-shadow:0 24px 60px rgba(6,20,45,.5);overflow:hidden;font-family:Inter,system-ui,sans-serif;color:#0d1b2e;visibility:hidden;opacity:0;transform:translateY(14px) scale(.98);pointer-events:none;transition:opacity .18s ease,transform .18s ease,visibility 0s linear .18s}',
    '.tsw-panel.open{visibility:visible;opacity:1;transform:none;pointer-events:auto;transition:opacity .18s ease,transform .18s ease}',
    '.tsw-grab{display:none}',
    '.tsw-head{display:flex;align-items:center;gap:10px;background:#071f4f;color:#fff;padding:13px 16px;flex:none}',
    '.tsw-head b{font-size:16px}.tsw-head small{display:block;color:#B9CFF2;font-size:11.5px}',
    '.tsw-head .x{margin-left:auto;background:none;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1}',
    '.tsw-recs{padding:10px 14px;background:#f2f7ff;border-bottom:1px solid #dbe7fa;font-size:12.8px;display:none;flex:none;max-height:170px;overflow-y:auto;-webkit-overflow-scrolling:touch}',
    '.tsw-recs h5{margin:4px 0 6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5a6b87}',
    '.tsw-recs .r{margin:0 0 7px}.tsw-recs a{color:#0B63CE;font-weight:700}',
    '.tsw-body{padding:14px;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;display:flex;flex-direction:column;gap:9px;flex:1 1 auto;min-height:0}',
    '.tsw-msg{max-width:88%;padding:10px 13px;border-radius:15px;font-size:14.3px;line-height:1.45;white-space:pre-wrap;word-break:break-word}',
    '.tsw-msg.bot{background:#eef3fb;border:1px solid #dbe7fa;align-self:flex-start;border-bottom-left-radius:5px}',
    '.tsw-msg.me{background:#0B63CE;color:#fff;align-self:flex-end;border-bottom-right-radius:5px}',
    '.tsw-book{background:#fff7e8;border:1.5px solid #f3d391}',
    '.tsw-book button,.tsw-tools button{background:#E8322E;color:#fff;border:none;border-radius:99px;padding:9px 15px;font:800 13.5px Inter,system-ui,sans-serif;cursor:pointer;margin:6px 6px 0 0}',
    '.tsw-tools button{background:#0A265C}',
    '.tsw-quick{display:flex;gap:7px;flex-wrap:wrap;padding:10px 14px 0;flex:none}',
    '.tsw-quick button{background:#eef3fb;border:1.5px solid #dbe4f0;border-radius:999px;padding:6px 11px;font:600 12.5px Inter,system-ui,sans-serif;cursor:pointer}',
    '.tsw-input{display:flex;gap:7px;padding:11px;border-top:1px solid #e3eaf3;align-items:stretch;flex:none}',
    '.tsw-input input[type=text]{flex:1;border:1.5px solid #dbe4f0;border-radius:12px;padding:11px 12px;font:400 14.5px Inter,system-ui,sans-serif;min-width:0}',
    '.tsw-input .ic{background:#eef3fb;border:1.5px solid #dbe4f0;border-radius:12px;padding:0 11px;font-size:16px;cursor:pointer}',
    '.tsw-input .ic.rec{background:#fdecec;animation:tswBlink 1s infinite}',
    '@keyframes tswBlink{50%{opacity:.55}}',
    '.tsw-input .send{background:#1280FF;color:#fff;border:none;border-radius:12px;padding:0 16px;font:800 14.5px Inter,system-ui,sans-serif;cursor:pointer}',
    '.tsw-fine{padding:0 14px 11px;margin:0;font-size:11.3px;color:#5a6b87;flex:none}',
    '@media(max-width:640px){.tsw-panel{left:0;right:0;bottom:0;width:auto;height:min(620px,calc(100vh - 40px));height:min(620px,calc(100dvh - 40px));max-height:calc(100vh - 40px);max-height:calc(100dvh - 40px);border-radius:24px 24px 0 0;padding-bottom:env(safe-area-inset-bottom,0px)}.tsw-grab{display:block;width:44px;height:5px;border-radius:99px;background:#c9d6ea;margin:8px auto 2px;flex:none}.tsw-btn{right:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px))}}',
    '@media(max-height:500px){.tsw-panel{bottom:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));height:calc(100vh - 20px);height:calc(100dvh - 20px);max-height:calc(100vh - 20px);max-height:calc(100dvh - 20px)}.tsw-recs{max-height:84px}.tsw-head{padding:9px 14px}.tsw-input{padding:8px 10px}}',
    '@media(max-width:640px) and (max-height:500px){.tsw-panel{left:0;right:0;bottom:0;height:auto;border-radius:24px 24px 0 0}}',
    '@media(prefers-reduced-motion:reduce){.tsw-panel,.tsw-btn{transition:none;animation:none}}'
  ].join('');
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  var btn = document.createElement('button');
  btn.className = 'tsw-btn';
  btn.type = 'button';
  btn.textContent = '💬 Ask Speedy';
  btn.setAttribute('aria-haspopup', 'dialog');

  var panel = document.createElement('div');
  panel.className = 'tsw-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Ask Speedy chat assistant');
  panel.innerHTML =
    '<div class="tsw-grab" aria-hidden="true"></div>' +
    '<div class="tsw-head"><span style="font-size:22px">🏎️</span><span><b>Speedy</b><small>Top Speed AI assistant • Live</small></span>' +
    '<button class="x" type="button" aria-label="Close chat">×</button></div>' +
    '<div class="tsw-quick">' +
    '<button type="button" data-q="How much is the diagnostic?">💲 Diagnostic cost</button>' +
    '<button type="button" data-q="My fridge is not cooling">🧊 Fridge help</button>' +
    '<button type="button" data-q="I want to book">📅 Book me</button></div>' +
    '<div class="tsw-recs" id="tswRecs"></div>' +
    '<div class="tsw-body" id="tswBody"></div>' +
    '<form class="tsw-input" id="tswForm">' +
    '<input type="file" id="tswFile" accept="image/*" style="display:none">' +
    '<button type="button" class="ic" id="tswPhoto" title="Send a photo — Speedy will take a first look" aria-label="Send a photo for diagnosis">📸</button>' +
    '<button type="button" class="ic" id="tswMic" title="Speak instead of typing" aria-label="Speak to Speedy">🎤</button>' +
    '<input type="text" id="tswText" placeholder="Ask about repairs, pricing, areas…" autocomplete="off" aria-label="Message Speedy">' +
    '<button type="submit" class="send">Send</button></form>' +
    '<p class="tsw-fine">Speedy books real jobs into Book OS. It never invents prices or certifies a repair is safe — a technician diagnoses on site.</p>';

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var body = panel.querySelector('#tswBody');
  var input = panel.querySelector('#tswText');
  var recsBox = panel.querySelector('#tswRecs');
  var history = [];
  var greeted = false;
  var pendingBook = null;
  var bookedRef = '';
  var bookedPhone = '';
  var typing = false;

  function esc(t) {
    return String(t == null ? '' : t).replace(/</g, '&lt;');
  }
  function addMsg(text, me) {
    var d = document.createElement('div');
    d.className = 'tsw-msg ' + (me ? 'me' : 'bot');
    d.innerHTML = text;
    body.appendChild(d);
    body.scrollTop = body.scrollHeight;
    return d;
  }
  function tok() {
    try { return localStorage.getItem('tsos_token') || ''; } catch (e) { return ''; }
  }
  function post(path, payload, auth) {
    var h = { 'Content-Type': 'application/json' };
    if (auth && tok()) h.Authorization = 'Bearer ' + tok();
    return fetch(API + path, { method: 'POST', headers: h, body: JSON.stringify(payload) }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Request failed');
        return j;
      });
    });
  }
  function get(path) {
    return fetch(API + path, { headers: { Authorization: 'Bearer ' + tok() } }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Request failed');
        return j;
      });
    });
  }

  var GUEST_UPDATES = [
    { t: '$25 off your first eligible repair', d: 'For new registered customers — published offer.', href: '/offers-rewards', c: 'See terms' }
  ];
  var GUEST_RECS = [
    { t: '$99 diagnostic, credited toward your repair', d: 'The residential diagnostic is collected at booking and credited in full toward the repair.' },
    { t: 'Track My Tech', d: 'Every booked job gets live 8-stage tracking.', href: '/track', c: 'Track a job' },
    { t: 'Care tip', d: 'Clean the dryer vent and fridge coils twice a year — the two cheapest breakdowns to prevent.' }
  ];

  function renderRecs(updates, recs) {
    var h = '';
    if (updates.length) {
      h += '<h5>🔔 Updates</h5>' + updates.map(function (u) {
        return '<p class="r"><b>' + esc(u.t) + '</b> — ' + esc(u.d) + (u.href ? ' <a href="' + u.href + '">' + esc(u.c || 'Open') + ' →</a>' : '') + '</p>';
      }).join('');
    }
    if (recs.length) {
      h += '<h5>✦ Speedy recommends</h5>' + recs.map(function (u) {
        return '<p class="r"><b>' + esc(u.t) + '</b> — ' + esc(u.d) + (u.href ? ' <a href="' + u.href + '">' + esc(u.c || 'Open') + ' →</a>' : '') + '</p>';
      }).join('');
    }
    if (h) { recsBox.innerHTML = h; recsBox.style.display = 'block'; }
  }

  function loadRecs() {
    if (!tok()) { renderRecs(GUEST_UPDATES, GUEST_RECS); return; }
    var updates = [];
    var recs = [];
    var jobs = get('/tracking/mine').catch(function () { return null; });
    var promos = get('/connect/promotions').catch(function () { return null; });
    var summary = get('/connect/summary').catch(function () { return null; });
    Promise.all([jobs, promos, summary]).then(function (rs) {
      try {
        var tj = rs[0] && (rs[0].data || rs[0]);
        var list = (tj && (tj.jobs || tj.tracking || tj.items)) || [];
        list.slice(0, 2).forEach(function (j) {
          var label = j.stageLabel8 || j.stageLabel || j.status || 'In progress';
          updates.push({ t: (j.appliance || 'Your job') + ' — ' + label, d: 'Live status from Track My Tech.', href: '/track', c: 'Open tracking' });
        });
      } catch (e) {}
      try {
        var pr = rs[1] && (rs[1].data || rs[1]);
        var offers = (pr && (pr.promotions || pr.offers)) || [];
        offers.slice(0, 2).forEach(function (o) {
          recs.push({ t: o.title || o.name || 'Current offer', d: o.description || o.terms || 'Published offer for your account.', href: '/offers-rewards', c: 'See terms' });
        });
        if (pr && pr.referralCode) updates.push({ t: 'Your referral code is live', d: 'Share it from your account — ' + pr.referralCode, href: '/garage', c: 'My Appliances' });
      } catch (e) {}
      try {
        var sm = rs[2] && (rs[2].data || rs[2]);
        var apps = (sm && (sm.appliances || sm.registered)) || [];
        var now = Date.now();
        apps.forEach(function (a) {
          var last = a.lastServiceAt || a.lastServicedAt || a.updatedAt;
          if (last && now - new Date(last).getTime() > 365 * 24 * 3600 * 1000) {
            recs.push({ t: 'Maintenance check suggested', d: 'Your ' + (a.appliance || a.type || 'appliance') + ' has no service in over a year — a check-up can catch small issues early.' });
          }
        });
      } catch (e) {}
      if (!updates.length && !recs.length) { renderRecs(GUEST_UPDATES, GUEST_RECS); return; }
      renderRecs(updates, recs.slice(0, 3));
    });
  }

  function maybeBook() {
    if (bookedRef) return;
    var text = history.map(function (h) { return (h.role === 'user' ? 'Customer' : 'Speedy') + ': ' + h.content; }).join('\n');
    post('/speedy/extract-booking', { text: text }).then(function (j) {
      var d = j.data || {};
      if (d.ready && !pendingBook) {
        pendingBook = d;
        var rows = [['Name', d.name], ['Phone', d.phone], ['City', d.city], ['ZIP', d.zip], ['Appliance', d.appliance], ['Problem', d.issue], ['Window', d.preferred_window || 'First available']];
        var card = document.createElement('div');
        card.className = 'tsw-msg bot tsw-book';
        card.innerHTML = '<b>Ready to book — does this look right?</b><br>' + rows.map(function (r) {
          return r[0] + ': <b>' + esc(r[1]) + '</b>';
        }).join('<br>') + '<br><span style="font-size:12.5px">$99 diagnostic, collected at booking, credited toward your repair. A Service Setter confirms by text.</span><br><button type="button" id="tswBookBtn">✓ Book my visit</button>';
        body.appendChild(card);
        body.scrollTop = body.scrollHeight;
        card.querySelector('#tswBookBtn').addEventListener('click', bookIt);
      }
    }).catch(function () {});
  }

  function bookIt() {
    var d = pendingBook;
    if (!d) return;
    pendingBook = null;
    addMsg('Booking your visit…', false);
    var bookPayload = {
      customer: { name: d.name, phone: d.phone },
      city: d.city, zip: d.zip, appliance: d.appliance, issue: d.issue,
      preferredWindow: d.preferred_window || undefined, source: 'SPEEDY_CHAT'
    };
    try { var refCode = sessionStorage.getItem('tsos_referral_code'); if (refCode) bookPayload.referralCode = refCode; } catch (e) {}
    post('/speedy/book', bookPayload).then(function (j) {
      bookedRef = j.data.referenceCode;
      bookedPhone = d.phone;
      var card = document.createElement('div');
      card.className = 'tsw-msg bot tsw-book';
      card.innerHTML = '✅ <b>Booked!</b> Your reference is <b>' + esc(bookedRef) + '</b>. A Service Setter will text ' + esc(d.phone) + ' to confirm your window.' +
        '<div class="tsw-tools"><button type="button" data-r="email">📧 Email me my receipt</button><button type="button" data-r="sms">💬 Text me my tracking link</button></div>';
      body.appendChild(card);
      body.scrollTop = body.scrollHeight;
      card.querySelector('[data-r="email"]').addEventListener('click', function () { sendReceipt('email'); });
      card.querySelector('[data-r="sms"]').addEventListener('click', function () { sendReceipt('sms'); });
    }).catch(function (e) {
      addMsg('That booking did not go through (' + esc(e.message) + '). You can use the booking form on this site, or call 954-931-7997.', false);
    });
  }

  function sendReceipt(channel) {
    if (!bookedRef || !bookedPhone) return;
    post('/speedy/send-receipt', { reference: bookedRef, phone: bookedPhone, channel: channel }).then(function (j) {
      addMsg('🧾 ' + esc((j.data && j.data.message) || 'Done.'), false);
    }).catch(function (e) {
      addMsg('🧾 That did not go through: ' + esc(e.message) + '. Call 954-931-7997 and we will send it by phone.', false);
    });
  }

  function send(raw) {
    var text = String(raw || '').trim();
    if (!text || typing) return;
    input.value = '';
    addMsg(esc(text), true);
    history.push({ role: 'user', content: text });
    typing = true;
    var t = addMsg('Speedy is typing…', false);
    post('/speedy/chat', { message: text, history: history.slice(-10) }).then(function (j) {
      var reply = (j.data && j.data.reply) || '';
      t.remove();
      typing = false;
      if (!reply) throw new Error('empty');
      addMsg(esc(reply), false);
      history.push({ role: 'assistant', content: reply });
      maybeBook();
    }).catch(function () {
      t.remove();
      typing = false;
      addMsg('Speedy hit a connection snag just now. For the fastest help, call dispatch at 954-931-7997 — or try me again in a moment.', false);
    });
  }

  // Photo diagnosis (existing public endpoint; governance preserved)
  var file = panel.querySelector('#tswFile');
  panel.querySelector('#tswPhoto').addEventListener('click', function () { file.click(); });
  file.addEventListener('change', function () {
    var f = file.files && file.files[0];
    file.value = '';
    if (!f) return;
    addMsg('📸 Sent a photo of my appliance', true);
    var r = new FileReader();
    r.onload = function (ev) {
      var img = new Image();
      img.onload = function () {
        var mx = 1280;
        var sc = Math.min(1, mx / Math.max(img.naturalWidth, img.naturalHeight));
        var cv = document.createElement('canvas');
        cv.width = Math.round(img.naturalWidth * sc);
        cv.height = Math.round(img.naturalHeight * sc);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        post('/speedy/diagnose', { imageDataUrl: cv.toDataURL('image/jpeg', 0.82), note: 'Photo sent by a customer in the Speedy chat' }).then(function (j) {
          var rep = (j.data && (j.data.reply || j.data.summary || j.data.text)) || '';
          addMsg(rep
            ? '📸 Speedy\'s first look: ' + esc(rep) + ' A technician confirms the diagnosis on site — Speedy never certifies a repair is safe. Want me to book the $99 diagnostic visit?'
            : '📸 I received your photo but could not read it clearly — a technician will review it in person. Want me to book the $99 diagnostic visit?', false);
        }).catch(function () {
          addMsg('📸 Speedy could not read that photo just now — book the visit and the technician will diagnose on site, or call 954-931-7997.', false);
        });
      };
      img.src = ev.target.result;
    };
    r.readAsDataURL(f);
  });

  // Voice — same pattern as the flagship booking suite (wireVoice):
  // transcripts land in the composer and send through the same path.
  var mic = panel.querySelector('#tswMic');
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    mic.addEventListener('click', function () {
      addMsg('🎤 Voice isn\'t supported in this browser — type instead, and I\'ll book you the same way. (Voice works in Chrome on desktop and Android.)', false);
    });
  } else {
    var rec = null, listening = false;
    mic.addEventListener('click', function () {
      if (listening) { try { rec.stop(); } catch (e) {} return; }
      rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = function (e) {
        var t = e.results[0][0].transcript;
        input.value = (input.value ? input.value.replace(/\s+$/, '') + ' ' : '') + t;
        input.focus();
        send(input.value);
      };
      rec.onend = function () { listening = false; mic.textContent = '🎤'; mic.classList.remove('rec'); };
      rec.onerror = rec.onend;
      try { rec.start(); listening = true; mic.textContent = '🔴'; mic.classList.add('rec'); } catch (e) {}
    });
  }

  panel.querySelectorAll('.tsw-quick button').forEach(function (b) {
    b.addEventListener('click', function () { send(b.getAttribute('data-q')); });
  });
  panel.querySelector('#tswForm').addEventListener('submit', function (e) {
    e.preventDefault();
    send(input.value);
  });
  panel.querySelector('.x').addEventListener('click', function () { panel.classList.remove('open'); });

  function openPanel() {
    panel.classList.add('open');
    if (!greeted) {
      greeted = true;
      addMsg('Hey, I\'m Speedy 🏎️ — Top Speed\'s assistant. Ask me about the $99 diagnostic, your city, or a broken appliance — or say "book" and I\'ll walk you to an appointment. You can type, talk (🎤), or send a photo (📸).', false);
      loadRecs();
    }
    setTimeout(function () { input.focus(); }, 80);
  }
  window.TSOpenSpeedy = openPanel;
  window.addEventListener('ts-open-speedy', openPanel);
  btn.addEventListener('click', function () {
    if (panel.classList.contains('open')) panel.classList.remove('open');
    else openPanel();
  });
})();
