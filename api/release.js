// Listen Here — /api/release
// Finds a record and returns its ordered tracklist.
// Discogs first (the same database your "artist title discogs" Google search lands on),
// MusicBrainz as the backup if Discogs has nothing or isn't set up.
// Use one of:
//   ?barcode=5400863191467
//   ?artist=Chic&album=C'est Chic&catno=SD 19209     best single match
//   ?id=dg:123456  (Discogs)  or  ?id=<MusicBrainz id>   a specific release
//   ?list=1&artist=Chic&album=C'est Chic              several candidates to choose from (text search)

const UA = 'ListenHere/1.2 ( https://listenhere-dun.vercel.app )'; // both databases ask apps to identify themselves
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

/* ---------------- Discogs ---------------- */
const DG = 'https://api.discogs.com';
const TOKEN = process.env.DISCOGS_TOKEN || '';
const dgName = s => String(s || '').replace(/\s*\(\d+\)$/, '').replace(/\*$/, '').trim(); // "Prince (2)" → "Prince"

async function dg(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(DG + path, { headers: { 'User-Agent': UA, Authorization: `Discogs token=${TOKEN}` } });
    if (r.status === 429) { await sleep(1200); continue; } // busy: wait a moment and try once more
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('Discogs ' + r.status);
    return r.json();
  }
  throw new Error('Discogs is busy');
}

async function dgSearch(params) {
  const q = new URLSearchParams({ type: 'release', format: 'Vinyl', per_page: '25', ...params });
  for (const [k, v] of [...q]) if (!v) q.delete(k);
  return (await dg('/database/search?' + q))?.results || [];
}

// Choose the best result: matches artist and title, matches the catalogue number if we read one,
// then the pressing most people own (usually the original, with the best-known cover).
function dgPick(results, artist, album, catno) {
  const a = norm(artist), t = norm(album), c = norm(catno);
  const fits = results.filter(r => { const n = norm(r.title); return (!a || n.includes(a)) && (!t || n.includes(t)); });
  const exact = fits.filter(r => !t || norm(String(r.title).split(' - ').slice(1).join(' - ')) === t);
  const pool = exact.length ? exact : fits.length ? fits : results.slice(0, 3);
  const byCat = c ? pool.filter(r => norm(r.catno) === c) : [];
  const best = (byCat.length ? byCat : pool).slice().sort((x, y) => (y.community?.have || 0) - (x.community?.have || 0));
  return best[0] || null;
}

async function dgFind({ barcode, artist, album, catno }) {
  if (barcode) {
    const r = await dgSearch({ barcode, format: '' });
    if (r[0]) return dgPick(r, '', '', '').id;
  }
  if (!artist && !album) return null;
  const tries = [];
  if (catno) tries.push({ artist, release_title: album, catno });
  tries.push({ artist, release_title: album });
  tries.push({ q: [artist, album].filter(Boolean).join(' ') });           // looser, like a Google search
  for (const p of tries) {
    const r = await dgSearch(p);
    const pick = r.length && dgPick(r, p.q ? '' : artist, p.q ? '' : album, catno);
    if (pick) return pick.id;
  }
  return null;
}

async function dgRelease(id) {
  const rel = await dg('/releases/' + id);
  if (!rel) return null;
  const imgs = rel.images || [];
  const front = imgs.find(i => i.type === 'primary') || imgs[0];
  const back = imgs.find(i => i !== front);
  const label = (rel.labels || [])[0] || {};
  const tracks = [];
  for (const t of rel.tracklist || []) {
    if (t.type_ === 'heading') continue;
    if (t.sub_tracks?.length && t.type_ === 'index') { for (const s of t.sub_tracks) tracks.push({ n: s.position || '', title: s.title }); continue; }
    tracks.push({ n: t.position || '', title: t.title });
  }
  return {
    id: 'dg:' + rel.id,
    source: 'discogs',
    url: rel.uri || `https://www.discogs.com/release/${rel.id}`,
    artist: (rel.artists || []).map(a => dgName(a.anv || a.name) + (a.join ? (a.join === ',' ? ', ' : ` ${a.join} `) : '')).join('').trim(),
    title: rel.title,
    year: rel.year ? String(rel.year) : (rel.released || '').slice(0, 4),
    label: dgName(label.name),
    catno: label.catno && label.catno !== 'none' ? label.catno : '',
    format: [...new Set((rel.formats || []).map(f => f.name))].join(', '),
    barcode: ((rel.identifiers || []).find(i => i.type === 'Barcode') || {}).value || '',
    artwork: front?.uri || '',
    artworkAlt: '',
    tracks: tracks.map((t, i) => ({ n: t.n || String(i + 1), title: t.title }))
  };
}

async function dgCandidates(artist, album) {
  let res = await dgSearch({ artist, release_title: album, per_page: '50' });
  if (!res.length) res = await dgSearch({ q: [artist, album].filter(Boolean).join(' '), per_page: '50' });
  const seen = new Set(), out = [];
  for (const r of res) {
    const [ar, ...ti] = String(r.title || '').split(' - ');
    const c = {
      id: 'dg:' + r.id, title: ti.join(' - ') || r.title, artist: dgName(ar), year: r.year || '', country: r.country || '',
      format: (r.format || []).slice(0, 3).join(', '), label: dgName((r.label || [])[0]), catno: r.catno || '',
      thumb: r.thumb || r.cover_image || '', have: r.community?.have || 0
    };
    const key = [c.title, c.artist, c.year, c.country, c.catno].join('|').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push(c);
    if (out.length >= 12) break;
  }
  return out;
}

/* ---------------- MusicBrainz (backup) ---------------- */
const MB = 'https://musicbrainz.org/ws/2';
const clean = s => String(s || '').replace(/["\\():\[\]{}^~*?!+\-&|/]/g, ' ').replace(/\s+/g, ' ').trim();
const isVinyl = rel => (rel.media || []).some(m => /vinyl/i.test(m.format || ''));
const artistOf = rel => (rel['artist-credit'] || []).map(a => a.name + (a.joinphrase || '')).join('');

async function mb(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(MB + path, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (r.status === 503) { await sleep(1100); continue; } // MusicBrainz asks for about one request a second
    if (!r.ok) throw new Error('MusicBrainz ' + r.status);
    return r.json();
  }
  throw new Error('MusicBrainz is busy, try again');
}

function textQueries(artist, album) {
  const a = clean(artist), t = clean(album), q = [];
  if (t && a) q.push(`release:"${t}" AND artist:"${a}"`, `release:(${t}) AND artist:(${a})`, `${t} ${a}`);
  else if (t) q.push(`release:"${t}"`, `release:(${t})`);
  else if (a) q.push(`artist:"${a}"`);
  return q;
}

async function mbSearch(queries) {
  for (const q of queries) {
    const j = await mb(`/release?query=${encodeURIComponent(q)}&fmt=json&limit=15`);
    const list = (j.releases || []).filter(r => (r.score || 0) >= 80);
    const pick = list.find(r => isVinyl(r) && r.status === 'Official') || list.find(isVinyl) || list[0];
    if (pick) return pick.id;
  }
  return null;
}

async function mbFind({ barcode, artist, album, catno }) {
  const queries = [];
  if (barcode) queries.push(`barcode:${clean(barcode)}`);
  if (catno) queries.push(`catno:"${clean(catno)}"` + (artist ? ` AND artist:"${clean(artist)}"` : ''));
  queries.push(...textQueries(artist, album));
  return queries.length ? mbSearch(queries) : null;
}

async function mbRelease(id) {
  const rel = await mb(`/release/${id}?inc=recordings+artist-credits+labels+release-groups&fmt=json`);
  const own = rel['cover-art-archive']?.front ? `https://coverartarchive.org/release/${rel.id}/front-500` : '';
  const group = rel['release-group']?.id ? `https://coverartarchive.org/release-group/${rel['release-group'].id}/front-500` : '';
  const label = (rel['label-info'] || [])[0] || {};
  return {
    id: rel.id,
    source: 'musicbrainz',
    artist: artistOf(rel),
    title: rel.title,
    year: (rel.date || '').slice(0, 4),
    label: label.label?.name || '',
    catno: label['catalog-number'] || '',
    format: [...new Set((rel.media || []).map(m => m.format).filter(Boolean))].join(', '),
    barcode: rel.barcode || '',
    artwork: own || group,
    artworkAlt: own ? group : '',
    tracks: (rel.media || []).flatMap(m => (m.tracks || []).map(t => ({ n: t.number, title: t.title })))
  };
}

async function mbCandidates(artist, album) {
  const seen = new Set(), out = [];
  for (const q of textQueries(artist, album)) {
    const j = await mb(`/release?query=${encodeURIComponent(q)}&fmt=json&limit=100`);
    for (const r of j.releases || []) {
      if (!isVinyl(r)) continue;
      const label = (r['label-info'] || [])[0] || {};
      const c = {
        id: r.id, title: r.title, artist: artistOf(r), year: (r.date || '').slice(0, 4), country: r.country || '',
        format: [...new Set((r.media || []).map(m => m.format).filter(Boolean))].join(', '),
        label: label.label?.name || '', catno: label['catalog-number'] || '', score: r.score || 0
      };
      const key = [c.title, c.artist, c.year, c.format, c.country].join('|').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); out.push(c);
    }
    if (out.length >= 8) break;
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, 12).map(c => ({ ...c, thumb: `https://coverartarchive.org/release/${c.id}/front-250` }));
}

/* ---------------- Request ---------------- */
// Try Discogs; if it isn't set up, has nothing, or fails, quietly use MusicBrainz.
async function viaDiscogs(fn) {
  if (!TOKEN) return null;
  try { return await fn(); } catch { return null; }
}

module.exports = async (req, res) => {
  const { barcode, artist, album, catno, id, list } = req.query;
  try {
    if (list) {
      if (!artist && !album) return res.status(400).json({ error: 'Type a title or an artist' });
      const c = (await viaDiscogs(() => dgCandidates(artist, album))) || [];
      return res.json({ candidates: c.length ? c : await mbCandidates(artist, album) });
    }

    let release = null;
    if (id && String(id).startsWith('dg:')) release = await dgRelease(String(id).slice(3));
    else if (id) release = await mbRelease(id);
    else {
      if (!barcode && !artist && !album) return res.status(400).json({ error: 'Nothing to search for' });
      const q = { barcode, artist, album, catno };
      const dgId = await viaDiscogs(() => dgFind(q));
      if (dgId) release = await viaDiscogs(() => dgRelease(dgId));
      if (!release) { const mbId = await mbFind(q); if (mbId) release = await mbRelease(mbId); }
    }
    if (!release) return res.json({ found: false });
    if (!release.artist) release.artist = artist || '';
    res.setHeader('Cache-Control', 's-maxage=86400'); // let Vercel remember lookups for a day
    res.json({ found: true, release });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
