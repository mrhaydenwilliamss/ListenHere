// Listen Here — the app.
// Foreground: photo → what record is it → tracklist → YouTube.
// Background: every scan is saved on the phone with its photo, time and place.
// Nothing in the background ever holds up the tracklist.

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
function distanceM(a, b) {
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const blobToBase64 = blob => new Promise(res => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.readAsDataURL(blob);
});
const urls = new Map(); // object URLs for saved photos
function photoUrl(e) {
  if (!e.photo) return '';
  if (!urls.has(e.id)) urls.set(e.id, URL.createObjectURL(e.photo));
  return urls.get(e.id);
}
const displayArtist = e => e.release?.artist || e.guess?.artist || '';
const displayTitle = e => e.release?.title || e.guess?.album || '';

/* =========================================================
   Views and navigation (no page changes: keeps the camera alive)
   ========================================================= */
let view = 'scan';
function showView(v) {
  view = v;
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === v));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  if (v === 'collection') { closeSheet(); renderCrate(); }
  if (v === 'scan') { closeSheet(); ensureCamera(); }
}
document.querySelectorAll('.tab').forEach(t => t.onclick = () => showView(t.dataset.view));

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
   Location — asked for once per scan, never blocks anything
   ========================================================= */
function captureLocation(entry) {
  if (!navigator.geolocation || localStorage.getItem('lh_location') === 'off') return;
  navigator.geolocation.getCurrentPosition(async pos => {
    entry.location = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy) };
    // Same spot as a recent named scan? Reuse that place name.
    if (!entry.place) {
      const recent = (await allEntries()).find(o => o.id !== entry.id && o.place && o.location && distanceM(o.location, entry.location) < 400);
      if (recent) entry.place = recent.place;
    }
    await saveEntry(entry);
    if (current?.id === entry.id) renderSheet(entry);
  }, err => {
    if (err.code === err.PERMISSION_DENIED) localStorage.setItem('lh_location', 'off');
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 120000 });
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

$('#shutter').onclick = async () => {
  if (view !== 'scan') return showView('scan');
  if (!cameraLive()) return startCamera();
  if (busy) return;
  busy = true;
  const scannedAt = new Date().toISOString(); // the actual moment of scanning
  setBusy(true, 'Reading…');
  try {
    const { photo, small } = await capture();
    const entry = { id: newId(), scannedAt, source: 'photo', status: 'identifying', photo, location: null, place: '' };
    $('#freeze').src = photoUrl(entry); $('#freeze').hidden = false;
    saveEntry(entry);           // background: saved immediately, finished later
    captureLocation(entry);     // background
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
        entry.status = 'notfound'; saveEntry(entry); renderSheet(entry); return;
      }
      saveEntry(entry);
      if (current?.id === entry.id) renderSheet(entry); // show the name now, tracklist follows
    }
    const g = entry.guess;
    const params = new URLSearchParams({ artist: g.artist || '', album: g.album || '' });
    if (g.catalogue_number) params.set('catno', g.catalogue_number);
    await findRelease(entry, params);
  } catch (e) {
    entry.status = 'error'; entry.error = e.message;
    saveEntry(entry);
    if (current?.id === entry.id) renderSheet(entry);
  }
}

async function findRelease(entry, params) {
  const j = await api('/api/release?' + params);
  if (j.found) { entry.release = j.release; entry.status = 'done'; delete entry.error; }
  else entry.status = 'notfound';
  saveEntry(entry);
  if (current?.id === entry.id) renderSheet(entry);
}

// Finish any scan interrupted by leaving the app or losing signal — no rescan needed
let retrying = false;
async function retryUnfinished() {
  if (retrying || !navigator.onLine) return;
  retrying = true;
  try {
    for (const e of await allEntries()) {
      if (e.id === current?.id && busy) continue;
      if (e.status !== 'identifying' && e.status !== 'error') continue;
      if (e.source === 'barcode') await findRelease(e, new URLSearchParams({ barcode: e.barcode })).catch(() => {});
      else if (e.photo) {
        const small = await shrink(e.photo);
        await identify(e, await blobToBase64(small));
      }
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
    const entry = { id: newId(), scannedAt, source: 'barcode', barcode: code, status: 'identifying', photo, location: null, place: '' };
    const j = await api('/api/release?barcode=' + encodeURIComponent(code));
    if (!j.found) { $('#hint').textContent = 'Barcode not found — photograph the cover or label'; await new Promise(r => setTimeout(r, 2500)); return; }
    entry.release = j.release; entry.status = 'done';
    saveEntry(entry); captureLocation(entry); openSheet(entry);
  } catch { /* silent: barcodes are a bonus */ }
  finally { busy = false; setBusy(false); }
}

/* =========================================================
   Album sheet
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
  const meta = r ? [r.label, r.catno, r.year, r.format].filter(Boolean).join(' · ') : (g.record_label || '');
  const art = r?.artwork || photoUrl(e);
  let status = '';
  if (e.status === 'identifying') status = artist ? 'Finding the tracklist…' : (e.source === 'barcode' ? 'Looking up barcode…' : 'Reading the record…');
  if (e.status === 'notfound') status = artist ? 'Couldn’t find a tracklist for this one.' : 'Couldn’t recognise this record. Try the label, or get closer.';
  if (e.status === 'error') status = 'No connection to the record database. It will finish by itself when you’re back online.';

  const tracks = r?.tracks || [];
  let lastSide = '';
  const rows = tracks.map(t => {
    const side = String(t.n).replace(/\d+/g, '');
    const gap = lastSide && side !== lastSide ? '<li class="sideRule" aria-hidden="true"></li>' : '';
    lastSide = side;
    return `${gap}<li><a href="${youtubeUrl(r.artist, t.title, r.title)}" data-track>
      <span class="n">${esc(t.n)}</span><span class="t">${esc(t.title)}</span><span class="go">↗</span></a></li>`;
  }).join('');

  const showPhoto = r?.artwork && e.photo;
  sheet.innerHTML = `<div class="sheet-inner">
    <button class="close" data-act="close" aria-label="Close">×</button>
    <div class="art">${art ? `<img src="${esc(art)}" alt="" data-fallback="${esc(photoUrl(e))}">` : typoCover(e)}</div>
    ${meta ? `<p class="meta mono">${esc(meta)}</p>` : ''}
    <h2 class="artist">${esc(artist || (e.status === 'identifying' ? '…' : 'Unknown'))}</h2>
    <h3 class="title">${esc(title)}</h3>
    ${status ? `<p class="status mono ${e.status === 'error' ? 'err' : ''}">${esc(status)}</p>` : ''}
    ${e.status === 'error' ? '<button class="btn" data-act="retry" style="margin-top:12px">Try again</button>' : ''}
    ${e.status === 'notfound' && artist ? `<a class="btn album-yt" href="${youtubeUrl(artist, title, '')}">Search YouTube for the album ↗</a>` : ''}
    ${tracks.length ? `<p class="lead mono"><span>Tap a track to hear it on YouTube</span><span>↗</span></p><ol class="tracks">${rows}</ol>` : ''}
    <div class="foot">
      <div class="where mono">
        ${e.sample ? '<div class="place">Sample record</div>' : `<div class="place">${esc(e.place || '')}</div>`}
        <div>${esc(when(e.scannedAt))}</div>
        ${e.sample ? '' : `<button class="linkbtn mono" data-act="place">${e.place ? 'Edit place' : 'Add place'}</button>`}
        <div class="placeEdit" hidden><input type="text" placeholder="e.g. Dutch Vinyl, Fitzroy" value="${esc(e.place || '')}" enterkeyhint="done"><button class="btn solid" data-act="savePlace">Save</button></div>
      </div>
      ${showPhoto ? `<img src="${esc(photoUrl(e))}" alt="Your photo">` : ''}
    </div>
    <div class="actions">
      <button class="linkbtn mono" data-act="edit">Not this record?</button>
      <button class="linkbtn mono" data-act="delete">Remove from collection</button>
    </div>
    <form class="editForm" hidden>
      <input name="artist" placeholder="Artist" value="${esc(artist)}" autocomplete="off">
      <input name="album" placeholder="Album" value="${esc(title)}" autocomplete="off">
      <button class="btn solid" type="submit">Search again</button>
    </form>
  </div>`;
  const img = sheet.querySelector('.art img');
  if (img) img.onerror = () => { if (img.dataset.fallback && img.src !== img.dataset.fallback) img.src = img.dataset.fallback; else img.replaceWith(Object.assign(document.createElement('div'), { innerHTML: typoCover(e) }).firstElementChild); };
}

function typoCover(e) {
  return `<div class="typo"><b>${esc(displayArtist(e) || 'Unknown')}</b><span>${esc(displayTitle(e))}</span></div>`;
}

sheet.addEventListener('click', async ev => {
  const t = ev.target.closest('[data-act], [data-track]');
  if (!t || !current) return;
  if (t.hasAttribute('data-track')) { t.classList.add('played'); return; } // the link opens YouTube
  const e = current, act = t.dataset.act;
  if (act === 'close') { closeSheet(); if (view === 'collection') renderCrate(); }
  if (act === 'retry') { e.status = 'identifying'; renderSheet(e); e.source === 'barcode' ? findRelease(e, new URLSearchParams({ barcode: e.barcode })).catch(() => {}) : identify(e, await blobToBase64(await shrink(e.photo))); }
  if (act === 'place') { const box = sheet.querySelector('.placeEdit'); box.hidden = false; box.querySelector('input').focus(); }
  if (act === 'savePlace') { e.place = sheet.querySelector('.placeEdit input').value.trim(); await saveEntry(e); renderSheet(e); }
  if (act === 'edit') { const f = sheet.querySelector('.editForm'); f.hidden = !f.hidden; if (!f.hidden) f.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  if (act === 'delete') {
    if (t.dataset.armed) { await deleteEntry(e.id); closeSheet(); if (view === 'collection') renderCrate(); }
    else { t.dataset.armed = '1'; t.textContent = 'Tap again to remove'; t.style.color = 'var(--red)'; }
  }
});
sheet.addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && ev.target.closest('.placeEdit')) sheet.querySelector('[data-act="savePlace"]').click();
});
sheet.addEventListener('submit', async ev => {
  ev.preventDefault();
  const e = current, f = new FormData(ev.target);
  const artist = String(f.get('artist')).trim(), album = String(f.get('album')).trim();
  if (!artist && !album) return;
  e.guess = { ...(e.guess || {}), artist, album, catalogue_number: '', kind: e.guess?.kind || 'cover' };
  delete e.release; e.status = 'identifying'; renderSheet(e);
  try { await findRelease(e, new URLSearchParams({ artist, album })); }
  catch (err) { e.status = 'error'; e.error = err.message; saveEntry(e); renderSheet(e); }
});

/* =========================================================
   The crate — vertical, layered, the middle record stands up
   ========================================================= */
const crate = $('#crate');
let sleeves = [], entries = [], focusIndex = -1, ticking = false;

async function renderCrate() {
  entries = (await allEntries()).filter(e => displayTitle(e) || e.status === 'identifying');
  const samples = entries.some(e => e.sample);
  $('#clearSamples').hidden = !samples;
  $('#count').textContent = entries.length ? `${entries.length} record${entries.length === 1 ? '' : 's'}` : '';
  $('#empty').hidden = entries.length > 0;
  crate.hidden = $('#crateInfo').hidden = entries.length === 0;
  if (!entries.length) return;

  crate.innerHTML = '<div class="spacer" data-pad></div>' + entries.map((e, i) => {
    const src = e.release?.artwork || photoUrl(e);
    return `<button class="sleeve" data-i="${i}" aria-label="${esc(displayArtist(e))} — ${esc(displayTitle(e))}">
      ${src ? `<img src="${esc(src)}" alt="" loading="lazy" data-fallback="${esc(photoUrl(e))}">` : typoCover(e)}</button>`;
  }).join('') + '<div class="spacer" data-pad></div>';
  sleeves = [...crate.querySelectorAll('.sleeve')];
  crate.querySelectorAll('.sleeve img').forEach(img => img.onerror = () => {
    if (img.dataset.fallback && !img.src.startsWith('blob:')) img.src = img.dataset.fallback;
    else { const e = entries[+img.parentElement.dataset.i]; img.outerHTML = typoCover(e); }
  });
  layoutCrate();
  crate.scrollTop = 0;
  focusIndex = -1;
  updateCrate();
}

let metrics = { s: 0, step: 0, pad: 0 };
function layoutCrate() {
  if (!sleeves.length) return;
  const s = sleeves[0].offsetWidth;
  const step = s * 0.34; // distance between record centres (they overlap)
  const pad = Math.max(0, (crate.clientHeight - s) / 2);
  crate.querySelectorAll('[data-pad]').forEach(p => p.style.height = pad + 'px');
  // the last record needs room to scroll to the middle
  crate.lastElementChild.style.height = pad + s * 0.66 + 'px';
  metrics = { s, step, pad };
}

function updateCrate() {
  ticking = false;
  if (!sleeves.length) return;
  const { step } = metrics;
  const pos = crate.scrollTop / step; // which record is in the middle, as a decimal
  sleeves.forEach((el, i) => {
    const d = i - pos;               // <0 above the middle (further into the crate), >0 below (flicked forward)
    const a = Math.abs(d);
    if (a > 7) { el.style.visibility = 'hidden'; return; }
    el.style.visibility = '';
    const k = Math.min(a, 1);
    const angle = d < 0 ? 52 * k + 6 * Math.min(a - k, 4) : -64 * k;  // lean back vs fall forward
    const lift = d < 0 ? 0 : -metrics.s * 0.08 * k;
    const scale = 1 - (d > 0 ? 0.12 : 0.06) * Math.min(a, 3);
    el.style.transform = `translateY(${lift}px) rotateX(${angle}deg) scale(${scale})`;
    el.style.zIndex = String(100 - Math.round(a * 10) + (d > 0 ? 0 : 1));
    el.style.filter = a > 0.5 ? `brightness(${1 - Math.min(a, 4) * 0.08})` : '';
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
  else crate.scrollTo({ top: i * metrics.step, behavior: 'smooth' });
});

function renderInfo(e) {
  if (!e) return;
  const where = e.sample ? 'Sample record' : e.place;
  $('#crateInfo').innerHTML = `<div class="a">${esc(displayArtist(e) || '…')}</div>
    <div class="t">${esc(displayTitle(e))}</div>
    <div class="w mono">${esc([where, when(e.scannedAt)].filter(Boolean).join(' · '))}</div>`;
}
$('#crateInfo').onclick = () => entries[focusIndex] && openSheet(entries[focusIndex]);

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
        scannedAt: new Date(Date.now() - n * 36e5 * 26).toISOString(), place: '', location: null
      });
    } catch { /* skip */ }
    await new Promise(r => setTimeout(r, 1100)); // be polite to MusicBrainz
  }
  btn.disabled = false; btn.textContent = 'Fill with sample records';
  renderCrate();
};
$('#clearSamples').onclick = async () => {
  for (const e of await allEntries()) if (e.sample) await deleteEntry(e.id);
  renderCrate();
};

/* =========================================================
   Go
   ========================================================= */
startCamera();
retryUnfinished();
