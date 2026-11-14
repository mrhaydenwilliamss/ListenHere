// Listen Here — /api/release
// Step 2 of a scan: find the record in MusicBrainz and return its ordered tracklist.
// Use one of:
//   ?barcode=5400863191467
//   ?artist=Chic&album=C'est Chic&catno=SD 19209
//   ?id=<MusicBrainz release id>

const MB = 'https://musicbrainz.org/ws/2';
const UA = 'ListenHere/1.0 ( https://listenhere-dun.vercel.app )'; // MusicBrainz asks every app to identify itself

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => String(s || '').replace(/["\\]/g, ' ').trim();
const isVinyl = rel => (rel.media || []).some(m => /vinyl/i.test(m.format || ''));

async function mb(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(MB + path, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (r.status === 503) { await sleep(1100); continue; } // MusicBrainz asks for about one request a second
    if (!r.ok) throw new Error('MusicBrainz ' + r.status);
    return r.json();
  }
  throw new Error('MusicBrainz is busy, try again');
}

async function search(queries) {
  for (const q of queries) {
    const j = await mb(`/release?query=${encodeURIComponent(q)}&fmt=json&limit=15`);
    const list = (j.releases || []).filter(r => (r.score || 0) >= 80);
    // Prefer an official vinyl release, then any vinyl, then the best match
    const pick = list.find(r => isVinyl(r) && r.status === 'Official') || list.find(isVinyl) || list[0];
    if (pick) return pick.id;
  }
  return null;
}

module.exports = async (req, res) => {
  const { barcode, artist, album, catno, id } = req.query;
  try {
    let releaseId = id;
    if (!releaseId) {
      const queries = [];
      if (barcode) queries.push(`barcode:${clean(barcode)}`);
      if (catno) queries.push(`catno:"${clean(catno)}"` + (artist ? ` AND artist:"${clean(artist)}"` : ''));
      if (album && artist) queries.push(`release:"${clean(album)}" AND artist:"${clean(artist)}"`);
      if (album && artist) queries.push(`${clean(album)} ${clean(artist)}`); // looser, for spelling differences
      if (!queries.length) return res.status(400).json({ error: 'Nothing to search for' });
      releaseId = await search(queries);
    }
    if (!releaseId) return res.json({ found: false });

    const rel = await mb(`/release/${releaseId}?inc=recordings+artist-credits+labels&fmt=json`);
    const label = (rel['label-info'] || [])[0] || {};
    res.setHeader('Cache-Control', 's-maxage=86400'); // let Vercel remember lookups for a day
    res.json({
      found: true,
      release: {
        id: rel.id,
        artist: (rel['artist-credit'] || []).map(a => a.name + (a.joinphrase || '')).join('') || artist || '',
        title: rel.title,
        year: (rel.date || '').slice(0, 4),
        label: label.label?.name || '',
        catno: label['catalog-number'] || '',
        format: [...new Set((rel.media || []).map(m => m.format).filter(Boolean))].join(', '),
        barcode: rel.barcode || '',
        artwork: rel['cover-art-archive']?.front ? `https://coverartarchive.org/release/${rel.id}/front-500` : '',
        tracks: (rel.media || []).flatMap(m => (m.tracks || []).map(t => ({ n: t.number, title: t.title })))
      }
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
