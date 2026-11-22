/* Speech recognition lives HERE (extension page) instead of in each website, so the microphone permission
   is granted once for the whole extension and new tabs never ask again. Results go to the active tab. */
(() => {
  const where = /speech\.html$/.test(location.pathname) ? 'tab' : 'offscreen';
  const send = m => chrome.runtime.sendMessage({ src: 'engine', where, ...m }).catch(() => {});
  const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
  if (!SR) { send({ type: 'speechFail', reason: 'unsupported' }); return; }
  let rec = null, fails = 0, lastStart = 0, muteUntil = 0;
  chrome.runtime.onMessage.addListener(m => { if (m && m.dst === 'speech' && m.type === 'mute') muteUntil = Math.max(muteUntil, m.until); });   // gravy is talking: don't listen to it
  function start() {
    if (rec) return;
    rec = new SR(); rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = true;
    rec.onstart = () => { lastStart = Date.now(); send({ type: 'speechOn', on: true }); };
    rec.onresult = e => {
      if (Date.now() < muteUntil) return;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        send({ type: 'speech', final: r.isFinal, idx: i, text: r[0].transcript });
      }
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { send({ type: 'speechFail', reason: e.error }); if (where === 'tab') { setTimeout(() => { if (!rec) start(); }, 4000); } else fails = 99; }
      else if (e.error === 'network') send({ type: 'speechNet' });
    };
    rec.onend = () => {
      rec = null; send({ type: 'speechOn', on: false });
      if (fails >= 5 || (fails === 99)) return;
      if (Date.now() - lastStart < 800) fails++; else fails = 0;     // instantly ending = broken here -> content falls back
      if (fails >= 5) { send({ type: 'speechFail', reason: 'unstable' }); return; }
      setTimeout(start, 150);
    };
    try { rec.start(); } catch { rec = null; fails++; setTimeout(start, 1000); }
  }
  start();
  setInterval(() => { if (!rec && fails < 5) start(); }, 3000);
})();
