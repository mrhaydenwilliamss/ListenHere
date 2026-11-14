// Listen Here — /api/identify
// Takes a photo of a record cover or centre label, asks Gemini what it is,
// then gets the real tracklist from MusicBrainz.
// The Gemini key lives in Vercel's settings (GEMINI_API_KEY), never in the page.

const MB = 'https://musicbrainz.org/ws/2';
const UA = 'ListenHere/0.2 ( https://listenhere-dun.vercel.app )'; // MusicBrainz asks every app to identify itself
const MODELS = [process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];

const PROMPT = `This photo shows a vinyl record: either its front cover, or the round paper label in the middle of the disc.
Identify the release. Read any printed text carefully (artist, title, record label name, catalogue number, side).
Only report what you can see or are confident about. If unsure of a field, leave it empty.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: ['cover', 'label', 'unknown'] },
    artist: { type: 'STRING' },
    album: { type: 'STRING' },
    record_label: { type: 'STRING' },
    catalogue_number: { type: 'STRING' },
    side: { type: 'STRING' },
    confidence: { type: 'NUMBER' }
  },
  required: ['kind', 'artist', 'album', 'confidence']
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => (s || '').replace(/["\\]/g, ' ').trim();

async function askGemini(base64) {
  let lastError = '';
  for (const model of MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: base64 } }, { text: PROMPT }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0 }
      })
    });
    if (r.ok) {
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      return { model, guess: JSON.parse(text) };
    }
    lastError = `${model}: ${r.status} ${(await r.text()).slice(0, 200)}`;
  }
  throw new Error('Gemini failed — ' + lastError);
}

async function mb(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(MB + path, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (r.status === 503) { await sleep(1100); continue; } // MusicBrainz rate limit: wait and retry
    if (!r.ok) throw new Error('MusicBrainz ' + r.status);
    return r.json();
  }
  throw new Error('MusicBrainz busy');
}

const isVinyl = rel => (rel.media || []).some(m => /vinyl/i.test(m.format || ''));

async function findRelease(g) {
  const tries = [];
  if (g.catalogue_number) tries.push(`catno:"${clean(g.catalogue_number)}"` + (g.artist ? ` AND artist:"${clean(g.artist)}"` : ''));
  if (g.album && g.artist) tries.push(`release:"${clean(g.album)}" AND artist:"${clean(g.artist)}"`);
  if (g.album) tries.push(`release:"${clean(g.album)}"`);
  for (const q of tries) {
    const j = await mb(`/release?query=${encodeURIComponent(q)}&fmt=json&limit=10`);
    const list = (j.releases || []).filter(r => (r.score || 0) >= 80);
    if (list.length) return { release: list.find(isVinyl) || list[0], matchedBy: q, options: list.length };
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel' });
  const t = { start: Date.now() };
  try {
    const { image } = req.body || {};
    if (!image) return res.status(400).json({ error: 'No image' });

    const { model, guess } = await askGemini(image);
    t.gemini = Date.now() - t.start;
    if (!guess.album && !guess.artist) return res.json({ guess, model, found: false, timings: t });

    const hit = await findRelease(guess);
    t.search = Date.now() - t.start - t.gemini;
    if (!hit) return res.json({ guess, model, found: false, timings: t });

    const rel = await mb(`/release/${hit.release.id}?inc=recordings+artist-credits&fmt=json`);
    t.tracklist = Date.now() - t.start - t.gemini - t.search;
    t.total = Date.now() - t.start;

    const artist = (rel['artist-credit'] || []).map(a => a.name + (a.joinphrase || '')).join('') || guess.artist;
    const tracks = (rel.media || []).flatMap(m => (m.tracks || []).map(tr => ({ number: tr.number, title: tr.title })));
    res.json({
      found: true, model, guess, matchedBy: hit.matchedBy, options: hit.options,
      release: {
        id: rel.id, artist, title: rel.title, year: (rel.date || '').slice(0, 4),
        format: (rel.media || []).map(m => m.format).filter(Boolean).join(' + '),
        artwork: `https://coverartarchive.org/release/${rel.id}/front-500`,
        tracks
      },
      timings: t
    });
  } catch (e) {
    res.status(500).json({ error: e.message, timings: t });
  }
};
