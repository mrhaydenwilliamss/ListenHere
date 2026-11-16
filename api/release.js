// Listen Here — /api/release
// Finds a record in MusicBrainz and returns its ordered tracklist.
// Use one of:
//   ?barcode=5400863191467
//   ?artist=Chic&album=C'est Chic&catno=SD 19209     best single match
//   ?id=<MusicBrainz release id>                      a specific release
//   ?list=1&artist=Chic&album=C'est Chic              several candidates to choose from (text search)

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
  const { barcode, artist, album, catno, id, list } = req.query;
  try {
    if (list) {
      if (!artist && !album) return res.status(400).json({ error: 'Type a title or an artist' });
      return res.json({ candidates: await candidates(artist, album) });
    }

    let hit = id ? { id, score: 100 } : null;
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
      score: hit.score,
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
