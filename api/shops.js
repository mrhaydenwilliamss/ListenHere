// Listen Here — /api/shops?lat=..&lon=..
// Finds record shops near a position using OpenStreetMap (free, no key).

module.exports = async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!isFinite(lat) || !isFinite(lon)) return res.status(400).json({ error: 'lat and lon needed' });
  const query = `[out:json][timeout:10];nwr(around:300,${lat},${lon})[shop=music];out center 5;`;
  try {
    const r = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ListenHere/0.2 ( https://listenhere-dun.vercel.app )' },
      body: 'data=' + encodeURIComponent(query)
    });
    if (!r.ok) throw new Error('OpenStreetMap ' + r.status);
    const j = await r.json();
    const shops = (j.elements || [])
      .filter(e => e.tags && e.tags.name)
      .map(e => ({ name: e.tags.name, suburb: e.tags['addr:suburb'] || '', lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon }));
    res.json({ shops });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
