// Listen Here — /api/release
// Finds a record in MusicBrainz and returns its ordered tracklist.
// Use one of:
//   ?barcode=5400863191467
//   ?artist=Chic&album=C'est Chic&catno=SD 19209     best single match
//   ?id=<MusicBrainz release id>                      a specific release
//   ?list=1&artist=Chic&album=C'est Chic              several candidates to choose from (text search)
//   ?verify=1&artist=..&album=..&catno=..&label=..     from a photo: the release only if what was read
//                                                      and what was found agree; otherwise up to 3 choices

const MB = 'https://musicbrainz.org/ws/2';
const UA = 'ListenHere/1.1 ( https://listenhere-dun.vercel.app )'; // MusicBrainz asks every app to identify itself

const sleep = ms => new Promise(r => setTimeout(r, ms));
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

async function search(queries) {
  for (const q of queries) {
    const j = await mb(`/release?query=${encodeURIComponent(q)}&fmt=json&limit=15`);
    const list = (j.releases || []).filter(r => (r.score || 0) >= 80);
    // Prefer an official vinyl release, then any vinyl, then the best match
    const pick = list.find(r => isVinyl(r) && r.status === 'Official') || list.find(isVinyl) || list[0];
    if (pick) return { id: pick.id, score: pick.score };
  }
  return null;
}

/* ---------- Checking a match against what was read from the photo ---------- */
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/&/g, ' and ').replace(/^the\s+/, '').replace(/\s*[\(\[].*?[\)\]]\s*/g, ' ').replace(/[^a-z0-9]/g, '');
const normCat = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a))) return 0.85;
  const pairs = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const p = s.slice(i, i + 2); m.set(p, (m.get(p) || 0) + 1); } return m; };
  const A = pairs(a), B = pairs(b); let hit = 0;
  for (const [p, n] of A) hit += Math.min(n, B.get(p) || 0);
  return (2 * hit) / Math.max(1, a.length - 1 + b.length - 1);
}
const NON_ALBUM = /compilation|live|remix|dj-mix|mixtape|soundtrack/i;
// How well one MusicBrainz release fits what Gemini read. 0..~1.3
function scoreCandidate(guess, r) {
  const label = (r['label-info'] || [])[0] || {};
  const rg = r['release-group'] || {};
  const artistSim = similarity(guess.artist, artistOf(r));
  const titleSim = similarity(guess.album, r.title);
  const catMatch = !!guess.catalogue_number && normCat(guess.catalogue_number).length > 2 &&
    (r['label-info'] || []).some(l => normCat(l['catalog-number']) === normCat(guess.catalogue_number));
  const labelSim = guess.record_label ? similarity(guess.record_label, label.label?.name) : 0;
  const secondary = (rg['secondary-types'] || []).join(' ');
  let s = 0.45 * artistSim + 0.45 * titleSim;
  if (catMatch) s += 0.25;
  if (labelSim > 0.8) s += 0.05;
  if (isVinyl(r)) s += 0.05;
  if (r.status === 'Official') s += 0.02;
  if (rg['primary-type'] === 'Album') s += 0.03;
  // Unless the photo says otherwise, an original album beats a compilation or live record of the same name
  if (NON_ALBUM.test(secondary) && !guess.is_compilation && !NON_ALBUM.test(guess.album || '')) s -= 0.15;
  return { s, artistSim, titleSim, catMatch, group: rg.id || r.id };
}
// Confident only when the artist AND title agree, or the catalogue number matches and one of them agrees
const isConfident = m => (m.artistSim >= 0.8 && m.titleSim >= 0.88) || (m.catMatch && (m.artistSim >= 0.6 || m.titleSim >= 0.6));

async function verifiedMatch(guess, unsure = false) {
  const pool = new Map();
  const queries = [];
  const a = clean(guess.artist), t = clean(guess.album), c = clean(guess.catalogue_number);
  if (c) queries.push(`catno:"${c}"`);
  queries.push(...textQueries(guess.artist, guess.album));
  for (const q of queries) {
    const j = await mb(`/release?query=${encodeURIComponent(q)}&fmt=json&limit=25`);
    for (const r of j.releases || []) if (!pool.has(r.id)) pool.set(r.id, { r, m: scoreCandidate(guess, r) });
    const best = [...pool.values()].sort((x, y) => y.m.s - x.m.s)[0];
    if (best && isConfident(best.m) && best.m.s > 0.9) break; // strong enough: no need for more searches
  }
  const ranked = [...pool.values()].sort((x, y) => y.m.s - x.m.s);
  const best = ranked[0];
  if (best && isConfident(best.m) && !unsure) { // a reading Gemini itself doubted is never answered outright
    // A different album scoring almost as well means it's genuinely ambiguous: ask instead
    const rival = ranked.find(x => x.m.group !== best.m.group);
    if (!rival || best.m.s - rival.m.s > 0.08 || !isConfident(rival.m)) return { confident: true, id: best.r.id };
  }
  // Not sure: up to 3 different albums (one pressing each, vinyl preferred) for the user to choose from
  const choices = [], groups = new Set();
  for (const x of ranked) {
    if (x.m.s < 0.35 || groups.has(x.m.group)) continue;
    const sameGroup = ranked.filter(y => y.m.group === x.m.group);
    const pick = sameGroup.find(y => isVinyl(y.r)) || x;
    groups.add(x.m.group);
    const label = (pick.r['label-info'] || [])[0] || {};
    choices.push({
      id: pick.r.id, title: pick.r.title, artist: artistOf(pick.r), year: (pick.r.date || '').slice(0, 4),
      format: [...new Set((pick.r.media || []).map(m => m.format).filter(Boolean))].join(', '),
      label: label.label?.name || '', catno: label['catalog-number'] || '',
      thumb: `https://coverartarchive.org/release-group/${x.m.group}/front-250`,
      thumbAlt: `https://coverartarchive.org/release/${pick.r.id}/front-250`
    });
    if (choices.length === 3) break;
  }
  return { confident: false, choices };
}

// Vinyl only: CD, cassette and digital releases are left out
async function candidates(artist, album) {
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
      // One row per distinct pressing description, best matches first
      const key = [c.title, c.artist, c.year, c.format, c.country].join('|').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key); out.push(c);
    }
    if (out.length >= 8) break;
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, 12).map(c => ({ ...c, thumb: `https://coverartarchive.org/release/${c.id}/front-250` }));
}

module.exports = async (req, res) => {
  const { barcode, artist, album, catno, id, list, verify, label: recordLabel, compilation, unsure } = req.query;
  try {
    if (verify && !id) {
      if (!artist && !album) return res.status(400).json({ error: 'Nothing to search for' });
      const v = await verifiedMatch({ artist, album, catalogue_number: catno, record_label: recordLabel, is_compilation: compilation === '1' }, unsure === '1');
      if (!v.confident) return res.json({ found: false, choices: v.choices });
      req.query.id = v.id; // carry on below with the confident match
    }
    if (list) {
      if (!artist && !album) return res.status(400).json({ error: 'Type a title or an artist' });
      return res.json({ candidates: await candidates(artist, album) });
    }

    const releaseId = req.query.id;
    let hit = releaseId ? { id: releaseId, score: 100 } : null;
    if (!hit) {
      const queries = [];
      if (barcode) queries.push(`barcode:${clean(barcode)}`);
      if (catno) queries.push(`catno:"${clean(catno)}"` + (artist ? ` AND artist:"${clean(artist)}"` : ''));
      queries.push(...textQueries(artist, album));
      if (!queries.length) return res.status(400).json({ error: 'Nothing to search for' });
      hit = await search(queries);
    }
    if (!hit) return res.json({ found: false });

    const rel = await mb(`/release/${hit.id}?inc=recordings+artist-credits+labels+release-groups&fmt=json`);
    // Artwork: this exact pressing's cover if it has one, otherwise the album's best cover from any pressing
    const own = rel['cover-art-archive']?.front ? `https://coverartarchive.org/release/${rel.id}/front-500` : '';
    const group = rel['release-group']?.id ? `https://coverartarchive.org/release-group/${rel['release-group'].id}/front-500` : '';
    const label = (rel['label-info'] || [])[0] || {};
    res.setHeader('Cache-Control', 's-maxage=86400'); // let Vercel remember lookups for a day
    res.json({
      found: true,
      confident: true,
      release: {
        id: rel.id,
        artist: artistOf(rel) || artist || '',
        title: rel.title,
        year: (rel.date || '').slice(0, 4),
        label: label.label?.name || '',
        catno: label['catalog-number'] || '',
        format: [...new Set((rel.media || []).map(m => m.format).filter(Boolean))].join(', '),
        barcode: rel.barcode || '',
        artwork: own || group,
        artworkAlt: own ? group : '',   // tried if the first image fails to load
        tracks: (rel.media || []).flatMap(m => (m.tracks || []).map(t => ({ n: t.number, title: t.title })))
      }
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};

// for tests
module.exports.scoreCandidate = scoreCandidate;
module.exports.isConfident = isConfident;
module.exports.similarity = similarity;
