// Listen Here — /api/identify
// Step 1 of a scan: a photo of a cover or centre label goes to Gemini, which says
// what record it is. The tracklist is fetched separately by /api/release.
// Optional "exclude": answers already shown to be wrong, so a second attempt doesn't repeat them.
// The Gemini key lives in Vercel's settings (GEMINI_API_KEY), never in the page.

const { gemini } = require('./_gemini');

const PROMPT = `This photo shows a vinyl record: either its front cover, or the round paper label in the middle of the disc.
Identify the exact release.
First, read any printed text (artist, title, record label name, catalogue number). Printed text is the strongest evidence.
If no text is readable, identify it from the artwork only if you genuinely recognise this specific cover; set text_visible to false.
Copy the artist and title exactly as printed. Never guess: leave a field empty if unsure, and give a low confidence.
Set is_compilation to true only if it is clearly a compilation, soundtrack or various-artists release.
If the photo is not a record, set kind to "unknown".`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: ['cover', 'label', 'unknown'] },
    artist: { type: 'STRING' },
    album: { type: 'STRING' },
    record_label: { type: 'STRING' },
    catalogue_number: { type: 'STRING' },
    text_visible: { type: 'BOOLEAN' },
    is_compilation: { type: 'BOOLEAN' },
    confidence: { type: 'NUMBER' }
  },
  required: ['kind', 'artist', 'album', 'confidence']
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { image, exclude } = req.body || {};
  if (!image) return res.status(400).json({ error: 'No image' });
  const notThese = Array.isArray(exclude) && exclude.length
    ? `\nIt has already been checked and is NOT any of these, so do not answer with them: ${exclude.slice(0, 5).join('; ')}.`
    : '';
  const start = Date.now();
  try {
    const { model, data } = await gemini(
      [{ inline_data: { mime_type: 'image/jpeg', data: image } }, { text: PROMPT + notThese }], SCHEMA);
    res.json({ guess: data, model, ms: Date.now() - start });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
