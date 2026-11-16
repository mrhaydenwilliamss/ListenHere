// Listen Here — shared Gemini helper (files starting with _ are not public endpoints on Vercel).
// Tries the strongest available Flash model first and falls back if one isn't available
// (Google retires model names over time). Remembers the one that worked, so later
// requests don't waste time on models that have gone.

const MODELS = [
  process.env.GEMINI_MODEL,      // optional override in Vercel settings
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash'
].filter(Boolean);

let working = null; // kept while this server instance stays warm

async function gemini(parts, schema) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set in Vercel');
  const order = working ? [working, ...MODELS.filter(m => m !== working)] : MODELS;
  let lastError = '';
  for (const model of order) {
    try {
      // Thinking turned right down: reading a record needs a quick look, not deliberation
      const thinking = /^gemini-2\.5/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: 'minimal' };
      const send = withThinking => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0,
            ...(withThinking ? { thinkingConfig: thinking } : {}) }
        })
      });
      let r = await send(true);
      if (r.status === 400) r = await send(false); // this model doesn't take that setting: ask plainly
      if (r.status === 404 || r.status === 400) { lastError = `${model}: ${r.status}`; if (working === model) working = null; continue; }
      if (r.status === 429) { lastError = `${model}: busy (free-tier limit)`; continue; } // try another model's quota
      if (!r.ok) { lastError = `${model}: ${r.status}`; continue; }
      const j = await r.json();
      const text = j.candidates?.[0]?.content?.parts?.find(p => typeof p.text === 'string')?.text || '{}';
      working = model;
      return { model, data: JSON.parse(text) };
    } catch (e) {
      lastError = `${model}: ${e.message}`;
    }
  }
  throw new Error('Could not reach Gemini (' + lastError + ')');
}

module.exports = { gemini };
