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
const displayArtist = e => e.release?.artist || e.guess?.artist || '';
const displayTitle = e => e.release?.title || e.guess?.album || '';
function typoCover(e) {
  return `<div class="typo"><b>${esc(displayArtist(e) || 'Unknown')}</b><span>${esc(displayTitle(e))}</span></div>`;
}
// An <img> that falls back to the user's photo, then to a typographic cover
function coverImg(e, src) {
  return src ? `<img src="${esc(src)}" alt="" loading="lazy" data-cover="${esc(e.id)}">` : typoCover(e);
}
document.addEventListener('error', ev => {
  const img = ev.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.cover) return;
  const e = entryById.get(img.dataset.cover) || current;
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
  if (v === 'collection') renderCollection();
  if (v === 'scan') ensureCamera();
}
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => showView(b.dataset.go));

/* =========================================================
   Camera
   ========================================================= */
const video = $('#video');
let stream = null;
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1920 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    $('#startCam').hidden = true;
    setBusy(false);
    startBarcodes();
  } catch (e) {
    $('#startCam').hidden = false;
    $('#hint').textContent = e.name === 'NotAllowedError' ? 'Camera access needed to scan' : 'Camera unavailable';
  }
}
const cameraLive = () => stream && stream.getVideoTracks()[0]?.readyState === 'live' && !video.paused;
function ensureCamera() { if (!cameraLive()) startCamera(); }
$('#startCam').onclick = startCamera;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (view === 'scan') ensureCamera();
  retryUnfinished();
});

// Grab the centre square of the camera: a full photo for the collection, a small one for Gemini
async function capture() {
  const vw = video.videoWidth, vh = video.videoHeight, side = Math.min(vw, vh);
  const make = (size, q) => new Promise(res => {
    const c = document.createElement('canvas');
    c.width = c.height = Math.min(size, side);
    c.getContext('2d').drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, c.width, c.height);
    c.toBlob(res, 'image/jpeg', q);
  });
  const [photo, small] = await Promise.all([make(1200, 0.85), make(768, 0.8)]);
  return { photo, small };
}

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
  busy = true;
  const scannedAt = new Date().toISOString(); // the actual moment of scanning
  setBusy(true, 'Reading…');
  try {
    const { photo, small } = await capture();
    const entry = { id: newId(), scannedAt, source: 'photo', status: 'identifying', photo };
    $('#freeze').src = photoUrl(entry); $('#freeze').hidden = false;
    saveEntry(entry);  // saved immediately; finished in the background
    openSheet(entry);
    await identify(entry, await blobToBase64(small));
  } finally {
    busy = false; setBusy(false);
  }
};

function setBusy(on, text) {
  $('#shutter').classList.toggle('busy', on);
  $('#frame').classList.toggle('busy', on);
  $('#hint').textContent = on ? text : 'Fill the frame with a cover or label';
}

async function identify(entry, base64) {
  try {
    if (!entry.guess) {
      const { guess } = await api('/api/identify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: base64 })
      });
      entry.guess = guess;
      if (guess.kind === 'unknown' || (!guess.album && !guess.artist)) {
        entry.status = 'notfound'; saveEntry(entry); refresh(entry); return;
      }
      saveEntry(entry);
      refresh(entry); // show the name now; the tracklist follows
    }
    const g = entry.guess;
    const params = new URLSearchParams({ artist: g.artist || '', album: g.album || '' });
    if (g.catalogue_number) params.set('catno', g.catalogue_number);
    await findRelease(entry, params, 'photo');
  } catch (e) {
    entry.status = 'error'; entry.error = e.message;
    saveEntry(entry); refresh(entry);
  }
}

async function findRelease(entry, params, by) {
  const j = await api('/api/release?' + params);
  if (j.found) {
    entry.release = j.release; entry.status = 'done'; delete entry.error;
    entry.matchBy = by;
  } else entry.status = 'notfound';
  saveEntry(entry); refresh(entry);
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
      else if (e.photo) await identify(e, await blobToBase64(await shrink(e.photo)));
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
    const j = await api('/api/release?barcode=' + encodeURIComponent(code));
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
const sheet = $('#sheet');
const sheetOpen = () => sheet.classList.contains('open');
function openSheet(entry) {
  current = entry;
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
  $('#freeze').hidden = true;
}

function renderSheet(e) {
  const r = e.release, g = e.guess || {};
  const artist = displayArtist(e), title = displayTitle(e);
  const details = r ? [r.label, r.catno, r.year, r.format].filter(Boolean).join(' · ') : (g.record_label || '');
  let status = '';
  if (e.status === 'identifying') status = artist ? 'Finding the tracklist…' : 'Reading the record…';
  if (e.status === 'notfound') status = artist ? 'Couldn’t find a tracklist. Try searching by text below.' : 'Couldn’t recognise this record. Try the label, or search by text below.';
  if (e.status === 'error') status = 'No connection to the record database. It will finish by itself when you’re back online.';

  // Slides: the found artwork first, then always your own photo
  const slides = [];
  slides.push(r?.artwork
    ? `<div class="slide"><img src="${esc(r.artwork)}" alt="Found artwork" data-cover="${esc(e.id)}" data-no-photo="1"></div>`
    : `<div class="slide">${e.photo && !r ? `<img src="${esc(photoUrl(e))}" alt="">` : typoCover(e)}</div>`);
  if (e.photo && (r?.artwork || r)) slides.push(`<div class="slide"><img src="${esc(photoUrl(e))}" alt="Your photo"><span class="tag mono">Your photo</span></div>`);

  const tracks = r?.tracks || [];
  let lastSide = '';
  const rows = tracks.map(t => {
    const side = String(t.n).replace(/\d+/g, '');
    const gap = lastSide && side !== lastSide ? '<li class="sideRule" aria-hidden="true"></li>' : '';
    lastSide = side;
    return `${gap}<li><a href="${youtubeUrl(r.artist, t.title, r.title)}" data-track>
      <span class="n">${esc(t.n)}</span><span class="t">${esc(t.title)}</span><span class="go">${PLAY}</span></a></li>`;
  }).join('');

  sheet.innerHTML = `<div class="sheet-top"><button class="close" data-act="close" aria-label="Close">×</button></div>
  <div class="sheet-inner">
    <div class="gallery">
      <div class="slides">${slides.join('')}</div>
      <div class="dots">${slides.length > 1 ? slides.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('') : ''}</div>
    </div>
    ${details ? `<p class="meta mono">${esc(details)}</p>` : ''}
    <h2 class="artist">${esc(artist || (e.status === 'identifying' ? '…' : 'Unknown'))}</h2>
    <h3 class="title">${esc(title)}</h3>
    ${status ? `<p class="status mono ${e.status === 'error' ? 'err' : ''}">${esc(status)}</p>` : ''}
    ${e.status === 'error' ? '<button class="btn" data-act="retry" style="margin-top:12px">Try again</button>' : ''}
    ${e.status === 'notfound' && artist ? `<a class="btn album-yt" href="${youtubeUrl(artist, title, '')}">${PLAY} Search YouTube for the album</a>` : ''}
    ${tracks.length ? `<p class="lead mono"><span>Tap a track to hear it on YouTube</span>${PLAY}</p><ol class="tracks">${rows}</ol>` : ''}
    <p class="when mono">${e.sample ? 'Sample record · ' : 'Scanned '}${esc(when(e.scannedAt))}</p>

    <section class="override">
      <h4>Wrong record?</h4>
      <p class="mono quiet" style="margin-top:4px">Search by title and artist instead</p>
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
    else identify(e, await blobToBase64(await shrink(e.photo)));
  }
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
  entries = (await allEntries()).filter(e => displayTitle(e) || e.status === 'identifying');
  entryById.clear(); entries.forEach(e => entryById.set(e.id, e));
  document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  $('#clearSamples').hidden = !entries.some(e => e.sample);
  $('#count').textContent = `${entries.length} record${entries.length === 1 ? '' : 's'}`;
  const empty = entries.length === 0;
  $('#empty').hidden = !empty;
  $('#crateWrap').hidden = empty || mode !== 'crate';
  $('#listWrap').hidden = empty || mode !== 'list';
  if (empty) return;
  if (mode === 'crate') renderCrate(); else renderList();
}

/* ---------- The crate: vertical, layered, the middle record stands up ---------- */
const crate = $('#crate');
let sleeves = [], focusIndex = -1, ticking = false, metrics = { s: 0, step: 0 };

function renderCrate() {
  crate.innerHTML = '<div class="spacer" data-pad></div>'
    + entries.map(() => '<div class="snap"></div>').join('')
    + '<div class="spacer" data-pad></div>'
    + entries.map((e, i) =>
      `<button class="sleeve" data-i="${i}" aria-label="${esc(displayArtist(e))} — ${esc(displayTitle(e))}">${coverImg(e, e.release?.artwork || photoUrl(e))}</button>`
    ).join('');
  sleeves = [...crate.querySelectorAll('.sleeve')];
  layoutCrate();
  crate.scrollTop = 0;
  focusIndex = -1;
  updateCrate();
}
// Record i is centred when the crate is scrolled to exactly i × step.
// Each snap marker is one step tall, with its centre where record i's centre sits.
function layoutCrate() {
  if (!sleeves.length) return;
  const H = crate.clientHeight;
  const s = sleeves[0].offsetWidth, step = s * 0.34; // distance between record centres (they overlap)
  const padMarkers = H / 2 - step / 2;
  crate.querySelectorAll('[data-pad]').forEach(p => p.style.height = padMarkers + 'px');
  crate.querySelectorAll('.snap').forEach(m => m.style.height = step + 'px');
  const top = H / 2 - s / 2;
  sleeves.forEach((el, i) => el.style.top = (top + i * step) + 'px');
  metrics = { s, step };
}

// Safety net: once scrolling has fully stopped (after a flick's momentum too),
// make sure a record is exactly centred; if not, glide there quickly.
let touching = false, settleTimer = 0, glideFrame = 0, gliding = false;
function glideTo(target) {
  cancelAnimationFrame(glideFrame);
  const start = crate.scrollTop, dist = target - start;
  if (Math.abs(dist) < 1) return;
  const duration = Math.min(260, 110 + Math.abs(dist) * 0.5); // short hops are near-instant
  const t0 = performance.now();
  gliding = true;
  crate.style.scrollSnapType = 'none'; // our glide, not the browser's slower one
  const frame = now => {
    const p = Math.min(1, (now - t0) / duration);
    crate.scrollTop = start + dist * (1 - Math.pow(1 - p, 3)); // ease-out
    if (p < 1) glideFrame = requestAnimationFrame(frame);
    else { gliding = false; crate.style.scrollSnapType = ''; }
  };
  glideFrame = requestAnimationFrame(frame);
}
function stopGlide() { cancelAnimationFrame(glideFrame); gliding = false; crate.style.scrollSnapType = ''; }
function settle() {
  clearTimeout(settleTimer);
  if (touching || gliding || !sleeves.length || !metrics.step) return;
  const max = (sleeves.length - 1) * metrics.step;
  glideTo(Math.max(0, Math.min(max, Math.round(crate.scrollTop / metrics.step) * metrics.step)));
}
const SETTLE_AFTER = 90; // ms of stillness before snapping
crate.addEventListener('touchstart', () => { touching = true; clearTimeout(settleTimer); stopGlide(); }, { passive: true });
crate.addEventListener('touchend', () => { touching = false; settleTimer = setTimeout(settle, SETTLE_AFTER); }, { passive: true });
crate.addEventListener('touchcancel', () => { touching = false; settleTimer = setTimeout(settle, SETTLE_AFTER); }, { passive: true });
crate.addEventListener('scroll', () => { if (gliding) return; clearTimeout(settleTimer); settleTimer = setTimeout(settle, SETTLE_AFTER); }, { passive: true });
if ('onscrollend' in window) crate.addEventListener('scrollend', () => { if (!gliding) settle(); });

// How the crate stays clean on iPhone:
// Safari sorts 3D-tilted siblings by their real depth and ignores stacking order when
// they share a perspective, so a record leaning back from an edge that touches the
// front record's face can poke through it. So: (1) each record carries its own
// perspective(), so Safari flattens them one by one; and (2) records above the middle
// are pushed physically back, a full record-depth per step, so every point of each one is
// genuinely behind the record in front. Depth order and stacking order then always agree.
const P = 1500;          // perspective distance, px
const MAX_LEAN = 64;     // degrees, furthest-back records
function updateCrate() {
  ticking = false;
  if (!sleeves.length) return;
  const { s, step } = metrics;
  const depth = s * Math.sin(MAX_LEAN * Math.PI / 180) + 12; // > any record's own depth when tilted
  const pos = crate.scrollTop / step;
  sleeves.forEach((el, i) => {
    const d = i - pos, a = Math.abs(d);
    if (d < -5 || d > 3) { el.style.visibility = 'hidden'; return; }
    el.style.visibility = '';
    const k = Math.min(a, 1);
    let transform;
    if (d <= 0) {
      // Above the middle (newer): pushed back, leaning back
      const angle = Math.min(MAX_LEAN, 48 * k + 4 * (a - k));
      transform = `perspective(${P}px) translateZ(${-depth * a}px) rotateX(${angle}deg)`;
    } else {
      // Below the middle (older): falling forward, dropped clear of the front record's face
      transform = `perspective(${P}px) translateY(${s * 0.22 * k}px) translateZ(${k}px) rotateX(${-70 * k}deg)`;
    }
    el.style.transform = transform;
    el.style.zIndex = String(i + 1);
    el.style.filter = d < -0.3 ? `brightness(${1 - Math.min(a, 4) * 0.06})` : '';
  });
  const i = Math.max(0, Math.min(sleeves.length - 1, Math.round(pos)));
  if (i !== focusIndex) { focusIndex = i; renderInfo(entries[i]); }
}
crate.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(updateCrate); } }, { passive: true });
addEventListener('resize', () => { layoutCrate(); updateCrate(); });
crate.addEventListener('click', ev => {
  const b = ev.target.closest('.sleeve');
  if (!b) return;
  const i = +b.dataset.i;
  if (i === focusIndex) openSheet(entries[i]);
  else glideTo(i * metrics.step);
});
function renderInfo(e) {
  if (!e) return;
  $('#crateInfo').innerHTML = `<div class="a">${esc(displayArtist(e) || '…')}</div>
    <div class="t">${esc(displayTitle(e))}</div>
    <div class="w mono">${esc(e.sample ? 'Sample record' : when(e.scannedAt))}</div>`;
}
$('#crateInfo').onclick = () => entries[focusIndex] && openSheet(entries[focusIndex]);

/* ---------- The list: search as you type, sort, A–Z index, swipe left to delete ---------- */
const listEl = $('#list'), q = $('#q'), az = $('#az'), bubble = $('#azBubble');
let sortBy = localStorage.getItem('lh_sort') || 'artist';
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
  sortBy = b.dataset.sort; localStorage.setItem('lh_sort', sortBy); listEl.scrollTop = 0; renderList();
});

function renderList() {
  document.querySelectorAll('.sortbar button').forEach(b => b.classList.toggle('on', b.dataset.sort === sortBy));
  const words = norm(q.value) ? q.value.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const shown = entries.filter(e => {
    if (!words.length) return true;
    const hay = [displayTitle(e), displayArtist(e), e.release?.label, e.release?.catno, e.release?.year].join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  });
  // Always ascending: A to Z, or oldest scan first
  const cmp = (x, y) => sortBy === 'date' ? x.localeCompare(y) : x.localeCompare(y, 'en', { sensitivity: 'base', numeric: true });
  shown.sort((a, b) => cmp(sortValue(a), sortValue(b)) || cmp(sortText(displayTitle(a)), sortText(displayTitle(b))));

  const alpha = sortBy !== 'date';
  listEl.innerHTML = shown.map(e => {
    const r = e.release || {};
    const meta = [r.year, r.label, r.format].filter(Boolean).join(' · ');
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

  // A–Z index, only when sorted alphabetically and there's enough to scroll
  const showIndex = alpha && shown.length > 8;
  az.hidden = !showIndex;
  listEl.classList.toggle('withIndex', showIndex);
  if (showIndex) {
    const present = new Set([...listEl.children].map(li => li.dataset.letter));
    az.innerHTML = LETTERS.map(l => `<span data-l="${l}" class="${present.has(l) ? '' : 'off'}">${l}</span>`).join('');
  }
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
