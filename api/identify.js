// Listen Here — /api/identify
// Step 1 of a scan: a photo of a cover or centre label goes to Gemini,
// which says what record it is. Fast on purpose: the tracklist is fetched
// separately by /api/release, so the app can show the answer sooner.
// The Gemini key lives in Vercel's settings (GEMINI_API_KEY), never in the page.

const MODELS = [process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];

const PROMPT = `This photo shows a vinyl record: either its front cover, or the round paper label in the middle of the disc.
Identify the release. Read any printed text carefully (artist, title, record label name, catalogue number, side).
Only report what you can see or are confident about. Leave a field empty if unsure.
If the photo is not a record, set kind to "unknown".`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: ['cover', 'label', 'unknown'] },
    artist: { type: 'STRING' },
    album: { type: 'STRING' },
    record_label: { type: 'STRING' },
    catalogue_number: { type: 'STRING' },
    confidence: { type: 'NUMBER' }
  },
  required: ['kind', 'artist', 'album', 'confidence']
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY is not set in Vercel' });
  const { image } = req.body || {};
  if (!image) return res.status(400).json({ error: 'No image' });

  const start = Date.now();
  let lastError = '';
  for (const model of MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: image } }, { text: PROMPT }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0 }
        })
      });
      if (!r.ok) { lastError = `${model}: ${r.status}`; continue; }
      const j = await r.json();
      const guess = JSON.parse(j.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
      return res.json({ guess, model, ms: Date.now() - start });
    } catch (e) {
      lastError = `${model}: ${e.message}`;
    }
  }
  res.status(502).json({ error: 'Could not reach Gemini (' + lastError + ')' });
};
