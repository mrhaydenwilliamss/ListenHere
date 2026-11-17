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
// what the crate and list show when a scan found nothing
const shownTitle = e => displayTitle(e) || (e.status === 'identifying' ? '…' : 'Unknown record');
const needsCheck = e => e.status === 'notfound' || e.status === 'error';
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
  if (searching()) closeSearch();
  view = v;
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === v));
  document.body.dataset.view = v;
  closeSheet();
  if (v === 'collection') { if (rescanFor) endRescan(); renderCollection(); }
  if (v === 'scan') { ensureCamera(); renderCam(); }
}
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => showView(b.dataset.go));

const scanEl = $('#scan'), colEl = $('#collection');
let swipe = null;
scanEl.addEventListener('pointerdown', ev => {
  if (view !== 'scan' || searching() || sheetOpen() || ev.target.closest('button, input, form, .searchPanel')) return;
  swipe = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, t0: ev.timeStamp, on: false, dx: 0, last: [] };
});
scanEl.addEventListener('pointermove', ev => {
  const s = swipe; if (!s || ev.pointerId !== s.id) return;
  const dx = ev.clientX - s.x0, dy = ev.clientY - s.y0;
  if (!s.on) {
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; } // an up/down move: not a swipe
    if (dx > -12) return;
    s.on = true;                                         // a leftward swipe: bring the list in
    scanEl.setPointerCapture(ev.pointerId);
    mode = 'list'; localStorage.setItem('lh_mode', mode);
    colEl.classList.add('active', 'sliding'); scanEl.classList.add('sliding');
    renderCollection();
  }
  s.dx = Math.min(0, dx);
  s.last.push({ t: ev.timeStamp, x: ev.clientX }); if (s.last.length > 5) s.last.shift();
  colEl.style.transform = `translateX(${innerWidth + s.dx}px)`;
  scanEl.style.transform = `translateX(${s.dx * 0.3}px)`;
});
function endSwipe(ev) {
  const s = swipe; if (!s || ev.pointerId !== s.id) return;
  swipe = null; if (!s.on) return;
  const a = s.last[0], b = s.last[s.last.length - 1];
  const v = a && b && b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0;     // px per ms, negative = leftward
  const go = s.dx < -innerWidth * 0.3 || v < -0.4;
  const ease = 'transform .32s cubic-bezier(.2,.8,.2,1)';
  colEl.style.transition = scanEl.style.transition = ease;
  colEl.style.transform = go ? 'translateX(0)' : `translateX(${innerWidth}px)`;
  scanEl.style.transform = go ? `translateX(${-innerWidth * 0.3}px)` : '';
  setTimeout(() => {
    for (const el of [colEl, scanEl]) { el.style.transition = el.style.transform = ''; el.classList.remove('sliding'); }
    if (go) showView('collection'); else colEl.classList.remove('active');
  }, 330);
}
scanEl.addEventListener('pointerup', endSwipe);
scanEl.addEventListener('pointercancel', endSwipe);

// Swipe right anywhere on the collection (crate or list) to slide back to the camera.
// Rows in the list only swipe left (to Delete), so a rightward swipe always means "back".
let back = null;
colEl.addEventListener('touchstart', ev => {
  back = null;
  if (view !== 'collection' || sheetOpen() || ev.touches.length > 1 || ev.target.closest('#az, input, .crateMenu')) return;
  const t = ev.touches[0];
  back = { x0: t.clientX, y0: t.clientY, on: false, dx: 0, last: [], row: ev.target.closest('.swipe') };
}, { passive: true });
colEl.addEventListener('touchmove', ev => {
  const s = back; if (!s) return;
  const t = ev.touches[0], dx = t.clientX - s.x0, dy = t.clientY - s.y0;
  if (!s.on) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;              // not sure yet
    if (Math.abs(dy) >= Math.abs(dx) || dx < 0 || (s.row && s.row.scrollLeft > 2)) { back = null; return; }
    // (up/down scrolls; leftward opens a row's Delete; an open row closes as usual)
    s.on = true;
    main.cancelDrag(); cam.cancelDrag();                    // the crates let go of this finger
    hideCrateMenu();
    scanEl.classList.add('active', 'sliding'); colEl.classList.add('sliding');
    ensureCamera();
  }
  if (ev.cancelable) ev.preventDefault();
  s.dx = Math.max(0, dx);
  s.last.push({ t: ev.timeStamp, x: t.clientX }); if (s.last.length > 5) s.last.shift();
  colEl.style.transform = `translateX(${s.dx}px)`;
  scanEl.style.transform = `translateX(${(s.dx - innerWidth) * 0.3}px)`;
}, { passive: false });
function endBack() {
  const s = back; back = null; if (!s || !s.on) return;
  const a = s.last[0], b = s.last[s.last.length - 1];
  const v = a && b && b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0;     // px per ms, positive = rightward
  const go = s.dx > innerWidth * 0.3 || v > 0.4;
  const ease = 'transform .32s cubic-bezier(.2,.8,.2,1)';
  colEl.style.transition = scanEl.style.transition = ease;
  colEl.style.transform = go ? `translateX(${innerWidth}px)` : 'translateX(0)';
  scanEl.style.transform = go ? '' : `translateX(${-innerWidth * 0.3}px)`;
  setTimeout(() => {
    for (const el of [colEl, scanEl]) { el.style.transition = el.style.transform = ''; el.classList.remove('sliding'); }
    if (go) showView('scan'); else scanEl.classList.remove('active');
  }, 330);
}
colEl.addEventListener('touchend', endBack);
colEl.addEventListener('touchcancel', endBack);

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
// the brackets inside the sharp area.
// Portrait: the crate sits at the top, the brackets lower down just above the shutter,
// and the picture is centred on the brackets so the fade runs evenly around them.
const portrait = () => innerHeight > innerWidth || innerHeight > 520;
function layoutVideo() {
  const vw = video.videoWidth || 3, vh = video.videoHeight || 4;   // before the camera starts: assume 3:4
  const W = innerWidth, H = innerHeight;
  const scale = Math.min(W / vw, H / vh);
  const w = vw * scale, h = vh * scale;
  const f = $('#frame').style, root = document.documentElement.style;
  if (!portrait()) {                                              // landscape: the plain centred camera
    Object.assign(video.style, { width: w + 'px', height: h + 'px', left: (W - w) / 2 + 'px', top: (H - h) / 2 + 'px' });
    video.classList.toggle('fadeY', h < H - 1);
    video.classList.toggle('fadeX', w < W - 1 && !(h < H - 1));
    const side = Math.max(120, Math.min(w - 32, h - 32, 640));
    const fade = h < H - 1 ? (h - side) / 2 : (w - side) / 2;
    video.style.setProperty('--fade', Math.max(48, fade - 2) + 'px');
    f.width = side + 'px'; f.top = (H - h) / 2 + h / 2 + 'px';
    return;
  }
  // Brackets: about two-thirds of the width, ending just above the shutter
  const shutterTop = $('#shutter').getBoundingClientRect().top - 9;           // includes its outer ring
  const barBottom = $('.topbar').getBoundingClientRect().bottom;
  const side = Math.round(Math.max(180, Math.min(W * 0.66, 320, H * 0.34)));
  const fBottom = shutterTop - 26, fTop = fBottom - side, fMid = fTop + side / 2;
  f.width = side + 'px'; f.top = fMid + 'px';
  // The sharp picture, centred on the brackets
  const top = h >= H ? (H - h) / 2 : fMid - h / 2;
  Object.assign(video.style, { width: w + 'px', height: h + 'px', left: (W - w) / 2 + 'px', top: top + 'px' });
  video.classList.toggle('fadeY', h < H - 1);
  video.classList.toggle('fadeX', false);
  video.style.setProperty('--fade', Math.max(40, Math.min(fTop - top, top + h - fBottom) - 2) + 'px');
  // The crate fills the space between the top bar and the brackets, with a caption line under it
  const ccTop = barBottom + 8, ccBottom = fTop - 30;
  const ccH = Math.max(120, ccBottom - ccTop);
  const s = Math.round(Math.min(W * 0.5, ccH / 1.62));                          // front record + 2–3 behind
  root.setProperty('--cc-top', ccTop + 'px');
  root.setProperty('--cc-h', ccH + 'px');
  camEl.style.setProperty('--s', s + 'px');
  root.setProperty('--ci-top', (ccBottom + 8) + 'px');
  $('#hint').style.bottom = (H - fBottom - 22) + 'px';                         // a small line between brackets and shutter
  $('#hint').style.top = 'auto';
  if (cam.sleeves.length && view === 'scan') cam.layout();
}
video.addEventListener('loadedmetadata', layoutVideo);
video.addEventListener('resize', layoutVideo);
addEventListener('resize', layoutVideo);
addEventListener('orientationchange', () => setTimeout(layoutVideo, 300));

/* =========================================================
   The crate on the camera screen
   The same crate engine as the Collection, oldest at the top and the newest scan at
   the front (bottom). It's a layer over the live camera: the camera never stops.
   ========================================================= */
const camEl = $('#camCrate'), camInfo = $('#camInfo');
let camEntries = [], camSig = '';
const cam = createCrate(camEl, {
  focusTop: (H, s) => H - s,                   // the record in front sits at the bottom of the crate
  range: [-4, 2],
  onFocus: i => showCamInfo(camEntries[i]),
  onTap: i => openSheet(camEntries[i]),
  onRest: () => camAtRest()
});
function showCamInfo(e) {
  if (!e) { camInfo.textContent = ''; return; }
  const a = displayArtist(e), t = displayTitle(e);
  camInfo.textContent = e.status === 'identifying' ? (a ? `${a} — finding tracks…` : 'Reading…')
    : needsCheck(e) ? (a || t ? `${a || 'Unknown'} — ${t || 'needs checking'}` : 'Unknown record — needs checking')
    : [a, t].filter(Boolean).join(' — ');
}
// Covers you can see get their artwork check, as in the Collection
function camAtRest() {
  if (view !== 'scan' || !cam.sleeves.length) return;
  const f = cam.focus;
  onScreen.clear();
  for (let i = Math.max(0, f - 3); i <= Math.min(camEntries.length - 1, f + 1); i++) onScreen.add(camEntries[i].id);
  wantArt(camEntries[f]);
  for (let i = f - 1; i >= Math.max(0, f - 3); i--) wantArt(camEntries[i]);
}
const camSignature = list => list.map(e => [e.id, e.release?.artwork || '', e.photo ? 1 : 0].join('|')).join('~');
// Rebuild only when the set of records (or a cover) has changed; otherwise leave it exactly as it is
async function renderCam({ keepId, hideId } = {}) {
  const list = (await allEntries()).reverse();                 // oldest first: the newest ends up in front
  const sig = camSignature(list) + (hideId || '');
  camEntries = list;
  if (sig === camSig && cam.sleeves.length) {
    if (Math.abs(cam.metrics.H - camEl.clientHeight) > 1) cam.layout();   // the screen size changed while away
    showCamInfo(camEntries[cam.focus]); return;
  }
  const wasAtFront = !cam.sleeves.length || cam.focus >= cam.sleeves.length - 1;
  const keep = keepId ?? (wasAtFront ? null : camEntries.find((e, i) => i === cam.focus)?.id);
  camSig = sig;
  cam.build(list.map(sleeveHtml).join(''));
  if (hideId) { const i = list.findIndex(e => e.id === hideId); if (cam.sleeves[i]) cam.sleeves[i].style.opacity = '0'; }
  const i = keep ? list.findIndex(e => e.id === keep) : -1;
  cam.layout(i >= 0 ? i : list.length - 1);
}
// A record's details or cover changed: update just that record, no rebuild
function camUpdate(e) {
  const i = camEntries.findIndex(x => x.id === e.id);
  if (i < 0) return;
  camEntries[i] = e;
  const img = cam.sleeves[i]?.querySelector('img');
  const src = e.release?.artwork || photoUrl(e);
  if (cam.sleeves[i] && (!img || img.getAttribute('src') !== src)) {
    cam.sleeves[i].innerHTML = coverImg(e, src) + '<i class="shade"></i>';
    cam.shades[i] = cam.sleeves[i].querySelector('.shade');
  }
  camSig = camSignature(camEntries);
  if (i === cam.focus) showCamInfo(e);
}

/* Placing a new scan in the crate:
   the brackets flash white, the photo lifts off the camera and travels up into the front
   of the crate while what was in front leans back to make room. Two seconds in all,
   the camera running the whole time. Only transform and opacity animate. */
async function placeInCrate(entry, photo, shotAt = performance.now()) {
  const url = URL.createObjectURL(photo);
  const fr = $('#frame').getBoundingClientRect();
  const img = () => { const el = new Image(); el.src = url; el.alt = ''; el.decoding = 'sync';
    Object.assign(el.style, { width: fr.width + 'px', height: fr.height + 'px' }); return el; };
  // what was captured stays in the brackets for a moment, then fades back to the live camera
  const ghost = img(); ghost.className = 'ghost';
  ghost.style.transform = `translate(${fr.left}px, ${fr.top}px)`;
  const flyer = img(); flyer.className = 'flyer';
  await Promise.all([ghost.decode?.().catch(() => {}), flyer.decode?.().catch(() => {})]);
  scanEl.append(ghost);              // under the brackets, so the white flash shows over it
  flyer.style.visibility = 'hidden'; document.body.append(flyer);

  // The crate makes room: the new record is added (hidden) at the front, then the crate glides to it
  const before = cam.sleeves.length ? cam.focus : -1;
  await renderCam({ keepId: camEntries[before]?.id, hideId: entry.id });
  const n = camEntries.length - 1;
  const s = cam.metrics.s || parseFloat(getComputedStyle(camEl).getPropertyValue('--s')) || 160;
  const box = camEl.getBoundingClientRect();
  const toX = (innerWidth - s) / 2, toY = box.top + cam.metrics.H - s, k = s / fr.width;
  const from = `translate(${fr.left}px, ${fr.top}px) scale(1)`;
  const lift = `translate(${fr.left + fr.width * 0.02}px, ${fr.top - 14}px) scale(.96)`;
  const to = `translate(${toX}px, ${toY}px) scale(${k})`;
  // the photo lifts off once the flash has peaked
  await new Promise(r => setTimeout(r, Math.max(0, 340 - (performance.now() - shotAt))));
  flyer.style.visibility = '';
  const fly = flyer.animate(
    [{ transform: from, offset: 0 }, { transform: lift, offset: 0.14 }, { transform: to, offset: 1 }],
    { duration: 1250, easing: 'cubic-bezier(.45,0,.15,1)', fill: 'both' });
  ghost.animate([{ opacity: 0.92 }, { opacity: 0 }], { duration: 2000, easing: 'cubic-bezier(.3,0,.2,1)', fill: 'forwards' })
    .finished.then(() => ghost.remove());
  setTimeout(() => cam.springTo(n * cam.metrics.step, 0, 0.007), 150);   // the old front leans back, unhurried
  await fly.finished.catch(() => {});
  // Land: the real record takes over from the flying photo in the same frame
  if (cam.sleeves[n]) cam.sleeves[n].style.opacity = '';
  camSig = camSignature(camEntries);
  requestAnimationFrame(() => { flyer.remove(); URL.revokeObjectURL(url); });
}

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
  if (searching()) return closeSearch();
  if (view !== 'scan' || sheetOpen()) return showView('scan');
  if (!cameraLive()) return startCamera();
  if (busy) return;
  flashFrame(); // instant, before any processing
  const tappedAt = performance.now();
  busy = true;
  const scannedAt = new Date().toISOString(); // the actual moment of scanning
  setBusy(true, 'Reading…');
  try {
    const { photo, small } = await capture();  // the camera keeps running
    let entry;
    const again = rescanFor && (await allEntries()).find(x => x.id === rescanFor);
    if (again) {               // second photo of a record already in the collection
      entry = again;
      if (photo2Urls.has(entry.id)) { URL.revokeObjectURL(photo2Urls.get(entry.id)); photo2Urls.delete(entry.id); }
      entry.photo2 = photo; entry.source = 'photo';
      delete entry.guess; delete entry.release; delete entry.choices; delete entry.error;
      entry.status = 'identifying';
    } else entry = { id: newId(), scannedAt, source: 'photo', status: 'identifying', photo };
    if (rescanFor) endRescan();
    await saveEntry(entry);  // saved immediately; finished in the background
    const working = identify(entry, await blobToBase64(small)); // starts now, never waits for the animation
    if (again) {
      // "Scan the label instead": back to that record's page, as before
      setTimeout(() => { if (view === 'scan' && !sheetOpen()) openSheet(entry); }, Math.max(0, 260 - (performance.now() - tappedAt)));
      await working;
    } else {
      setBusy(false);
      await placeInCrate(entry, photo, tappedAt);   // ready for the next scan as soon as it lands
    }
  } finally {
    busy = false; setBusy(false);
  }
};

/* =========================================================
   Search by text, over the live camera (left of the shutter)
   ========================================================= */
const panel = $('#searchPanel'), spForm = $('#spForm'), spResults = $('#spResults');
const searching = () => !panel.hidden;
function openSearch() {
  panel.hidden = false;
  document.body.classList.add('searching');
  spResults.innerHTML = '';
  setTimeout(() => spForm.elements.title.focus(), 50);
}
function closeSearch() {
  panel.hidden = true;
  document.body.classList.remove('searching');
  document.activeElement?.blur();
}
$('#btnSearch').onclick = openSearch;
panel.addEventListener('click', ev => {
  if (ev.target === panel || ev.target.closest('[data-sp="close"]')) return closeSearch(); // tap outside or ×
  const pick = ev.target.closest('[data-sp-pick]');
  if (pick) addFromSearch(pick.dataset.spPick);
});
spForm.elements.title.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); spForm.elements.artist.focus(); } });
spForm.addEventListener('submit', async ev => {
  ev.preventDefault();
  const title = spForm.elements.title.value.trim(), artist = spForm.elements.artist.value.trim();
  if (!title && !artist) { spResults.innerHTML = '<li class="mono quiet" style="padding:12px 0">Type a title or an artist</li>'; return; }
  document.activeElement?.blur();
  spResults.innerHTML = '<li class="mono quiet" style="padding:12px 0">Searching…</li>';
  try {
    const { candidates } = await api('/api/release?' + new URLSearchParams({ list: 1, album: title, artist }));
    spResults.innerHTML = candidates.length ? candidates.map(c => `<li><button data-sp-pick="${esc(c.id)}">
        <span class="cthumb"><img src="${esc(c.thumb)}" alt="" loading="lazy" onerror="this.remove()"></span>
        <span class="ctext"><b>${esc(c.title)}</b><span>${esc(c.artist)}</span>
        <span class="mono">${esc([c.year, c.format, c.country, c.label, c.catno].filter(Boolean).join(' · '))}</span></span>
      </button></li>`).join('')
      : '<li class="mono quiet" style="padding:12px 0">No vinyl releases found. Try fewer words, or check the spelling.</li>';
  } catch (err) {
    spResults.innerHTML = `<li class="mono" style="padding:12px 0;color:#ff8a70">${esc(err.message)}</li>`;
  }
});
// Picking a result adds it to the collection like a scan (its picture is the found cover)
async function addFromSearch(id) {
  spResults.innerHTML = '<li class="mono quiet" style="padding:12px 0">Loading tracklist…</li>';
  try {
    const j = await api('/api/release?' + new URLSearchParams({ id }));
    if (!j.found) throw new Error('Couldn’t load that release');
    const entry = { id: newId(), scannedAt: new Date().toISOString(), source: 'search', status: 'done', release: j.release, matchBy: 'manual' };
    await saveEntry(entry);
    closeSearch();
    openSheet(entry);
  } catch (err) {
    spResults.innerHTML = `<li class="mono" style="padding:12px 0;color:#ff8a70">${esc(err.message)}</li>`;
  }
}

/* =========================================================
   Upload a photo (right of the shutter): identified exactly like a shutter photo
   ========================================================= */
const fileInput = $('#fileInput');
$('#btnUpload').onclick = () => { if (!busy) fileInput.click(); };
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';                 // so the same photo can be chosen again later
  if (!file || busy) return;
  busy = true;
  const scannedAt = new Date().toISOString();
  setBusy(true, 'Reading…');
  try {
    const { photo, small } = await shrinkFile(file);
    const entry = { id: newId(), scannedAt, source: 'photo', status: 'identifying', photo };
    saveEntry(entry);
    openSheet(entry);
    await identify(entry, await blobToBase64(small));
  } catch {
    $('#hint').textContent = 'Couldn’t open that photo';
    await new Promise(r => setTimeout(r, 2000));
  } finally { busy = false; setBusy(false); }
});
// Keep the whole picture (no crop): longest side 1200 px to keep, 768 px for Gemini
async function shrinkFile(file) {
  let img;
  try { img = await createImageBitmap(file); }
  catch {
    img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  }
  const w = img.width, h = img.height;
  const make = (max, q) => new Promise(res => {
    const k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    c.toBlob(res, 'image/jpeg', q);
  });
  const [photo, small] = await Promise.all([make(1200, 0.88), make(768, 0.8)]);
  return { photo, small };
}

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
        body: JSON.stringify({ image: base64 })
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
    const params = new URLSearchParams({ artist: g.artist || '', album: g.album || '' });
    if (g.catalogue_number) params.set('catno', g.catalogue_number);
    if (g.text_on_record) params.set('text', g.text_on_record.slice(0, 200));
    await findRelease(entry, params, 'photo');
  } catch (e) {
    entry.status = 'error'; entry.error = e.message;
    saveEntry(entry); refresh(entry);
  }
}

async function findRelease(entry, params, by) {
  const j = await api('/api/release?' + params);
  delete entry.choices;
  if (j.found) {
    entry.release = j.release; entry.status = 'done'; delete entry.error;
    entry.matchBy = by;
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
  camUpdate(entry);
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
  if (view !== 'scan' || busy || sheetOpen() || searching() || video.readyState < 2) return;
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
  document.body.classList.add('sheetOpen');
  sheet.setAttribute('aria-hidden', 'false');
  $('#collection').classList.add('withSheet');
}
function closeSheet() {
  current = null;
  sheet.classList.remove('open');
  document.body.classList.remove('sheetOpen');
  sheet.setAttribute('aria-hidden', 'true');
  $('#collection').classList.remove('withSheet');
  if (view === 'scan' && video.paused) resumePreview(); // unfreeze the preview
}

function renderSheet(e) {
  const r = e.release, g = e.guess || {};
  const artist = displayArtist(e), title = displayTitle(e);
  const details = r ? [r.label, r.catno, r.year, r.format].filter(Boolean).join(' · ') : (g.record_label || '');
  let status = '';
  if (e.status === 'identifying') status = artist ? 'Finding the tracklist…' : 'Reading the record…';
  if (e.status === 'notfound') status = artist ? 'Couldn’t find this record. Scan the label, or search by title below.' : 'Couldn’t recognise this record. Scan the label, or search by title below.';
  if (e.status === 'error') status = 'No connection to the record database. It will finish by itself when you’re back online.';

  // Slides: the found artwork first, then always your own photo(s)
  const slides = [];
  slides.push(r?.artwork
    ? `<div class="slide"><img src="${esc(r.artwork)}" alt="Found artwork" data-cover="${esc(e.id)}" data-no-photo="1"${r.artworkAlt ? ` data-alt="${esc(r.artworkAlt)}"` : ''}></div>`
    : `<div class="slide">${e.photo && !r ? `<img src="${esc(photoUrl(e))}" alt="Your photo"><span class="tag mono">Your photo</span>` : typoCover(e)}</div>`);
  if (e.photo && r) slides.push(`<div class="slide"><img src="${esc(photoUrl(e))}" alt="Your photo"><span class="tag mono">Your photo</span></div>`);
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
    <div class="gallery" id="gallery">
      <div class="slides">${slides.join('')}</div>
      <div class="dots">${slides.length > 1 ? slides.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('') : ''}</div>
    </div>
    ${details ? `<p class="meta mono">${esc(details)}</p>` : ''}
    <h2 class="artist">${esc(artist || (e.status === 'identifying' ? '…' : 'Unknown'))}</h2>
    <h3 class="title">${esc(title)}</h3>
    ${status ? `<p class="status mono ${e.status === 'error' ? 'err' : ''}">${esc(status)}</p>` : ''}
    ${e.status === 'error' ? '<button class="btn" data-act="retry" style="margin-top:12px">Try again</button>' : ''}
    ${e.status === 'notfound' && artist ? `<a class="btn album-yt" href="${youtubeUrl(artist, title, '')}" target="_blank" rel="noopener">${PLAY} Search YouTube for the album</a>` : ''}
    ${tracks.length ? `<p class="lead mono"><span>Tap a track to hear it on YouTube</span>${PLAY}</p><ol class="tracks">${rows}</ol>` : ''}
    <p class="when mono">${e.sample ? 'Sample record · ' : 'Scanned '}${esc(when(e.scannedAt))}${r?.source === 'discogs' ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener">Data provided by Discogs</a>` : ''}</p>

    <section class="override">
      <h4>Wrong record?</h4>
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
  camSig = ''; if (view === 'scan') renderCam();
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
  entries = sortEntries(await allEntries()); // every scan stays, found or not, so it can be checked later
  document.querySelectorAll('.sortbar [data-sort]').forEach(b => b.classList.toggle('on', b.dataset.sort === sortBy));
  showDir();
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
const DECEL = 0.998;                       // per ms, as iOS
const PROJECT = DECEL / (1 - DECEL);       // ms: distance = velocity × this
const SPRING = 0.016;                      // per ms: critically damped settle (~300 ms)
const P = 1500, MAX_LEAN = 64;             // Cover Flow look
// iOS rubber band: past an edge, movement is resisted more the further you pull
const band = (over, dim) => (1 - 1 / (over * 0.55 / dim + 1)) * dim;

// One crate engine, used twice: the Collection's crate and the camera's crate.
// cfg.focusTop(H, s): where the record in focus sits; cfg.range: how many records show behind / ahead;
// cfg.onFocus(i), cfg.onTap(i), cfg.onHold(i), cfg.onRest(), cfg.onDown() are optional hooks.
function createCrate(el, cfg) {
  const c = { el, sleeves: [], shades: [], focus: -1, metrics: { s: 0, step: 0, H: 0, max: 0 }, pos: 0, anim: null, drag: null };
  let frameId = 0;
  const [BEHIND, AHEAD] = cfg.range || [-5, 3];

  c.build = html => {
    el.innerHTML = html;
    c.sleeves = [...el.querySelectorAll('.sleeve')];
    c.shades = c.sleeves.map(x => x.querySelector('.shade'));
    c.stop(); c.pos = 0; c.focus = -1;
  };
  c.layout = startAt => {
    if (!c.sleeves.length) return;
    const H = el.clientHeight, s = c.sleeves[0].offsetWidth, step = s * 0.34;
    const top = cfg.focusTop(H, s);
    c.sleeves.forEach(x => x.style.top = top + 'px');
    const keep = startAt ?? (c.focus >= 0 ? c.focus : 0);
    c.metrics = { s, step, H, max: (c.sleeves.length - 1) * step };
    c.pos = keep * step;
    c.focus = -1; // forces the caption to refresh
    c.draw();
    cfg.onRest?.();
  };
  // Draw every record for the current position. Called once per frame at most.
  // Safari note: each record carries its own perspective(), and records behind are pushed
  // back a full record-depth per step, so 3D depth order always matches stacking order.
  c.draw = () => {
    const { s, step } = c.metrics;
    if (!step) return;
    const depth = s * Math.sin(MAX_LEAN * Math.PI / 180) + 12;
    const at = c.pos / step;
    for (let i = 0; i < c.sleeves.length; i++) {
      const x = c.sleeves[i], d = i - at, a = Math.abs(d);
      const show = d >= BEHIND && d <= AHEAD;
      if (x._show !== show) { x.style.visibility = show ? '' : 'hidden'; x._show = show; }
      if (!show) continue;
      const k = Math.min(a, 1);
      const y = d * step;
      if (d <= 0) {
        const angle = Math.min(MAX_LEAN, 48 * k + 4 * (a - k));
        x.style.transform = `translate3d(0,${y}px,0) perspective(${P}px) translateZ(${-depth * a}px) rotateX(${angle}deg)`;
        c.shades[i].style.opacity = d < -0.05 ? Math.min(a, 4) * 0.07 : 0;
      } else {
        x.style.transform = `translate3d(0,${y + s * 0.22 * k}px,0) perspective(${P}px) translateZ(${k}px) rotateX(${-70 * k}deg)`;
        c.shades[i].style.opacity = 0;
      }
    }
    const f = Math.max(0, Math.min(c.sleeves.length - 1, Math.round(at)));
    if (f !== c.focus) { c.focus = f; cfg.onFocus?.(f); }
  };

  const banded = raw => {
    const { H, max } = c.metrics;
    if (raw < 0) return -band(-raw, H);
    if (raw > max) return max + band(raw - max, H);
    return raw;
  };
  const unband = p => { // inverse of banded, so a new drag starts exactly where the crate is
    const { H: dim, max } = c.metrics, inv = v => (dim / 0.55) * (1 / (1 - v / dim) - 1);
    if (p < 0) return -inv(Math.min(-p, dim * 0.999));
    if (p > max) return max + inv(Math.min(p - max, dim * 0.999));
    return p;
  };

  /* ---- animation: momentum decay that lands on a record, or a spring ---- */
  c.stop = () => { cancelAnimationFrame(frameId); c.anim = null; };
  function run(a) {
    c.stop();
    c.anim = { ...a, t0: performance.now(), x0: c.pos };
    const frame = now => {
      const an = c.anim, t = now - an.t0;
      let x, done = false;
      if (an.type === 'decay') {
        x = an.x0 + an.D * (1 - Math.exp(-an.k * t));
        if (Math.abs(an.x0 + an.D - x) < 0.3) { x = an.x0 + an.D; done = true; }
      } else {
        const w = an.w, x0 = an.x0 - an.target;
        x = an.target + (x0 + (an.v + w * x0) * t) * Math.exp(-w * t);
        if (t > 60 && Math.abs(x - an.target) < 0.3) { x = an.target; done = true; }
      }
      c.pos = x; c.draw();
      if (done) { c.anim = null; cfg.onRest?.(); } else frameId = requestAnimationFrame(frame);
    };
    frameId = requestAnimationFrame(frame);
  }
  c.clampIndex = i => Math.max(0, Math.min(c.sleeves.length - 1, i));
  c.springTo = (target, v = 0, w = SPRING) => run({ type: 'spring', target, v, w });
  // Release with velocity v (px/ms, in crate direction)
  c.release = v => {
    const { step, max } = c.metrics;
    if (c.pos < 0 || c.pos > max) return c.springTo(c.pos < 0 ? 0 : max, v * 0.3);
    const projected = c.pos + v * PROJECT;                     // where a natural iOS glide would end
    let target = c.clampIndex(Math.round(projected / step)) * step;
    let D = target - c.pos;
    if (Math.abs(v) > 0.08 && Math.sign(D) === Math.sign(v)) {
      let k = v / D;                                         // decay that starts at the finger's speed and ends on target
      if (k > 0.02) {                                        // would stop too abruptly: carry on to the next record
        const next = c.clampIndex(Math.round(target / step) + Math.sign(v)) * step;
        if (next !== target) { target = next; D = target - c.pos; k = v / D; }
      }
      if (k <= 0.02) return run({ type: 'decay', D, k: Math.max(k, 0.0012) });
    }
    c.springTo(target, v);                                   // slow release: settle gently
  };
  c.goTo = i => c.springTo(c.clampIndex(i) * c.metrics.step);
  // Another gesture (the swipe back to the camera) takes over this finger
  c.cancelDrag = () => { const d = c.drag; if (!d) return; c.drag = null; clearTimeout(d.hold); c.release(0); };

  /* ---- touch, pen and mouse ---- */
  el.addEventListener('pointerdown', ev => {
    if (ev.button > 0 || !c.sleeves.length) return;
    const wasMoving = !!c.anim && (c.anim.type === 'decay' || Math.abs(c.anim.target - c.pos) > 2);
    c.stop();                                                // catch the crate where it is
    const d = c.drag = { id: ev.pointerId, y0: ev.clientY, raw0: unband(c.pos), t0: ev.timeStamp, moved: 0,
             wasMoving, target: ev.target.closest('.sleeve'), samples: [{ t: ev.timeStamp, y: ev.clientY }] };
    el.setPointerCapture(ev.pointerId);
    cfg.onDown?.();
    if (cfg.onHold && d.target && !wasMoving) d.hold = setTimeout(() => {   // held still for half a second
      if (c.drag !== d || d.moved >= 8) return;
      c.drag = null;
      cfg.onHold(+d.target.dataset.i);
    }, 500);
  });
  el.addEventListener('pointermove', ev => {
    const d = c.drag;
    if (!d || ev.pointerId !== d.id) return;
    const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
    for (const e of events) d.samples.push({ t: e.timeStamp, y: e.clientY });
    while (d.samples.length > 2 && ev.timeStamp - d.samples[0].t > 100) d.samples.shift();
    const dy = ev.clientY - d.y0;
    d.moved = Math.max(d.moved, Math.abs(dy));
    c.pos = banded(d.raw0 - dy);                             // finger down = crate back, 1:1
    c.draw();                                                // same frame as the touch
  });
  const endDrag = ev => {
    const d = c.drag;
    if (!d || ev.pointerId !== d.id) return;
    c.drag = null; clearTimeout(d.hold);
    if (d.moved < 8 && ev.timeStamp - d.t0 < 450) {          // a tap, not a drag
      if (d.wasMoving) return c.release(0);                  // a tap on a moving crate just stops it
      const i = d.target ? +d.target.dataset.i : -1;
      if (i < 0) return c.release(0);
      if (i === c.focus && Math.abs(c.pos - i * c.metrics.step) < 2) return cfg.onTap?.(i);
      return c.springTo(i * c.metrics.step);
    }
    // velocity over the last ~80 ms; a pause before lifting means no fling
    const last = d.samples[d.samples.length - 1];
    const recent = d.samples.filter(p => last.t - p.t <= 80);
    let v = 0;
    if (ev.timeStamp - last.t < 60 && recent.length > 1) {
      const first = recent[0];
      v = -(last.y - first.y) / Math.max(1, last.t - first.t); // crate moves opposite to the finger
    }
    c.release(Math.max(-8, Math.min(8, v)));
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  el.addEventListener('click', ev => { // keyboard activation only; taps are handled above
    if (ev.detail !== 0) return;
    const b = ev.target.closest('.sleeve');
    if (b) cfg.onTap?.(+b.dataset.i);
  });

  /* ---- trackpad and mouse wheel (desktop): the system supplies its own momentum ---- */
  let wheelTimer = 0;
  el.addEventListener('wheel', ev => {
    ev.preventDefault();
    if (!c.sleeves.length) return;
    c.stop();
    const unit = ev.deltaMode === 1 ? 40 : ev.deltaMode === 2 ? c.metrics.H : 1;
    c.pos = Math.max(-40, Math.min(c.metrics.max + 40, c.pos + ev.deltaY * unit));
    c.draw();
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => c.goTo(Math.round(c.pos / c.metrics.step)), 120);
  }, { passive: false });
  return c;
}

/* ---------- The Collection's crate ---------- */
const crate = $('#crate');
const main = createCrate(crate, {
  focusTop: (H, s) => H / 2 - s / 2,
  onFocus: f => { lastViewedId = entries[f]?.id ?? lastViewedId; renderInfo(entries[f]); },
  onTap: i => openSheet(entries[i]),
  onHold: i => { main.goTo(i); showCrateMenu(i); },
  onDown: () => hideCrateMenu(),
  onRest: () => crateAtRest()
});

// A fingerprint of what the crate or list shows. If nothing has changed since it was
// built, the existing covers are reused as they are (already loaded and drawn) instead
// of being rebuilt, which is what caused the blank-cover lag on returning.
const signature = list => sortBy + sortDir + '#' + list.map(e =>
  [e.id, e.release?.artwork || '', displayTitle(e), displayArtist(e), e.photo ? 1 : 0, e.status].join('|')).join('~');
let crateSig = '', listSig = '';
const sleeveHtml = (e, i) =>
  `<button class="sleeve" data-i="${i}" style="z-index:${i + 1}" aria-label="${esc(displayArtist(e))} — ${esc(shownTitle(e))}">${coverImg(e, e.release?.artwork || photoUrl(e))}<i class="shade"></i></button>`;

function renderCrate() {
  const i = entries.findIndex(e => e.id === lastViewedId);
  const sig = signature(entries);
  if (sig === crateSig && main.sleeves.length) {   // nothing changed: just return to the record
    main.stop();
    main.layout(i >= 0 ? i : 0);
    return;
  }
  crateSig = sig;
  main.build(entries.map(sleeveHtml).join(''));
  main.layout(i >= 0 ? i : 0); // come back to the record last viewed
}
addEventListener('resize', () => { if (main.sleeves.length && !crate.closest('[hidden]')) main.layout(); });

// Once the crate stops, the records you can see (behind and in front of the centre) get their check
function crateAtRest() {
  if (!main.sleeves.length || mode !== 'crate' || view !== 'collection') return;
  const f = main.focus;
  onScreen.clear();
  for (let i = Math.max(0, f - 4); i <= Math.min(entries.length - 1, f + 2); i++) onScreen.add(entries[i].id);
  for (let i = Math.min(entries.length - 1, f + 2); i >= Math.max(0, f - 4); i--) if (i !== f) wantArt(entries[i]);
  wantArt(entries[f]); // the centre record goes first
}

/* ---- keyboard: up / down arrows ---- */
addEventListener('keydown', ev => {
  if (view !== 'collection' || mode !== 'crate' || sheetOpen() || !main.sleeves.length) return;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    main.goTo(main.focus + (ev.key === 'ArrowDown' ? 1 : -1));
  }
  if (ev.key === 'Enter' && entries[main.focus]) openSheet(entries[main.focus]);
});

function renderInfo(e) {
  if (!e) return;
  $('#crateInfo').innerHTML = `<div class="a">${esc(displayArtist(e) || (e.status === 'identifying' ? '…' : ''))}</div>
    <div class="t">${esc(shownTitle(e))}</div>
    <div class="w mono">${esc(needsCheck(e) ? 'Needs checking' : e.sample ? 'Sample record' : when(e.scannedAt))}</div>`;
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

$('#crateInfo').onclick = () => entries[main.focus] && openSheet(entries[main.focus]);

// The pop-up from a press and hold: one button, over the record
const crateMenu = $('#crateMenu');
let menuFor = null;
function showCrateMenu(i) {
  menuFor = entries[i]; if (!menuFor) return;
  crateMenu.hidden = false;
  requestAnimationFrame(() => crateMenu.classList.add('show'));
}
function hideCrateMenu() {
  if (crateMenu.hidden) return;
  menuFor = null; crateMenu.classList.remove('show');
  setTimeout(() => { if (!menuFor) crateMenu.hidden = true; }, 160);
}
crateMenu.addEventListener('click', async ev => {
  if (!ev.target.closest('button') || !menuFor) return hideCrateMenu();
  const e = menuFor, i = entries.indexOf(e);
  hideCrateMenu();
  await removeEntry(e.id);
  lastViewedId = entries[i + 1]?.id || entries[i - 1]?.id || null; // the crate stays where it was
  renderCollection();
});
addEventListener('pointerdown', ev => { if (!crateMenu.hidden && !crateMenu.contains(ev.target)) hideCrateMenu(); }, true);

/* ---------- The list: search as you type, sort, A–Z index, swipe left to delete ---------- */
const listEl = $('#list'), q = $('#q'), az = $('#az'), bubble = $('#azBubble');
let sortBy = localStorage.getItem('lh_sort') || 'date'; // newest first, as the brief's crate
// Direction: ↑ ascending (A to Z, oldest first), ↓ descending (Z to A, newest first).
// Each sort starts the natural way round: A to Z for names, newest first for date.
const natural = by => by === 'date' ? 'desc' : 'asc';
let sortDir = localStorage.getItem('lh_dir') || natural(sortBy);
const dirBtn = $('#sortDir');
function showDir() { dirBtn.textContent = sortDir === 'asc' ? '↑' : '↓'; dirBtn.setAttribute('aria-label', sortDir === 'asc' ? 'Ascending, tap to reverse' : 'Descending, tap to reverse'); }
dirBtn.onclick = () => {
  sortDir = sortDir === 'asc' ? 'desc' : 'asc'; localStorage.setItem('lh_dir', sortDir);
  listEl.scrollTop = 0; renderCollection();
};
const LETTERS_AZ = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
let LETTERS = LETTERS_AZ;
// Filed the way a record shop files them: "The Cure" under C
const sortText = s => String(s || '').trim().replace(/^(the|a|an)\s+/i, '');
const letterOf = s => { const c = norm(sortText(s)).charAt(0).toUpperCase(); return /[A-Z]/.test(c) ? c : '#'; };
function sortValue(e) {
  if (sortBy === 'title') return sortText(displayTitle(e));
  if (sortBy === 'date') return e.scannedAt;
  return sortText(displayArtist(e));
}
document.querySelectorAll('.sortbar [data-sort]').forEach(b => b.onclick = () => {
  if (sortBy === b.dataset.sort) return;
  sortBy = b.dataset.sort; sortDir = natural(sortBy);
  localStorage.setItem('lh_sort', sortBy); localStorage.setItem('lh_dir', sortDir);
  listEl.scrollTop = 0; renderCollection();
});
// One order for both Crate and List: A to Z for artist and title, newest first for date
function sortEntries(list) {
  const az = (x, y) => x.localeCompare(y, 'en', { sensitivity: 'base', numeric: true });
  const flip = sortDir === 'desc' ? -1 : 1;
  return list.sort((a, b) => flip * (sortBy === 'date'
    ? a.scannedAt.localeCompare(b.scannedAt)
    : az(sortValue(a), sortValue(b)) || az(sortText(displayTitle(a)), sortText(displayTitle(b)))));
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
    const meta = needsCheck(e) ? 'Needs checking'
      : sortBy === 'date' ? when(e.scannedAt) : [r.year, r.label, r.format].filter(Boolean).join(' · ');
    const letter = alpha ? letterOf(sortBy === 'title' ? displayTitle(e) : displayArtist(e)) : '';
    return `<li data-letter="${letter}"><div class="swipe">
      <button class="rowmain" data-open="${esc(e.id)}">
        <span class="cover">${coverImg(e, r.artwork || photoUrl(e))}</span>
        <span class="txt"><span class="rt">${esc(shownTitle(e))}</span><span class="ra">${esc(displayArtist(e))}</span><span class="rm mono">${esc(meta)}</span></span>
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
    LETTERS = sortDir === 'desc' ? LETTERS_AZ.slice().reverse() : LETTERS_AZ;
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
  if (i >= 0 && main.sleeves[i]) main.sleeves[i].innerHTML = coverImg(e, src) + '<i class="shade"></i>', main.shades[i] = main.sleeves[i].querySelector('.shade');
  camUpdate(e);
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
   Keep the app locked in place when the keyboard opens.
   iOS slides the whole page up to make room for the keyboard; a web page can't stop that,
   but it can see how far (visualViewport.offsetTop) and move everything straight back.
   The field being typed in is then kept visible by moving only what needs to move:
   the camera search box re-centres above the keyboard, and the album page scrolls itself.
   ========================================================= */
const vv = window.visualViewport;
let fixTimer = 0;
function lockViewport() {
  if (!vv) return;
  const shift = Math.max(0, vv.offsetTop);
  document.body.style.transform = shift ? `translateY(${shift}px)` : '';
  // everything below the visible area (the keyboard, plus any slide iOS has made)
  const hidden = Math.max(0, innerHeight - vv.height);
  document.documentElement.style.setProperty('--kb', hidden + 'px');
  document.documentElement.classList.toggle('kbOpen', hidden > 80);
  // keep the field being typed in visible while the keyboard animates
  clearTimeout(fixTimer);
  fixTimer = setTimeout(() => keepFieldVisible(document.activeElement), 60);
}
// Scroll the field's own container (album page, search box, list) so the field sits mid-way
// in the space above the keyboard. The rest of the app never moves.
function keepFieldVisible(field) {
  if (!(field instanceof HTMLInputElement)) return;
  const scroller = field.closest('.sheet, .spCard, .list');
  if (!scroller) return;
  const box = scroller.getBoundingClientRect(), r = field.getBoundingClientRect();
  const top = Math.max(box.top, vv ? vv.offsetTop : 0), bottom = Math.min(box.bottom, vv ? vv.offsetTop + vv.height : innerHeight);
  if (r.top >= top + 12 && r.bottom <= bottom - 12) return;                 // already comfortably visible
  scroller.scrollBy({ top: (r.top + r.bottom) / 2 - (top + bottom) / 2, behavior: 'smooth' });
}
if (vv) { vv.addEventListener('resize', lockViewport); vv.addEventListener('scroll', lockViewport); }
addEventListener('scroll', () => { if (scrollX || scrollY) scrollTo(0, 0); }, { passive: true });
document.addEventListener('focusin', ev => {
  // check a few times as the keyboard slides in (iOS reports its size as it goes)
  for (const ms of [120, 320, 600]) setTimeout(() => { lockViewport(); keepFieldVisible(ev.target); }, ms);
});
document.addEventListener('focusout', () => setTimeout(lockViewport, 60));

/* =========================================================
   Go
   ========================================================= */
layoutVideo();
renderCam();
startCamera();
retryUnfinished();
