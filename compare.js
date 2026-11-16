// Listen Here — /api/compare
// The visual check: is the user's photo of a cover the same album cover as the artwork
// we found? Catches the case where Gemini confidently names the wrong record, which no
// text check can spot. Only Cover Art Archive images are fetched.

const { gemini } = require('./_gemini');

const PROMPT = `Image 1 is a phone photo of a vinyl record's front cover, taken in a shop (it may be angled, cropped, glary or partly covered by a hand or sticker).
Image 2 is a catalogue image of an album cover.
Do they show the same album cover design? Allow for different pressings or reissues of the same album with small differences (a sticker, a logo, slightly different colours or text placement).
Answer "no" only if they are clearly different covers. Answer "unsure" if image 1 is too unclear to tell.`;

const SCHEMA = {
  type: 'OBJECT',
  properties: { same: { type: 'STRING', enum: ['yes', 'no', 'unsure'] }, reason: { type: 'STRING' } },
  required: ['same']
};

const allowed = u => { try { return /(^|\.)coverartarchive\.org$/.test(new URL(u).hostname); } catch { return false; } };

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { image, artwork } = req.body || {};
  if (!image || !artwork || !allowed(artwork)) return res.status(400).json({ error: 'Photo and a Cover Art Archive image needed' });
  const start = Date.now();
  try {
    const thumb = artwork.replace(/-500$/, '-250'); // smaller is plenty, and faster
    const a = await fetch(thumb, { redirect: 'follow', headers: { 'User-Agent': 'ListenHere/1.2 ( https://listenhere-dun.vercel.app )' } });
    if (!a.ok) return res.json({ same: 'unsure', reason: 'artwork unavailable' }); // can't check: don't block
    const art = Buffer.from(await a.arrayBuffer()).toString('base64');
    const mime = a.headers.get('content-type') || 'image/jpeg';
    const { data } = await gemini([
      { inline_data: { mime_type: 'image/jpeg', data: image } },
      { inline_data: { mime_type: mime, data: art } },
      { text: PROMPT }
    ], SCHEMA);
    res.json({ same: data.same || 'unsure', reason: data.reason || '', ms: Date.now() - start });
  } catch (e) {
    res.json({ same: 'unsure', reason: e.message }); // a failed check never blocks the result
  }
};
