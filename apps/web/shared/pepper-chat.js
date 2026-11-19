/* Top Speed — Pepper Chat bar (staff consoles, 2026-11-18).
   Ramone's directive: "create a pepper chat bar for me and all
   workstations for new employees with account sign up."

   Speedy is the customer-facing chat; Pepper is the staff-facing
   Systems Manager. This bar rides the STAFF consoles only (never
   public/customer pages): signed-in staff ask Pepper about the
   platform, their work and onboarding at POST /api/v1/pepper/chat
   (staff-gated on the server), live status answers come from the
   real systems board, and a reported problem files a real
   NEEDS_OWNER report forwarded to Ramone Williams.

   Signed out there is NO chat — the bar shows the new-employee
   card instead: staff accounts are issued personally by Ramone
   (Master) through Work Time Access; there is no public staff
   self-signup by rule.

   Rendering discipline: every dynamic string (messages, account
   email, API replies) is rendered with textContent — never
   innerHTML — so nothing a user or the API returns can inject
   markup. Icons are static inline SVG in this file's own chrome. */
(function () {
  if (window.__pepperChatLoaded) return;
  window.__pepperChatLoaded = true;
  if (document.getElementById('pepperChatBar') || document.getElementById('pepperChatPanel')) return;

  var API = 'https://top-speed-service-os.vercel.app/api/v1';

  function token() {
    try {
      if (window.TSOSVault && typeof window.TSOSVault.token === 'function') {
        var vt = window.TSOSVault.token();
        if (vt) return vt;
      }
    } catch (e) {}
    try { return localStorage.getItem('tsos_token') || localStorage.getItem('tsos_tech_token') || ''; } catch (e) { return ''; }
  }

  var css = [
    '.pcb-bar{position:fixed;right:16px;bottom:18px;bottom:calc(18px + env(safe-area-inset-bottom,0px));z-index:9995;display:flex;align-items:center;gap:8px;background:#0C162B;color:#fff;border:1.5px solid #E94E5C;border-radius:999px;padding:9px 14px 9px 11px;font:700 13.5px Inter,system-ui,sans-serif;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;box-shadow:0 10px 30px rgba(6,15,35,.5);transition:opacity .18s ease,visibility .18s ease}',
    '.pcb-bar svg{width:20px;height:20px;display:block}',
    '.pcb-bar.pcb-dragging{cursor:grabbing;transition:none;opacity:.92}',
    '.pcb-bar small{display:block;font:600 10.5px Inter,system-ui,sans-serif;color:#B9C6DE;letter-spacing:.02em}',
    'body:has(.pcb-panel.open) .pcb-bar{opacity:0;visibility:hidden;pointer-events:none}',
    '.pcb-panel{position:fixed;right:18px;bottom:76px;bottom:calc(76px + env(safe-area-inset-bottom,0px));z-index:9996;width:min(400px,calc(100vw - 24px));max-height:min(78vh,720px);max-height:min(720px,calc(100dvh - 108px));display:flex;flex-direction:column;background:#fff;border-radius:20px;box-shadow:0 24px 60px rgba(6,15,35,.5);overflow:hidden;font-family:Inter,system-ui,sans-serif;color:#0C162B;visibility:hidden;opacity:0;transform:translateY(14px) scale(.98);pointer-events:none;transition:opacity .18s ease,transform .18s ease,visibility 0s linear .18s}',
    '.pcb-panel.open{visibility:visible;opacity:1;transform:none;pointer-events:auto;transition:opacity .18s ease,transform .18s ease}',
    '.pcb-head{display:flex;align-items:center;gap:10px;background:#0C162B;color:#fff;padding:13px 16px;flex:none}',
    '.pcb-head svg{width:24px;height:24px;display:block}',
    '.pcb-head b{font-size:15.5px;letter-spacing:.01em}.pcb-head small{display:block;color:#B9C6DE;font-size:11.5px;font-weight:600}',
    '.pcb-head .x{margin-left:auto;background:none;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1}',
    '.pcb-body{padding:14px;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;display:flex;flex-direction:column;gap:9px;flex:1 1 auto;min-height:0}',
    '.pcb-msg{max-width:88%;padding:10px 13px;border-radius:15px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-break:break-word}',
    '.pcb-msg.bot{background:#EEF2F9;border:1px solid #D8E1F0;align-self:flex-start;border-bottom-left-radius:5px}',
    '.pcb-msg.me{background:#0C162B;color:#fff;align-self:flex-end;border-bottom-right-radius:5px}',
    '.pcb-card{background:#FFF8EC;border:1.5px solid #F0D9A8;border-radius:15px;padding:13px 14px;font-size:13.8px;line-height:1.5;align-self:stretch}',
    '.pcb-card h4{margin:0 0 7px;font-size:14.5px}',
    '.pcb-card ol{margin:0;padding-left:19px;display:flex;flex-direction:column;gap:6px}',
    '.pcb-card .signin{margin-top:11px;background:#E94E5C;color:#fff;border:none;border-radius:99px;padding:9px 16px;font:800 13.5px Inter,system-ui,sans-serif;cursor:pointer}',
    '.pcb-quick{display:flex;gap:7px;flex-wrap:wrap;padding:10px 14px 0;flex:none}',
    '.pcb-quick button{background:#EEF2F9;border:1.5px solid #D8E1F0;border-radius:999px;padding:6px 11px;font:600 12.5px Inter,system-ui,sans-serif;cursor:pointer;color:#0C162B}',
    '.pcb-input{display:flex;gap:7px;padding:11px;border-top:1px solid #E3EAF3;align-items:stretch;flex:none}',
    '.pcb-input input[type=text]{flex:1;border:1.5px solid #D8E1F0;border-radius:12px;padding:11px 12px;font:400 14.5px Inter,system-ui,sans-serif;min-width:0}',
    '.pcb-input .send{background:#E94E5C;color:#fff;border:none;border-radius:12px;padding:0 15px;font:800 14px Inter,system-ui,sans-serif;cursor:pointer;display:flex;align-items:center}',
    '.pcb-input .send svg{width:18px;height:18px;display:block}',
    '.pcb-fine{padding:0 14px 11px;margin:0;font-size:11.3px;color:#5A6B87;flex:none}',
    '@media(max-width:640px){.pcb-panel{left:0;right:0;bottom:0;width:auto;height:min(620px,calc(100vh - 40px));height:min(620px,calc(100dvh - 40px));max-height:calc(100vh - 40px);max-height:calc(100dvh - 40px);border-radius:24px 24px 0 0;padding-bottom:env(safe-area-inset-bottom,0px)}.pcb-bar{right:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px))}}',
    '@media(prefers-reduced-motion:reduce){.pcb-panel,.pcb-bar{transition:none}}'
  ].join('');
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);
  if (!document.querySelector('link[href="/fonts.css"]')) {
    var fl = document.createElement('link');
    fl.rel = 'stylesheet';
    fl.href = '/fonts.css';
    document.head.appendChild(fl);
  }

  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A1.8 1.8 0 0 1 5.8 3.7h12.4A1.8 1.8 0 0 1 20 5.5v8.3a1.8 1.8 0 0 1-1.8 1.8H13l-4.6 3.9v-3.9H5.8A1.8 1.8 0 0 1 4 13.8z"/><path d="M7.6 9.3h.01M12 9.3h.01M16.4 9.3h.01" stroke-width="2.6" stroke="#E94E5C"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12h14M13 5.5 19.5 12 13 18.5"/></svg>';

  var bar = document.createElement('button');
  bar.className = 'pcb-bar';
  bar.id = 'pepperChatBar';
  bar.type = 'button';
  bar.setAttribute('aria-haspopup', 'dialog');
  bar.innerHTML = ICON_CHAT + '<span>Ask Pepper<small>Systems Manager — staff</small></span>';

  var panel = document.createElement('div');
  panel.className = 'pcb-panel';
  panel.id = 'pepperChatPanel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Ask Pepper — Systems Manager chat');
  panel.innerHTML =
    '<div class="pcb-head">' + ICON_CHAT + '<span><b>Pepper</b><small>System Operations Manager · reports to Ramone Williams</small></span>' +
    '<button class="x" type="button" aria-label="Close chat">×</button></div>' +
    '<div class="pcb-body"></div>' +
    '<div class="pcb-quick" style="display:none">' +
    '<button type="button" data-q="What is the system status?">System status</button>' +
    '<button type="button" data-q="How do accounts work here for a new employee?">New-employee accounts</button>' +
    '<button type="button" data-q="What are the pricing rules?">Pricing rules</button>' +
    '<button type="button" data-q="__report__">Report a problem</button>' +
    '</div>' +
    '<div class="pcb-input" style="display:none"><input type="text" placeholder="Ask Pepper about the platform or your work" aria-label="Message Pepper" maxlength="2000"><button class="send" type="button" aria-label="Send message">' + ICON_SEND + '</button></div>' +
    '<p class="pcb-fine">Staff only. Problems reported here are filed to Ramone Williams.</p>';

  document.body.appendChild(bar);
  document.body.appendChild(panel);

  /* Movable launcher (Ramone, 2026-11-19, from his Tech App photo:
     the assistant bubble covered the bottom tab bar). Press-and-drag
     moves the pill anywhere on screen; a tap without real movement
     still opens the chat. Default dock sits CLEAR of any fixed
     bottom navigation (e.g. the Tech App's tab bar); a dragged
     position is remembered for the session. */
  var pcbSuppressClick = false;
  var pcbDrag = { active: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 };
  function pcbClamp(x, y) {
    var w = bar.offsetWidth || 150, h = bar.offsetHeight || 46;
    return {
      x: Math.min(Math.max(4, x), Math.max(4, window.innerWidth - w - 4)),
      y: Math.min(Math.max(4, y), Math.max(4, window.innerHeight - h - 4)),
    };
  }
  function pcbPlace(x, y) {
    var c = pcbClamp(x, y);
    bar.style.left = c.x + 'px';
    bar.style.top = c.y + 'px';
    bar.style.right = 'auto';
    bar.style.bottom = 'auto';
  }
  function pcbBottomNavHeight() {
    var nav = document.querySelector('nav.tabs, .tabbar, [data-bottom-nav]');
    if (!nav) return 0;
    var r = nav.getBoundingClientRect();
    return r.height > 0 && r.bottom >= window.innerHeight - 2 ? r.height : 0;
  }
  function pcbDefaultDock() {
    var navH = pcbBottomNavHeight();
    var w = bar.offsetWidth || 150, h = bar.offsetHeight || 46;
    pcbPlace(window.innerWidth - w - 16, window.innerHeight - h - navH - 14);
    if (navH) panel.style.bottom = navH + 66 + 'px';
  }
  function pcbRestore() {
    try {
      var raw = sessionStorage.getItem('pcb_pos');
      if (raw) {
        var pos = JSON.parse(raw);
        if (pos && isFinite(pos.x) && isFinite(pos.y)) { pcbPlace(pos.x, pos.y); return; }
      }
    } catch (e) {}
    pcbDefaultDock();
  }
  bar.addEventListener('pointerdown', function (ev) {
    pcbDrag.active = true;
    pcbDrag.moved = false;
    pcbDrag.sx = ev.clientX;
    pcbDrag.sy = ev.clientY;
    var r = bar.getBoundingClientRect();
    pcbDrag.ox = r.left;
    pcbDrag.oy = r.top;
    try { bar.setPointerCapture(ev.pointerId); } catch (e) {}
  });
  bar.addEventListener('pointermove', function (ev) {
    if (!pcbDrag.active) return;
    var dx = ev.clientX - pcbDrag.sx, dy = ev.clientY - pcbDrag.sy;
    if (!pcbDrag.moved && Math.sqrt(dx * dx + dy * dy) < 7) return;
    if (!pcbDrag.moved) { pcbDrag.moved = true; bar.classList.add('pcb-dragging'); pcbPlace(pcbDrag.ox, pcbDrag.oy); }
    pcbPlace(pcbDrag.ox + dx, pcbDrag.oy + dy);
    if (ev.cancelable) ev.preventDefault();
  });
  function pcbEndDrag() {
    if (!pcbDrag.active) return;
    pcbDrag.active = false;
    bar.classList.remove('pcb-dragging');
    if (pcbDrag.moved) {
      var r = bar.getBoundingClientRect();
      try { sessionStorage.setItem('pcb_pos', JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) })); } catch (e) {}
      pcbSuppressClick = true;
      setTimeout(function () { pcbSuppressClick = false; }, 80);
    }
  }
  bar.addEventListener('pointerup', pcbEndDrag);
  bar.addEventListener('pointercancel', pcbEndDrag);
  pcbRestore();
  window.addEventListener('resize', function () {
    var r = bar.getBoundingClientRect();
    if (r.width) pcbPlace(r.left, r.top);
  });

  var body = panel.querySelector('.pcb-body');
  var quick = panel.querySelector('.pcb-quick');
  var inputRow = panel.querySelector('.pcb-input');
  var input = panel.querySelector('.pcb-input input');
  var history = [];
  var greeted = false;
  var mode = null; // 'chat' | 'guest'

  function addLine(text, me, cls) {
    var div = document.createElement('div');
    div.className = 'pcb-msg ' + (me ? 'me' : 'bot') + (cls ? ' ' + cls : '');
    div.textContent = String(text == null ? '' : text);
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    return div;
  }

  function showGuestCard(note) {
    mode = 'guest';
    quick.style.display = 'none';
    inputRow.style.display = 'none';
    body.innerHTML = '';
    if (note) addLine(note, false);
    var card = document.createElement('div');
    card.className = 'pcb-card pepper-chat-onboarding';
    var h = document.createElement('h4');
    h.textContent = 'New employee? Start here.';
    card.appendChild(h);
    var intro = document.createElement('p');
    intro.style.margin = '0 0 8px';
    intro.textContent = 'This chat is for signed-in staff. Staff accounts are not self-serve — here is how yours works:';
    card.appendChild(intro);
    var steps = [
      'Your account is issued personally by Ramone Williams (the Master) through Work Time Access. You get your sign-in from him directly — there is no public sign-up for staff accounts.',
      'Employee accounts also carry an employee number (TS-1001, TS-1002, …).',
      'First sign-in may ask for two extra steps, both normal: a Speedy Verify access code (8 digits, issued by Ramone) and the Layer 2 step — a 6-digit code sent to your email.',
      'Once you are in, the Training Academy intro modules walk you through the platform and your post.',
      'Problems at any step go to Ramone Williams — he is the one who issues and fixes accounts.'
    ];
    var ol = document.createElement('ol');
    steps.forEach(function (s) {
      var li = document.createElement('li');
      li.textContent = s;
      ol.appendChild(li);
    });
    card.appendChild(ol);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'signin';
    btn.textContent = 'Sign in';
    btn.addEventListener('click', goSignIn);
    card.appendChild(btn);
    body.appendChild(card);
  }

  function goSignIn() {
    // Prefer this console's own sign-in form (most staff consoles
    // gate inline on the same page); fall back to the shared
    // sign-in page when this page has none.
    var pw = document.querySelector('input[type="password"]');
    if (pw) {
      var form = pw.closest('form') || pw;
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      var email = document.querySelector('input[type="email"], input[name="email"]');
      setTimeout(function () { (email || pw).focus(); }, 350);
      panel.classList.remove('open');
      return;
    }
    window.location.assign('/login');
  }

  function showChat() {
    mode = 'chat';
    quick.style.display = 'flex';
    inputRow.style.display = 'flex';
    if (!greeted) {
      greeted = true;
      addLine('On duty. Ask me about the platform, the work rules, where a console lives, or how accounts work — or say "system status" for the live board. If something is a problem, report it here and I will file it for Ramone.', false);
    }
    setTimeout(function () { input.focus(); }, 60);
  }

  function refreshMode(note) {
    if (token()) {
      if (mode !== 'chat') { body.innerHTML = ''; greeted = false; showChat(); }
    } else {
      showGuestCard(note || null);
    }
  }

  function send(text) {
    var message = String(text || '').trim();
    if (!message) return;
    addLine(message, true);
    history.push({ role: 'user', content: message });
    input.value = '';
    var pending = addLine('…', false);
    fetch(API + '/pepper/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
      body: JSON.stringify({ message: message, history: history.slice(-10), surface: window.location.pathname }),
    }).then(function (res) {
      if (res.status === 401) {
        pending.remove();
        showGuestCard('Your session has ended — sign in again to keep chatting.');
        return null;
      }
      if (res.status === 403) {
        pending.textContent = 'This chat is for staff accounts (Service Setters, managers, the Master). This sign-in does not carry a staff role — if that is wrong, it goes to Ramone Williams.';
        return null;
      }
      return res.json().catch(function () { return null; });
    }).then(function (json) {
      if (!json) return;
      var reply = (json.data && json.data.reply) || 'No reply came back — try again, and if it keeps happening, file it in the Pepper console report log (/pepper).';
      pending.textContent = reply;
      history.push({ role: 'assistant', content: reply });
      if (history.length > 20) history = history.slice(-20);
      body.scrollTop = body.scrollHeight;
    }).catch(function () {
      pending.textContent = 'That message never reached the server — check your connection and try again. Nothing was sent or filed.';
    });
  }

  bar.addEventListener('click', function () {
    if (pcbSuppressClick) return;
    panel.classList.add('open');
    refreshMode(null);
  });
  panel.querySelector('.x').addEventListener('click', function () { panel.classList.remove('open'); });
  panel.querySelector('.send').addEventListener('click', function () { send(input.value); });
  input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') send(input.value); });
  quick.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-q]');
    if (!b) return;
    var q = b.getAttribute('data-q');
    if (q === '__report__') {
      input.value = 'Report a problem: ';
      input.focus();
      return;
    }
    send(q);
  });
})();
