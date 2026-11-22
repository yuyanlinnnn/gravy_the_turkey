/* The engine: runs in a hidden offscreen document (the only place an MV3 extension can keep a camera open).
   It does ALL the vision + gesture logic and emits small messages:
     {type:'cursor',  x, y, lost, pinch, centering, pose, lm:{hands:[[[x,y]..21]], nose:[x,y]|null}}   ~30/s
     {type:'gesture', name:'click'|'undo'|'redo'|'scroll'|'zoomStart'|'zoomMove'|'zoomEnd', dir?, ratio?}
     {type:'frame',   jpg}            small camera thumbnail for the preview box (~10/s, only if preview is on)
     {type:'status',  cam, head, hands, name?}

   GESTURES
     head                      → cursor
     pinch (thumb+index)       → click
     ONE finger up / down      → scroll up / down   (head no longer scrolls)
     TWO open hands apart      → zoom in            together → zoom out
     TWO fists                 → lock the zoom where it is (open hands again = start a new zoom)
     open-hand swipe ← / →     → undo / redo                                                          */

const send = m => chrome.runtime.sendMessage({ src: 'engine', ...m }).catch(() => {});
const video = document.getElementById('cam');
const cfg = { sens: 1, preview: true };
const head = { center: null, centerAt: 0, recenter: false, fx: new OneEuro(), fy: new OneEuro(), lastSeen: 0 };
const hand = { frames: 0, count: 0, pinched: false, lastClick: 0, swipe: [], lastSwipe: 0,
               zooming: false, openFrames: 0, pointFrames: 0, baseGap: 1, ratio: 1 };
let W = 640, H = 480, cur = { x: 0.5, y: 0.5 };

chrome.runtime.onMessage.addListener(msg => {
  if (msg.dst !== 'engine') return;
  if (msg.type === 'recenter') head.recenter = true;
  if (msg.type === 'sens') cfg.sens = msg.value;
  if (msg.type === 'preview') cfg.preview = !!msg.value;
});

const dist = (a, b) => Math.hypot((a.x - b.x) * W, (a.y - b.y) * H);
const FINGERS = [[8, 6], [12, 10], [16, 14], [20, 18]];            // [tip, pip] for index..pinky
const pinchRatio = l => dist(l[4], l[8]) / Math.max(dist(l[0], l[9]), 1);
const extended = (l, tip, pip) => dist(l[tip], l[0]) > dist(l[pip], l[0]) * 1.15;
const curled = (l, tip, pip) => dist(l[tip], l[0]) < dist(l[pip], l[0]) * 1.05;
const openPalm = l => FINGERS.every(([t, p]) => extended(l, t, p));
const isFist = l => FINGERS.every(([t, p]) => curled(l, t, p));
const isPoint = l => extended(l, 8, 6) && FINGERS.slice(1).every(([t, p]) => curled(l, t, p));
// +1 = pointing down, -1 = pointing up, 0 = sideways / unclear (image y grows downward)
function pointDir(l) {
  const dy = (l[8].y - l[5].y) * H, dx = (l[8].x - l[5].x) * W;
  if (Math.abs(dy) < Math.abs(dx) * 1.2) return 0;
  return dy < 0 ? -1 : 1;
}
const gesture = (name, extra) => send({ type: 'gesture', name, ...extra });

function updateHead(face, now) {
  if (!face) return false;
  head.lastSeen = now;
  const n = face[1];                                   // landmark 1 = nose tip
  if (head.recenter || !head.center) {
    if (!head.centerAt) head.centerAt = now + 1500;    // 1.5 s to look at the middle of the screen
    if (now < head.centerAt) return true;
    head.center = { x: n.x, y: n.y }; head.centerAt = 0; head.recenter = false;
    head.fx.reset(); head.fy.reset();
    return true;
  }
  const gx = 11 * cfg.sens, gy = 14 * cfg.sens;
  const nx = hfClamp(0.5 + (head.center.x - n.x) * gx, 0, 1);   // raw camera image isn't mirrored → flip x
  const ny = hfClamp(0.5 + (n.y - head.center.y) * gy, 0, 1);
  cur = { x: head.fx.filter(nx, now), y: head.fy.filter(ny, now) };
  return true;
}

// returns { pinch: bool, pose: string }
function updateHands(hands, now) {
  if (hands.length !== hand.count) { hand.count = hands.length; hand.frames = 0; hand.swipe = []; hand.openFrames = 0; hand.pointFrames = 0; }
  hand.frames++;

  /* ---- two hands: open + apart/together = zoom, two fists = lock ---- */
  if (hands.length >= 2) {
    hand.pinched = false;
    const [a, b] = hands, gap = dist(a[9], b[9]) / W;
    const open = openPalm(a) && openPalm(b), fists = isFist(a) && isFist(b);
    if (fists) {
      hand.openFrames = 0;
      if (hand.zooming) { hand.zooming = false; gesture('zoomEnd'); }       // size stays exactly where it is
      return { pinch: false, pose: '✊✊ zoom locked' };
    }
    if (open) {
      hand.openFrames++;
      if (!hand.zooming && hand.openFrames >= 5) { hand.zooming = true; hand.baseGap = Math.max(gap, 0.05); hand.ratio = 1; gesture('zoomStart'); }
      else if (hand.zooming) { hand.ratio += (gap / hand.baseGap - hand.ratio) * 0.35; gesture('zoomMove', { ratio: hand.ratio }); }
      return { pinch: false, pose: hand.zooming ? '🖐🖐 zooming' : '🖐🖐 hold steady…' };
    }
    hand.openFrames = 0;                                                    // in-between pose: hold the current zoom
    return { pinch: false, pose: '2 hands' };
  }
  hand.openFrames = 0;
  if (hand.zooming) { hand.zooming = false; gesture('zoomEnd'); }
  if (hands.length === 0) { hand.pinched = false; return { pinch: false, pose: '' }; }

  /* ---- one hand ---- */
  const l = hands[0], ratio = pinchRatio(l);

  if (isPoint(l) && pointDir(l) !== 0) {                    // one finger up / down → scroll
    hand.pointFrames++; hand.pinched = false; hand.swipe = [];
    const dir = pointDir(l);
    if (hand.pointFrames >= 3) gesture('scroll', { dir });
    return { pinch: false, pose: dir < 0 ? '☝ scroll up' : '👇 scroll down' };
  }
  hand.pointFrames = 0;

  if (!hand.pinched && ratio < 0.30 && hand.frames >= 5 && now - hand.lastClick > 500) {
    hand.pinched = true; hand.lastClick = now; gesture('click');
  } else if (hand.pinched && ratio > 0.45) hand.pinched = false;

  let pose = ratio < 0.45 ? '🤏 pinch' : isFist(l) ? '✊ fist' : openPalm(l) ? '🖐 open' : '✋ hand';
  if (!hand.pinched && ratio > 0.5 && openPalm(l)) {        // open-hand swipe = undo / redo
    hand.swipe.push({ t: now, x: 1 - l[0].x });
    while (hand.swipe.length && now - hand.swipe[0].t > 400) hand.swipe.shift();
    if (hand.swipe.length >= 4 && hand.frames >= 8 && now - hand.lastSwipe > 1200) {
      const dx = hand.swipe[hand.swipe.length - 1].x - hand.swipe[0].x;
      if (Math.abs(dx) > 0.28) { hand.lastSwipe = now; hand.swipe = []; gesture(dx > 0 ? 'redo' : 'undo'); }
    }
  } else hand.swipe = [];
  return { pinch: ratio < 0.45, pose };
}

async function main() {
  send({ type: 'status', cam: 'loading' });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
  } catch (e) { return send({ type: 'status', cam: 'error', name: e.name }); }
  video.srcObject = stream; await video.play();
  W = video.videoWidth || 640; H = video.videoHeight || 480;

  let vision;
  try { vision = await import('./vendor/vision_bundle.mjs'); }
  catch { return send({ type: 'status', cam: 'error', name: 'AssetsMissing' }); }
  try {
    const fileset = await vision.FilesetResolver.forVisionTasks(chrome.runtime.getURL('vendor/wasm'));
    const make = async (Cls, model, extra) => {
      const base = { modelAssetPath: chrome.runtime.getURL(model) };
      try { return await Cls.createFromOptions(fileset, { baseOptions: { ...base, delegate: 'GPU' }, runningMode: 'VIDEO', ...extra }); }
      catch { return await Cls.createFromOptions(fileset, { baseOptions: { ...base, delegate: 'CPU' }, runningMode: 'VIDEO', ...extra }); }
    };
    const handLm = await make(vision.HandLandmarker, 'vendor/models/hand_landmarker.task', { numHands: 2 });
    const faceLm = await make(vision.FaceLandmarker, 'vendor/models/face_landmarker.task', { numFaces: 1 });
    send({ type: 'ready' });

    const thumb = document.createElement('canvas'); thumb.width = 192; thumb.height = 144;
    const tctx = thumb.getContext('2d');
    const r3 = v => Math.round(v * 1000) / 1000;
    let lastVT = -1, lastStatus = 0, lastFrame = 0;
    // setInterval, not rAF: this document is hidden, and rAF can be throttled there.
    setInterval(() => {
      if (video.readyState < 2 || video.currentTime === lastVT) return;
      lastVT = video.currentTime;
      const now = performance.now();
      let h, f;
      try { h = handLm.detectForVideo(video, now); f = faceLm.detectForVideo(video, now); } catch (e) { return; }
      const hands = h.landmarks || [], face = (f.faceLandmarks || [])[0] || null;
      const seen = updateHead(face, now);
      const { pinch, pose } = updateHands(hands, now);
      const lost = !seen && now - head.lastSeen > 600;
      const lm = { hands: hands.map(hh => hh.map(p => [r3(p.x), r3(p.y)])), nose: face ? [r3(face[1].x), r3(face[1].y)] : null };
      send({ type: 'cursor', x: cur.x, y: cur.y, lost, pinch, pose, lm, centering: !!head.centerAt });
      if (cfg.preview && now - lastFrame > 125) {
        lastFrame = now; tctx.drawImage(video, 0, 0, 192, 144);
        send({ type: 'frame', jpg: thumb.toDataURL('image/jpeg', 0.5) });
      }
      if (now - lastStatus > 2000) { lastStatus = now; send({ type: 'status', cam: 'ready', head: !lost, hands: hands.length }); }
    }, 33);
  } catch (e) {
    console.error(e); send({ type: 'status', cam: 'error', name: 'ModelError', msg: String(e.message || e) });
  }
}
main();
