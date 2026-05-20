// netlify/functions/route-traffic.js
// Routing routier avec trafic temps réel
// Priorité : Mapbox driving-traffic → Google Directions → OSRM (fallback sans trafic)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

const MAPBOX_BASE = 'https://api.mapbox.com/directions/v5/mapbox/driving-traffic/'
const GOOGLE_DIR  = 'https://maps.googleapis.com/maps/api/directions/json'
const OSRM_BASE   = 'https://router.project-osrm.org/route/v1/driving/'

// ── Mapbox driving-traffic ────────────────────────────────────────────────────
// Profil driving-traffic = trafic temps réel + historique intégré nativement
async function routeMapbox(waypoints, token) {
  // Max 25 waypoints par requête Mapbox
  const coords = waypoints.map(p => `${p.lng},${p.lat}`).join(';')
  const url = `${MAPBOX_BASE}${coords}?overview=full&geometries=geojson&access_token=${token}`
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
  const d = await r.json()
  if (d.code !== 'Ok' || !d.routes?.[0]) return null

  const route = d.routes[0]
  const legs = route.legs.map(leg => ({
    distanceKm:        Math.round(leg.distance / 100) / 10,
    durationMin:       Math.round(leg.duration / 60),
    trafficDurationMin: Math.round(leg.duration / 60)  // driving-traffic inclut déjà le trafic
  }))

  return {
    polylineGeoJson:   route.geometry,
    totalDistanceKm:   Math.round(route.distance / 100) / 10,
    totalDurationMin:  Math.round(route.duration / 60),
    trafficDurationMin: Math.round(route.duration / 60),
    legs,
    hasTraffic: true,
    source: 'mapbox'
  }
}

// ── Google Maps Directions ────────────────────────────────────────────────────
function decodePolyline(enc) {
  const coords = []
  let i = 0, lat = 0, lng = 0
  while (i < enc.length) {
    let b, shift = 0, result = 0
    do { b = enc.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
    lat += (result & 1) ? ~(result >> 1) : (result >> 1)
    shift = 0; result = 0
    do { b = enc.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
    lng += (result & 1) ? ~(result >> 1) : (result >> 1)
    coords.push([lng / 1e5, lat / 1e5])
  }
  return { type: 'LineString', coordinates: coords }
}

async function routeGoogle(waypoints, departureTimestamp, key) {
  const origin    = `${waypoints[0].lat},${waypoints[0].lng}`
  const dest      = `${waypoints[waypoints.length - 1].lat},${waypoints[waypoints.length - 1].lng}`
  const midpoints = waypoints.slice(1, -1)
  const params = new URLSearchParams({ origin, destination: dest, mode: 'driving', departure_time: String(departureTimestamp), traffic_model: 'best_guess', key })
  if (midpoints.length) params.set('waypoints', midpoints.map(p => `${p.lat},${p.lng}`).join('|'))
  const r = await fetch(`${GOOGLE_DIR}?${params}`, { signal: AbortSignal.timeout(8000) })
  const d = await r.json()
  if (d.status !== 'OK' || !d.routes?.[0]) return null
  const route = d.routes[0]
  const legs = route.legs.map(leg => ({
    distanceKm:        Math.round(leg.distance.value / 100) / 10,
    durationMin:       Math.round(leg.duration.value / 60),
    trafficDurationMin: Math.round((leg.duration_in_traffic?.value ?? leg.duration.value) / 60)
  }))
  return {
    polylineGeoJson:   decodePolyline(route.overview_polyline.points),
    totalDistanceKm:   Math.round(legs.reduce((s, l) => s + l.distanceKm, 0) * 10) / 10,
    totalDurationMin:  legs.reduce((s, l) => s + l.durationMin, 0),
    trafficDurationMin: legs.reduce((s, l) => s + l.trafficDurationMin, 0),
    legs,
    hasTraffic: true,
    source: 'google'
  }
}

// ── OSRM (fallback sans trafic) ───────────────────────────────────────────────
async function routeOSRM(waypoints) {
  const cs = waypoints.map(p => `${p.lng},${p.lat}`).join(';')
  const r  = await fetch(`${OSRM_BASE}${cs}?overview=full&geometries=geojson`, { signal: AbortSignal.timeout(8000) })
  const d  = await r.json()
  if (!d.routes?.[0]) return null
  const rt = d.routes[0]
  const legs = (rt.legs || []).map(leg => ({
    distanceKm:        Math.round(leg.distance / 100) / 10,
    durationMin:       Math.round(leg.duration / 60),
    trafficDurationMin: Math.round(leg.duration / 60)
  }))
  return {
    polylineGeoJson:   rt.geometry,
    totalDistanceKm:   Math.round(rt.distance / 100) / 10,
    totalDurationMin:  Math.round(rt.duration / 60),
    trafficDurationMin: Math.round(rt.duration / 60),
    legs,
    hasTraffic: false,
    source: 'osrm'
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) }

  let body
  try { body = JSON.parse(event.body) }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) } }

  const { waypoints, departureHHMM } = body
  if (!Array.isArray(waypoints) || waypoints.length < 2)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'waypoints requis (min 2)' }) }

  let result = null

  // 1. Mapbox driving-traffic (trafic temps réel)
  const mapboxToken = process.env.MAPBOX_TOKEN
  if (mapboxToken) result = await routeMapbox(waypoints, mapboxToken).catch(() => null)

  // 2. Google Directions (trafic temps réel, si clé disponible)
  if (!result) {
    const googleKey = process.env.GOOGLE_MAPS_KEY
    if (googleKey) {
      let departureTimestamp = 'now'
      if (departureHHMM) {
        const [h, m] = departureHHMM.split(':').map(Number)
        const d = new Date(); d.setHours(h, m, 0, 0)
        departureTimestamp = Math.max(Math.floor(d.getTime() / 1000), Math.floor(Date.now() / 1000) + 60)
      }
      result = await routeGoogle(waypoints, departureTimestamp, googleKey).catch(() => null)
    }
  }

  // 3. OSRM (fallback sans trafic)
  if (!result) result = await routeOSRM(waypoints).catch(() => null)

  if (!result) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Routing indisponible' }) }
  return { statusCode: 200, headers: CORS, body: JSON.stringify(result) }
}
