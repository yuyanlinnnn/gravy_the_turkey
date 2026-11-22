/* Shared, DOM-free logic. Loaded as a classic script by BOTH the content script and the
   engine (offscreen) page, so everything here lives in the global scope. */

const hfClamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Every command is spoken after the wake word:  "gravy, undo"  (see parseWake / parseCommand below)
const COMMANDS = {
  undo:        ['undo', 'undo that'],
  redo:        ['redo', 're do', 'redo that'],
  deleteThat:  ['delete that', 'scratch that', 'delete last', 'remove that'],
  deleteWord:  ['delete', 'delete word', 'delete last word', 'backspace'],
  selectAll:   ['select all', 'select everything'],
  deleteSel:   ['delete selection', 'delete selected'],
  bold:        ['bold'],
  italic:      ['italic', 'italics'],
  underline:   ['underline'],
  copyAll:     ['copy all', 'copy everything'],
  paste:       ['paste'],
  zoomIn:      ['zoom in', 'bigger', 'make it bigger', 'larger'],
  zoomOut:     ['zoom out', 'smaller', 'make it smaller'],
  zoomReset:   ['reset zoom', 'zoom reset', 'normal size'],
  click:       ['click', 'left click'],
  enter:       ['enter', 'press enter', 'return', 'submit'],
  recenter:    ['recenter', 're center', 'center', 'calibrate'],
  cursorFaster:['cursor faster', 'faster cursor', 'speed up'],
  cursorSlower:['cursor slower', 'slower cursor', 'slow down'],
  scrollDown:  ['scroll down', 'page down'],
  scrollUp:    ['scroll up', 'page up'],
  goStart:     ['go to start', 'go to the start', 'go to top', 'go to the top'],
  goEnd:       ['go to end', 'go to the end', 'go to bottom', 'go to the bottom'],
  navBack:     ['go back', 'back'],
  navForward:  ['go forward', 'forward'],
  reload:      ['reload', 'refresh', 'reload page', 'refresh page'],
  newTab:      ['new tab', 'open new tab', 'open a new tab'],
  closeTab:    ['close tab', 'close this tab'],
  nextTab:     ['next tab', 'right tab'],
  prevTab:     ['previous tab', 'left tab'],
  pause:       ['stop typing', 'pause typing', 'stop listening', 'pause listening', 'mute', 'go to sleep'],
  resume:      ['start typing', 'resume typing', 'start listening', 'resume listening', 'resume', 'listen', 'wake up'],
  help:        ['help', 'show commands', 'show help'],
  upload:      ['upload', 'upload file', 'upload a file', 'choose file', 'choose a file', 'attach file', 'attach a file', 'attach', 'browse files', 'show files', 'select file'],
  walkOn:      ['walk', 'walk around', 'go for a walk', 'start walking', 'wander', 'go walk'],
  walkOff:     ['stop walking', 'stay', 'stay here', 'sit', 'sit down', 'stand still', 'stop wandering'],
  changeVoice: ['change voice', 'next voice', 'different voice', 'new voice', 'switch voice'],
  chefVoice:   ['chef voice', 'angry chef', 'chef mode', 'angry voice', 'angry chef voice'],
  professorVoice: ['professor voice', 'professor mode', 'normal voice'],
  cancelPick:  ['cancel', 'never mind', 'nevermind', 'close list', 'close files', 'cancel upload'],
};

function normalizeCmd(raw) {
  return raw.toLowerCase().replace(/[.,!?;:]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function matchCommand(raw) {
  const t = normalizeCmd(raw);
  for (const [name, list] of Object.entries(COMMANDS)) if (list.includes(t)) return name;
  return null;
}

// Wake word. Speech recognition spells it a few ways, so accept the usual ones.
const WAKE_RE = /^\s*(?:hey\s+|ok\s+|okay\s+)?(?:gravy|gravey|gravi|grave\s?y|gray\s?vy|grady)\b[\s,.:;!?-]*/i;
// "Gravy, undo."  → { rest: 'undo.' }      "just some text" → null      "Gravy" alone → { rest: '' }
function parseWake(raw) {
  const m = raw.match(WAKE_RE);
  return m ? { rest: raw.slice(m[0].length) } : null;
}
const NUMS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twice: 2 };
const REPEATABLE = new Set(['undo', 'redo', 'deleteWord', 'scrollDown', 'scrollUp', 'zoomIn', 'zoomOut', 'cursorFaster', 'cursorSlower']);
// "undo three times" → { name:'undo', count:3 }
const TABNUM = { one: 1, won: 1, first: 1, two: 2, to: 2, too: 2, second: 2, three: 3, free: 3, third: 3, four: 4, for: 4, fourth: 4, five: 5, fifth: 5, six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, ate: 8, eighth: 8, nine: 9, ninth: 9, ten: 10, tenth: 10, last: -1 };

/* ---- "there's 30 minutes left for my assignment" -> 30 ---- */
const WORDN = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
                sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90 };
function parseDuration(text) {
  let t = ' ' + text.toLowerCase().replace(/[,]/g, ' ').replace(/-/g, ' ') + ' ';
  t = t.replace(/\b(half an hour|half hour)\b/g, ' 30 minutes ').replace(/\b(an hour and a half|hour and a half)\b/g, ' 90 minutes ')
       .replace(/\b(a quarter of an hour|quarter of an hour|quarter hour)\b/g, ' 15 minutes ');
  t = t.replace(/\b(twenty|thirty|forty|fifty|sixty)\s+(one|two|three|four|five|six|seven|eight|nine)\b/g, (_, a, b) => ' ' + (WORDN[a] + WORDN[b]) + ' ');
  t = t.replace(/\b(a|an)\s+(hour|minute|min)\b/g, ' 1 $2');
  t = t.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|ninety)\b/g, w => ' ' + WORDN[w] + ' ');
  let total = 0, found = false, m;
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/g;
  while ((m = re.exec(t))) { found = true; total += parseFloat(m[1]) * (/^h/.test(m[2]) ? 60 : 1); }
  return found && total > 0 && total <= 600 ? Math.round(total * 10) / 10 : null;
}
function parseCommand(rest) {
  const t = normalizeCmd(rest).replace(/^please\s+/, '');
  if (!t) return { empty: true, name: null, count: 1 };
  let name = matchCommand(t);
  if (name) return { name, count: 1 };
  // commands with an argument (keep dots, so "docs.google.com" survives)
  const lt = rest.toLowerCase().trim().replace(/[,!?;:]+/g, ' ').replace(/\s+/g, ' ').replace(/\.$/, '').replace(/^please\s+/, '');
  if (/^(?:cancel|stop|clear|remove|forget|reset)\b.*\btimer\b/.test(lt)) return { name: 'clearTimer', count: 1 };
  if (/^(?:how much time|how long|time left|what.?s the time left|how many minutes)/.test(lt)) return { name: 'timeLeft', count: 1 };
  if (/\b(left|remaining|timer|due|deadline|to go|have|got|only)\b/.test(lt) && !/^(?:search|google|open|go to|visit|upload|attach|tab)/.test(lt)) {
    const dur = parseDuration(lt); if (dur) return { name: 'setTimer', arg: dur, count: 1 };
  }
  let a = lt.match(/^(?:go to |goto |switch to |open |show )?(?:tab|tap|tabs)\s*(?:number\s+|no\.?\s*|#)?(\d+|[a-z]+)$/);
  if (!a) a = lt.match(/^(?:go to |goto |switch to |open |show )?(?:the )?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\s+tab$/);
  if (a) { const n = /^\d+$/.test(a[1]) ? parseInt(a[1], 10) : TABNUM[a[1]]; if (n) return { name: 'gotoTab', arg: n, count: 1 }; }
  a = lt.match(/^(?:file|number|option|pick|choose|select|upload|attach)\s*(?:file\s*|number\s*)?(\d+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|one|two|three|four|five|six|seven|eight|nine|ten|to|too|for|won|free|ate)$/);
  if (a) { const n = /^\d+$/.test(a[1]) ? parseInt(a[1], 10) : TABNUM[a[1]]; if (n > 0) return { name: 'pickFile', arg: n, count: 1 }; }
  a = lt.match(/^(?:upload|attach)\s+(?:the\s+|my\s+)?(?:file\s+)?(?:called\s+|named\s+)?(.+)$/);
  if (a) return { name: 'uploadNamed', arg: a[1], count: 1 };
  a = lt.match(/^(?:search for|search|google)\s+(.+)$/);
  if (a) return { name: 'search', arg: a[1], count: 1 };
  a = lt.match(/^(?:go to|open|visit)\s+(.+)$/);
  if (a) return { name: 'openSite', arg: a[1], count: 1 };
  const m = t.match(/^(.*?)\s*(?:x\s*)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twice)(?:\s+times?)?$/);
  if (m) {
    name = matchCommand(m[1]);
    if (name && REPEATABLE.has(name)) return { name, count: hfClamp(NUMS[m[2]] || parseInt(m[2], 10), 1, 10) };
  }
  return { name: null, count: 1 };
}

// "docs dot google dot com" / "docs.google.com" / "google com" → https URL, otherwise a Google search
function toUrl(arg) {
  const a = arg.trim().replace(/\s+dot\s+/g, '.').replace(/\s+slash\s+/g, '/');
  const compact = a.replace(/\s+/g, '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(compact)) return 'https://' + compact;
  const m = a.match(/^([a-z0-9-]+) (com|org|edu|net|gov|io)$/);
  if (m) return 'https://' + m[1] + '.' + m[2];
  return 'https://www.google.com/search?q=' + encodeURIComponent(arg.trim());
}
// "google dot com and some more" → site "google dot com", rest "and some more"
function trimSiteArg(arg) {
  const w = arg.trim().split(/\s+/);
  if (w[0].includes('.')) return { site: w[0], rest: w.slice(1).join(' ') };
  if (w[1] === 'dot') {
    let j = 0, site = w[0];
    while (w[j + 1] === 'dot' && w[j + 2]) { site += ' dot ' + w[j + 2]; j += 2; }
    return { site, rest: w.slice(j + 1).join(' ') };
  }
  if (/^(com|org|edu|net|gov|io)$/.test(w[1] || '')) return { site: w[0] + ' ' + w[1], rest: w.slice(2).join(' ') };
  return { site: arg.trim(), rest: '' };
}
function searchUrl(q) { return 'https://www.google.com/search?q=' + encodeURIComponent(q.trim()); }

// Speech recognition often glues several phrases into one result ("delete gravy undo you should sell gravy lock").
// Split it into pieces:  text | wake (a lone "gravy") | cmd {name,count,arg} | unknown.
// After "gravy", the LONGEST leading run of words that forms a known command is the command; the rest is text again.
const WAKE_G = /(?:\b(?:hey|ok|okay)\s+)?\b(?:gravy|gravey|gravi|grave\s?y|gray\s?vy|grady)\b[\s,.:;!?-]*/gi;
function splitUtterance(raw) {
  const wakes = []; let m; WAKE_G.lastIndex = 0;
  while ((m = WAKE_G.exec(raw))) wakes.push({ start: m.index, end: m.index + m[0].length });
  if (!wakes.length) return [{ type: 'text', text: raw }];
  const parts = [];
  const pre = raw.slice(0, wakes[0].start);
  if (pre.trim()) parts.push({ type: 'text', text: pre });
  wakes.forEach((w, i) => {
    const seg = raw.slice(w.end, i + 1 < wakes.length ? wakes[i + 1].start : raw.length);
    const words = seg.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { parts.push({ type: 'wake' }); return; }
    const whole = parseCommand(seg);
    if (whole.name === 'search') { parts.push({ type: 'cmd', ...whole }); return; }                 // a search swallows the rest
    if (whole.name === 'openSite') {                                                                  // a site name ends where the address ends
      const t = trimSiteArg(whole.arg);
      parts.push({ type: 'cmd', name: 'openSite', arg: t.site, count: 1 });
      if (t.rest) parts.push({ type: 'text', text: t.rest });
      return;
    }
    for (let k = Math.min(words.length, 7); k >= 1; k--) {
      const c = parseCommand(words.slice(0, k).join(' '));
      if (c.name) {
        parts.push({ type: 'cmd', ...c });
        const rest = words.slice(k).join(' ');
        if (rest) parts.push({ type: 'text', text: rest });
        return;
      }
    }
    parts.push({ type: 'unknown', text: seg.trim() });
  });
  return parts;
}

const PUNCT_RULES = [
  [/\s*\bnew paragraph\b\s*/gi, '\n\n'],
  [/\s*\bnew line\b\s*/gi, '\n'],
  [/\s*\b(?:period|full stop)\b/gi, '.'],
  [/\s*\bcomma\b/gi, ','],
  [/\s*\bquestion mark\b/gi, '?'],
  [/\s*\bexclamation (?:point|mark)\b/gi, '!'],
  [/\s*\bsemicolon\b/gi, ';'],
  [/\s*\bcolon\b/gi, ':'],
];

// Turn a spoken phrase into text that fits after `before` (the text left of the caret).
function formatDictation(raw, before) {
  let t = raw.trim();
  if (!t) return '';
  for (const [re, rep] of PUNCT_RULES) t = t.replace(re, rep);
  t = t.replace(/\bi\b/g, 'I');
  t = t.replace(/([.!?]\s+|\n\s*)([a-z])/g, (m, a, b) => a + b.toUpperCase());
  const sentenceStart = before.trim() === '' || /[.!?]\s*$/.test(before) || /\n\s*$/.test(before);
  if (sentenceStart) t = t.replace(/^(\s*)([a-z])/, (m, a, b) => a + b.toUpperCase());
  const needSpace = before.length > 0 && !/\s$/.test(before) && !/^[\s.,;:?!]/.test(t);
  return (needSpace ? ' ' : '') + t;
}

function wordStartBefore(text, pos) {
  let i = pos;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

// One-Euro filter: smooths jitter when still, stays responsive when moving fast.
class OneEuro {
  constructor(minCut = 1.5, beta = 8, dCut = 1) { Object.assign(this, { minCut, beta, dCut, t: null, x: 0, dx: 0 }); }
  alpha(cut, dt) { const tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt); }
  reset() { this.t = null; }
  filter(x, tMs) {
    const t = tMs / 1000;
    if (this.t == null) { this.t = t; this.x = x; this.dx = 0; return x; }
    const dt = Math.max(t - this.t, 1e-3);
    const dx = (x - this.x) / dt;
    this.dx += this.alpha(this.dCut, dt) * (dx - this.dx);
    const a = this.alpha(this.minCut + this.beta * Math.abs(this.dx), dt);
    this.x += a * (x - this.x);
    this.t = t;
    return this.x;
  }
}

if (typeof module !== 'undefined') module.exports = { parseDuration, COMMANDS, matchCommand, parseWake, parseCommand, splitUtterance, toUrl, searchUrl, trimSiteArg, formatDictation, wordStartBefore, OneEuro, hfClamp };
