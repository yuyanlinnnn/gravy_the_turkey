/* Service worker = the switchboard.
   engine (offscreen doc: camera + MediaPipe)  ──►  here  ──►  content script of the ACTIVE tab
   It also does the things only an extension can:
     • browser zoom (chrome.tabs.setZoom)
     • REAL (trusted) typing / key / mouse / wheel input through the Chrome DevTools Protocol (chrome.debugger).
       Canvas editors such as Google Docs ignore script-made events, so they need this.
       While attached, Chrome shows a "HandsFree Pet started debugging this browser" bar — don't press Cancel. */

importScripts('shared.js');            // parseCommand / splitUtterance, so tabs can be controlled even on pages the pet can't enter
const OFFSCREEN = 'offscreen.html';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
let activeTab = null, zoomBase = null, setupOpened = false;

async function hasOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}
async function startEngine() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN, reasons: ['USER_MEDIA'],
    justification: 'Camera hand/head tracking for hands-free control',
  });
}
const SPEECH_URL = chrome.runtime.getURL('speech.html');
async function openSpeechTab() {              // plan B for the shared microphone: a pinned extension tab (extension pages keep one permission)
  const have = await chrome.tabs.query({ url: SPEECH_URL });
  if (!have.length) await chrome.tabs.create({ url: SPEECH_URL, pinned: true, active: false });
}
async function closeSpeechTab() { const t = await chrome.tabs.query({ url: SPEECH_URL }); if (t.length) await chrome.tabs.remove(t.map(x => x.id)); }
async function stopEngine() { await closeSpeechTab().catch(() => {}); if (await hasOffscreen()) await chrome.offscreen.closeDocument(); }
async function setEnabled(on) {
  await chrome.storage.local.set({ enabled: on });
  chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  if (on) await startEngine(); else { await stopEngine(); await detachAll(); }
}

chrome.action.onClicked.addListener(async () => {
  const { enabled } = await chrome.storage.local.get('enabled');
  setEnabled(!enabled);
});
chrome.runtime.onInstalled.addListener(d => {
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
});
chrome.runtime.onStartup.addListener(async () => {
  const { enabled } = await chrome.storage.local.get('enabled');
  if (enabled) setEnabled(true);
});

async function refreshActive() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  activeTab = t ? t.id : null;
}
chrome.tabs.onActivated.addListener(refreshActive);
chrome.windows.onFocusChanged.addListener(refreshActive);

// keep the pet/camera box a constant physical size while the page zoom changes
chrome.tabs.onZoomChange.addListener(({ tabId, newZoomFactor }) => {
  chrome.tabs.sendMessage(tabId, { src: 'bg', type: 'zoom', factor: newZoomFactor }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.src === 'content' && msg.type === 'cdp') {                   // needs an answer so the pet can report errors
    cdpDo(sender.tab.id, msg).then(() => sendResponse({ ok: true }), e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.src === 'content' && (msg.type === 'listFiles' || msg.type === 'upload')) {
    const job = msg.type === 'listFiles' ? listFiles() : cdpUpload(sender.tab.id, msg.paths).then(() => ({ ok: true }));
    job.then(r => sendResponse(msg.type === 'listFiles' ? { files: r } : r), e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  (async () => {
    if (msg.src === 'engine') await fromEngine(msg);
    else if (msg.src === 'content') await fromContent(msg, sender);
  })().catch(e => console.warn('[HandsFree]', e));
});

async function fromEngine(msg) {   // eslint-disable-line
  if (msg.type === 'ready') {                       // engine just started: hand it the saved settings
    const { sens = 1, preview = true } = await chrome.storage.local.get(['sens', 'preview']);
    chrome.runtime.sendMessage({ dst: 'engine', type: 'sens', value: sens }).catch(() => {});
    chrome.runtime.sendMessage({ dst: 'engine', type: 'preview', value: preview }).catch(() => {});
    return;
  }
  if (msg.type === 'speechFail' && msg.where === 'offscreen') { await openSpeechTab(); return; }   // plan B
  if (msg.type === 'speechFail' && msg.where === 'tab' && /allowed/.test(msg.reason)) {            // needs the one-time permission
    if (!setupOpened) { setupOpened = true; chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') }); }
    msg = { ...msg, type: 'speechHint' };
  }
  if (activeTab == null) await refreshActive();
  if (activeTab == null) return;

  if (msg.type === 'gesture') {                     // two-hand zoom is done here: only the extension can zoom a tab
    if (msg.name === 'zoomStart') zoomBase = await chrome.tabs.getZoom(activeTab);
    if (msg.name === 'zoomMove') {
      if (zoomBase == null) zoomBase = await chrome.tabs.getZoom(activeTab);
      await chrome.tabs.setZoom(activeTab, clamp(zoomBase * msg.ratio, 0.25, 5));
      return;                                       // (not forwarded: too chatty)
    }
    if (msg.name === 'zoomEnd') zoomBase = null;    // fists: the zoom simply stays where it is
  }
  if (msg.type === 'status' && msg.cam === 'error' && msg.name === 'NotAllowedError' && !setupOpened) {
    setupOpened = true; chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
  }
  chrome.tabs.sendMessage(activeTab, msg).catch(() => {                      // no pet on this page (chrome://, new-tab page, still loading)
    if (msg.type === 'speech' && msg.final) bgCommand(msg.text).catch(() => {});
  });
}

async function fromContent(msg, sender) {
  if (msg.type === 'timer') { await timerOp(msg); return; }
  const tab = (sender && sender.tab && sender.tab.id) ?? activeTab;
  if (msg.type === 'zoom') {
    if (tab == null) return;
    const z = await chrome.tabs.getZoom(tab);
    await chrome.tabs.setZoom(tab, msg.dir === 0 ? 1 : clamp(msg.dir > 0 ? z * 1.2 : z / 1.2, 0.25, 5));
  } else if (msg.type === 'getZoom') {
    if (tab == null) return;
    const factor = await chrome.tabs.getZoom(tab);
    chrome.tabs.sendMessage(tab, { src: 'bg', type: 'zoom', factor }).catch(() => {});
  } else if (msg.type === 'recenter') {
    chrome.runtime.sendMessage({ dst: 'engine', type: 'recenter' }).catch(() => {});
  } else if (msg.type === 'sens') {
    const { sens = 1 } = await chrome.storage.local.get('sens');
    const value = clamp(sens + msg.delta, 0.4, 3);
    await chrome.storage.local.set({ sens: value });
    chrome.runtime.sendMessage({ dst: 'engine', type: 'sens', value }).catch(() => {});
  } else if (msg.type === 'tab') {
    await tabOp(sender.tab, msg);
  } else if (msg.type === 'preview') {
    await chrome.storage.local.set({ preview: !!msg.on });
    chrome.runtime.sendMessage({ dst: 'engine', type: 'preview', value: !!msg.on }).catch(() => {});
  }
}

/* ------------------------------------------------------------ trusted input (CDP) */
const attached = new Set();
chrome.debugger.onDetach.addListener(src => attached.delete(src.tabId));
chrome.tabs.onRemoved.addListener(id => attached.delete(id));

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try { await chrome.debugger.attach({ tabId }, '1.3'); }
  catch (e) {
    if (!/already attached/i.test(String(e.message))) throw e;
    // either our own earlier attach (service worker restarted) or DevTools — try it, the command will tell us
  }
  attached.add(tabId);
}
async function detachAll() {
  for (const tabId of [...attached]) { try { await chrome.debugger.detach({ tabId }); } catch {} attached.delete(tabId); }
}
async function cdpDo(tabId, m) {
  await ensureAttached(tabId);
  const cmd = (method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
  if (m.op === 'insert') {
    await cmd('Input.insertText', { text: m.text });
  } else if (m.op === 'key') {
    const base = { key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, nativeVirtualKeyCode: m.vk, modifiers: m.modifiers || 0 };
    const withCmds = m.commands ? { commands: m.commands } : {};
    await cmd('Input.dispatchKeyEvent', m.text ? { type: 'keyDown', text: m.text, ...base } : { type: 'rawKeyDown', ...base, ...withCmds });
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  } else if (m.op === 'click') {
    const p = { x: m.x, y: m.y, button: 'left', clickCount: 1 };
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: m.x, y: m.y });
    await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', ...p });
    await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p });
  } else if (m.op === 'wheel') {
    await cmd('Input.dispatchMouseEvent', { type: 'mouseWheel', x: m.x, y: m.y, deltaX: 0, deltaY: m.dy });
  }
}

// The tab strip / + button / address bar belong to Chrome itself, so an extension can't click them —
// but it CAN open, close and switch tabs. That's what the voice commands use.
async function tabOp(here, msg) {
  const win = here.windowId;
  const tabs = (await chrome.tabs.query({ windowId: win })).filter(t => t.url !== SPEECH_URL).sort((a, b) => a.index - b.index);   // numbering skips the pinned voice tab
  const at = tabs.findIndex(t => t.id === here.id);
    if (msg.op === 'new') await chrome.tabs.create({ windowId: win, url: msg.url || 'https://www.google.com/' });
    else if (msg.op === 'close') await chrome.tabs.remove(here.id);
    else if (msg.op === 'next' && tabs.length > 1) await chrome.tabs.update(tabs[(at + 1) % tabs.length].id, { active: true });
    else if (msg.op === 'prev' && tabs.length > 1) await chrome.tabs.update(tabs[(at - 1 + tabs.length) % tabs.length].id, { active: true });
    else if (msg.op === 'goto') {
      const t = msg.n === -1 ? tabs[tabs.length - 1] : tabs[msg.n - 1];
      if (t) { await chrome.tabs.update(t.id, { active: true }); chrome.tabs.sendMessage(t.id, { src: 'bg', type: 'say', text: '→ tab ' + (tabs.indexOf(t) + 1) + ' of ' + tabs.length }).catch(() => {}); }
      else chrome.tabs.sendMessage(here.id, { src: 'bg', type: 'say', text: 'No tab ' + msg.n + ' — this window has ' + tabs.length + ' tabs' }).catch(() => {});
    }
    else if (msg.op === 'open') await chrome.tabs.create({ windowId: win, url: msg.url });      // new tab, so the document stays open
}

/* ------------------------------------------------------------ "gravy" on every tab
   1. Tabs opened before the extension was (re)loaded have no pet (or a dead one): put a fresh one in.
   2. Pages Chrome forbids extensions to enter (new-tab page, chrome://, Web Store, PDF viewer…) can't show the pet,
      but the voice still works there for tab / navigation / typing-mode commands (bgCommand below). */
async function ensurePet(tab) {
  if (!tab || tab.id == null || !/^(https?|file|ftp):/.test(tab.url || '')) return;
  try { await chrome.tabs.sendMessage(tab.id, { src: 'bg', type: 'ping' }); return; } catch {}
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['shared.js', 'content.js'] }); } catch {}
}
async function ensureAllPets() { for (const t of await chrome.tabs.query({})) await ensurePet(t); }
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const { enabled } = await chrome.storage.local.get('enabled');
  if (enabled) chrome.tabs.get(tabId).then(ensurePet).catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => ensureAllPets());
chrome.runtime.onStartup.addListener(() => setTimeout(ensureAllPets, 1500));
chrome.storage.onChanged.addListener(c => { if (c.enabled && c.enabled.newValue) ensureAllPets(); });

async function bgCommand(text) {
  if (activeTab == null) await refreshActive();
  const here = await chrome.tabs.get(activeTab).catch(() => null);
  if (!here) return;
  for (const p of splitUtterance(text)) {
    if (p.type !== 'cmd') continue;
    const n = p.name, arg = p.arg;
    if (n === 'newTab') await tabOp(here, { op: 'new' });
    else if (n === 'closeTab') await tabOp(here, { op: 'close' });
    else if (n === 'nextTab') await tabOp(here, { op: 'next' });
    else if (n === 'prevTab') await tabOp(here, { op: 'prev' });
    else if (n === 'gotoTab') await tabOp(here, { op: 'goto', n: arg });
    else if (n === 'openSite') await tabOp(here, { op: 'open', url: toUrl(arg) });
    else if (n === 'search') await tabOp(here, { op: 'open', url: searchUrl(arg) });
    else if (n === 'navBack') await chrome.tabs.goBack(here.id).catch(() => {});
    else if (n === 'navForward') await chrome.tabs.goForward(here.id).catch(() => {});
    else if (n === 'reload') await chrome.tabs.reload(here.id);
    else if (n === 'setTimer') await timerOp({ op: 'set', minutes: arg });
    else if (n === 'clearTimer') await timerOp({ op: 'clear' });
    else if (n === 'timeLeft') await timerOp({ op: 'left' });
    else if (n === 'pause') await chrome.storage.local.set({ typing: false });
    else if (n === 'resume') await chrome.storage.local.set({ typing: true });
  }
}


/* ------------------------------------------------------------ file upload without the native file dialog
   The OS "choose a file" window can't be reached by a cursor or by an extension. Instead we put our own list of files
   on the page (content.js) and, when one is picked, hand its path straight to the page's <input type=file>
   with the DevTools protocol (DOM.setFileInputFiles) — the same thing as choosing it in the dialog. */
async function listFiles() {
  const out = [];
  try {                                                   // everything you downloaded lately (live)
    for (const d of await chrome.downloads.search({ orderBy: ['-startTime'], limit: 60, state: 'complete' })) {
      if (d.exists === false || !d.filename || /\.crdownload$/i.test(d.filename)) continue;
      out.push({ path: d.filename, t: Date.parse(d.endTime || d.startTime) || 0 });
    }
  } catch {}
  try {                                                   // Desktop / Documents index made by refresh-files.sh (optional)
    const r = await fetch(chrome.runtime.getURL('files.json'), { cache: 'no-store' });
    if (r.ok) for (const f of ((await r.json()).files || [])) out.push({ path: f.path, t: f.t || 0 });
  } catch {}
  const seen = new Set();
  return out.filter(f => f.path && !seen.has(f.path) && seen.add(f.path)).sort((a, b) => b.t - a.t).slice(0, 80).map(f => {
    const parts = f.path.split(/[\\/]/);
    return { path: f.path, name: parts.pop(), dir: parts.pop() || '', t: f.t };
  });
}
async function cdpUpload(tabId, paths) {
  await ensureAttached(tabId);
  const cmd = (method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
  const { root } = await cmd('DOM.getDocument', { depth: -1, pierce: true });
  const find = n => {                                    // the input the page script tagged with data-hf-file
    const a = n.attributes || [];
    for (let i = 0; i < a.length; i += 2) if (a[i] === 'data-hf-file') return n.nodeId;
    for (const c of [...(n.children || []), ...(n.shadowRoots || []), ...(n.contentDocument ? [n.contentDocument] : [])]) { const r = find(c); if (r) return r; }
    return 0;
  };
  const nodeId = find(root);
  if (!nodeId) throw new Error('upload field not found on the page');
  await cmd('DOM.setFileInputFiles', { files: paths, nodeId });
}


/* ------------------------------------------------------------ assignment timer
   "gravy, there's 30 minutes left" → the deadline is stored (so every tab shows the same clock on the turkey) and
   alarms fire at 15 min ("You better hurry up!"), 3 min ("You're cooked! Submit!") and 0.
   gravy talks with the browser's own text-to-speech; the microphone is muted while it speaks so it never types its own voice. */
const ALERTS = { 'hf-t15': "You better hurry up!", 'hf-t3': "You're cooked! Submit!", 'hf-t0': "Time's up! Submit it now!" };
const sayOnPage = text => { if (activeTab != null) chrome.tabs.sendMessage(activeTab, { src: 'bg', type: 'say', text }).catch(() => {}); };
function muteMic(ms) {
  const until = Date.now() + ms;
  chrome.runtime.sendMessage({ dst: 'speech', type: 'mute', until }).catch(() => {});
  if (activeTab != null) chrome.tabs.sendMessage(activeTab, { src: 'bg', type: 'mute', until }).catch(() => {});
}
// A funny, pompous male professor: a British "Daniel" if the Mac has it, otherwise the next best male voice.
// Slightly slow and low, like someone peering over his glasses. "gravy, change voice" cycles through the ones installed.
const PROF_VOICES = ['Daniel', 'Google UK English Male', 'Arthur', 'Oliver', 'Fred', 'Alex', 'Albert', 'Ralph', 'Bruce'];
async function voiceList() {
  let all = []; try { all = await chrome.tts.getVoices(); } catch {}
  const out = [];
  for (const n of PROF_VOICES) { const v = all.find(x => x.voiceName === n || x.voiceName.startsWith(n + ' ')); if (v && !out.includes(v.voiceName)) out.push(v.voiceName); }
  return out;
}
async function speak(text) {
  muteMic(text.length * 95 + 2800);
  const { voiceName } = await chrome.storage.local.get('voiceName');
  const list = await voiceList();
  const voice = voiceName && list.includes(voiceName) ? voiceName : list[0];
  const { persona } = await chrome.storage.local.get('persona');
  const chef = persona === 'chef';                            // an original furious-chef style: fast, loud, impatient
  const opts = { lang: 'en-US', rate: chef ? 1.25 : 0.9, pitch: chef ? 1.05 : 0.8, volume: 1, onEvent: ev => { if (ev.type === 'end' || ev.type === 'interrupted' || ev.type === 'error') muteMic(1200); } };
  if (voice) { opts.voiceName = voice; if (/UK|Daniel|Arthur|Oliver/.test(voice)) opts.lang = 'en-GB'; }
  try { chrome.tts.stop(); chrome.tts.speak(text, opts); } catch {}
}
const fmtMin = m => { const h = Math.floor(m / 60), r = Math.round(m % 60); return (h ? h + (h === 1 ? ' hour' : ' hours') + (r ? ' ' : '') : '') + (r || !h ? r + (r === 1 ? ' minute' : ' minutes') : ''); };
async function timerOp(msg) {
  if (activeTab == null) await refreshActive();
  if (msg.op === 'set') {
    const now = Date.now(), deadline = now + msg.minutes * 60000;
    await chrome.alarms.clearAll();
    await chrome.storage.local.set({ deadline, timerMins: msg.minutes });
    for (const [name, left] of [['hf-t15', 15], ['hf-t3', 3], ['hf-t0', 0]]) {
      const when = deadline - left * 60000;
      if (when > now + 2000) chrome.alarms.create(name, { when });
    }
    sayOnPage('⏱ ' + fmtMin(msg.minutes) + ' — I’ll keep time!');
    speak('Got it. ' + fmtMin(msg.minutes) + ' left. Let\'s go!');
  } else if (msg.op === 'persona') {
    await chrome.storage.local.set({ persona: msg.value });
    sayOnPage(msg.value === 'chef' ? '👨‍🍳 Angry chef mode' : '🎓 Professor mode');
    speak(msg.value === 'chef' ? 'Right! Let us get this assignment done! Move it!' : 'Splendid! Back to the lecture hall.');
  } else if (msg.op === 'voice') {
    const list = await voiceList(); if (!list.length) { sayOnPage('No other voices found'); return; }
    const { voiceName } = await chrome.storage.local.get('voiceName');
    const next = list[(list.indexOf(voiceName) + 1) % list.length];
    await chrome.storage.local.set({ voiceName: next });
    sayOnPage('🗣 Voice: ' + next); speak('Splendid! How do I sound, my dear student?');
  } else if (msg.op === 'clear') {
    await chrome.alarms.clearAll(); await chrome.storage.local.remove(['deadline', 'timerMins']);
    sayOnPage('⏱ Timer cleared'); speak('Timer cleared.');
  } else if (msg.op === 'left') {
    const { deadline } = await chrome.storage.local.get('deadline');
    const m = deadline ? Math.max(0, (deadline - Date.now()) / 60000) : null;
    const text = m == null ? 'There is no timer. Say: gravy, there are 30 minutes left.' : m < 1 ? 'Less than a minute left!' : 'About ' + fmtMin(Math.round(m)) + ' left.';
    sayOnPage('⏱ ' + text); speak(text);
  }
}
chrome.alarms.onAlarm.addListener(async a => {
  const text = ALERTS[a.name]; if (!text) return;
  if (activeTab == null) await refreshActive();
  const { persona } = await chrome.storage.local.get('persona');
  const spoken = persona === 'chef' ? ({ 'hf-t15': 'Come on! You better hurry up!', 'hf-t3': "You're cooked! Submit! Now!", 'hf-t0': 'Time is up! Submit it! Now!' })[a.name] : 'Ahem! ' + text;
  sayOnPage('⏰ ' + text); speak(spoken);
});
