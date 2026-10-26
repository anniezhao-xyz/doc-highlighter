/* Doc Highlighter: find words on a document page and animate a marker swipe over them.
 * Pipeline: file -> page bitmap + word boxes (PDF text layer or OCR) -> bars -> schedule -> frames.
 */
'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const SWATCHES = ['#88c9d7', '#02a3bc', '#e8ac76', '#dc6c00']; // first one is the default
const PDF_RENDER_WIDTH = 2400; // page bitmap width in px; word boxes live in this space

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');

const state = {
  fileName: 'document',
  pdf: null,
  pageNum: 1,
  page: null,      // canvas holding the rendered page
  words: [],       // reading-order words: {text, norm, x0, y0, x1, y1, line}
  lines: [],       // {y0, y1}
  source: '',      // 'pdf' | 'ocr'
  bars: [],        // {id, group, phrase, text, x0, y0, x1, y1, manual}
  selected: null,
  mode: 'edit',
  time: 0,
  playing: false,
  busy: false,
  ocrWorker: null,
  editView: null,
  drag: null,
  pan: { x: 0, y: 0 }, // framing offset in page px, set by dragging the preview
  zoom: 1,             // multiplier on the automatic framing scale
  panDrag: null,
  endEdits: {},        // barKey -> adjusted x1 (page px)
  endDrag: null,
  darkPage: false,
};
let nextId = 1;

/* ---------- settings ---------- */

function settings() {
  const [w, h] = $('aspect').value.split('x').map(Number);
  return {
    color: $('color').value,
    opacity: +$('opacity').value,
    leadIn: +$('leadIn').value,
    swipe: +$('swipe').value,
    gap: +$('gap').value,
    hold: +$('hold').value,
    order: $('order').value,
    width: w,
    height: h,
    fps: +$('fps').value,
    framing: $('framing').value,
    bg: $('bg').value,
    blend: $('blend').value === 'auto' ? (state.darkPage ? 'screen' : 'multiply') : $('blend').value,
    scaleLen: $('scaleLen').checked,
    posterize: +$('posterize').value,
  };
}

const CANVAS_BLEND = { multiply: 'multiply', screen: 'screen', normal: 'source-over' };
const BLEND_LABEL = { multiply: 'Multiply', screen: 'Screen', normal: 'Normal' };

/* A page is "dark mode" if its average brightness is low (light text on a dark background). */
function detectDarkPage() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = Math.max(1, Math.round((64 * state.page.height) / state.page.width));
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(state.page, 0, 0, c.width, c.height);
  const px = cx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  state.darkPage = sum / (px.length / 4) < 110;
  $('blend').options[0].textContent = `Auto (${state.darkPage ? 'Screen, dark page detected' : 'Multiply, light page detected'})`;
}

function setStatus(msg) { $('status').textContent = msg; }

/* ---------- loading ---------- */

async function loadFile(file) {
  if (state.busy) return;
  state.busy = true;
  try {
    state.fileName = file.name.replace(/\.[^.]+$/, '') || 'document';
    $('dropTitle').textContent = file.name;
    $('dropSub').textContent = 'Click or drop to replace';
    state.bars = [];
    state.selected = null;
    state.pan = { x: 0, y: 0 };
    state.zoom = 1;
    state.endEdits = {};
    syncZoomSlider();
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      setStatus('Opening PDF…');
      const data = new Uint8Array(await file.arrayBuffer());
      state.pdf = await pdfjsLib.getDocument({ data }).promise;
      $('pageNum').max = state.pdf.numPages;
      $('pageNum').value = 1;
      $('pageCount').textContent = `of ${state.pdf.numPages}`;
      $('pageRow').hidden = state.pdf.numPages < 2;
      await loadPdfPage(1);
    } else {
      state.pdf = null;
      $('pageRow').hidden = true;
      setStatus('Opening image…');
      const img = await loadImage(file);
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const cx = c.getContext('2d');
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, c.width, c.height);
      cx.drawImage(img, 0, 0);
      state.page = c;
      await runOcr();
    }
    afterPageLoaded();
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't open that file: ${err.message || err}`);
  } finally {
    state.busy = false;
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not a readable image')); };
    img.src = url;
  });
}

async function loadPdfPage(n) {
  state.pageNum = n;
  setStatus(`Rendering page ${n}…`);
  const page = await state.pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(5, PDF_RENDER_WIDTH / base.width) });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width);
  c.height = Math.floor(vp.height);
  const cx = c.getContext('2d');
  cx.fillStyle = '#fff';
  cx.fillRect(0, 0, c.width, c.height);
  // 'print' intent renders without requestAnimationFrame, so it doesn't stall in a background tab.
  await page.render({ canvasContext: cx, viewport: vp, intent: 'print' }).promise;
  state.page = c;

  const words = extractPdfWords(await page.getTextContent(), vp);
  if (words.length < 5 || $('forceOcr').checked) {
    await runOcr();
  } else {
    setWords(words, 'pdf');
  }
}

/* PDF text items are runs of text (often a whole line). Split them into words and estimate
 * each word's x-range by measuring substrings in a similar font, scaled to the run's real width. */
function extractPdfWords(tc, vp) {
  const m = document.createElement('canvas').getContext('2d');
  const out = [];
  for (const item of tc.items) {
    if (!item.str || !item.str.trim()) continue;
    const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
    const fh = Math.hypot(tx[2], tx[3]);
    if (fh < 2 || Math.abs(tx[1]) > fh * 0.05) continue; // skip tiny or rotated text
    const runW = item.width * vp.scale;
    const style = tc.styles[item.fontName] || {};
    m.font = `100px ${style.fontFamily || 'sans-serif'}`;
    const full = m.measureText(item.str).width || 1;
    const k = runW / full;
    const x = tx[4];
    const baseline = tx[5];
    const y0 = baseline - fh * 0.8;
    const y1 = baseline + fh * 0.2;
    const re = /\S+/g;
    let mt;
    while ((mt = re.exec(item.str))) {
      const before = m.measureText(item.str.slice(0, mt.index)).width;
      const ww = m.measureText(mt[0]).width;
      out.push({
        text: mt[0],
        x0: x + before * k,
        x1: x + (before + ww) * k,
        y0, y1,
        startsRun: mt.index === 0,
        endsRun: mt.index + mt[0].length === item.str.length,
      });
    }
  }
  return out;
}

async function runOcr() {
  state.source = 'ocr';
  setStatus('Reading text with OCR (first run downloads ~10 MB)…');
  if (!state.ocrWorker) {
    state.ocrWorker = await Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') setStatus(`Reading text with OCR… ${Math.round(m.progress * 100)}%`);
      },
    });
  }
  const { data } = await state.ocrWorker.recognize(state.page);
  const words = (data.words || [])
    .filter((w) => w.text.trim() && w.confidence > 15)
    .map((w) => ({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }));
  setWords(words, 'ocr');
}

/* Group words into lines (by vertical center), order them for reading, and glue together
 * word fragments that pdf.js split across separate text runs. */
function setWords(raw, source) {
  state.source = source;
  const sorted = raw.slice().sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const lines = [];
  for (const w of sorted) {
    const cy = (w.y0 + w.y1) / 2;
    const h = w.y1 - w.y0;
    let line = null;
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
      if (Math.abs(lines[i].cy - cy) < Math.max(h, lines[i].h) * 0.45) { line = lines[i]; break; }
    }
    if (!line) { line = { cy, h, words: [] }; lines.push(line); }
    line.words.push(w);
  }

  state.lines = [];
  state.words = [];
  lines.sort((a, b) => a.cy - b.cy);
  for (const line of lines) {
    line.words.sort((a, b) => a.x0 - b.x0);
    const merged = [];
    for (const w of line.words) {
      const prev = merged[merged.length - 1];
      const h = w.y1 - w.y0;
      if (prev && prev.endsRun && w.startsRun && w.x0 - prev.x1 < h * 0.12) {
        prev.text += w.text;
        prev.x1 = Math.max(prev.x1, w.x1);
        prev.endsRun = w.endsRun;
      } else {
        merged.push({ ...w });
      }
    }
    const idx = state.lines.length;
    state.lines.push({
      y0: Math.min(...merged.map((w) => w.y0)),
      y1: Math.max(...merged.map((w) => w.y1)),
    });
    for (const w of merged) {
      state.words.push({ text: w.text, norm: norm(w.text), x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, line: idx });
    }
  }
}

function norm(s) {
  return s.toLowerCase()
    .normalize('NFKD')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, '')
    .replace(/^'+|'+$/g, '');
}

function afterPageLoaded() {
  detectDarkPage();
  $('empty').hidden = true;
  $('exportMp4').disabled = false;
  $('exportXml').disabled = false;
  $('exportAe').disabled = false;
  const n = state.words.length;
  const how = state.source === 'pdf' ? 'from the PDF text' : 'with OCR';
  setStatus(n ? `Found ${n} words ${how}.` : 'No readable text found. You can still draw highlights by hand in Edit view.');
  findPhrases();
}

/* ---------- matching ---------- */

function findPhrases() {
  const phrases = $('phrases').value.split('\n').map((p) => p.trim()).filter(Boolean);
  const firstOnly = $('firstOnly').checked;
  const tokens = state.words.filter((w) => w.norm);
  state.bars = state.bars.filter((b) => b.manual);
  const list = $('matchList');
  list.innerHTML = '';

  phrases.forEach((phrase, pi) => {
    const want = phrase.split(/\s+/).map(norm).filter(Boolean);
    let count = 0;
    if (want.length) {
      for (let i = 0; i + want.length <= tokens.length; i++) {
        let ok = true;
        for (let j = 0; j < want.length; j++) {
          if (tokens[i + j].norm !== want[j]) { ok = false; break; }
        }
        if (!ok) continue;
        addBarsForWords(tokens.slice(i, i + want.length), phrase, pi);
        count++;
        i += want.length - 1;
        if (firstOnly) break;
      }
    }
    const li = document.createElement('li');
    if (!count) li.className = 'miss';
    li.innerHTML = `<span></span><span class="n">${count ? `${count} found` : 'not found'}</span>`;
    li.firstChild.textContent = phrase;
    list.appendChild(li);
  });
  state.selected = null;
  refresh();
}

/* One match can wrap across lines; each line becomes its own bar, sharing a group so the
 * swipe continues from one line straight into the next. */
function addBarsForWords(ws, phrase, phraseIndex) {
  const group = nextId++;
  const segs = [];
  // Leave surrounding punctuation ("bidding." / “Residents) out of the highlight.
  ws = ws.map((w, i) => {
    const lead = i === 0 ? w.text.match(/^[^\p{L}\p{N}$€£#@]*/u)[0].length : 0;
    const trail = i === ws.length - 1 ? w.text.match(/[^\p{L}\p{N}%]*$/u)[0].length : 0;
    if (!lead && !trail) return w;
    const per = (w.x1 - w.x0) / w.text.length;
    return { ...w, x0: w.x0 + lead * per, x1: w.x1 - trail * per, text: w.text.slice(lead, w.text.length - trail || undefined) };
  });
  for (const w of ws) {
    const cur = segs[segs.length - 1];
    const h = w.y1 - w.y0;
    if (cur && cur.line === w.line && w.x0 - cur.x1 < h * 1.5) {
      cur.x1 = Math.max(cur.x1, w.x1);
      cur.text.push(w.text);
    } else {
      segs.push({ line: w.line, x0: w.x0, x1: w.x1, text: [w.text] });
    }
  }
  for (const s of segs) {
    const L = state.lines[s.line];
    const key = barKey(s.x0, L.y0);
    state.bars.push({
      id: nextId++, group, phraseIndex, phrase, text: s.text.join(' '), key,
      x0: s.x0, x1: state.endEdits[key] ?? s.x1, y0: L.y0, y1: L.y1, manual: false,
    });
  }
}

/* Hand-adjusted bar ends, keyed by where the bar starts, so they survive re-running Find. */
const barKey = (x0, y0) => `${state.pageNum}:${Math.round(x0)}:${Math.round(y0)}`;

function setBarEnd(bar, x1) {
  bar.x1 = Math.max(bar.x0 + 2, Math.min(state.page.width, x1));
  if (bar.key) state.endEdits[bar.key] = bar.x1;
}

/* The draggable end handle sits on the marker's right edge (barPageRect adds padding). */
function endHandleX(bar) {
  const r = barPageRect(bar);
  return r.x + r.w;
}

function addManualBar(r) {
  // Snap to words mostly inside the dragged box; fall back to the raw box.
  const inside = state.words.filter((w) => {
    const ix = Math.min(w.x1, r.x1) - Math.max(w.x0, r.x0);
    const iy = Math.min(w.y1, r.y1) - Math.max(w.y0, r.y0);
    return ix > (w.x1 - w.x0) * 0.5 && iy > (w.y1 - w.y0) * 0.4;
  });
  if (inside.length) {
    addBarsForWords(inside, inside.map((w) => w.text).join(' '), Infinity);
    for (const b of state.bars) if (b.group === state.bars[state.bars.length - 1].group) b.manual = true;
  } else {
    const g = nextId++;
    state.bars.push({ id: nextId++, group: g, phraseIndex: Infinity, phrase: 'Custom', text: 'Custom area', ...r, manual: true });
  }
  state.selected = state.bars[state.bars.length - 1].id;
  refresh();
}

function deleteBar(id) {
  state.bars = state.bars.filter((b) => b.id !== id);
  if (state.selected === id) state.selected = null;
  refresh();
}

/* ---------- timing ---------- */

function orderedGroups(s) {
  const groups = new Map();
  for (const b of state.bars) {
    if (!groups.has(b.group)) groups.set(b.group, []);
    groups.get(b.group).push(b);
  }
  const arr = [...groups.values()];
  const pos = (g) => [g[0].y0, g[0].x0];
  arr.sort((a, b) => {
    if (s.order === 'typed' && a[0].phraseIndex !== b[0].phraseIndex) {
      return a[0].phraseIndex - b[0].phraseIndex;
    }
    const [ay, ax] = pos(a), [by, bx] = pos(b);
    return Math.abs(ay - by) > 4 ? ay - by : ax - bx;
  });
  return arr;
}

/* With "scale with length" on, the swipe moves at a steady speed: the slider value is the time
 * for ~80 characters. Length is measured from the bar's width in multiples of its text height
 * (an average character is about half the text height wide), so it works for drawn areas too. */
const REF_CHARS = 80;
const MIN_SWIPE = 0.1; // seconds; keeps one-word highlights from being a single-frame pop
function swipeDuration(bar, s) {
  if (!s.scaleLen) return s.swipe;
  const chars = (2 * (bar.x1 - bar.x0)) / (bar.y1 - bar.y0);
  return Math.max(MIN_SWIPE, s.swipe * Math.min(3, chars / REF_CHARS));
}

/* With ease-out, a swipe covers 95% of its width in the first ~63% of its time and spends the
 * rest creeping to the end. So the gap is measured from that visible finish: at 0 the next
 * swipe starts as the previous one lands, and negative gaps start it while the previous is
 * still clearly moving. Each swipe still starts at least one step after the previous one, so
 * large negative gaps give a tight stagger rather than everything firing at once. */
const VISIBLE_DONE = 1 - Math.cbrt(0.05);

function schedule(s) {
  const items = [];
  const minStagger = 1 / (s.posterize && s.posterize < s.fps ? s.posterize : s.fps);
  let prevStart = -Infinity;
  let prevVisibleEnd = s.leadIn;
  let lastEnd = s.leadIn;
  orderedGroups(s).forEach((g, gi) => {
    let t = gi === 0 ? s.leadIn : Math.max(prevStart + minStagger, prevVisibleEnd + s.gap);
    prevStart = t;
    // Lines of one wrapped phrase run back to back, as one continuous swipe.
    for (const bar of g) {
      const d = swipeDuration(bar, s);
      items.push({ bar, start: t, end: t + d });
      prevVisibleEnd = t + d * VISIBLE_DONE;
      t += d;
      lastEnd = Math.max(lastEnd, t);
    }
  });
  return { items, duration: Math.max(lastEnd + s.hold, 0.5) };
}

/* Swipe progress 0..1 at time t, with ease-out and optional posterized (stepped) timing. */
function swipeProgress(it, t, s) {
  if (s.posterize && s.posterize < s.fps) {
    // Hold each step for whole video frames so the stepping is even.
    const step = Math.max(1, Math.round(s.fps / s.posterize)) / s.fps;
    t = it.start + Math.floor((t - it.start + 1e-6) / step) * step;
  }
  const p = Math.min(1, Math.max(0, (t - it.start) / (it.end - it.start)));
  return p > 0 ? ease(p) : 0;
}

/* ---------- framing ---------- */

/* Maps page pixels into a W x H frame: frame = page * scale + offset. */
function frameView(W, H, framing) {
  const pw = state.page.width, ph = state.page.height;
  let r = { x: 0, y: 0, w: pw, h: ph };
  let margin = 0.05;
  if (framing === 'zoom' && state.bars.length) {
    margin = 0;
    // Frame whole lines (not just the highlighted words) so sentences aren't cut off mid-line.
    const ys = state.bars.map((b) => (b.y0 + b.y1) / 2);
    const lineWords = state.words.filter((w) => ys.some((y) => y >= w.y0 && y <= w.y1));
    const xs = state.bars.concat(lineWords);
    const x0 = Math.min(...xs.map((b) => b.x0));
    const x1 = Math.max(...xs.map((b) => b.x1));
    const y0 = Math.min(...state.bars.map((b) => b.y0));
    const y1 = Math.max(...state.bars.map((b) => b.y1));
    const pad = pw * 0.06;
    r = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
    const minW = pw * 0.4;
    if (r.w < minW) { r.x -= (minW - r.w) / 2; r.w = minW; }
    const aspect = W / H;
    if (r.w / r.h < aspect) { const nw = r.h * aspect; r.x -= (nw - r.w) / 2; r.w = nw; }
    else { const nh = r.w / aspect; r.y -= (nh - r.h) / 2; r.h = nh; }
    // Pull back a bit so the highlights have some page around them.
    const ZOOM_OUT = 1.12;
    r = { x: r.x - (r.w * (ZOOM_OUT - 1)) / 2, y: r.y - (r.h * (ZOOM_OUT - 1)) / 2, w: r.w * ZOOM_OUT, h: r.h * ZOOM_OUT };
    // keep the window on the page where it fits
    if (r.w <= pw) r.x = Math.min(Math.max(r.x, 0), pw - r.w); else r.x = (pw - r.w) / 2;
    if (r.h <= ph) r.y = Math.min(Math.max(r.y, 0), ph - r.h); else r.y = (ph - r.h) / 2;
  }
  // Auto framing centers the region; the user's zoom and pan (in page px) adjust it from there.
  const base = Math.min((W * (1 - 2 * margin)) / r.w, (H * (1 - 2 * margin)) / r.h);
  const scale = base * state.zoom;
  const cx = r.x + r.w / 2 + state.pan.x;
  const cy = r.y + r.h / 2 + state.pan.y;
  return { scale, ox: W / 2 - cx * scale, oy: H / 2 - cy * scale, base, rcx: r.x + r.w / 2, rcy: r.y + r.h / 2 };
}

/* Numeric framing, in the same terms as the After Effects Page layer: where the page's center
 * sits in the frame (px) and its scale (% of the page image's full resolution). */
function pageTransform(view) {
  return {
    x: view.ox + (state.page.width * view.scale) / 2,
    y: view.oy + (state.page.height * view.scale) / 2,
    scale: view.scale * 100,
  };
}

function setPageTransform(x, y, scalePct) {
  const s = settings();
  const v = frameView(s.width, s.height, s.framing);
  const scale = Math.max(0.001, scalePct / 100);
  state.zoom = scale / v.base;
  // Solve frameView's ox = W/2 - (rcx + pan.x) * scale for pan, given the page center position.
  const ox = x - (state.page.width * scale) / 2;
  const oy = y - (state.page.height * scale) / 2;
  state.pan.x = (s.width / 2 - ox) / scale - v.rcx;
  state.pan.y = (s.height / 2 - oy) / scale - v.rcy;
  syncZoomSlider();
  render();
}

function syncZoomSlider() {
  const z = $('zoom');
  z.value = state.zoom;
  z.parentElement.querySelector('output').textContent = `${Math.round(state.zoom * 100)}%`;
}

function syncFramingFields(view) {
  const t = pageTransform(view);
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
  set('posX', Math.round(t.x));
  set('posY', Math.round(t.y));
  set('posScale', Math.round(t.scale * 10) / 10);
}

/* ---------- drawing ---------- */

function drawPage(c, W, H, view, bg) {
  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);
  c.imageSmoothingQuality = 'high';
  c.drawImage(state.page, view.ox, view.oy, state.page.width * view.scale, state.page.height * view.scale);
}

/* Marker shape in page pixels: a little taller and wider than the text box. */
function barPageRect(bar) {
  const h = bar.y1 - bar.y0;
  const x0 = bar.x0 - h * 0.12, x1 = bar.x1 + h * 0.12;
  const y0 = bar.y0 - h * 0.08, y1 = bar.y1 + h * 0.04;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* The same marker in frame pixels. */
function barRect(bar, view) {
  const r = barPageRect(bar);
  return {
    x: view.ox + r.x * view.scale,
    y: view.oy + r.y * view.scale,
    w: r.w * view.scale,
    h: r.h * view.scale,
  };
}

function fillBar(c, r, progress, color) {
  const w = r.w * progress;
  if (w <= 0.5) return;
  c.fillStyle = color;
  c.fillRect(r.x, r.y, w, r.h);
}

// Cubic ease-out: starts fast, settles gently. The AE export uses the matching bezier.
const ease = (p) => 1 - Math.pow(1 - p, 3);

function drawFrame(c, s, view, sched, t) {
  drawPage(c, s.width, s.height, view, s.bg);
  c.save();
  c.globalCompositeOperation = CANVAS_BLEND[s.blend];
  c.globalAlpha = s.opacity;
  for (const it of sched.items) {
    const p = swipeProgress(it, t, s);
    if (p > 0) fillBar(c, barRect(it.bar, view), p, s.color);
  }
  c.restore();
}

function render() {
  if (!state.page) return;
  const s = settings();
  if (state.mode === 'edit') {
    const W = 1600, H = Math.round((1600 * state.page.height) / state.page.width);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const view = { scale: W / state.page.width, ox: 0, oy: 0 };
    state.editView = view;
    ctx.drawImage(state.page, 0, 0, W, H);
    ctx.save();
    ctx.globalCompositeOperation = CANVAS_BLEND[s.blend];
    ctx.globalAlpha = s.opacity;
    for (const b of state.bars) fillBar(ctx, barRect(b, view), 1, s.color);
    ctx.restore();
    const sel = state.bars.find((b) => b.id === state.selected);
    if (sel) {
      const r = barRect(sel, view);
      ctx.strokeStyle = '#2a5bd7';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 5]);
      ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
      ctx.setLineDash([]);
      // End handle: drag it (or use the arrow keys) to adjust where the highlight stops.
      const hx = r.x + r.w, hh = r.h + 16, hw = 8;
      ctx.fillStyle = '#2a5bd7';
      ctx.fillRect(hx - hw / 2, r.y - 8, hw, hh);
      ctx.fillStyle = '#fff';
      for (let i = -1; i <= 1; i++) ctx.fillRect(hx - 1, r.y + r.h / 2 + i * 6 - 1.5, 2, 3);
    }
    if (state.drag) {
      const d = state.drag;
      ctx.strokeStyle = '#2a5bd7';
      ctx.lineWidth = 2;
      ctx.fillStyle = 'rgba(42,91,215,0.08)';
      const x = Math.min(d.x0, d.x1) * view.scale, y = Math.min(d.y0, d.y1) * view.scale;
      const w = Math.abs(d.x1 - d.x0) * view.scale, h = Math.abs(d.y1 - d.y0) * view.scale;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }
  } else {
    if (canvas.width !== s.width || canvas.height !== s.height) { canvas.width = s.width; canvas.height = s.height; }
    const sched = schedule(s);
    state.time = Math.min(state.time, sched.duration);
    drawFrame(ctx, s, frameView(s.width, s.height, s.framing), sched, state.time);
    $('scrub').max = sched.duration;
    $('scrub').value = state.time;
    $('timeLabel').textContent = `${state.time.toFixed(1)}s / ${sched.duration.toFixed(1)}s`;
  }
  syncFramingFields(frameView(s.width, s.height, s.framing));
}

function refresh() {
  renderBarList();
  render();
}

function renderBarList() {
  const ul = $('barList');
  ul.innerHTML = '';
  const s = settings();
  orderedGroups(s).flat().forEach((b, i) => {
    const li = document.createElement('li');
    if (b.id === state.selected) li.className = 'sel';
    li.innerHTML = `<span class="tag">${i + 1}</span><span class="t"></span><button title="Remove highlight" aria-label="Remove highlight">×</button>`;
    li.querySelector('.t').textContent = b.text;
    li.onclick = () => { state.selected = b.id; setMode('edit'); refresh(); };
    li.querySelector('button').onclick = (e) => { e.stopPropagation(); deleteBar(b.id); };
    ul.appendChild(li);
  });
}

/* ---------- edit interactions ---------- */

function toPage(e) {
  const rect = canvas.getBoundingClientRect();
  const cx = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const cy = ((e.clientY - rect.top) / rect.height) * canvas.height;
  return { x: cx / state.editView.scale, y: cy / state.editView.scale };
}

/* Preview: drag to pan the shot, scroll/pinch to zoom. */
function canvasPx(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: ((e.clientX - rect.left) * canvas.width) / rect.width, y: ((e.clientY - rect.top) * canvas.height) / rect.height };
}
canvas.addEventListener('pointerdown', (e) => {
  if (state.mode !== 'preview' || !state.page) return;
  const s = settings();
  state.panDrag = { start: canvasPx(e), pan: { ...state.pan }, scale: frameView(s.width, s.height, s.framing).scale };
  $('stage').classList.add('panning');
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  const d = state.panDrag;
  if (!d) return;
  const p = canvasPx(e);
  state.pan.x = d.pan.x - (p.x - d.start.x) / d.scale;
  state.pan.y = d.pan.y - (p.y - d.start.y) / d.scale;
  render();
});
canvas.addEventListener('pointerup', () => {
  if (!state.panDrag) return;
  state.panDrag = null;
  $('stage').classList.remove('panning');
});
canvas.addEventListener('wheel', (e) => {
  if (state.mode !== 'preview' || !state.page) return;
  e.preventDefault();
  state.zoom = Math.min(20, Math.max(0.1, state.zoom * Math.exp(-e.deltaY * 0.002)));
  syncZoomSlider();
  render();
}, { passive: false });

function resetFraming() {
  state.pan = { x: 0, y: 0 };
  state.zoom = 1;
  syncZoomSlider();
  render();
}

/* The bar whose end handle is under the pointer (within ~8 screen px), if any. */
function endHandleHit(p) {
  const tol = (8 * canvas.width) / canvas.getBoundingClientRect().width / state.editView.scale;
  return state.bars.slice().reverse().find((b) => {
    const r = barPageRect(b);
    return Math.abs(p.x - endHandleX(b)) <= tol && p.y >= r.y - tol / 2 && p.y <= r.y + r.h + tol / 2;
  });
}

canvas.addEventListener('pointerdown', (e) => {
  if (state.mode !== 'edit' || !state.page) return;
  const p = toPage(e);
  const edge = endHandleHit(p);
  if (edge) {
    state.selected = edge.id;
    state.endDrag = { bar: edge, offset: endHandleX(edge) - edge.x1 };
    canvas.setPointerCapture(e.pointerId);
    refresh();
    return;
  }
  const hit = state.bars.slice().reverse().find((b) => {
    const r = barPageRect(b);
    return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  });
  if (hit) { state.selected = hit.id; refresh(); return; }
  state.selected = null;
  state.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  canvas.setPointerCapture(e.pointerId);
  refresh();
});
canvas.addEventListener('pointermove', (e) => {
  if (state.mode !== 'edit' || !state.page) return;
  const p = toPage(e);
  if (state.endDrag) {
    setBarEnd(state.endDrag.bar, p.x - state.endDrag.offset);
    render();
    return;
  }
  if (state.drag) {
    state.drag.x1 = p.x;
    state.drag.y1 = p.y;
    render();
    return;
  }
  canvas.style.cursor = endHandleHit(p) ? 'ew-resize' : '';
});
canvas.addEventListener('pointerup', () => {
  if (state.endDrag) {
    state.endDrag = null;
    refresh();
    return;
  }
  const d = state.drag;
  if (!d) return;
  state.drag = null;
  const r = { x0: Math.min(d.x0, d.x1), x1: Math.max(d.x0, d.x1), y0: Math.min(d.y0, d.y1), y1: Math.max(d.y0, d.y1) };
  if (r.x1 - r.x0 > 6 && r.y1 - r.y0 > 3) addManualBar(r); else render();
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
    e.preventDefault();
    deleteBar(state.selected);
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && state.selected) {
    // Nudge the selected highlight's end; Shift for bigger steps.
    e.preventDefault();
    const bar = state.bars.find((b) => b.id === state.selected);
    const step = (bar.y1 - bar.y0) * (e.shiftKey ? 0.5 : 0.08);
    setBarEnd(bar, bar.x1 + (e.key === 'ArrowRight' ? step : -step));
    refresh();
  } else if (e.key === ' ' && state.page) {
    e.preventDefault();
    setMode('preview');
    togglePlay();
  }
});

/* ---------- preview playback ---------- */

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  if (mode === 'edit') stopPlay();
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $('stage').className = `stage ${mode}`;
  $('transport').hidden = mode !== 'preview';
  render();
}

let lastTick = 0;
function tick(now) {
  if (!state.playing) return;
  const dur = schedule(settings()).duration;
  state.time += (now - lastTick) / 1000;
  lastTick = now;
  if (state.time >= dur) { state.time = dur; stopPlay(); }
  render();
  if (state.playing) requestAnimationFrame(tick);
}
function togglePlay() {
  if (state.playing) { stopPlay(); return; }
  if (state.time >= schedule(settings()).duration - 0.01) state.time = 0;
  state.playing = true;
  $('playBtn').textContent = 'Pause';
  lastTick = performance.now();
  requestAnimationFrame(tick);
}
function stopPlay() {
  state.playing = false;
  $('playBtn').textContent = 'Play';
}

/* ---------- MP4 export ---------- */

async function exportMp4() {
  if (!window.VideoEncoder) {
    alert('This browser can’t encode video. Please use a recent Chrome, Edge, or Safari.');
    return;
  }
  const s = settings();
  const codec = await pickCodec(s);
  if (!codec) { alert('This browser can’t encode H.264 at that size. Try a smaller size.'); return; }

  stopPlay();
  lockExport(true);
  try {
    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width: s.width, height: s.height },
      fastStart: 'in-memory',
    });
    let failure = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { failure = e; },
    });
    encoder.configure({ codec, width: s.width, height: s.height, bitrate: bitrateFor(s), framerate: s.fps });

    const off = document.createElement('canvas');
    off.width = s.width;
    off.height = s.height;
    const oc = off.getContext('2d');
    const view = frameView(s.width, s.height, s.framing);
    const sched = schedule(s);
    const frames = Math.ceil(sched.duration * s.fps);
    for (let f = 0; f < frames; f++) {
      if (failure) throw failure;
      drawFrame(oc, s, view, sched, f / s.fps);
      const vf = new VideoFrame(off, { timestamp: Math.round((f * 1e6) / s.fps), duration: Math.round(1e6 / s.fps) });
      encoder.encode(vf, { keyFrame: f % (s.fps * 2) === 0 });
      vf.close();
      while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 5));
      if (f % 5 === 0) { setProgress(f / frames); setStatus(`Encoding video… frame ${f + 1} of ${frames}`); }
    }
    await encoder.flush();
    if (failure) throw failure;
    muxer.finalize();
    download(new Blob([muxer.target.buffer], { type: 'video/mp4' }), `${state.fileName}_highlight.mp4`);
    setStatus(`Exported ${state.fileName}_highlight.mp4 (${sched.duration.toFixed(1)}s, ${s.width}×${s.height}, ${s.fps} fps).`);
  } catch (err) {
    console.error(err);
    setStatus(`Video export failed: ${err.message || err}`);
  } finally {
    lockExport(false);
  }
}

async function pickCodec(s) {
  for (const codec of ['avc1.640028', 'avc1.64002a', 'avc1.640033', 'avc1.4d0033', 'avc1.42003e']) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: s.width, height: s.height, bitrate: bitrateFor(s), framerate: s.fps });
      if (r.supported) return codec;
    } catch (_) { /* try next */ }
  }
  return null;
}

const bitrateFor = (s) => Math.round(s.width * s.height * s.fps * 0.2);

/* ---------- Premiere export ---------- */

/* Builds a zip with the page and each highlight as full-frame PNGs, plus an FCP 7 XML
 * sequence (which Premiere imports) where each highlight's swipe is a Crop keyframe pair. */
async function exportPremiere() {
  const s = settings();
  if (!state.bars.length && !confirm('There are no highlights yet. Export just the page?')) return;
  stopPlay();
  lockExport(true);
  try {
    setStatus('Building Premiere package…');
    const zip = new JSZip();
    const folder = `${slug(state.fileName)}_highlights`;
    const dir = zip.folder(folder);
    const view = frameView(s.width, s.height, s.framing);
    const sched = schedule(s);
    const total = Math.ceil(sched.duration * s.fps);

    const c = document.createElement('canvas');
    c.width = s.width;
    c.height = s.height;
    const cx = c.getContext('2d');
    drawPage(cx, s.width, s.height, view, s.bg);
    dir.file('page.png', await toPng(c));

    const layers = [];
    for (let i = 0; i < sched.items.length; i++) {
      const it = sched.items[i];
      cx.clearRect(0, 0, s.width, s.height);
      const r = barRect(it.bar, view);
      fillBar(cx, r, 1, s.color);
      const name = `highlight_${String(i + 1).padStart(2, '0')}.png`;
      dir.file(name, await toPng(c));
      const start = Math.round(it.start * s.fps);
      const swipeFrames = Math.max(1, Math.round((it.end - it.start) * s.fps));
      // Crop "right" is the % of frame width hidden from the right edge.
      const cropFrom = clampPct(100 * (1 - r.x / s.width));
      const cropTo = clampPct(100 * (1 - (r.x + r.w) / s.width));
      // Two linear keys stay easy to retime. Posterized motion can't be expressed that way, so it
      // gets a key on every frame (Premiere only renders whole frames, so this steps exactly).
      const keys = s.posterize && s.posterize < s.fps
        ? Array.from({ length: swipeFrames + 1 }, (_, f) => [f, clampPct(cropFrom + (cropTo - cropFrom) * swipeProgress(it, it.start + f / s.fps, s))])
        : [[0, cropFrom], [swipeFrames, cropTo]];
      layers.push({ name, label: it.bar.text, start, swipeFrames, cropFrom, cropTo, keys });
      setProgress((i + 1) / (sched.items.length + 1));
    }

    dir.file(`${folder}.xml`, premiereXml(folder, s, total, layers));
    dir.file('highlights.json', JSON.stringify({
      width: s.width, height: s.height, fps: s.fps, durationFrames: total,
      color: s.color, opacity: s.opacity, layers,
    }, null, 2));
    dir.file('README.txt', readme(folder, s));
    const blob = await zip.generateAsync({ type: 'blob' }, (m) => setProgress(m.percent / 100));
    download(blob, `${folder}.zip`);
    setStatus(`Exported ${folder}.zip with ${layers.length} highlight layer${layers.length === 1 ? '' : 's'}.`);
  } catch (err) {
    console.error(err);
    setStatus(`Premiere export failed: ${err.message || err}`);
  } finally {
    lockExport(false);
  }
}

function premiereXml(name, s, total, layers) {
  const rate = `<rate><timebase>${s.fps}</timebase><ntsc>FALSE</ntsc></rate>`;
  const STILL = 108000; // nominal media length for stills
  let fileId = 0;
  const clip = (file, label, start, extra) => {
    fileId++;
    return `
        <track>
          <clipitem id="clipitem-${fileId}">
            <name>${esc(label)}</name>
            <enabled>TRUE</enabled>
            <duration>${STILL}</duration>
            ${rate}
            <start>${start}</start>
            <end>${total}</end>
            <in>0</in>
            <out>${total - start}</out>
            <file id="file-${fileId}">
              <name>${file}</name>
              <pathurl>${file}</pathurl>
              ${rate}
              <duration>${STILL}</duration>
              <media><video><samplecharacteristics><width>${s.width}</width><height>${s.height}</height></samplecharacteristics></video></media>
            </file>${extra}
          </clipitem>
        </track>`;
  };
  const param = (id, value, keys) => `
                <parameter authoringApp="PremierePro">
                  <parameterid>${id}</parameterid>
                  <name>${id}</name>
                  <valuemin>0</valuemin>
                  <valuemax>100</valuemax>
                  <value>${value}</value>${(keys || []).map(([when, v]) => `
                  <keyframe><when>${when}</when><value>${v}</value></keyframe>`).join('')}
                </parameter>`;

  const tracks = [clip('page.png', 'page.png', 0, '')];
  for (const l of layers) {
    tracks.push(clip(l.name, `${l.name} – ${l.label}`, l.start, `
            <compositemode>${s.blend}</compositemode>
            <filter>
              <effect>
                <name>Opacity</name>
                <effectid>opacity</effectid>
                <effectcategory>motion</effectcategory>
                <effecttype>motion</effecttype>
                <mediatype>video</mediatype>${param('opacity', Math.round(s.opacity * 100))}
              </effect>
            </filter>
            <filter>
              <effect>
                <name>Crop</name>
                <effectid>crop</effectid>
                <effectcategory>motion</effectcategory>
                <effecttype>motion</effecttype>
                <mediatype>video</mediatype>${param('left', 0)}${param('right', l.cropTo, l.keys)}${param('top', 0)}${param('bottom', 0)}
              </effect>
            </filter>`));
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>${esc(name)}</name>
    <duration>${total}</duration>
    ${rate}
    <media>
      <video>
        <format>
          <samplecharacteristics>
            ${rate}
            <width>${s.width}</width>
            <height>${s.height}</height>
            <anamorphic>FALSE</anamorphic>
            <pixelaspectratio>square</pixelaspectratio>
            <fielddominance>none</fielddominance>
          </samplecharacteristics>
        </format>${tracks.join('')}
      </video>
    </media>
  </sequence>
</xmeml>
`;
}

function readme(folder, s) {
  return `Doc Highlighter – Premiere package
=================================

Contents
  ${folder}.xml       Sequence (${s.width}x${s.height}, ${s.fps} fps) to import into Premiere
  page.png            The document page, framed for the video
  highlight_NN.png    One marker bar per layer (full-frame, transparent background)
  highlights.json     Timing and position data, for other tools or scripts

How to use
  1. Unzip this folder somewhere it will stay (e.g. your project's assets folder).
  2. In Premiere: File > Import, pick ${folder}.xml.
  3. If Premiere asks where the media is, point it at this folder and it will
     relink every PNG at once.
  4. Open the imported sequence. V1 is the page; V2 and up are the highlights.

Editing the animation
${s.posterize && s.posterize < s.fps ? `  - Each highlight's swipe is keyframed on Effect Controls > Crop > Right, with
    a keyframe on every frame so the ${s.posterize} fps posterized stepping and the
    ease-out come through exactly. Slide the clip to retime it; to change the
    speed, re-export from Doc Highlighter.` : `  - Each highlight's swipe is two keyframes on Effect Controls > Crop > Right.
    Drag them to change speed. They import as linear; to match the app's
    ease-out, right-click the second keyframe > Temporal Interpolation > Ease In.`}
  - Slide a highlight clip left/right on the timeline to retime it.
  - Opacity and blend mode (${BLEND_LABEL[s.blend]}) are under Effect Controls > Opacity.
  - To change the marker color, re-export from Doc Highlighter, or add
    Effects > Generate > Fill (or Tint) to the highlight clips.
`;
}

/* ---------- After Effects export ---------- */

/* Builds a zip with the full-resolution page image and a .jsx script. Running the script in
 * AE builds a comp: background solid, the page as an image layer, and one shape layer per
 * highlight, parented to the page so moving or scaling the page carries the highlights. */
async function exportAfterEffects() {
  const s = settings();
  if (!state.bars.length && !confirm('There are no highlights yet. Export just the page?')) return;
  stopPlay();
  lockExport(true);
  try {
    setStatus('Building After Effects package…');
    const folder = `${slug(state.fileName)}_highlights_AE`;
    const zip = new JSZip();
    const dir = zip.folder(folder);
    dir.file('page.png', await toPng(state.page));
    setProgress(0.4);

    const view = frameView(s.width, s.height, s.framing);
    const sched = schedule(s);
    const data = {
      name: `${slug(state.fileName)}_highlights`,
      width: s.width,
      height: s.height,
      fps: s.fps,
      duration: Math.ceil(sched.duration * s.fps) / s.fps,
      bg: hexToRgb(s.bg),
      color: hexToRgb(s.color),
      opacity: Math.round(s.opacity * 100),
      blend: s.blend.toUpperCase(),
      posterize: s.posterize && s.posterize < s.fps ? s.posterize : 0,
      page: {
        w: state.page.width,
        h: state.page.height,
        scale: view.scale * 100,
        x: view.ox + (state.page.width * view.scale) / 2,
        y: view.oy + (state.page.height * view.scale) / 2,
      },
      bars: sched.items.map((it, i) => {
        const r = barPageRect(it.bar);
        return {
          name: `Highlight ${String(i + 1).padStart(2, '0')} – ${it.bar.text}`.slice(0, 60),
          x: r.x, y: r.y + r.h / 2, w: r.w, h: r.h,
          t0: it.start, t1: it.end,
        };
      }),
    };
    dir.file(`${folder}.jsx`, aeScript(data));
    dir.file('README.txt', aeReadme(folder, s));
    const blob = await zip.generateAsync({ type: 'blob' }, (m) => setProgress(0.4 + (m.percent / 100) * 0.6));
    download(blob, `${folder}.zip`);
    setStatus(`Exported ${folder}.zip with ${data.bars.length} highlight layer${data.bars.length === 1 ? '' : 's'}.`);
  } catch (err) {
    console.error(err);
    setStatus(`After Effects export failed: ${err.message || err}`);
  } finally {
    lockExport(false);
  }
}

function aeScript(data) {
  // ExtendScript may not read the file as UTF-8, so keep the script pure ASCII.
  const json = JSON.stringify(data, null, 2)
    .replace(/[\u007f-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `// Doc Highlighter - After Effects comp builder
// Run in After Effects: File > Scripts > Run Script File..., then pick this file.
// Keep page.png in the same folder as this script.
(function () {
  var DATA = ${json};

  var here = File($.fileName).parent;
  var pageFile = File(here.fsName + "/page.png");
  if (!pageFile.exists) {
    alert("Couldn't find page.png next to this script.\\nUnzip the whole folder and run the script from there.");
    return;
  }

  app.beginUndoGroup("Doc Highlighter");
  var proj = app.project || app.newProject();
  var bin = proj.items.addFolder(DATA.name);
  var footage = proj.importFile(new ImportOptions(pageFile));
  footage.parentFolder = bin;

  var comp = proj.items.addComp(DATA.name, DATA.width, DATA.height, 1, DATA.duration, DATA.fps);
  comp.parentFolder = bin;
  comp.bgColor = DATA.bg;

  var bg = comp.layers.addSolid(DATA.bg, "Background", DATA.width, DATA.height, 1, DATA.duration);
  bg.locked = true;

  var page = comp.layers.add(footage);
  page.name = "Page";
  page.transform.position.setValue([DATA.page.x, DATA.page.y]);
  page.transform.scale.setValue([DATA.page.scale, DATA.page.scale]);

  // Ease-out matching the app preview: cubic-bezier(0.33, 1, 0.68, 1).
  function easeOut(prop, k1, k2, dur) {
    var dims = [3, 2, 1];
    for (var d = 0; d < dims.length; d++) {
      try {
        var out1 = [], in2 = [], lin = [];
        for (var i = 0; i < dims[d]; i++) {
          out1.push(new KeyframeEase(i === 0 ? 303 / dur : 0, 33));
          in2.push(new KeyframeEase(0, 32));
          lin.push(new KeyframeEase(0, 0.1));
        }
        prop.setTemporalEaseAtKey(k1, lin, out1);
        prop.setTemporalEaseAtKey(k2, in2, lin);
        return;
      } catch (e) {}
    }
  }

  for (var b = 0; b < DATA.bars.length; b++) {
    var bar = DATA.bars[b];
    var layer = comp.layers.addShape();
    layer.name = bar.name;
    var group = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
    group.name = "Marker";
    var contents = group.property("ADBE Vectors Group");
    var rect = contents.addProperty("ADBE Vector Shape - Rect");
    rect.property("ADBE Vector Rect Size").setValue([bar.w, bar.h]);
    rect.property("ADBE Vector Rect Position").setValue([bar.w / 2, 0]);
    var fill = contents.addProperty("ADBE Vector Graphic - Fill");
    fill.property("ADBE Vector Fill Color").setValue(DATA.color);

    // Parented to the page, so position and size are in page pixels.
    layer.parent = page;
    layer.transform.anchorPoint.setValue([0, 0]);
    layer.transform.position.setValue([bar.x, bar.y]);
    layer.transform.opacity.setValue(DATA.opacity);
    layer.blendingMode = BlendingMode[DATA.blend];

    // The swipe: horizontal scale 0% -> 100%, growing from the left edge.
    var scale = layer.transform.scale;
    scale.setValueAtTime(bar.t0, [0, 100]);
    scale.setValueAtTime(bar.t1, [100, 100]);
    easeOut(scale, 1, 2, bar.t1 - bar.t0);

    // Posterized motion: hold each step for whole frames, counted from the first keyframe.
    // The keyframes stay editable; delete the expression to make the swipe smooth again.
    if (DATA.posterize) {
      scale.expression =
        "var step = Math.max(1, Math.round(thisComp.frameRate / " + DATA.posterize + ")) * thisComp.frameDuration;\\n" +
        "var t0 = key(1).time;\\n" +
        "time < t0 ? value : valueAtTime(t0 + Math.floor((time - t0 + 0.0001) / step) * step);";
    }
  }

  comp.workAreaStart = 0;
  comp.workAreaDuration = DATA.duration;
  comp.openInViewer();
  app.endUndoGroup();
})();
`;
}

function aeReadme(folder, s) {
  return `Doc Highlighter – After Effects package
======================================

Contents
  ${folder}.jsx   Script that builds the comp
  page.png        The document page at full resolution

How to use
  1. Unzip this folder somewhere it will stay; AE links to page.png from here.
  2. In After Effects: File > Scripts > Run Script File…, and pick the .jsx.
  3. A new comp opens, with a project bin of the same name.

What you get
  - Background: a solid in the chosen background color (locked).
  - Page: the document as an image layer, framed like the app's preview.
    Animate its Position/Scale for camera moves;
    the highlights are parented to it and follow along.
  - Highlight NN: one shape layer per highlight (${BLEND_LABEL[s.blend]} blend). The swipe
    is two Scale keyframes (0% -> 100% width) with an ease-out. Drag them to
    retime, or change the color under Contents > Marker > Fill.${s.posterize && s.posterize < s.fps ? `
  - Posterized to ${s.posterize} fps by an expression on Scale. Delete the
    expression for smooth motion.` : ''}

To bring it into Premiere, use File > Import on the .aep, or Dynamic Link.
`;
}

const hexToRgb = (hex) => [1, 3, 5].map((i) => Math.round((parseInt(hex.slice(i, i + 2), 16) / 255) * 1000) / 1000);

/* ---------- helpers ---------- */

const clampPct = (v) => Math.round(Math.min(100, Math.max(0, v)) * 100) / 100;
const slug = (s) => s.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'document';
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const toPng = (c) => new Promise((resolve) => c.toBlob(resolve, 'image/png'));

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function lockExport(on) {
  $('exportMp4').disabled = on;
  $('exportXml').disabled = on;
  $('exportAe').disabled = on;
  $('progress').hidden = !on;
  setProgress(0);
}
function setProgress(f) { $('progressBar').style.width = `${Math.round(f * 100)}%`; }

/* ---------- wiring ---------- */

function initSwatches() {
  const wrap = $('swatches');
  const custom = wrap.querySelector('.custom');
  for (const hex of SWATCHES) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = hex;
    b.title = hex;
    b.dataset.hex = hex;
    b.onclick = () => { $('color').value = hex; $('colorHex').value = hex; $('colorHex').classList.remove('invalid'); syncSwatches(); render(); };
    wrap.insertBefore(b, custom);
  }
  $('color').addEventListener('input', () => { syncSwatches(); render(); });
  syncSwatches();
}
function syncSwatches() {
  const v = $('color').value.toLowerCase();
  let matched = false;
  document.querySelectorAll('.swatch').forEach((b) => {
    const on = b.dataset.hex === v;
    matched = matched || on;
    b.classList.toggle('active', on);
  });
  const custom = document.querySelector('.custom');
  custom.classList.toggle('active', !matched);
  if (!matched) custom.style.background = v;
}

/* A hex text box kept in sync with a color picker. Accepts "88c9d7", "#88C9D7" or "#8cd". */
function bindHex(colorId, hexId) {
  const color = $(colorId), hex = $(hexId);
  color.addEventListener('input', () => { hex.value = color.value; hex.classList.remove('invalid'); });
  const apply = (commit) => {
    let v = hex.value.trim().replace(/^#?/, '#').toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(v)) v = '#' + [...v.slice(1)].map((ch) => ch + ch).join('');
    const ok = /^#[0-9a-f]{6}$/.test(v);
    hex.classList.toggle('invalid', !ok && commit);
    if (!ok) return;
    if (commit) hex.value = v;
    if (color.value !== v) { color.value = v; color.dispatchEvent(new Event('input')); }
  };
  hex.addEventListener('input', () => apply(false));
  hex.addEventListener('change', () => apply(true));
  hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') hex.blur(); });
}

function initSliders() {
  document.querySelectorAll('.slider input').forEach((inp) => {
    const out = inp.parentElement.querySelector('output');
    const show = () => {
      out.textContent = inp.dataset.fmt === 'pct' ? `${Math.round(inp.value * 100)}%` : `${(+inp.value).toFixed(2).replace(/0$/, '')}s`;
    };
    inp.addEventListener('input', () => { show(); refresh(); });
    show();
  });
  ['order', 'aspect', 'fps', 'framing', 'bg', 'blend', 'posterize'].forEach((id) => $(id).addEventListener('input', refresh));
}

const drop = $('drop');
$('file').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
document.body.addEventListener('dragover', (e) => e.preventDefault());
document.body.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

$('pageNum').addEventListener('change', async () => {
  if (!state.pdf || state.busy) return;
  const n = Math.min(state.pdf.numPages, Math.max(1, +$('pageNum').value || 1));
  state.busy = true;
  try {
    state.bars = [];
    await loadPdfPage(n);
    afterPageLoaded();
  } finally { state.busy = false; }
});
$('forceOcr').addEventListener('change', async () => {
  if (!state.pdf || state.busy) return;
  state.busy = true;
  try { await loadPdfPage(state.pageNum); afterPageLoaded(); } finally { state.busy = false; }
});
$('findBtn').addEventListener('click', () => { if (state.page) findPhrases(); });
$('phrases').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (state.page) findPhrases(); }
});
$('firstOnly').addEventListener('change', () => { if (state.page) findPhrases(); });
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));
$('playBtn').addEventListener('click', togglePlay);
$('scrub').addEventListener('input', (e) => { stopPlay(); state.time = +e.target.value; render(); });
$('exportMp4').addEventListener('click', exportMp4);
$('exportXml').addEventListener('click', exportPremiere);
$('exportAe').addEventListener('click', exportAfterEffects);
$('resetFraming').addEventListener('click', resetFraming);
$('zoom').addEventListener('input', (e) => { state.zoom = +e.target.value; }); // before initSliders' re-render
['posX', 'posY', 'posScale'].forEach((id) => $(id).addEventListener('change', () => {
  if (!state.page) return;
  const x = parseFloat($('posX').value), y = parseFloat($('posY').value), sc = parseFloat($('posScale').value);
  if ([x, y, sc].every(Number.isFinite) && sc > 0) setPageTransform(x, y, sc); else render();
}));
$('scaleLen').addEventListener('change', () => {
  $('swipeHint').hidden = !$('scaleLen').checked;
  refresh();
});

$('stage').className = 'stage edit';
initSwatches();
bindHex('color', 'colorHex');
bindHex('bg', 'bgHex');
initSliders();

// Exposed for debugging from the console.
window.docHighlighter = { state, loadFile, findPhrases, settings, schedule, premiereXml };
