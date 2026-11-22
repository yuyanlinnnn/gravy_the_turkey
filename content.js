/* The "pet": lives on every page (shadow DOM so the site can't style/break it).
   - draws the virtual cursor, the pet, the camera preview and the settings panel (all constant physical size)
   - turns engine messages (cursor / click / scroll / undo / redo) into real DOM actions
   - listens for speech and sends text through an ADAPTER, so each kind of editor can be supported separately
   - on TRUSTED_HOSTS (Google Docs) it types / clicks / scrolls with real browser input via the background worker */
(() => {
  if (window.top !== window) return;                       // top frame only
  // A copy left behind by an older load of the extension (it can no longer talk to Chrome) is retired; this copy replaces it.
  const stale = document.getElementById('handsfree-pet-host');
  if (stale) { stale.remove(); document.dispatchEvent(new CustomEvent('hf-replace')); }

  const IS_MAC = /Mac/i.test(navigator.platform);
  const TRUSTED_HOSTS = ['docs.google.com'];               // ← sites that ignore script-made events: use real input there
  const trusted = () => TRUSTED_HOSTS.includes(location.hostname);

  /* ------------------------------------------------------------------ pet UI */
  const host = document.createElement('div');
  host.id = 'handsfree-pet-host';
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
  <style>
    .z{zoom:var(--inv,1)}                                  /* cancels browser page-zoom so these never grow/shrink */
    #cursor{position:fixed;left:0;top:0;width:44px;height:44px;pointer-events:none;will-change:transform;transition:opacity .2s;z-index:100}
    #cursor .ring{position:absolute;inset:0;border:3px solid #fde68a;border-radius:50%;background:rgba(253,230,138,.15);box-sizing:border-box}
    #cursor .dot{position:absolute;left:18px;top:18px;width:8px;height:8px;border-radius:50%;background:#fde68a}
    #cursor.lost{opacity:.2}
    #cursor.pinch .ring{border-color:#f87171;background:rgba(248,113,113,.3)}
    .ripple{position:fixed;width:20px;height:20px;margin:-10px 0 0 -10px;border:3px solid #f87171;border-radius:50%;pointer-events:none;animation:rip .5s ease-out forwards;z-index:100}
    @keyframes rip{to{transform:scale(4);opacity:0}}
    #pet{position:fixed;right:24px;bottom:24px;pointer-events:auto;user-select:none;font-family:system-ui,sans-serif;
         display:flex;flex-direction:column;align-items:center;gap:6px;cursor:grab;width:120px}
    #body{font-size:54px;line-height:1;filter:drop-shadow(0 4px 6px rgba(0,0,0,.35));animation:bob 2.4s ease-in-out infinite}
    #pet.listening #body{animation-duration:1s}
    #pet.sleep #body{animation:none;filter:grayscale(1) opacity(.6)}
    #pet.lost #body{animation:none;transform:rotate(-12deg)}
    #pet.pinch #body{animation:none;transform:scale(1.25)}
    #body{scale:var(--face,1) 1}                           /* the emoji faces left; --face:-1 turns it to face right */
    #pet.walking #body{animation:step .38s ease-in-out infinite}
    @keyframes bob{50%{transform:translateY(-6px)}}
    @keyframes step{0%,100%{transform:translateY(0) rotate(-7deg)}50%{transform:translateY(-8px) rotate(7deg)}}
    #bubble{position:absolute;bottom:100%;right:0;margin-bottom:6px;width:max-content;max-width:280px;background:#111827;color:#f9fafb;padding:6px 12px;border-radius:12px;font-size:14px;line-height:1.35;
            opacity:0;transition:opacity .2s;text-align:center;white-space:pre-line;pointer-events:none}
    #bubble.show{opacity:1}
    #timer{font-size:14px;font-weight:700;color:#111827;background:#fde68a;border:2px solid #f59e0b;border-radius:10px;padding:2px 10px;white-space:nowrap;box-shadow:0 3px 8px rgba(0,0,0,.35);margin-bottom:-2px}
    #timer[hidden]{display:none}
    #timer.warn{background:#fdba74;border-color:#ea580c}
    #timer.hot{background:#f87171;border-color:#b91c1c;color:#fff;animation:pulse .8s ease-in-out infinite}
    @keyframes pulse{50%{transform:scale(1.12)}}
    #badge{font-size:12px;color:#fff;background:#374151;border-radius:999px;padding:2px 10px;white-space:nowrap}
    #cam{position:fixed;left:24px;bottom:24px;width:224px;pointer-events:auto;background:#000;border:2px solid #4b5563;border-radius:10px;overflow:hidden;font-family:system-ui,sans-serif}
    #cam .view{position:relative;width:224px;height:168px;background:#111827}
    #cam img,#cam canvas{position:absolute;inset:0;width:224px;height:168px}
    #cam img{transform:scaleX(-1)}
    #pose{color:#fde68a;font-size:13px;text-align:center;padding:3px 0;background:#111827;min-height:20px}
    #panel{position:fixed;right:24px;bottom:160px;width:290px;max-height:70vh;overflow:auto;pointer-events:auto;background:#111827;color:#f9fafb;
           border:1px solid #4b5563;border-radius:14px;padding:12px 14px;font:14px/1.45 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.45)}
    #panel[hidden],#cam[hidden]{display:none}
    #panel h4{margin:10px 0 4px;font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:#fde68a}
    #panel .row{display:flex;flex-wrap:wrap;gap:6px}
    #panel button{font:inherit;font-size:15px;min-height:44px;min-width:80px;flex:1;border-radius:10px;border:2px solid #4b5563;background:#374151;color:#fff;cursor:pointer}
    #panel button:hover{border-color:#fde68a}
    #panel .st div{display:flex;justify-content:space-between}
    #panel summary{cursor:pointer;min-height:36px;padding:8px 0;color:#fde68a;font-weight:600}
    #panel .how{color:#cbd5e1;font-size:13px}
    #files{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) scale(var(--inv,1));width:520px;max-width:92vw;max-height:84vh;overflow:auto;pointer-events:auto;z-index:50;
           background:#111827;color:#f9fafb;border:2px solid #fde68a;border-radius:16px;padding:14px 16px;font:16px/1.4 system-ui,sans-serif;box-shadow:0 12px 50px rgba(0,0,0,.6)}
    #files[hidden]{display:none}
    #files .hint{color:#cbd5e1;font-size:14px;margin:4px 0 10px}
    #files .fbtn{display:flex;align-items:center;gap:10px;width:100%;min-height:52px;margin:0 0 6px;padding:6px 12px;text-align:left;font:inherit;font-size:16px;border-radius:10px;border:2px solid #4b5563;background:#374151;color:#fff;cursor:pointer}
    #files .fbtn:hover{border-color:#fde68a}
    #files .fbtn b{min-width:28px;color:#fde68a}
    #files .fbtn small{color:#9ca3af;margin-left:auto;font-size:12px}
    #files .row{display:flex;gap:8px;margin-top:8px}
    #files .row button{flex:1;min-height:48px;font:inherit;font-size:15px;border-radius:10px;border:2px solid #4b5563;background:#1f2937;color:#fff;cursor:pointer}
  </style>
  <div id="panel" class="z" hidden>
    <b>🦃 HandsFree</b> <span style="float:right;opacity:.6;font-size:12px">click the turkey to hide</span>
    <h4>Status</h4><div class="st" id="st"></div>
    <h4>Cursor speed: <span id="spd">×1.0</span></h4>
    <div class="row"><button data-act="slower">− Slower</button><button data-act="faster">+ Faster</button><button data-act="recenter">⌖ Recenter</button></div>
    <h4>Page</h4>
    <div class="row"><button data-act="zoomOut">Zoom −</button><button data-act="zoomIn">Zoom +</button><button data-act="undo">↶ Undo</button><button data-act="redo">↷ Redo</button></div>
    <div class="row" style="margin-top:6px"><button data-act="camera" id="camBtn">📷 Camera</button><button data-act="sleep" id="sleepBtn">⌨ Typing</button><button data-act="close">Close</button></div>
    <div class="row" style="margin-top:6px"><button data-act="fast" id="fastBtn">⚡ Fast typing</button><button data-act="walk" id="walkBtn">🚶 Walking</button></div>
    <details id="how"><summary>❓ How to use</summary>
    <div class="how">
      <b>Head</b> moves the cursor (say “recenter” if it drifts).<br>
      <b>Pinch</b> thumb + index = click.<br>
      <b>One finger up / down</b> = scroll up / down.<br>
      <b>Two open hands apart</b> = zoom in; <b>together</b> = zoom out; <b>two fists</b> = keep the size.<br>
      <b>Open-hand swipe</b> ← undo, → redo.<br>
      While typing is on, say “period”, “comma”, “question mark”, “new line”, “new paragraph” for punctuation.<br>
      <b>Typing:</b> say <b>“gravy, start typing”</b> — then everything you say is typed. Say <b>“gravy, stop typing”</b> to stop (speech is ignored while it’s off).<br>
      <b>Commands:</b> always start with <b>“gravy, …”</b> (they work whether typing is on or off).<br>
      undo · redo · delete (last word) · delete that (what I just typed) · select all · bold · italic · underline · copy all · paste ·
      zoom in / out · scroll down / up · click · enter · go back · recenter · cursor faster / slower ·
      reload · help. Add a number to repeat: “gravy, undo three times”.<br>
      <b>Tabs</b> (Chrome’s tab bar can’t be reached by a cursor, so use your voice): “gravy, new tab” · “next tab” · “previous tab” · “tab 2” · “close tab” · “search for pumpkin pie” · “open docs dot google dot com” (new tabs open next to this one).<br>
      <b>Google Docs:</b> Chrome shows a “started debugging this browser” bar — leave it, don’t press Cancel.
    </div></details>
  </div>
  <div id="files" hidden><b>📎 Choose a file to attach</b>
    <div class="hint">Pinch a file, or say <b>“gravy, file 2”</b> · <b>“gravy, upload essay”</b> (part of the name) · <b>“gravy, cancel”</b></div>
    <div id="flist"></div>
    <div class="row"><button data-f="native">Normal file window</button><button data-f="cancel">Cancel</button></div></div>
  <div id="cam" class="z"><div class="view"><img id="camimg" alt=""><canvas id="camov" width="224" height="168"></canvas></div><div id="pose">camera starting…</div></div>
  <div id="pet" class="sleep z"><div id="bubble"></div><div id="timer" hidden></div><div id="body">🦃</div><div id="badge">starting…</div></div>
  <div id="cursor" class="lost"><div class="ring"></div><div class="dot"></div></div>`;
  document.documentElement.appendChild(host);
  const $ = s => root.querySelector(s);
  const cursorEl = $('#cursor'), pet = $('#pet'), bubble = $('#bubble'), badge = $('#badge'), panel = $('#panel'),
        cam = $('#cam'), camimg = $('#camimg'), camov = $('#camov'), camctx = camov.getContext('2d'), poseEl = $('#pose');

  let pageZoom = 1;                                        // browser zoom of this tab (from the background worker)
  const placeCursor = (px, py) => { cursorEl.style.transform = `translate(${px}px,${py}px) scale(${1 / pageZoom}) translate(-22px,-22px)`; };
  function applyZoom(f) { pageZoom = f || 1; host.style.setProperty('--inv', String(1 / pageZoom)); if (cursor) placeCursor(hfClamp(cursor.x * innerWidth, 0, innerWidth - 1), hfClamp(cursor.y * innerHeight, 0, innerHeight - 1)); }

  let bubbleTimer;
  function say(text, ms = 2600) {
    bubble.textContent = text; bubble.classList.add('show');
    clearTimeout(bubbleTimer); bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms);
  }

  // drag the pet around with a real mouse (position is remembered); a plain click toggles the panel
  let drag = null;
  pet.addEventListener('mousedown', e => { const r = pet.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false }; pet.style.cursor = 'grabbing'; e.preventDefault(); });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    drag.moved = true;
    pet.style.right = 'auto'; pet.style.bottom = 'auto';
    pet.style.left = hfClamp(e.clientX - drag.dx, 0, innerWidth - 60) + 'px';
    pet.style.top = hfClamp(e.clientY - drag.dy, 0, innerHeight - 60) + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return; const was = drag; drag = null; pet.style.cursor = 'grab'; walkX = null; walkTarget = null; walkWait = 4;
    if (!was.moved) { togglePanel(); return; }
    try { chrome.storage.local.set({ petPos: { left: pet.style.left, top: pet.style.top } }); } catch {}
  });
  try { chrome.storage.local.get('petPos', ({ petPos }) => { if (petPos) { pet.style.right = pet.style.bottom = 'auto'; pet.style.left = petPos.left; pet.style.top = petPos.top; } }); } catch {}

  /* ------------------------------------------------------------------ state */
  let deadline = 0, muteUntil = 0;
  function renderTimer() {
    const el = root.querySelector('#timer'); if (!el) return;
    if (!deadline || !enabled) { el.hidden = true; return; }
    const left = deadline - Date.now();
    if (left < -60000) { el.hidden = true; return; }                       // a minute after time's up: put the clock away
    el.hidden = false;
    if (left <= 0) { el.textContent = '⏰ TIME!'; el.className = 'hot'; return; }
    const m = Math.floor(left / 60000), sec = Math.floor(left / 1000) % 60;
    el.textContent = '⏱ ' + (m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
    el.className = left <= 3 * 60000 ? 'hot' : left <= 15 * 60000 ? 'warn' : '';
  }
  setInterval(renderTimer, 1000);
  let walkOn = true, isWalking = false, walkX = null, walkY = 0, walkTarget = null, walkWait = 2;
  let enabled = false, paused = true, camState = 'loading', headOk = true, handsN = 0, sens = 1, previewOn = true;
  let lastInsertLen = 0, armedUntil = 0, lastResult = '—', hintAt = 0;
  // paused = typing OFF (default). Commands and gestures still work. "gravy, start typing" turns it on.
  let cursor = { x: 0.5, y: 0.5, lost: true };
  placeCursor(innerWidth / 2, innerHeight / 2);            // start mid-screen, not top-left
  function refreshPet() {
    pet.className = 'z ' + (paused ? 'sleep' : !headOk && camState === 'ready' ? 'lost' : cursorEl.classList.contains('pinch') ? 'pinch' : ((rec || engineMic) ? 'listening' : '')) + (isWalking ? ' walking' : '');
    badge.textContent = paused ? '⌨ typing OFF' : camState === 'error' ? '⚠ camera' : camState === 'loading' ? 'loading…' : !headOk ? '🙈 can’t see you' : (rec || engineMic) ? '✍ typing ON' : '🦃 ready';
    renderPanel();
  }
  function send(msg) { try { chrome.runtime.sendMessage({ src: 'content', ...msg }); } catch {} }

  /* ------------------------------------------------------------------ settings panel */
  function togglePanel(show) { panel.hidden = show === undefined ? !panel.hidden : !show; renderPanel(); }
  function renderPanel() {
    if (panel.hidden) return;
    $('#spd').textContent = '×' + sens.toFixed(1);
    $('#camBtn').textContent = '📷 Camera: ' + (previewOn ? 'on' : 'off');
    $('#sleepBtn').textContent = '⌨ Typing: ' + (paused ? 'off' : 'on');
    $('#walkBtn').textContent = '🚶 Walking: ' + (walkOn ? 'on' : 'off');
    $('#fastBtn').textContent = '⚡ Fast typing: ' + (fastTyping ? 'on' : 'off');
    const rows = [
      ['Camera', camState === 'ready' ? '✅ on' : camState === 'error' ? '⚠ problem (see bubble)' : '⏳ loading…'],
      ['Head', camState !== 'ready' ? '–' : headOk ? '✅ tracking' : '🙈 not seen — face the camera'],
      ['Hands', camState === 'ready' ? String(handsN) : '–'],
      ['Voice', (rec || engineMic) ? '👂 listening' : useLocalSR ? '❌ off (allow mic for this site)' : '⏳ starting…'],
      ['Typing', paused ? '⌨ OFF — say “gravy, start typing”' : '✍ ON'],
      ['Last typed', lastResult],
    ];
    $('#st').innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><span>${v}</span></div>`).join('');
  }
  panel.addEventListener('mousedown', e => e.preventDefault());      // keep focus (and caret) in the page's text box
  panel.addEventListener('click', e => { const b = e.target.closest('button[data-act]'); if (b) panelAct(b.dataset.act); });
  function setPreview(on) {
    previewOn = on; cam.hidden = !on || !enabled; send({ type: 'preview', on }); renderPanel();
  }
  function panelAct(a) {
    const f = { slower: () => RUN.cursorSlower(), faster: () => RUN.cursorFaster(), recenter: () => RUN.recenter(),
                zoomIn: () => RUN.zoomIn(), zoomOut: () => RUN.zoomOut(), undo: () => RUN.undo(), redo: () => RUN.redo(),
                camera: () => setPreview(!previewOn),
                fast: () => { fastTyping = !fastTyping; resetEarly(); try { chrome.storage.local.set({ fast: fastTyping }); } catch {} say(fastTyping ? '⚡ Fast typing on — words appear as you speak' : 'Fast typing off — text appears after each sentence', 3000); renderPanel(); },
                walk: () => (walkOn ? RUN.walkOff() : RUN.walkOn()),
                sleep: () => (paused ? RUN.resume() : RUN.pause()), close: () => togglePanel(false) }[a];
    if (f) f();
  }

  /* ------------------------------------------------------------------ camera preview (thumbnail + landmarks from the engine) */
  const SKELETON = [[0,1,2,3,4],[0,5,6,7,8],[5,9,10,11,12],[9,13,14,15,16],[13,17,18,19,20],[0,17]];
  function drawCam(lm, pose) {
    if (cam.hidden) return;
    const w = camov.width, h = camov.height;
    camctx.clearRect(0, 0, w, h);
    if (lm) {
      for (const hh of lm.hands || []) {
        const P = hh.map(([x, y]) => [(1 - x) * w, y * h]);           // mirrored, to match the mirrored image
        camctx.strokeStyle = '#4ade80'; camctx.lineWidth = 2;
        for (const chain of SKELETON) { camctx.beginPath(); camctx.moveTo(...P[chain[0]]); for (const i of chain.slice(1)) camctx.lineTo(...P[i]); camctx.stroke(); }
        camctx.fillStyle = '#fde68a';
        for (const [x, y] of P) { camctx.beginPath(); camctx.arc(x, y, 3, 0, 6.3); camctx.fill(); }
      }
      if (lm.nose) { camctx.beginPath(); camctx.arc((1 - lm.nose[0]) * w, lm.nose[1] * h, 6, 0, 6.3); camctx.fillStyle = '#60a5fa'; camctx.fill(); }
    }
    poseEl.textContent = pose || (lm && lm.nose ? 'face ✓' : 'show your face');
  }

  /* ------------------------------------------------------------------ real (trusted) input via the background worker */
  let cdpChain = Promise.resolve();
  function cdpFail(err) {
    lastResult = '✗ ' + err; renderPanel();
    say('Real-input error: ' + err + '\n(close DevTools on this tab; don’t press Cancel on the debugging bar)', 8000);
  }
  function cdp(op, p = {}) {
    cdpChain = cdpChain.then(() => new Promise(res => {
      try {
        chrome.runtime.sendMessage({ src: 'content', type: 'cdp', op, ...p }, r => {
          const err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || (!r && 'no answer from extension') || (!r.ok && r.error);
          if (err) cdpFail(err); else if (op === 'insert') { lastResult = '✓ typed'; renderPanel(); }
          res();
        });
      } catch { lastResult = '✗ extension was reloaded — refresh this page'; say('The extension was reloaded.\nRefresh this page (Cmd+R) and try again.', 8000); renderPanel(); res(); }
    }));
    return cdpChain;
  }
  const KEYS = { z: ['KeyZ', 90], y: ['KeyY', 89], a: ['KeyA', 65], c: ['KeyC', 67], Backspace: ['Backspace', 8], Enter: ['Enter', 13],
                 Home: ['Home', 36], End: ['End', 35], ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40],
                 v: ['KeyV', 86], b: ['KeyB', 66], i: ['KeyI', 73], u: ['KeyU', 85] };
  // Mac only: synthetic Cmd+Z / Cmd+A etc. do nothing in a plain text box unless the editing command is named too.
  const MAC_CMDS = { 'z': ['undo'], 'z+shift': ['redo'], 'a': ['selectAll'], 'c': ['copy'], 'v': ['paste'], 'Backspace+alt': ['deleteWordBackward'],
                     'ArrowUp': ['moveToBeginningOfDocument'], 'ArrowDown': ['moveToEndOfDocument'] };
  function pressKey(key, { cmd = false, shift = false, alt = false } = {}, native = false) {
    const [code, vk] = KEYS[key];
    const modifiers = (alt ? 1 : 0) | (cmd ? (IS_MAC ? 4 : 2) : 0) | (shift ? 8 : 0);
    const commands = native && IS_MAC ? MAC_CMDS[key + (shift ? '+shift' : '') + (alt ? '+alt' : '')] || MAC_CMDS[key] : undefined;
    return cdp('key', { key, code, vk, modifiers, commands, text: key === 'Enter' ? '\r' : undefined });
  }
  function cdpTypeText(text) {                              // real typing: works in boxes the page protects from script-made input
    text.split('\n').forEach((p, i) => { if (i > 0) pressKey('Enter'); if (p) cdp('insert', { text: p }); });
  }

  /* ------------------------------------------------------------------ ADAPTERS
     An adapter = how to read/edit ONE kind of editor. First one whose match() is true wins.
     Interface:  match() · before() text left of caret · insert(text) · undo() · redo() ·
                 selectAll() · deleteSel() · deleteWord() · goStart() · goEnd() · copyAll()                   */
  const deepActive = () => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a; };
  const isTextInput = el => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|email|url|tel|)$/i.test(el.type)));
  const isEditable = el => el && (isTextInput(el) || el.isContentEditable);

  const domAdapter = {            // plain <input>, <textarea>, and any contenteditable (Gmail, Notion, Slack, Canvas, …)
    name: 'dom',
    el: () => deepActive(),
    match() { return isEditable(this.el()); },
    before() {
      const el = this.el();
      if (isTextInput(el)) return el.value.slice(0, el.selectionStart);
      const s = getSelection(); if (!s.rangeCount) return '';
      const pre = document.createRange(); pre.selectNodeContents(el);
      pre.setEnd(s.getRangeAt(0).startContainer, s.getRangeAt(0).startOffset);
      return pre.toString();
    },
    insert(text) {
      const el = this.el(), parts = text.split('\n');
      const read = () => (isTextInput(el) ? el.value : el.textContent);
      const was = read();
      let ok = true;
      parts.forEach((p, i) => {
        if (i > 0 && (isTextInput(el) || !document.execCommand('insertParagraph'))) ok = document.execCommand('insertText', false, '\n') && ok;
        if (p && !document.execCommand('insertText', false, p)) {
          ok = false;
          if (isTextInput(el)) {
            el.setRangeText(p, el.selectionStart, el.selectionEnd, 'end');          // fallback 1: set the value ourselves
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: p }));
          }
        }
      });
      // fallback 2: the page ignored script-made typing (value unchanged) → type with real browser input
      if (text.trim() && ((isTextInput(el) && read() === was) || (!ok && !isTextInput(el)))) cdpTypeText(text);
    },
    // Every edit command below is "verified": we run the normal in-page command, and if the page ignored it
    // (React/Canvas-style inputs often do) we repeat it as REAL keyboard input through the debugger.
    snap(sel) { const el = this.el(); return !el ? '' : (isTextInput(el) ? el.value + (sel ? '|' + el.selectionStart + '|' + el.selectionEnd : '') : el.textContent + (sel ? '|' + String(getSelection()) : '')); },
    tryDom(run, fallback, sel) { const s0 = this.snap(sel); try { run(); } catch {} if (this.snap(sel) === s0) fallback(); },
    undo() { this.tryDom(() => document.execCommand('undo'), () => pressKey('z', { cmd: true }, true)); },
    redo() { this.tryDom(() => document.execCommand('redo'), () => IS_MAC ? pressKey('z', { cmd: true, shift: true }, true) : pressKey('y', { cmd: true }, true)); },
    selectAll() {
      const el = this.el();
      this.tryDom(() => { isTextInput(el) ? el.select() : document.execCommand('selectAll'); }, () => pressKey('a', { cmd: true }, true), true);
    },
    delSel() {                                               // delete whatever is selected (or the char before the caret)
      const el = this.el();
      this.tryDom(() => document.execCommand('delete'), () => {
        if (isTextInput(el) && el.selectionStart !== el.selectionEnd) {
          const v = el.value; el.setRangeText('', el.selectionStart, el.selectionEnd, 'end');
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
          if (el.value !== v) return;
        }
        pressKey('Backspace');
      });
    },
    deleteSel() { this.delSel(); },
    deleteWord() {
      const el = this.el();
      if (isTextInput(el)) {
        if (el.selectionStart === el.selectionEnd) el.setSelectionRange(wordStartBefore(el.value, el.selectionStart), el.selectionEnd);
      } else { const s = getSelection(); if (s.isCollapsed) s.modify('extend', 'backward', 'word'); }
      this.delSel();
    },
    goStart() { const el = this.el(); isTextInput(el) ? el.setSelectionRange(0, 0) : getSelection().modify('move', 'backward', 'documentboundary'); },
    goEnd() { const el = this.el(); isTextInput(el) ? el.setSelectionRange(el.value.length, el.value.length) : getSelection().modify('move', 'forward', 'documentboundary'); },
    copyAll() { this.selectAll(); document.execCommand('copy'); },
    deleteBack(n) {                                        // remove the last n characters before the caret
      const el = this.el();
      if (isTextInput(el)) { const st = el.selectionStart; el.setSelectionRange(Math.max(0, st - n), st); }
      else { const s = getSelection(); for (let i = 0; i < n; i++) s.modify('extend', 'backward', 'character'); }
      this.delSel();
    },
    paste() { navigator.clipboard.readText().then(t => this.insert(t)).catch(() => say('Paste blocked — allow clipboard access for this site', 4000)); },
    format(kind) { document.execCommand(kind); },
  };

  // Google Docs draws on a canvas and ignores script-made events, so this adapter types with REAL input
  // (Chrome DevTools Protocol via the background worker). Docs gives us no way to read the text, so we only
  // remember what we typed ourselves (docsTail) for capitalisation/spacing.
  let docsTail = '';                  // what we know is left of the caret: '' = start of a line, 'x' = somewhere after text
  const docsEditable = () => {
    try { const f = document.querySelector('iframe.docs-texteventtarget-iframe'), d = f && f.contentDocument; return d && (d.querySelector('[contenteditable]') || d.body); } catch { return null; }
  };
  function docsFocus() { const el = docsEditable(); if (el) { try { el.focus({ preventScroll: true }); } catch {} } return !!el; }
  const docsAdapter = {
    name: 'google-docs',
    match() { return location.hostname === 'docs.google.com' && /\/document\//.test(location.pathname); },
    before() { return docsTail; },
    insert(text) {
      text.split('\n').forEach((p, i) => { if (i > 0) pressKey('Enter'); if (p) cdp('insert', { text: p }); });
      docsTail = (docsTail + text).slice(-200);
    },
    undo() { docsTail = 'x'; pressKey('z', { cmd: true }); },
    redo() { docsTail = 'x'; IS_MAC ? pressKey('z', { cmd: true, shift: true }) : pressKey('y', { cmd: true }); },
    selectAll() { pressKey('a', { cmd: true }); },
    deleteSel() { docsTail = 'x'; pressKey('Backspace'); },
    deleteWord() { docsTail = 'x'; pressKey('Backspace', IS_MAC ? { alt: true } : { cmd: true }); },
    goStart() { docsTail = ''; IS_MAC ? pressKey('ArrowUp', { cmd: true }) : pressKey('Home', { cmd: true }); },
    goEnd() { docsTail = 'x'; IS_MAC ? pressKey('ArrowDown', { cmd: true }) : pressKey('End', { cmd: true }); },
    copyAll() { pressKey('a', { cmd: true }); pressKey('c', { cmd: true }); },
    deleteBack(n) { n = Math.min(n, 300); docsTail = docsTail.slice(0, -n); for (let i = 0; i < n; i++) pressKey('Backspace'); },
    paste() { docsTail = 'x'; pressKey('v', { cmd: true }); },
    format(kind) { pressKey({ bold: 'b', italic: 'i', underline: 'u' }[kind], { cmd: true }); },
  };
  for (const k of ['insert', 'undo', 'redo', 'selectAll', 'deleteSel', 'deleteWord', 'goStart', 'goEnd', 'copyAll', 'deleteBack', 'paste', 'format']) {
    const f = docsAdapter[k];
    docsAdapter[k] = function (...args) { if (!docsFocus()) { lastResult = '✗ Docs editor not found'; say('Can’t find the Docs editor — click inside the document', 4000); } return f.apply(this, args); };
  }

  // The focused thing is an <iframe> (rich-text widgets, embedded forms…): we can't read inside it, but real input still reaches it.
  const frameAdapter = {
    name: 'iframe-real-input',
    match() { const a = document.activeElement; return !!a && a.tagName === 'IFRAME' && a.id !== 'handsfree-pet-host'; },
    before() { return ''; },
    insert(text) { cdpTypeText(text); },
    undo() { pressKey('z', { cmd: true }, true); },
    redo() { IS_MAC ? pressKey('z', { cmd: true, shift: true }, true) : pressKey('y', { cmd: true }, true); },
    selectAll() { pressKey('a', { cmd: true }, true); },
    deleteSel() { pressKey('Backspace'); },
    deleteWord() { pressKey('Backspace', IS_MAC ? { alt: true } : { cmd: true }, true); },
    goStart() { IS_MAC ? pressKey('ArrowUp', { cmd: true }, true) : pressKey('Home', { cmd: true }); },
    goEnd() { IS_MAC ? pressKey('ArrowDown', { cmd: true }, true) : pressKey('End', { cmd: true }); },
    copyAll() { pressKey('a', { cmd: true }, true); pressKey('c', { cmd: true }, true); },
    deleteBack(n) { for (let i = 0; i < Math.min(n, 300); i++) pressKey('Backspace'); },
    paste() { pressKey('v', { cmd: true }, true); },
    format(kind) { pressKey({ bold: 'b', italic: 'i', underline: 'u' }[kind], { cmd: true }); },
  };

  // Nothing is focused (typical right after "gravy, new tab"): find the page's main text box and focus it.
  const isShown = el => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  function autoFocusInput() {
    const picks = ['input[type=search]', '[role=searchbox]', 'textarea[name=q]', 'input[name=q]', '[role=combobox]', 'textarea',
                   'input[type=text]', 'input:not([type])', 'input[type=email]', 'input[type=url]', '[contenteditable=true]', '[contenteditable=plaintext-only]'];
    for (const q of picks) for (const el of document.querySelectorAll(q)) {
      if (el.disabled || el.readOnly || !isEditable(el) || !isShown(el)) continue;
      el.focus();
      if (isTextInput(el)) el.setSelectionRange(el.value.length, el.value.length);
      else { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      return el;
    }
    return null;
  }

  const ADAPTERS = [docsAdapter, frameAdapter, domAdapter];                 // ← add new editor formats here
  const adapter = () => ADAPTERS.find(a => { try { return a.match(); } catch { return false; } });

  /* ------------------------------------------------------------------ virtual cursor + click + scroll */
  const pickTarget = (x, y) => document.elementsFromPoint(x, y).find(e => e !== host);
  function caretRangeAt(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y); if (!p) return null;
      const r = document.createRange(); r.setStart(p.offsetNode, p.offset); r.collapse(true); return r;
    }
    return document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
  }
  function virtualClick(x, y) {
    const rip = document.createElement('div'); rip.className = 'ripple';
    rip.style.left = x + 'px'; rip.style.top = y + 'px'; root.appendChild(rip); setTimeout(() => rip.remove(), 600);
    // the pet's own UI lives in a closed shadow root, so hit-test it by rectangle
    const mine = [...root.querySelectorAll('#panel:not([hidden]) button, #panel:not([hidden]) summary, #files:not([hidden]) button, #body')].find(b => {
      const r = b.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
    if (mine) { mine.id === 'body' ? togglePanel() : mine.click(); return; }
    if (trusted()) { docsTail = ''; cdp('click', { x: Math.round(x), y: Math.round(y) }); return; }       // real mouse click
    const el = pickTarget(x, y); if (!el) return;
    if (isTextInput(el)) { el.focus(); if (el.selectionStart === el.selectionEnd && document.activeElement !== el) el.setSelectionRange(el.value.length, el.value.length); return; }
    const ce = el.isContentEditable ? el : el.closest('[contenteditable]:not([contenteditable=false])');
    if (ce) {
      ce.focus();
      const r = caretRangeAt(x, y);
      if (r && ce.contains(r.startContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      return;
    }
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new MouseEvent('mousedown', o));
    if (el.focus) el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent('pointerup', o)); el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  let bigCache = { t: 0, el: null };
  function bigScroller() {                                 // the largest scrollable box on the page (for apps that scroll an inner div)
    if (Date.now() - bigCache.t < 3000) return bigCache.el;
    let best = null, area = 0;
    for (const e of document.querySelectorAll('div,main,section,article')) {
      if (e.scrollHeight <= e.clientHeight + 40) continue;
      const oy = getComputedStyle(e).overflowY; if (oy !== 'auto' && oy !== 'scroll') continue;
      const a = e.clientWidth * e.clientHeight; if (a > area) { area = a; best = e; }
    }
    bigCache = { t: Date.now(), el: best }; return best;
  }
  function scrollerAt(x, y) {
    for (let e = pickTarget(x, y); e && e !== document.documentElement; e = e.parentElement) {
      const oy = getComputedStyle(e).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && e.scrollHeight > e.clientHeight) return e;
    }
    if (document.scrollingElement && document.scrollingElement.scrollHeight > innerHeight + 5) return window;
    return bigScroller() || window;
  }
  let wheelBusy = false;
  function scrollBy(dy, x = innerWidth / 2, y = innerHeight / 2, smooth = true) {
    if (trusted()) {                                       // real mouse wheel (Docs ignores scrollTop changes)
      if (wheelBusy) return; wheelBusy = true;
      cdp('wheel', { x: Math.round(hfClamp(x, 1, innerWidth - 1)), y: Math.round(hfClamp(y, 1, innerHeight - 1)), dy }).then(() => { wheelBusy = false; });
      return;
    }
    scrollerAt(x, y).scrollBy({ top: dy, behavior: smooth ? 'smooth' : 'auto' });
  }

  function onCursor(m) {
    cursor = m;
    headOk = !m.lost;
    const px = hfClamp(m.x * innerWidth, 0, innerWidth - 1), py = hfClamp(m.y * innerHeight, 0, innerHeight - 1);
    placeCursor(px, py);
    cursorEl.classList.toggle('lost', !!m.lost);
    const was = cursorEl.classList.contains('pinch'); cursorEl.classList.toggle('pinch', !!m.pinch);
    if (was !== !!m.pinch) refreshPet();
    if (m.centering) say('Look at the middle of the screen…', 600);
    drawCam(m.lm, m.pose);
  }

  /* ------------------------------------------------------------------ commands */

  /* ------------------------------------------------------------------ file upload (no native file window)
     Anything that would open the computer's file window ( <input type=file> ) opens THIS list instead.
     Picking a file hands its path to the page's file field via the background worker. */
  let pickInput = null, pickList = [], nativeNext = false;
  const filesBox = () => root.querySelector('#files'), flist = () => root.querySelector('#flist');
  const fileInputOf = t => {
    if (!t || !t.closest) return null;
    const i = t.closest('input[type=file]'); if (i) return i;
    const l = t.closest('label'); return l && l.control && l.control.type === 'file' ? l.control : null;
  };
  function findFileInput() {
    const all = [...document.querySelectorAll('input[type=file]')].filter(i => !i.disabled);
    if (all.length < 2) return all[0] || null;
    const cx = cursor.x * innerWidth, cy = cursor.y * innerHeight;
    const d = i => { let r = i.getBoundingClientRect(); if (!r.width && i.parentElement) r = i.parentElement.getBoundingClientRect(); return Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy); };
    return all.sort((a, b) => d(a) - d(b))[0];
  }
  function closePicker() { pickInput = null; filesBox().hidden = true; }
  function renderPicker() {
    const box = flist(); box.textContent = '';
    if (!pickList.length) { const d = document.createElement('div'); d.className = 'hint'; d.textContent = 'No files found yet. Download the file first, or run refresh-files.sh in the extension folder.'; box.appendChild(d); return; }
    pickList.slice(0, 12).forEach((f, i) => {
      const b = document.createElement('button'); b.className = 'fbtn'; b.dataset.i = i;
      const n = document.createElement('b'); n.textContent = i + 1;
      const t = document.createElement('span'); t.textContent = f.name;
      const dsm = document.createElement('small'); dsm.textContent = f.dir;
      b.append(n, t, dsm); box.appendChild(b);
    });
  }
  function loadFiles(cb) {
    try { chrome.runtime.sendMessage({ src: 'content', type: 'listFiles' }, r => { pickList = (r && r.files) || []; cb(); }); }
    catch { pickList = []; cb(); }
  }
  function openFilePicker(input) {
    pickInput = input || findFileInput();
    if (!pickInput) return say('I can’t find an upload button on this page.\nClick the page’s “upload / choose file” button first.', 4500);
    filesBox().hidden = false; flist().textContent = 'loading…'; say('📎 choose a file', 2500);
    loadFiles(renderPicker);
  }
  function doUpload(f) {
    if (!f || !pickInput) return;
    const input = pickInput; input.setAttribute('data-hf-file', '1');
    say('📎 attaching ' + f.name + '…', 2500);
    try {
      chrome.runtime.sendMessage({ src: 'content', type: 'upload', paths: [f.path] }, r => {
        input.removeAttribute('data-hf-file');
        if (r && r.ok) { lastResult = '✓ attached ' + f.name; say('✓ attached ' + f.name, 3500); }
        else say('Couldn’t attach: ' + ((r && r.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'no answer') + '\n(close DevTools on this tab; don’t press Cancel on the debugging bar)', 7000);
        renderPanel();
      });
    } catch { input.removeAttribute('data-hf-file'); say('The extension was reloaded.\nRefresh this page and try again.', 6000); }
    closePicker();
  }
  const normFile = t => t.toLowerCase().replace(/\.[a-z0-9]{1,5}$/, m => ' ' + m.slice(1)).replace(/[^a-z0-9]+/g, ' ').trim();
  function bestFile(spoken) {
    const stop = new Set(['the', 'a', 'my', 'file', 'called', 'named', 'dot', 'document', 'doc']);
    const toks = spoken.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !stop.has(w));
    if (!toks.length) return null;
    let best = null, bs = 0;
    for (const f of pickList) { const n = ' ' + normFile(f.name) + ' ', sc = toks.filter(w => n.includes(w)).length; if (sc > bs) { bs = sc; best = f; } }
    return bs >= Math.ceil(toks.length / 2) ? best : null;           // pickList is newest-first, so ties go to the newest file
  }
  root.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('#files button'); if (!b) return;
    if (b.dataset.i != null) doUpload(pickList[+b.dataset.i]);
    else if (b.dataset.f === 'cancel') closePicker();
    else if (b.dataset.f === 'native') { const i = pickInput; closePicker(); nativeNext = true; try { i && i.click(); } catch {} setTimeout(() => { nativeNext = false; }, 800); }
  });
  document.addEventListener('click', e => {                           // a page button / real mouse click that would open the file window
    if (!enabled || nativeNext || e.__hf) return;
    const i = fileInputOf(e.composedPath ? e.composedPath()[0] : e.target);
    if (i) { e.preventDefault(); e.stopPropagation(); openFilePicker(i); }
  }, true);
  const px = () => cursor.x * innerWidth, py = () => cursor.y * innerHeight;
  const needAdapter = fn => () => { const a = adapter(); a ? fn(a) : say('Click a text box first'); };
  const RUN = {
    undo: () => { lastInsertLen = 0; (adapter() || domAdapter).undo(); },
    redo: () => { lastInsertLen = 0; (adapter() || domAdapter).redo(); },
    deleteThat: needAdapter(a => { if (lastInsertLen) { a.deleteBack(lastInsertLen); lastInsertLen = 0; } else a.deleteWord(); }),   // removes what you just dictated
    bold: needAdapter(a => a.format('bold')), italic: needAdapter(a => a.format('italic')), underline: needAdapter(a => a.format('underline')),
    paste: needAdapter(a => a.paste()),
    selectAll: needAdapter(a => a.selectAll()), deleteSel: needAdapter(a => { lastInsertLen = 0; a.deleteSel(); }), deleteWord: needAdapter(a => { lastInsertLen = 0; a.deleteWord(); }),
    goStart: () => { const a = adapter(); a ? a.goStart() : scrollBy(-1e6, px(), py()); }, goEnd: () => { const a = adapter(); a ? a.goEnd() : scrollBy(1e6, px(), py()); },
    copyAll: needAdapter(a => { a.copyAll(); say('Copied'); }),
    zoomIn: () => send({ type: 'zoom', dir: 1 }), zoomOut: () => send({ type: 'zoom', dir: -1 }), zoomReset: () => send({ type: 'zoom', dir: 0 }),
    click: () => virtualClick(px(), py()),
    enter: () => {
      const el = deepActive();
      const searchy = el && el.form && (el.tagName === 'INPUT' || el.type === 'search' || el.name === 'q' || /^(searchbox|combobox)$/.test(el.getAttribute('role') || ''));
      if (searchy) { try { el.form.requestSubmit(); return; } catch {} }      // search boxes: submit the form
      pressKey('Enter');                                                       // anything else: a real Enter key
    },
    recenter: () => { send({ type: 'recenter' }); say('Look at the middle of the screen…'); },
    cursorFaster: () => { send({ type: 'sens', delta: 0.2 }); say('Cursor faster'); }, cursorSlower: () => { send({ type: 'sens', delta: -0.2 }); say('Cursor slower'); },
    scrollDown: () => scrollBy(innerHeight * 0.7, px(), py()), scrollUp: () => scrollBy(-innerHeight * 0.7, px(), py()),
    navBack: () => history.back(), navForward: () => history.forward(), reload: () => location.reload(),
    newTab: () => send({ type: 'tab', op: 'new' }), closeTab: () => send({ type: 'tab', op: 'close' }),
    nextTab: () => send({ type: 'tab', op: 'next' }), prevTab: () => send({ type: 'tab', op: 'prev' }),
    gotoTab: n => send({ type: 'tab', op: 'goto', n }),
    openSite: arg => { say('Opening in a new tab…', 2000); send({ type: 'tab', op: 'open', url: toUrl(arg) }); },
    search: arg => { say('Searching in a new tab…', 2000); send({ type: 'tab', op: 'open', url: searchUrl(arg) }); },
    pause: () => { paused = true; try { chrome.storage.local.set({ typing: false }); } catch {} refreshPet(); say('⌨ Typing OFF\nsay “gravy, start typing” to type again', 3500); },
    resume: () => { paused = false; try { chrome.storage.local.set({ typing: true }); } catch {} refreshPet(); say('✍ Typing ON — talk and it types.\nSay “gravy, stop typing” when done.', 4000); },
    help: () => togglePanel(true),
    walkOn: () => { walkOn = true; walkTarget = null; walkWait = 0.5; try { chrome.storage.local.set({ walk: true }); } catch {} renderPanel(); say('🚶 Off I go!', 2000); },
    walkOff: () => { walkOn = false; setWalking(false); try { chrome.storage.local.set({ walk: false }); } catch {} renderPanel(); say('🦃 Staying here', 2000); },
    chefVoice: () => send({ type: 'timer', op: 'persona', value: 'chef' }),
    professorVoice: () => send({ type: 'timer', op: 'persona', value: 'professor' }),
    changeVoice: () => send({ type: 'timer', op: 'voice' }),
    setTimer: m => send({ type: 'timer', op: 'set', minutes: m }),
    clearTimer: () => send({ type: 'timer', op: 'clear' }),
    timeLeft: () => send({ type: 'timer', op: 'left' }),
    upload: () => openFilePicker(),
    pickFile: n => { if (filesBox().hidden) return say('Say “gravy, upload” first to see the files', 3000); const f = pickList[n - 1]; f ? doUpload(f) : say('There is no file ' + n, 2500); },
    uploadNamed: arg => {
      const input = pickInput || findFileInput();
      if (!input) return say('I can’t find an upload button on this page.', 3500);
      pickInput = input;
      loadFiles(() => { const f = bestFile(arg); if (f) doUpload(f); else { filesBox().hidden = false; renderPicker(); say('No file matching “' + arg + '” — pick from the list', 4500); } });
    },
    cancelPick: () => { if (!filesBox().hidden) { closePicker(); say('Cancelled'); } },
  };
  function onGesture(m) {
    if (m.name === 'click') RUN.click();
    else if (m.name === 'scroll') scrollBy(m.dir * 20, px(), py(), false);       // one finger up / down
    else if (m.name === 'undo') { RUN.undo(); say('↶ undo'); }
    else if (m.name === 'redo') { RUN.redo(); say('↷ redo'); }
    else if (m.name === 'zoomStart') say('🔍 zooming…', 4000);
    else if (m.name === 'zoomEnd') say('Zoom kept');
  }

  /* ------------------------------------------------------------------ speech */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, wantVoice = false, useLocalSR = false, engineMic = false;
  function dictate(raw) {
    let a = adapter();
    if (!a) { const el = autoFocusInput(); if (el) { a = adapter(); say('✍ Typing into the ' + (el.getAttribute('aria-label') || el.placeholder || el.name || el.tagName.toLowerCase()) + ' box', 2500); } }
    if (!a) return say('Heard “' + raw.trim() + '” — and I can’t find a text box on this page.\nClick inside one first.', 4000);
    const chunk = formatDictation(raw, a.before());
    if (chunk) { a.insert(chunk); lastInsertLen = chunk.length; say('“' + raw.trim() + '”', 1800); }
  }
  // Typing mode: "gravy, start typing" / "gravy, stop typing". Commands always begin with the wake word "gravy".
  // One speech result can hold several phrases ("hello gravy undo more words"), so it is split into pieces
  // (see splitUtterance in shared.js) and each piece is handled in order.
  // "gravy" brings the pet back: shown, moved to its home corner, panel open.
  function summon() {
    if (!enabled) return;
    host.style.display = 'block';
    pet.style.left = pet.style.top = pet.style.right = pet.style.bottom = '';
    try { chrome.storage.local.remove('petPos'); } catch {}
    walkX = null; walkTarget = null; walkWait = 3;
    refreshPet();
  }
  function handleFinal(raw) {
    say('heard: ' + raw.trim(), 1500);
    let parts = splitUtterance(raw);
    if (parts.some(p => p.type !== 'text')) summon();
    if (Date.now() < armedUntil && parts.length === 1 && parts[0].type === 'text') parts = splitUtterance('gravy ' + raw);   // armed by a lone "gravy"
    armedUntil = 0;
    for (const p of parts) {
      if (p.type === 'wake') { armedUntil = Date.now() + 6000; say('🎙 Yes? Say a command', 3000); }
      else if (p.type === 'unknown') say('Unknown command: “' + p.text + '”\nSay “gravy, help”', 4000);
      else if (p.type === 'cmd') {
        say('⌘ ' + p.name + (p.count > 1 ? ' ×' + p.count : '') + (p.arg ? ' ' + p.arg : ''), 1500);
        for (let i = 0; i < p.count; i++) RUN[p.name] && RUN[p.name](p.arg);
      } else if (!paused) dictate(p.text);
      else if (Date.now() - hintAt > 6000) { hintAt = Date.now(); say('⌨ Typing is OFF — I ignored that.\nSay “gravy, start typing”.', 3500); }
    }
  }
  /* ---- low-latency typing ----
     Chrome only calls a sentence "final" after you pause (often 1–2 s). So we also listen to the interim results and
     type words as soon as the recognizer has settled on them (unchanged across two updates, or quiet for 450 ms).
     When the final result arrives we type only the words that are still missing. Utterances that contain the wake word
     ("gravy") are never typed early — they wait for the final result so a command is never typed as text. */
  let fastTyping = true, early = {};
  const HOLD_WORDS = new Set(['new', 'question', 'exclamation', 'full']);          // first half of a spoken punctuation command
  const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++; return i; };
  function earlyCommit(idx, words, upTo) {
    const st = early[idx]; if (!st || paused || st.blocked) return;
    while (upTo > st.n && HOLD_WORDS.has(words[upTo - 1].toLowerCase())) upTo--;
    if (upTo <= st.n) return;
    const chunk = words.slice(st.n, upTo).join(' ');
    st.n = upTo;
    dictate(chunk);
  }
  function onInterim(idx, text) {
    if (Date.now() < muteUntil) return;
    if (!fastTyping || paused) return;
    const words = text.trim().split(/\s+/).filter(Boolean);
    const st = early[idx] || (early[idx] = { n: 0, prev: [], timer: 0, blocked: false });
    clearTimeout(st.timer);
    if (splitUtterance(text).some(p => p.type !== 'text') || Date.now() < armedUntil) st.blocked = true;   // a command is coming: wait
    if (st.blocked) { st.prev = words; return; }
    const L = commonPrefix(st.prev, words); st.prev = words;
    earlyCommit(idx, words, Math.min(L, words.length - 2));                    // survived two updates in a row, and not the newest words
    st.timer = setTimeout(() => earlyCommit(idx, words, words.length - 1), 450);   // recognizer went quiet: all but the last word are settled
  }
  function onFinalResult(idx, text) {
    if (Date.now() < muteUntil) { delete early[idx]; return; }
    const st = early[idx]; delete early[idx];
    if (st) clearTimeout(st.timer);
    const rest = st && st.n > 0 ? text.trim().split(/\s+/).filter(Boolean).slice(st.n).join(' ') : text;
    if (rest.trim()) handleFinal(rest);
  }
  function resetEarly() { for (const k in early) clearTimeout(early[k].timer); early = {}; }

  function startVoice() {
    if (!useLocalSR || !SR || rec) return;
    rec = new SR(); rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = true;
    rec.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) onFinalResult(i, r[0].transcript); else onInterim(i, r[0].transcript);
      }
    };
    rec.onstart = () => say('🎤 mic is on — talk now', 1800);
    rec.onspeechstart = () => say('…hearing you', 900);
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { wantVoice = false; say('Mic blocked on this site — click the lock icon in the address bar → allow microphone', 6000); }
      else if (e.error === 'network') say('Speech needs an internet connection', 3000);
      else if (e.error !== 'no-speech' && e.error !== 'aborted') say('Mic error: ' + e.error, 4000);
    };
    rec.onend = () => { rec = null; resetEarly(); refreshPet(); if (wantVoice) setTimeout(() => { if (wantVoice && !rec) startVoice(); }, 120); };
    try { rec.start(); } catch {}
    refreshPet();
  }
  function stopVoice() { wantVoice = false; if (rec) { const r = rec; rec = null; try { r.stop(); } catch {} } refreshPet(); }
  function syncVoice() {
    if (!useLocalSR) return;
    if (enabled && document.visibilityState === 'visible') { wantVoice = true; startVoice(); } else stopVoice();
  }
  document.addEventListener('visibilitychange', syncVoice);
  setInterval(() => { if (useLocalSR && enabled && wantVoice && !rec && document.visibilityState === 'visible') startVoice(); }, 3000);   // watchdog


  /* ------------------------------------------------------------------ the turkey wanders around the window
     It strolls to a random spot, rests a few seconds, strolls again. It stands still while you drag it, while the
     settings panel is open, and when walking is switched off (“gravy, stay” / “gravy, walk”). */
  function setWalking(on) { if (isWalking !== on) { isWalking = on; refreshPet(); } }
  let walkLast = 0;
  function walkTick(t) {
    requestAnimationFrame(walkTick);
    const dt = Math.min(0.1, (t - walkLast) / 1000); walkLast = t;
    if (!enabled || !walkOn || drag || !panel.hidden || host.style.display === 'none') { walkTarget = null; setWalking(false); walkX = null; return; }
    const r = pet.getBoundingClientRect(), w = r.width || 120, h = r.height || 90;
    if (walkX == null) { walkX = r.left; walkY = r.top; walkWait = Math.max(walkWait, 1.5); }
    if (!walkTarget) {
      walkWait -= dt;
      if (walkWait > 0) { setWalking(false); return; }
      walkTarget = { x: 8 + Math.random() * Math.max(1, innerWidth - w - 16), y: 90 + Math.random() * Math.max(1, innerHeight - h - 98) };
    }
    const dx = walkTarget.x - walkX, dy = walkTarget.y - walkY, d = Math.hypot(dx, dy), step = 75 * dt;
    if (d <= step) { walkX = walkTarget.x; walkY = walkTarget.y; walkTarget = null; walkWait = 1.5 + Math.random() * 4; setWalking(false); }
    else { walkX += dx / d * step; walkY += dy / d * step; setWalking(true); if (Math.abs(dx) > 4) pet.style.setProperty('--face', dx > 0 ? '-1' : '1'); }
    pet.style.right = pet.style.bottom = 'auto';
    pet.style.left = (walkX * pageZoom) + 'px'; pet.style.top = (walkY * pageZoom) + 'px';   // the pet is zoom-compensated, so convert page px → its units
  }
  requestAnimationFrame(walkTick);

  /* ------------------------------------------------------------------ wiring */
  function setEnabled(on) {
    enabled = !!on; host.style.display = enabled ? 'block' : 'none'; cam.hidden = !enabled || !previewOn;
    if (enabled) {
      send({ type: 'getZoom' });
      say('Hi! Look at the middle of the screen, then pinch to click.', 3500);
      try { chrome.storage.local.get('seenHelp2', ({ seenHelp2 }) => { if (!seenHelp2) { togglePanel(true); chrome.storage.local.set({ seenHelp2: true }); } }); } catch {}
    }
    syncVoice(); refreshPet();
  }
  try {
    chrome.storage.local.get(['sens', 'preview', 'typing', 'fast', 'localSR', 'walk', 'deadline'], ({ sens: s, preview, typing, fast, localSR, walk, deadline: dl }) => { walkOn = walk !== false; deadline = dl || 0; renderTimer(); if (localSR) { useLocalSR = true; syncVoice(); } if (s) sens = s; fastTyping = fast !== false; if (preview === false) { previewOn = false; cam.hidden = true; } paused = !typing; refreshPet(); });
    chrome.storage.local.get('enabled', ({ enabled }) => setEnabled(enabled));
    chrome.storage.onChanged.addListener(c => {
      if (c.enabled) setEnabled(c.enabled.newValue);
      if (c.sens) { sens = c.sens.newValue; renderPanel(); }
      if (c.typing) { paused = !c.typing.newValue; refreshPet(); }
      if (c.deadline) { deadline = c.deadline.newValue || 0; renderTimer(); }
      if (c.walk) { walkOn = c.walk.newValue !== false; if (!walkOn) setWalking(false); renderPanel(); }
      if (c.fast) { fastTyping = c.fast.newValue !== false; renderPanel(); }
      if (c.preview) { previewOn = c.preview.newValue !== false; cam.hidden = !previewOn || !enabled; renderPanel(); }
    });
    chrome.runtime.onMessage.addListener((m, _sender, reply) => {
      if (m.src === 'bg' && m.type === 'zoom') { applyZoom(m.factor); return; }
      if (m.src === 'bg' && m.type === 'ping') { reply(true); return; }
      if (m.src === 'bg' && m.type === 'mute') { muteUntil = Math.max(muteUntil, m.until); resetEarly(); return; }
      if (m.src === 'bg' && m.type === 'say') { say(m.text, 2500); return; }
      if (m.src !== 'engine' || !enabled) return;
      if (m.type === 'cursor') onCursor(m);
      else if (m.type === 'gesture') onGesture(m);
      else if (m.type === 'frame') camimg.src = m.jpg;
      else if (m.type === 'speech') { if (!useLocalSR) { if (m.final) onFinalResult(m.idx, m.text); else onInterim(m.idx, m.text); } }
      else if (m.type === 'speechOn') {
        engineMic = !!m.on;
        if (m.on && useLocalSR) { useLocalSR = false; stopVoice(); try { chrome.storage.local.remove('localSR'); } catch {} }   // shared mic works again
        refreshPet();
      }
      else if (m.type === 'speechHint') say('Microphone: finish the “HandsFree setup” tab and click Allow — once, for all sites', 7000);
      else if (m.type === 'speechNet') say('Speech needs an internet connection', 3000);
      else if (m.type === 'speechFail') {            // extension-level mic unavailable: use the old per-site recognizer
        useLocalSR = true; engineMic = false; try { chrome.storage.local.set({ localSR: true }); } catch {} say('Using this page’s microphone instead (it may ask once per site)', 5000); syncVoice();
      }
      else if (m.type === 'status') {
        camState = m.cam; if (m.head != null) headOk = m.head; if (m.hands != null) handsN = m.hands;
        if (m.cam === 'error') say(m.name === 'AssetsMissing' ? 'Assets missing — run get-assets.sh / get-assets.ps1, then reload the extension'
                                  : m.name === 'NotAllowedError' ? 'Camera not allowed — finish the setup tab' : 'Engine error: ' + (m.msg || m.name), 7000);
        refreshPet();
      }
    });
  } catch {}

  document.addEventListener('hf-replace', () => { try { setEnabled(false); host.remove(); } catch {} });   // a newer copy took over this page

  // test hook: only reachable from the isolated world, never from the page
  if (typeof globalThis.__HF_TEST__ === 'object') globalThis.__HF_TEST__.api = { renderTimer, setDL: v => { deadline = v; }, handleFinal, onCursor, onGesture, adapter, virtualClick, setEnabled, RUN, applyZoom, docsAdapter, root, host, state: () => ({ paused, lastInsertLen, lastResult }), docsFocus, SRhook: () => rec, walkTick };
})();
