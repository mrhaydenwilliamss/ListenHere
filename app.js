// Listen Here — the app.
// Foreground: photo → what record is it → tracklist → YouTube.
// Background: every scan is saved on the phone with its photo and time.
// Nothing in the background ever holds up the tracklist.

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PLAY = '<svg class="play" viewBox="0 0 10 12" aria-hidden="true"><path d="M0 0L10 6L0 12Z" fill="currentColor"/></svg>';

/* =========================================================
   Storage — the Collection lives on the phone (IndexedDB)
   ========================================================= */
let dbp;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('listenhere', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('scans', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('scans', mode);
    const out = fn(t.objectStore('scans'));
    t.oncomplete = () => res(out?.result);
    t.onerror = () => rej(t.error);
  });
}
const saveEntry = e => tx('readwrite', s => s.put(e)).catch(err => console.warn('save failed', err));
const deleteEntry = id => tx('readwrite', s => s.delete(id));
const allEntries = async () => ((await tx('readonly', s => s.getAll())) || []).sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));

if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

/* =========================================================
   Helpers
   ========================================================= */
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const GENERIC = /^(intro|outro|interlude|untitled|reprise|prelude|overture|theme|skit|hidden track)\b/i;
function youtubeUrl(artist, track, album) {
  const q = GENERIC.test(track.trim()) ? `${artist} ${album} ${track}` : `${artist} ${track}`;
  return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
}
function when(iso) {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  return `${date} · ${time}`;
}
const blobToBase64 = blob => new Promise(res => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.readAsDataURL(blob);
});
const urls = new Map(); // object URLs for saved photos
function photoUrl(e) {
  if (!e?.photo) return '';
  if (!urls.has(e.id)) urls.set(e.id, URL.createObjectURL(e.photo));
  return urls.get(e.id);
}
// A cover reading still waiting for its visual check is never shown anywhere
const guessShown = e => !(e.status === 'identifying' && (e.guess?.kind === 'cover' || e.guess?.text_visible === false));
const displayArtist = e => e.release?.artist || (guessShown(e) ? e.guess?.artist : '') || '';
const displayTitle = e => e.release?.title || (guessShown(e) ? e.guess?.album : '') || '';
function typoCover(e) {
  return `<div class="typo"><b>${esc(displayArtist(e) || 'Unknown')}</b><span>${esc(displayTitle(e))}</span></div>`;
}
// An <img> that falls back to the user's photo, then to a typographic cover
function coverImg(e, src) {
  const alt = e.release?.artworkAlt || '';
  return src ? `<img src="${esc(src)}" alt="" loading="lazy" data-cover="${esc(e.id)}"${alt ? ` data-alt="${esc(alt)}"` : ''}>` : typoCover(e);
}
// When artwork fails to load: retry once (the Cover Art Archive is sometimes briefly
// unavailable), then the album's other artwork, then your photo, then a lettered cover.
document.addEventListener('error', ev => {
  const img = ev.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.cover) return;
  const e = entryById.get(img.dataset.cover) || current;
  const src = img.getAttribute('src') || '';
  if (src.includes('coverartarchive.org') && !img.dataset.retried) {
    img.dataset.retried = '1';
    setTimeout(() => { img.src = src + (src.includes('?') ? '&' : '?') + 'retry=1'; }, 1500);
    return;
  }
  if (img.dataset.alt && !img.dataset.usedAlt) {
    img.dataset.usedAlt = '1'; delete img.dataset.retried;
    img.src = img.dataset.alt; return;
  }
  const fallback = img.dataset.noPhoto ? '' : photoUrl(e);
  if (fallback && img.src !== fallback) img.src = fallback;
  else img.outerHTML = e ? typoCover(e) : '';
}, true);

// Loose text form for searching: lower case, no accents or punctuation
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

/* =========================================================
   Views and navigation (no page changes: keeps the camera alive)
   ========================================================= */
let view = 'scan';
function showView(v) {
  view = v;
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === v));
  document.body.dataset.view = v;
  closeSheet();
  if (v === 'collection') { if (rescanFor) endRescan(); renderCollection(); }
  if (v === 'scan') ensureCamera();
}
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => showView(b.dataset.go));

/* =========================================================
   Camera
   ========================================================= */
const video = $('#video'), videoBg = $('#videoBg');
let stream = null;
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // 4:3 uses the camera's full width; widescreen modes crop the sides
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 }, aspectRatio: { ideal: 4 / 3 } },
      audio: false
    });
    video.srcObject = stream;
    videoBg.srcObject = stream;          // same live feed, shown blurred behind
    // Low Power Mode can stop videos starting by themselves: if so, the first touch starts them
    try { await video.play(); } catch {
      addEventListener('pointerdown', () => resumePreview(), { once: true, capture: true });
    }
    videoBg.play().catch(() => {});
    layoutVideo();
    $('#startCam').hidden = true;
    setBusy(false);
    startBarcodes();
  } catch (e) {
    $('#startCam').hidden = false;
    $('#hint').textContent = e.name === 'NotAllowedError' ? 'Camera access needed to scan' : 'Camera unavailable';
  }
}
const cameraLive = () => stream && stream.getVideoTracks()[0]?.readyState === 'live';
function ensureCamera() { if (!cameraLive()) startCamera(); else if (video.paused) resumePreview(); }
function freezePreview() { video.pause(); videoBg.pause(); }
function resumePreview() { video.play().catch(() => {}); videoBg.play().catch(() => {}); }
$('#startCam').onclick = startCamera;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (view === 'scan') ensureCamera();
  retryUnfinished();
});

// Size the sharp picture to the camera's own shape, as large as fits ("contain"),
// fade whichever edges fall short of the screen into the blurred backdrop, and keep
// the brackets inside the sharp area, near full width.
function layoutVideo() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const W = innerWidth, H = innerHeight;
  const scale = Math.min(W / vw, H / vh);
  const w = vw * scale, h = vh * scale;
  Object.assign(video.style, { width: w + 'px', height: h + 'px', left: (W - w) / 2 + 'px', top: (H - h) / 2 + 'px' });
  video.classList.toggle('fadeY', h < H - 1);
  video.classList.toggle('fadeX', w < W - 1 && !(h < H - 1));
  const side = Math.max(120, Math.min(w - 32, h - 32, 640));
  // fade from the picture's edge all the way to the brackets
  const fade = h < H - 1 ? (h - side) / 2 : (w - side) / 2;
  video.style.setProperty('--fade', Math.max(48, fade - 2) + 'px');
  const f = $('#frame').style;
  f.width = side + 'px';
  f.top = (H - h) / 2 + h / 2 + 'px';
}
video.addEventListener('loadedmetadata', layoutVideo);
video.addEventListener('resize', layoutVideo);
addEventListener('resize', layoutVideo);
addEventListener('orientationchange', () => setTimeout(layoutVideo, 300));

// The photo is exactly what's inside the on-screen brackets: we work out which part of
// the camera image sits behind them and crop just that.
function frameCrop() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const box = video.getBoundingClientRect(), f = $('#frame').getBoundingClientRect();
  const scale = Math.max(box.width / vw, box.height / vh);      // how much the image is enlarged
  const ox = box.left + (box.width - vw * scale) / 2;           // where the image's edge sits on screen
  const oy = box.top + (box.height - vh * scale) / 2;
  let side = Math.min(Math.min(f.width, f.height) / scale, vw, vh);
  const sx = Math.max(0, Math.min(vw - side, (f.left - ox) / scale));
  const sy = Math.max(0, Math.min(vh - side, (f.top - oy) / scale));
  return { sx, sy, side };
}
async function capture() {
  const { sx, sy, side } = frameCrop();
  const make = (size, q) => new Promise(res => {
    const c = document.createElement('canvas');
    c.width = c.height = Math.round(Math.min(size, side));
    c.getContext('2d').drawImage(video, sx, sy, side, side, 0, 0, c.width, c.height);
    c.toBlob(res, 'image/jpeg', q);
  });
  const [photo, small] = await Promise.all([make(1200, 0.88), make(768, 0.8)]);
  return { photo, small };
}

// Shutter confirmation on the crosshairs (restarts cleanly on rapid presses)
function flashFrame() {
  const f = $('#frame');
  f.classList.remove('flash');
  void f.offsetWidth;
  f.classList.add('flash');
}
$('#frame').addEventListener('animationend', ev => { if (ev.target.classList.contains('ring')) $('#frame').classList.remove('flash'); });

/* =========================================================
   Identifying a record
   ========================================================= */
let busy = false;
async function api(path, opts) {
  const r = await fetch(path, opts);
  let j;
  try { j = await r.json(); } catch { throw new Error(`Server error (${r.status})`); }
  if (!r.ok) throw new Error(j.error || `Server error (${r.status})`);
  return j;
}

// The shutter is also the way back to the camera: from an album page or from the collection
$('#shutter').onclick = async () => {
  if (view !== 'scan' || sheetOpen()) return showView('scan');
  if (!cameraLive()) return startCamera();
  if (busy) return;
  flashFrame(); // instant, before any processing
  const tappedAt = performance.now();
  busy = true;
  const scannedAt = new Date().toISOString(); // the actual moment of scanning
  setBusy(true, 'Reading…');
  try {
    const { photo, small } = await capture();
    freezePreview(); // freeze the preview exactly as framed
    let entry;
    const again = rescanFor && (await allEntries()).find(x => x.id === rescanFor);
    if (again) {               // second photo of a record already in the collection
      entry = again;
      if (photo2Urls.has(entry.id)) { URL.revokeObjectURL(photo2Urls.get(entry.id)); photo2Urls.delete(entry.id); }
      entry.photo2 = photo; entry.source = 'photo';
      delete entry.guess; delete entry.release; delete entry.choices; delete entry.error;
      delete entry.ruledOut; delete entry.unidentified;
      entry.status = 'identifying';
    } else entry = { id: newId(), scannedAt, source: 'photo', status: 'identifying', photo };
    if (rescanFor) endRescan();
    saveEntry(entry);  // saved immediately; finished in the background
    const working = identify(entry, await blobToBase64(small)); // starts now, never waits for the page
    // Let the crosshair flash be seen before the album slides up (identifying takes longer anyway)
    setTimeout(() => { if (view === 'scan' && !sheetOpen()) openSheet(entry); }, Math.max(0, 260 - (performance.now() - tappedAt)));
    await working;
  } finally {
    busy = false; setBusy(false);
  }
};

function setBusy(on, text) {
  $('#shutter').classList.toggle('busy', on);
  $('#frame').classList.toggle('busy', on);
  $('#hint').textContent = on ? text : rescanFor ? 'Now photograph the label · tap here to cancel' : 'Fill the frame with a cover or label';
}

/* Remembered corrections: once you've told the app which release a reading means,
   the same reading goes straight to your choice next time. Kept on this phone only. */
const fixKey = g => g?.barcode ? 'bc:' + g.barcode : (g && (g.artist || g.album)) ? norm(g.artist) + '|' + norm(g.album) : '';
function readFixes() { try { return JSON.parse(localStorage.getItem('lh_fixes') || '{}'); } catch { return {}; } }
function rememberFix(e, releaseId) {
  const key = fixKey(e.source === 'barcode' ? { barcode: e.barcode } : e.guess);
  if (!key) return;
  const all = readFixes(); all[key] = releaseId;
  try { localStorage.setItem('lh_fixes', JSON.stringify(all)); } catch { /* storage full: not essential */ }
}
const knownFix = g => readFixes()[fixKey(g)] || '';

async function identify(entry, base64) {
  try {
    if (!entry.guess) {
      const { guess } = await api('/api/identify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64, exclude: entry.ruledOut || [] })
      });
      entry.guess = guess;
      if (guess.kind === 'unknown' || (!guess.album && !guess.artist)) {
        entry.status = 'notfound'; saveEntry(entry); refresh(entry); return;
      }
      saveEntry(entry);
      refresh(entry); // show the name now; the tracklist follows
    }
    const g = entry.guess;
    const fixed = knownFix(g);
    if (fixed) return await findRelease(entry, new URLSearchParams({ id: fixed }), 'remembered');
    // verify=1: the server only answers confidently when what it found matches what was read
    const params = new URLSearchParams({ verify: 1, artist: g.artist || '', album: g.album || '' });
    if (g.catalogue_number) params.set('catno', g.catalogue_number);
    if (g.record_label) params.set('label', g.record_label);
    if (g.is_compilation) params.set('compilation', '1');
    let sure = Number(g.confidence ?? 1); if (sure > 1) sure /= 100;
    if (sure < 0.6) params.set('unsure', '1'); // Gemini itself wasn't sure: offer choices, don't answer
    await findRelease(entry, params, 'photo', base64);
  } catch (e) {
    entry.status = 'error'; entry.error = e.message;
    saveEntry(entry); refresh(entry);
  }
}

// Covers are checked by eye before being shown: your photo against the artwork found.
// A mismatch means Gemini named the wrong record, so it's never shown; instead the app
// asks Gemini again with that answer ruled out. After two misses it says so honestly.
const MAX_TRIES = 2;
async function coverMatches(entry, base64, release) {
  const g = entry.guess || {};
  if (!base64 || !release.artwork || (g.kind !== 'cover' && g.text_visible !== false)) return true; // labels: no cover to compare
  entry.stage = 'checking'; refresh(entry);
  try {
    const { same } = await api('/api/compare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64, artwork: release.artwork })
    });
    return same !== 'no';
  } catch { return true; } // a failed check never blocks a result
  finally { delete entry.stage; }
}

async function findRelease(entry, params, by, base64) {
  const j = await api('/api/release?' + params);
  delete entry.choices;
  if (j.found && by === 'photo' && !(await coverMatches(entry, base64, j.release))) {
    const wrong = `${j.release.artist} — ${j.release.title}`;
    entry.ruledOut = [...(entry.ruledOut || []), wrong];
    if (entry.ruledOut.length < MAX_TRIES) {          // try again, ruling out the wrong answer
      delete entry.guess; delete entry.release;
      entry.status = 'identifying'; saveEntry(entry); refresh(entry);
      return identify(entry, base64);
    }
    delete entry.guess; delete entry.release;         // give up honestly rather than show a wrong cover
    entry.status = 'notfound'; entry.unidentified = true;
    saveEntry(entry); refresh(entry); return;
  }
  if (j.found) {
    entry.release = j.release; entry.status = 'done'; delete entry.error; delete entry.unidentified;
    entry.matchBy = by;
  } else if (j.choices?.length) {
    entry.status = 'choose'; entry.choices = j.choices; delete entry.release; // not sure: ask, never guess
  } else entry.status = 'notfound';
  saveEntry(entry); refresh(entry);
}

/* "Scan the label instead": a second photo of the same record re-identifies it,
   keeping the first photo and the original scan time */
let rescanFor = null;
function startRescan(e) {
  showView('scan');
  rescanFor = e.id;
  $('#hint').textContent = 'Now photograph the label · tap here to cancel';
  $('#hint').classList.add('rescan');
}
function endRescan() {
  rescanFor = null;
  $('#hint').classList.remove('rescan');
  if (!busy) setBusy(false);
}
$('#hint').addEventListener('click', () => { if (rescanFor) endRescan(); });
const photo2Urls = new Map();
function photo2Url(e) {
  if (!e?.photo2) return '';
  if (!photo2Urls.has(e.id)) photo2Urls.set(e.id, URL.createObjectURL(e.photo2));
  return photo2Urls.get(e.id);
}

// Re-draw whatever is showing this record
function refresh(entry) {
  if (current?.id === entry.id) renderSheet(entry);
}

// Finish any scan interrupted by leaving the app or losing signal — no rescan needed
let retrying = false;
async function retryUnfinished() {
  if (retrying || !navigator.onLine) return;
  retrying = true;
  try {
    for (const e of await allEntries()) {
      if (busy && e.id === current?.id) continue;
      if (e.status !== 'identifying' && e.status !== 'error') continue;
      if (e.source === 'barcode') await findRelease(e, new URLSearchParams({ barcode: e.barcode }), 'barcode').catch(() => {});
      else if (e.photo2 || e.photo) await identify(e, await blobToBase64(await shrink(e.photo2 || e.photo)));
    }
  } finally { retrying = false; }
}
async function shrink(blob) {
  const img = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = c.height = Math.min(768, img.width);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', 0.8));
}

/* =========================================================
   Barcodes — read quietly in the background, nothing on screen
   ========================================================= */
let detector = null, lastCode = '', lastCodeAt = 0;
async function startBarcodes() {
  if (detector) return;
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/barcode-detector@3/+esm');
    const D = mod.BarcodeDetector || mod.default?.BarcodeDetector || mod.default;
    detector = new D({ formats: ['ean_13', 'upc_a', 'ean_8', 'upc_e'] });
    barcodeLoop();
  } catch (e) { console.warn('Barcode reader unavailable', e); }
}
async function barcodeLoop() {
  setTimeout(barcodeLoop, 200);
  if (view !== 'scan' || busy || sheetOpen() || video.readyState < 2) return;
  try {
    const codes = await detector.detect(video);
    const code = codes[0]?.rawValue;
    if (!code || (code === lastCode && Date.now() - lastCodeAt < 15000)) return;
    lastCode = code; lastCodeAt = Date.now();
    barcodeScan(code);
  } catch { /* ignore a bad frame */ }
}
async function barcodeScan(code) {
  if (busy) return;
  busy = true;
  const scannedAt = new Date().toISOString();
  setBusy(true, 'Barcode ' + code);
  try {
    const { photo } = await capture();
    const fixed = knownFix({ barcode: code });
    const j = await api('/api/release?' + (fixed ? 'id=' + encodeURIComponent(fixed) : 'barcode=' + encodeURIComponent(code)));
    if (!j.found) { $('#hint').textContent = 'Barcode not found — photograph the cover or label'; await new Promise(r => setTimeout(r, 2500)); return; }
    const entry = { id: newId(), scannedAt, source: 'barcode', barcode: code, status: 'done', photo, release: j.release, matchBy: 'barcode' };
    saveEntry(entry); openSheet(entry);
  } catch { /* silent: barcodes are a bonus */ }
  finally { busy = false; setBusy(false); }
}

/* =========================================================
   Album page
   ========================================================= */
let current = null;
let lastViewedId = null; // the record to keep in view in the crate and list
const sheet = $('#sheet');
const sheetOpen = () => sheet.classList.contains('open');
function openSheet(entry) {
  current = entry;
  lastViewedId = entry.id; // so the crate and list come back to this record
  wantArt(entry);
  renderSheet(entry);
  sheet.scrollTop = 0;
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  $('#collection').classList.add('withSheet');
}
function closeSheet() {
  current = null;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  $('#collection').classList.remove('withSheet');
  if (view === 'scan' && video.paused) resumePreview(); // unfreeze the preview
}

function renderSheet(e) {
  const r = e.release, g = e.guess || {};
  // A cover reading isn't shown until the cover has passed the visual check, so a wrong name never flashes up
  const unconfirmed = e.status === 'identifying' && !r && (g.kind === 'cover' || g.text_visible === false);
  const artist = unconfirmed ? '' : displayArtist(e), title = unconfirmed ? '' : displayTitle(e);
  const details = r ? [r.label, r.catno, r.year, r.format].filter(Boolean).join(' · ') : (g.record_label || '');
  let status = '';
  if (e.status === 'identifying') status = e.ruledOut?.length ? 'Not a match. Taking another look…' : unconfirmed ? 'Reading the record…' : artist ? 'Finding the tracklist…' : 'Reading the record…';
  if (e.status === 'notfound' && e.unidentified) status = 'Couldn’t identify this cover with confidence. Scan the label, or search by title below.';
  else if (e.status === 'notfound') status = artist ? 'Couldn’t find this record. Scan the label, or search by title below.' : 'Couldn’t recognise this record. Scan the label, or search by title below.';
  if (e.status === 'choose') status = 'Not sure which record this is. Pick it below, or scan the label.';
  if (e.status === 'error') status = 'No connection to the record database. It will finish by itself when you’re back online.';

  // Slides: the found artwork first, then always your own photo
  const slides = [];
  slides.push(r?.artwork
    ? `<div class="slide"><img src="${esc(r.artwork)}" alt="Found artwork" data-cover="${esc(e.id)}" data-no-photo="1"${r.artworkAlt ? ` data-alt="${esc(r.artworkAlt)}"` : ''}></div>`
    : `<div class="slide">${e.photo && !r ? `<img src="${esc(photoUrl(e))}" alt="">` : typoCover(e)}</div>`);
  if (e.photo && (r?.artwork || r)) slides.push(`<div class="slide"><img src="${esc(photoUrl(e))}" alt="Your photo"><span class="tag mono">Your photo</span></div>`);
  if (e.photo2) slides.push(`<div class="slide"><img src="${esc(photo2Url(e))}" alt="Your second photo"><span class="tag mono">Your second photo</span></div>`);

  const tracks = r?.tracks || [];
  let lastSide = '';
  const rows = tracks.map(t => {
    const side = String(t.n).replace(/\d+/g, '');
    const gap = lastSide && side !== lastSide ? '<li class="sideRule" aria-hidden="true"></li>' : '';
    lastSide = side;
    return `${gap}<li><a href="${youtubeUrl(r.artist, t.title, r.title)}" target="_blank" rel="noopener" data-track>
      <span class="n">${esc(t.n)}</span><span class="t">${esc(t.title)}</span><span class="go">${PLAY}</span></a></li>`;
  }).join('');

  sheet.innerHTML = `<div class="sheet-top"><button class="close" data-act="close" aria-label="Close">×</button></div>
  <div class="sheet-inner">
    <div class="gallery">
      <div class="slides">${slides.join('')}</div>
      <div class="dots">${slides.length > 1 ? slides.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('') : ''}</div>
    </div>
    ${(e.status === 'choose' || (e.status === 'identifying' && e.guess && !r && !unconfirmed)) ? '<p class="meta mono">Read from your photo</p>' : details ? `<p class="meta mono">${esc(details)}</p>` : ''}
    <h2 class="artist">${esc(artist || (e.status === 'identifying' ? '…' : 'Unknown'))}</h2>
    <h3 class="title">${esc(title)}</h3>
    ${status ? `<p class="status mono ${e.status === 'error' ? 'err' : ''}">${esc(status)}</p>` : ''}
    ${e.status === 'error' ? '<button class="btn" data-act="retry" style="margin-top:12px">Try again</button>' : ''}
    ${e.status === 'notfound' && artist ? `<a class="btn album-yt" href="${youtubeUrl(artist, title, '')}" target="_blank" rel="noopener">${PLAY} Search YouTube for the album</a>` : ''}
    ${e.status === 'choose' ? `<section class="choose">
      <h4>Which one is it?</h4>
      <ul class="cands">${e.choices.map(c => `<li><button data-pick="${esc(c.id)}">
        <span class="cthumb"><img src="${esc(c.thumb)}" alt="" data-thumb-alt="${esc(c.thumbAlt || '')}" onerror="if(this.dataset.thumbAlt&&this.src!==this.dataset.thumbAlt){this.src=this.dataset.thumbAlt}else{this.remove()}"></span>
        <span class="ctext"><b>${esc(c.title)}</b><span>${esc(c.artist)}</span>
        <span class="mono">${esc([c.year, c.format, c.label, c.catno].filter(Boolean).join(' · '))}</span></span>
      </button></li>`).join('')}</ul>
    </section>` : ''}
    ${tracks.length ? `<p class="lead mono"><span>Tap a track to hear it on YouTube</span>${PLAY}</p><ol class="tracks">${rows}</ol>` : ''}
    <p class="when mono">${e.sample ? 'Sample record · ' : 'Scanned '}${esc(when(e.scannedAt))}</p>

    <section class="override">
      <h4>${e.status === 'choose' || e.status === 'notfound' ? 'None of these?' : 'Wrong record?'}</h4>
      ${e.sample ? '' : `<button class="btn rescan" data-act="rescan">Scan the label instead</button>
      <p class="mono quiet" style="margin-top:14px">Or search by title and artist</p>`}
      <form data-form="override">
        <input name="title" placeholder="Title" value="${esc(title)}" autocomplete="off" enterkeyhint="search">
        <input name="artist" placeholder="Artist" value="${esc(artist)}" autocomplete="off" enterkeyhint="search">
        <button class="btn solid" type="submit">Search</button>
      </form>
      <ul class="cands" id="cands"></ul>
    </section>
    <div class="removeRow"><button class="linkbtn mono" data-act="delete">Remove from collection</button></div>
  </div>`;

  // Dots follow the swipe
  const strip = sheet.querySelector('.slides'), dots = sheet.querySelectorAll('.dots i');
  if (dots.length) strip.addEventListener('scroll', () => {
    const i = Math.round(strip.scrollLeft / strip.clientWidth);
    dots.forEach((d, k) => d.classList.toggle('on', k === i));
  }, { passive: true });
}

sheet.addEventListener('click', async ev => {
  const t = ev.target.closest('[data-act], [data-track], [data-pick]');
  if (!t || !current) return;
  if (t.hasAttribute('data-track')) { t.classList.add('played'); return; } // the link opens YouTube
  const e = current;
  if (t.dataset.pick) return pickCandidate(e, t.dataset.pick);
  const act = t.dataset.act;
  if (act === 'close') { closeSheet(); if (view === 'collection') renderCollection(); }
  if (act === 'retry') {
    e.status = 'identifying'; renderSheet(e);
    if (e.source === 'barcode') findRelease(e, new URLSearchParams({ barcode: e.barcode }), 'barcode').catch(() => {});
    else identify(e, await blobToBase64(await shrink(e.photo2 || e.photo)));
  }
  if (act === 'rescan') { startRescan(e); return; }
  if (act === 'delete') {
    if (t.dataset.armed) { await removeEntry(e.id); closeSheet(); if (view === 'collection') renderCollection(); }
    else { t.dataset.armed = '1'; t.textContent = 'Tap again to remove'; t.style.color = 'var(--red)'; }
  }
});

// Text override: list the matching releases, the user picks the right one
sheet.addEventListener('submit', async ev => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const title = String(f.get('title')).trim(), artist = String(f.get('artist')).trim();
  const list = sheet.querySelector('#cands');
  if (!title && !artist) { list.innerHTML = '<li class="mono quiet" style="padding:12px 0">Type a title or an artist</li>'; return; }
  document.activeElement?.blur();
  list.innerHTML = '<li class="mono quiet" style="padding:12px 0">Searching…</li>';
  try {
    const { candidates } = await api('/api/release?' + new URLSearchParams({ list: 1, album: title, artist }));
    list.innerHTML = candidates.length ? candidates.map(c => `<li><button data-pick="${esc(c.id)}">
        <span class="cthumb"><img src="${esc(c.thumb)}" alt="" loading="lazy" onerror="this.remove()"></span>
        <span class="ctext"><b>${esc(c.title)}</b><span>${esc(c.artist)}</span>
        <span class="mono">${esc([c.year, c.format, c.country, c.label, c.catno].filter(Boolean).join(' · '))}</span></span>
      </button></li>`).join('')
      : '<li class="mono quiet" style="padding:12px 0">No vinyl releases found. Try fewer words, or check the spelling.</li>';
  } catch (err) {
    list.innerHTML = `<li class="mono" style="padding:12px 0;color:var(--red)">${esc(err.message)}</li>`;
  }
});

async function pickCandidate(e, id) {
  const list = sheet.querySelector('#cands');
  if (list) list.innerHTML = '<li class="mono quiet" style="padding:12px 0">Loading tracklist…</li>';
  try {
    await findRelease(e, new URLSearchParams({ id }), 'manual');
    rememberFix(e, id); // next time this reading goes straight here
    sheet.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    if (list) list.innerHTML = `<li class="mono" style="padding:12px 0;color:var(--red)">${esc(err.message)}</li>`;
  }
}

async function removeEntry(id) {
  await deleteEntry(id);
  if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); }
}

/* =========================================================
   Collection: crate or list
   ========================================================= */
let mode = localStorage.getItem('lh_mode') || 'crate';
let entries = [];
const entryById = new Map();
document.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
  mode = b.dataset.mode; localStorage.setItem('lh_mode', mode); renderCollection();
});

async function renderCollection() {
  entries = sortEntries((await allEntries()).filter(e => displayTitle(e) || e.status === 'identifying'));
  document.querySelectorAll('.sortbar button').forEach(b => b.classList.toggle('on', b.dataset.sort === sortBy));
  entryById.clear(); entries.forEach(e => entryById.set(e.id, e));
  document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  $('#clearSamples').hidden = !entries.some(e => e.sample);
  $('#count').textContent = `${entries.length} record${entries.length === 1 ? '' : 's'}`;
  const empty = entries.length === 0;
  $('#empty').hidden = !empty;
  $('#crateWrap').hidden = empty || mode !== 'crate';
  $('#listWrap').hidden = empty || mode !== 'list';
  if (empty) return;
  if (mode === 'crate') renderCrate(); else renderList(true);
}

/* ---------- The crate: vertical Cover Flow with its own scroll physics ----------
   No browser scrolling here. A small physics engine moves the records:
   - Dragging: the crate follows the finger 1:1, drawn in the same frame.
   - Release: velocity is measured over the last ~80 ms of the gesture.
   - Momentum: iOS-style deceleration (UIScrollView's "normal" rate, 0.998 per ms).
     We project where that natural glide would end, choose the record nearest to it,
     and shape the decay so it arrives there exactly — one continuous movement that
     starts at the finger's speed and comes to rest centred. No separate snap.
   - A touch during momentum catches the crate where it is.
   - Past either end the crate stretches with iOS-style resistance and springs back.
   Only transforms and opacity change per frame (GPU work, no layout). */
const crate = $('#crate');
let sleeves = [], shades = [], focusIndex = -1;
let metrics = { s: 0, step: 0, H: 0, max: 0 };
let pos = 0;               // how far the crate has moved, in px (record i is centred at i × step)
let anim = null, animFrame = 0;

const DECEL = 0.998;                       // per ms, as iOS
const PROJECT = DECEL / (1 - DECEL);       // ms: distance = velocity × this
const SPRING = 0.016;                      // per ms: critically damped settle (~300 ms)
const P = 1500, MAX_LEAN = 64;             // Cover Flow look

// A fingerprint of what the crate or list shows. If nothing has changed since it was
// built, the existing covers are reused as they are (already loaded and drawn) instead
// of being rebuilt, which is what caused the blank-cover lag on returning.
const signature = list => sortBy + '#' + list.map(e =>
  [e.id, e.release?.artwork || '', displayTitle(e), displayArtist(e), e.photo ? 1 : 0, e.status].join('|')).join('~');
let crateSig = '', listSig = '';

function renderCrate() {
  const sig = signature(entries);
  if (sig === crateSig && sleeves.length) {        // nothing changed: just return to the record
    stopAnim();
    const i = entries.findIndex(e => e.id === lastViewedId);
    layoutCrate(i >= 0 ? i : 0);
    return;
  }
  crateSig = sig;
  crate.innerHTML = entries.map((e, i) =>
    `<button class="sleeve" data-i="${i}" style="z-index:${i + 1}" aria-label="${esc(displayArtist(e))} — ${esc(displayTitle(e))}">${coverImg(e, e.release?.artwork || photoUrl(e))}<i class="shade"></i></button>`
  ).join('');
  sleeves = [...crate.querySelectorAll('.sleeve')];
  shades = sleeves.map(el => el.querySelector('.shade'));
  stopAnim();
  pos = 0; focusIndex = -1;
  const i = entries.findIndex(e => e.id === lastViewedId);
  layoutCrate(i >= 0 ? i : 0); // come back to the record last viewed
}
function layoutCrate(startAt) {
  if (!sleeves.length) return;
  const H = crate.clientHeight, s = sleeves[0].offsetWidth, step = s * 0.34;
  const top = H / 2 - s / 2;
  sleeves.forEach(el => el.style.top = top + 'px');
  const keep = startAt ?? (focusIndex >= 0 ? focusIndex : 0);
  metrics = { s, step, H, max: (sleeves.length - 1) * step };
  pos = keep * step;
  focusIndex = -1; // forces the caption under the crate to refresh
  draw();
  crateAtRest();
}
addEventListener('resize', () => { if (sleeves.length && !crate.closest('[hidden]')) layoutCrate(); });

// Draw every record for the current position. Called once per frame at most.
// Safari note: each record carries its own perspective(), and records above the middle are
// pushed back a full record-depth per step, so 3D depth order always matches stacking order.
function draw() {
  const { s, step } = metrics;
  if (!step) return;
  const depth = s * Math.sin(MAX_LEAN * Math.PI / 180) + 12;
  const at = pos / step;
  for (let i = 0; i < sleeves.length; i++) {
    const el = sleeves[i], d = i - at, a = Math.abs(d);
    const show = d >= -5 && d <= 3;
    if (el._show !== show) { el.style.visibility = show ? '' : 'hidden'; el._show = show; }
    if (!show) continue;
    const k = Math.min(a, 1);
    const y = d * step;
    if (d <= 0) {
      const angle = Math.min(MAX_LEAN, 48 * k + 4 * (a - k));
      el.style.transform = `translate3d(0,${y}px,0) perspective(${P}px) translateZ(${-depth * a}px) rotateX(${angle}deg)`;
      shades[i].style.opacity = d < -0.05 ? Math.min(a, 4) * 0.07 : 0;
    } else {
      el.style.transform = `translate3d(0,${y + s * 0.22 * k}px,0) perspective(${P}px) translateZ(${k}px) rotateX(${-70 * k}deg)`;
      shades[i].style.opacity = 0;
    }
  }
  const f = Math.max(0, Math.min(sleeves.length - 1, Math.round(at)));
  if (f !== focusIndex) { focusIndex = f; lastViewedId = entries[f]?.id ?? lastViewedId; renderInfo(entries[f]); }
}

// iOS rubber band: past an edge, movement is resisted more the further you pull
const band = (over, dim) => (1 - 1 / (over * 0.55 / dim + 1)) * dim;
function banded(raw) {
  if (raw < 0) return -band(-raw, metrics.H);
  if (raw > metrics.max) return metrics.max + band(raw - metrics.max, metrics.H);
  return raw;
}
function unband(p) { // inverse of banded, so a new drag starts exactly where the crate is
  const dim = metrics.H, inv = v => (dim / 0.55) * (1 / (1 - v / dim) - 1);
  if (p < 0) return -inv(Math.min(-p, dim * 0.999));
  if (p > metrics.max) return metrics.max + inv(Math.min(p - metrics.max, dim * 0.999));
  return p;
}

/* ---- animation: momentum decay that lands on a record, or a spring ---- */
function stopAnim() { cancelAnimationFrame(animFrame); anim = null; }
// Once the crate stops, the records you can see (behind and in front of the centre) get their check
function crateAtRest() {
  if (!sleeves.length || mode !== 'crate' || view !== 'collection') return;
  onScreen.clear();
  for (let i = Math.max(0, focusIndex - 4); i <= Math.min(entries.length - 1, focusIndex + 2); i++) onScreen.add(entries[i].id);
  for (let i = Math.min(entries.length - 1, focusIndex + 2); i >= Math.max(0, focusIndex - 4); i--) if (i !== focusIndex) wantArt(entries[i]);
  wantArt(entries[focusIndex]); // the centre record goes first
}
function run(a) {
  stopAnim();
  anim = { ...a, t0: performance.now(), x0: pos };
  const frame = now => {
    const t = now - anim.t0;
    let x, done = false;
    if (anim.type === 'decay') {
      x = anim.x0 + anim.D * (1 - Math.exp(-anim.k * t));
      if (Math.abs(anim.x0 + anim.D - x) < 0.3) { x = anim.x0 + anim.D; done = true; }
    } else {
      const w = anim.w, x0 = anim.x0 - anim.target;
      x = anim.target + (x0 + (anim.v + w * x0) * t) * Math.exp(-w * t);
      if (t > 60 && Math.abs(x - anim.target) < 0.3) { x = anim.target; done = true; }
    }
    pos = x; draw();
    if (done) { anim = null; crateAtRest(); } else animFrame = requestAnimationFrame(frame);
  };
  animFrame = requestAnimationFrame(frame);
}
const clampIndex = i => Math.max(0, Math.min(sleeves.length - 1, i));
function springTo(target, v = 0, w = SPRING) { run({ type: 'spring', target, v, w }); }

// Release with velocity v (px/ms, in crate direction)
function release(v) {
  const { step, max } = metrics;
  if (pos < 0 || pos > max) return springTo(pos < 0 ? 0 : max, v * 0.3);
  const projected = pos + v * PROJECT;                      // where a natural iOS glide would end
  let target = clampIndex(Math.round(projected / step)) * step;
  let D = target - pos;
  if (Math.abs(v) > 0.08 && Math.sign(D) === Math.sign(v)) {
    let k = v / D;                                          // decay that starts at the finger's speed and ends on target
    if (k > 0.02) {                                         // would stop too abruptly: carry on to the next record
      const next = clampIndex(Math.round(target / step) + Math.sign(v)) * step;
      if (next !== target) { target = next; D = target - pos; k = v / D; }
    }
    if (k <= 0.02) return run({ type: 'decay', D, k: Math.max(k, 0.0012) });
  }
  springTo(target, v);                                      // slow release: settle gently
}

/* ---- touch, pen and mouse ---- */
let drag = null;
crate.addEventListener('pointerdown', ev => {
  if (ev.button > 0 || !sleeves.length) return;
  const wasMoving = !!anim && (anim.type === 'decay' || Math.abs(anim.target - pos) > 2);
  stopAnim();                                                // catch the crate where it is
  drag = { id: ev.pointerId, y0: ev.clientY, raw0: unband(pos), t0: ev.timeStamp, moved: 0,
           wasMoving, target: ev.target.closest('.sleeve'), samples: [{ t: ev.timeStamp, y: ev.clientY }] };
  crate.setPointerCapture(ev.pointerId);
});
crate.addEventListener('pointermove', ev => {
  if (!drag || ev.pointerId !== drag.id) return;
  const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
  for (const e of events) drag.samples.push({ t: e.timeStamp, y: e.clientY });
  while (drag.samples.length > 2 && ev.timeStamp - drag.samples[0].t > 100) drag.samples.shift();
  const dy = ev.clientY - drag.y0;
  drag.moved = Math.max(drag.moved, Math.abs(dy));
  pos = banded(drag.raw0 - dy);                              // finger down = crate back, 1:1
  draw();                                                    // same frame as the touch
});
function endDrag(ev) {
  if (!drag || ev.pointerId !== drag.id) return;
  const d = drag; drag = null;
  if (d.moved < 8 && ev.timeStamp - d.t0 < 450) {           // a tap, not a drag
    if (d.wasMoving) return release(0);                      // a tap on a moving crate just stops it
    const i = d.target ? +d.target.dataset.i : -1;
    if (i < 0) return release(0);
    if (i === focusIndex && Math.abs(pos - i * metrics.step) < 2) return openSheet(entries[i]);
    return springTo(i * metrics.step);
  }
  // velocity over the last ~80 ms; a pause before lifting means no fling
  const last = d.samples[d.samples.length - 1];
  const recent = d.samples.filter(p => last.t - p.t <= 80);
  let v = 0;
  if (ev.timeStamp - last.t < 60 && recent.length > 1) {
    const first = recent[0];
    v = -(last.y - first.y) / Math.max(1, last.t - first.t); // crate moves opposite to the finger
  }
  release(Math.max(-8, Math.min(8, v)));
}
crate.addEventListener('pointerup', endDrag);
crate.addEventListener('pointercancel', endDrag);
crate.addEventListener('click', ev => { // keyboard activation only; taps are handled above
  if (ev.detail !== 0) return;
  const b = ev.target.closest('.sleeve');
  if (b) openSheet(entries[+b.dataset.i]);
});

/* ---- trackpad and mouse wheel (desktop): the system supplies its own momentum ---- */
let wheelTimer = 0;
crate.addEventListener('wheel', ev => {
  ev.preventDefault();
  if (!sleeves.length) return;
  stopAnim();
  const unit = ev.deltaMode === 1 ? 40 : ev.deltaMode === 2 ? metrics.H : 1;
  pos = Math.max(-40, Math.min(metrics.max + 40, pos + ev.deltaY * unit));
  draw();
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => springTo(clampIndex(Math.round(pos / metrics.step)) * metrics.step), 120);
}, { passive: false });

/* ---- keyboard: up / down arrows ---- */
addEventListener('keydown', ev => {
  if (view !== 'collection' || mode !== 'crate' || sheetOpen() || !sleeves.length) return;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    springTo(clampIndex(focusIndex + (ev.key === 'ArrowDown' ? 1 : -1)) * metrics.step);
  }
  if (ev.key === 'Enter' && entries[focusIndex]) openSheet(entries[focusIndex]);
});

function renderInfo(e) {
  if (!e) return;
  $('#crateInfo').innerHTML = `<div class="a">${esc(displayArtist(e) || '…')}</div>
    <div class="t">${esc(displayTitle(e))}</div>
    <div class="w mono">${esc((e.status === 'choose' || e.status === 'notfound') ? 'Needs checking · tap to choose' : e.sample ? 'Sample record' : when(e.scannedAt))}</div>`;
  $('#crateInfo').querySelectorAll('.a, .t').forEach(marquee);
}

// Lock-screen style: a line too long to fit holds, then scrolls left and loops seamlessly
const MQ_SPEED = 40, MQ_GAP = 48, MQ_HOLD = 2; // px per second, px between repeats, seconds paused each loop
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
function marquee(el) {
  const text = el.textContent;
  el.classList.add('marquee');
  el.innerHTML = `<span class="mq"><span>${esc(text)}</span></span>`;
  const inner = el.firstChild, one = inner.firstChild;
  const room = el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight);
  const w = one.getBoundingClientRect().width;
  if (w <= room + 1) { el.classList.remove('marquee'); el.textContent = text; return; } // fits: stays still and centred
  inner.insertAdjacentHTML('beforeend', `<span class="gap"></span><span aria-hidden="true">${esc(text)}</span>`);
  if (reduceMotion.matches) return;
  const shift = w + MQ_GAP, dur = shift / MQ_SPEED + MQ_HOLD;
  inner.animate([
    { transform: 'translateX(0)', offset: 0 },
    { transform: 'translateX(0)', offset: MQ_HOLD / dur },         // pause on the start
    { transform: `translateX(${-shift}px)`, offset: 1 }            // second copy lands exactly where the first began
  ], { duration: dur * 1000, iterations: Infinity, easing: 'linear' });
}

$('#crateInfo').onclick = () => entries[focusIndex] && openSheet(entries[focusIndex]);

/* ---------- The list: search as you type, sort, A–Z index, swipe left to delete ---------- */
const listEl = $('#list'), q = $('#q'), az = $('#az'), bubble = $('#azBubble');
let sortBy = localStorage.getItem('lh_sort') || 'date'; // newest first, as the brief's crate
const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
// Filed the way a record shop files them: "The Cure" under C
const sortText = s => String(s || '').trim().replace(/^(the|a|an)\s+/i, '');
const letterOf = s => { const c = norm(sortText(s)).charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#'; };
function sortValue(e) {
  if (sortBy === 'title') return sortText(displayTitle(e));
  if (sortBy === 'date') return e.scannedAt;
  return sortText(displayArtist(e));
}
document.querySelectorAll('.sortbar button').forEach(b => b.onclick = () => {
  if (sortBy === b.dataset.sort) return;
  sortBy = b.dataset.sort; localStorage.setItem('lh_sort', sortBy); listEl.scrollTop = 0; renderCollection();
});
// One order for both Crate and List: A to Z for artist and title, newest first for date
function sortEntries(list) {
  const az = (x, y) => x.localeCompare(y, 'en', { sensitivity: 'base', numeric: true });
  return list.sort((a, b) => sortBy === 'date'
    ? b.scannedAt.localeCompare(a.scannedAt)
    : az(sortValue(a), sortValue(b)) || az(sortText(displayTitle(a)), sortText(displayTitle(b))));
}

function renderList(restore = false) {
  const sig = signature(entries) + '?' + q.value;
  if (sig === listSig && listEl.children.length) { // nothing changed: keep the rows as they are
    if (restore) centreListOn(lastViewedId);
    return;
  }
  listSig = sig;
  listSeen.disconnect();
  const words = norm(q.value) ? q.value.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const shown = entries.filter(e => {
    if (!words.length) return true;
    const hay = [displayTitle(e), displayArtist(e), e.release?.label, e.release?.catno, e.release?.year].join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  });

  const alpha = sortBy !== 'date';
  listEl.innerHTML = shown.map(e => {
    const r = e.release || {};
    // sorted by Date: show when it was scanned, so the order makes sense at a glance
    const meta = (e.status === 'choose' || e.status === 'notfound') ? 'Needs checking'
      : sortBy === 'date' ? when(e.scannedAt) : [r.year, r.label, r.format].filter(Boolean).join(' · ');
    const letter = alpha ? letterOf(sortBy === 'title' ? displayTitle(e) : displayArtist(e)) : '';
    return `<li data-letter="${letter}"><div class="swipe">
      <button class="rowmain" data-open="${esc(e.id)}">
        <span class="cover">${coverImg(e, r.artwork || photoUrl(e))}</span>
        <span class="txt"><span class="rt">${esc(displayTitle(e) || '…')}</span><span class="ra">${esc(displayArtist(e))}</span><span class="rm mono">${esc(meta)}</span></span>
      </button>
      <button class="rowdel" data-del="${esc(e.id)}">Delete</button>
    </div></li>`;
  }).join('');
  $('#noResults').hidden = shown.length > 0;
  listEl.querySelectorAll('li').forEach(li => listSeen.observe(li));
  if (restore) centreListOn(lastViewedId);

  // A–Z index, only when sorted alphabetically and there's enough to scroll
  const showIndex = alpha && shown.length > 8;
  az.hidden = !showIndex;
  listEl.classList.toggle('withIndex', showIndex);
  if (showIndex) {
    const present = new Set([...listEl.children].map(li => li.dataset.letter));
    az.innerHTML = LETTERS.map(l => `<span data-l="${l}" class="${present.has(l) ? '' : 'off'}">${l}</span>`).join('');
  }
}

// Rows report when they're on screen, so only records you can see get an artwork check
const listSeen = new IntersectionObserver(items => {
  for (const it of items) {
    const id = it.target.querySelector('[data-open]')?.dataset.open;
    if (!id) continue;
    if (it.isIntersecting) { onScreen.add(id); wantArt(entryById.get(id)); }
    else onScreen.delete(id);
  }
}, { root: listEl });

function centreListOn(id) {
  if (!id) return;
  const li = listEl.querySelector(`[data-open="${CSS.escape(id)}"]`)?.closest('li');
  if (li) listEl.scrollTop = Math.max(0, li.offsetTop - (listEl.clientHeight - li.offsetHeight) / 2);
}

// Jump to the first record under a letter (or the next letter that has records)
function jumpTo(letter) {
  const from = LETTERS.indexOf(letter);
  for (const l of LETTERS.slice(from).concat(LETTERS.slice(0, from).reverse())) {
    const li = listEl.querySelector(`li[data-letter="${l}"]`);
    if (li) { listEl.scrollTop = li.offsetTop; break; }
  }
  bubble.textContent = letter; bubble.hidden = false;
  clearTimeout(jumpTo.t); jumpTo.t = setTimeout(() => bubble.hidden = true, 600);
}
function letterAt(y) {
  const spans = az.querySelectorAll('span');
  for (const s of spans) { const r = s.getBoundingClientRect(); if (y >= r.top && y < r.bottom) return s.dataset.l; }
  const first = spans[0]?.getBoundingClientRect();
  return y < (first?.top ?? 0) ? LETTERS[0] : LETTERS.at(-1);
}
let lastLetter = '';
function onIndex(ev) {
  ev.preventDefault();
  const t = ev.touches ? ev.touches[0] : ev;
  const l = letterAt(t.clientY);
  if (l !== lastLetter) { lastLetter = l; jumpTo(l); }
}
az.addEventListener('touchstart', ev => { lastLetter = ''; onIndex(ev); }, { passive: false });
az.addEventListener('touchmove', onIndex, { passive: false });
az.addEventListener('mousedown', ev => {
  lastLetter = ''; onIndex(ev);
  const move = e => onIndex(e), up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
});
q.addEventListener('input', renderList);
listEl.addEventListener('click', async ev => {
  const open = ev.target.closest('[data-open]'), del = ev.target.closest('[data-del]');
  if (open) {
    const sw = open.parentElement;
    if (sw.scrollLeft > 4) { sw.scrollTo({ left: 0, behavior: 'smooth' }); return; } // tap closes an open swipe
    openSheet(entryById.get(open.dataset.open));
  }
  if (del) {
    const li = del.closest('li');
    li.style.transition = 'opacity .2s'; li.style.opacity = '0';
    await removeEntry(del.dataset.del);
    entries = entries.filter(e => e.id !== del.dataset.del);
    entryById.delete(del.dataset.del);
    setTimeout(() => { li.remove(); $('#count').textContent = `${entries.length} record${entries.length === 1 ? '' : 's'}`; if (!entries.length) renderCollection(); }, 200);
  }
});

/* =========================================================
   Artwork check for records saved before album-level artwork existed.
   On demand only: a record is checked when it's opened, or when it's on screen in the
   crate (once the crate is at rest) or the list. One check a second at most, newest
   request first, and a record that has left the screen by its turn is skipped (it will be
   checked when next seen). Each record is checked once, ever.
   ========================================================= */
const artQueue = [];          // record ids, newest request last
const onScreen = new Set();   // ids currently visible in the crate or list
let artBusy = false;
const artDone = new Set(); // checked (or being checked) this session, whatever object holds the record
const needsArt = e => !!e?.release?.id && !e.artChecked && !artDone.has(e.id) && !(e.release.artwork && 'artworkAlt' in e.release);
function wantArt(e) {
  if (!needsArt(e)) return;
  const i = artQueue.indexOf(e.id);
  if (i >= 0) artQueue.splice(i, 1);
  artQueue.push(e.id);
  if (!artBusy) checkNextArt();
}
async function checkNextArt() {
  artBusy = true;
  while (artQueue.length) {
    const id = artQueue.pop();                                   // most recent request first
    if (id !== current?.id && !onScreen.has(id)) continue;       // no longer visible: leave for later
    const e = entryById.get(id) || (current?.id === id ? current : null);
    if (!needsArt(e) || !navigator.onLine) continue;
    artDone.add(id);
    try {
      const j = await api('/api/release?' + new URLSearchParams({ id: e.release.id }));
      // the collection may have reloaded meanwhile: update whichever copy is current
      for (const x of new Set([e, entryById.get(id), current?.id === id ? current : null])) {
        if (!x?.release) continue;
        if (j.found) { x.release.artwork = j.release.artwork; x.release.artworkAlt = j.release.artworkAlt; }
        x.artChecked = true;
      }
      const latest = entryById.get(id) || e;
      await saveEntry(latest);
      showNewArt(latest);
    } catch { artDone.delete(id); /* tried again next time it's seen */ }
    await new Promise(res => setTimeout(res, 1100)); // be polite to MusicBrainz
  }
  artBusy = false;
}
// Put a newly found cover in place, without rebuilding the crate or list
function showNewArt(e) {
  const src = e.release.artwork || photoUrl(e);
  const i = entries.findIndex(x => x.id === e.id);
  if (i >= 0 && sleeves[i]) sleeves[i].innerHTML = coverImg(e, src) + '<i class="shade"></i>', shades[i] = sleeves[i].querySelector('.shade');
  const cell = listEl.querySelector(`[data-open="${CSS.escape(e.id)}"] .cover`);
  if (cell) cell.innerHTML = coverImg(e, src);
  if (current?.id === e.id) renderSheet(e);
  // the crate and list now match the saved data, so they don't need rebuilding later
  if (crateSig) crateSig = signature(entries);
  if (listSig) listSig = signature(entries) + '?' + q.value;
}

/* =========================================================
   Sample records — real lookups, so the design is judged on real artwork
   ========================================================= */
const SAMPLES = [
  ['George Benson', 'Give Me the Night'], ['Chic', 'C’est Chic'], ['Change', 'Miracles'],
  ['Linda Clifford', 'I’m Yours'], ['Sylvester', 'All I Need'], ['Stevie Wonder', 'My Cherie Amour'],
  ['Jamiroquai', 'A Funk Odyssey']
];
$('#addSamples').onclick = async () => {
  const btn = $('#addSamples');
  btn.disabled = true;
  let n = 0;
  for (const [artist, album] of SAMPLES) {
    btn.textContent = `Fetching ${++n} of ${SAMPLES.length}…`;
    try {
      const j = await api('/api/release?' + new URLSearchParams({ artist, album }));
      if (j.found) await saveEntry({
        id: newId(), sample: true, source: 'sample', status: 'done', release: j.release,
        scannedAt: new Date(Date.now() - n * 36e5 * 26).toISOString()
      });
    } catch { /* skip */ }
    await new Promise(r => setTimeout(r, 1100)); // be polite to MusicBrainz
  }
  btn.disabled = false; btn.textContent = 'Fill with sample records';
  renderCollection();
};
$('#clearSamples').onclick = async () => {
  for (const e of await allEntries()) if (e.sample) await removeEntry(e.id);
  renderCollection();
};

/* =========================================================
   Go
   ========================================================= */
startCamera();
retryUnfinished();
