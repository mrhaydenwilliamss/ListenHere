// Listen Here — /api/shops?lat=..&lon=..
// Finds record shops near a position using OpenStreetMap (free, no key).
// Tries a few public OpenStreetMap servers in turn, in case one is busy or refuses.

const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];
const UA = 'ListenHere/0.2 (personal record-scanning app; https://listenhere-dun.vercel.app)';

module.exports = async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!isFinite(lat) || !isFinite(lon)) return res.status(400).json({ error: 'lat and lon needed' });
  const query = `[out:json][timeout:10];nwr(around:300,${lat},${lon})[shop=music];out center 5;`;
  const errors = [];
  for (const server of SERVERS) {
    try {
      const r = await fetch(`${server}?data=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json, */*', Referer: 'https://listenhere-dun.vercel.app/' }
      });
      if (!r.ok) { errors.push(`${new URL(server).host} ${r.status}`); continue; }
      const j = await r.json();
      const shops = (j.elements || [])
        .filter(e => e.tags && e.tags.name)
        .map(e => ({ name: e.tags.name, suburb: e.tags['addr:suburb'] || '', lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon }));
      return res.json({ shops, server: new URL(server).host });
    } catch (e) {
      errors.push(`${new URL(server).host} ${e.message}`);
    }
  }
  res.status(502).json({ error: 'OpenStreetMap unavailable: ' + errors.join('; ') });
};
