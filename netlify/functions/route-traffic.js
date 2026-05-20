// netlify/functions/route-traffic.js
// Routing routier avec modélisation de trafic par heure de la journée
// Source : OSRM (géométrie réelle) + coefficients heure de pointe France
// Fallback Google Directions si GOOGLE_MAPS_KEY est défini (trafic live)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

const OSRM_BASE  = 'https://router.project-osrm.org/route/v1/driving/'
const GOOGLE_DIR = 'https://maps.googleapis.com/maps/api/directions/json'

// ── Modèle de trafic heure de la journée (France, mix urbain/périurbain) ──────
// Inspiré des données Waze / TomTom pour les zones Île-de-France et régionales
function trafficFactor(hhMM) {
  if (!hhMM) return 1.10
  const [h, m] = hhMM.split(':').map(Number)
  const t = h * 60 + m
  if (t >= 390  && t < 570)  return 1.50  // 6h30–9h30  heure de pointe matin
  if (t >= 570  && t < 690)  return 1.20  // 9h30–11h30 fin de pointe matin
  if (t >= 690  && t < 840)  return 1.15  // 11h30–14h  heure de déjeuner
  if (t >= 840  && t < 1020) return 1.10  // 14h–17h    après-midi fluide
  if (t >= 1020 && t < 1200) return 1.45  // 17h–20h    heure de pointe soir
  if (t >= 1200 && t < 1320) return 1.20  // 20h–22h    soirée dégagement
  if (t >= 330  && t < 390)  return 1.05  // 5h30–6h30  très tôt
  return 1.00                              // nuit        circulation libre
}

// Libellé lisible de la période de trafic
function trafficLabel(factor) {
  if (factor >= 1.40) return 'Heure de pointe'
  if (factor >= 1.20) return 'Trafic modéré'
  if (factor >= 1.10) return 'Trafic fluide+'
  return 'Trafic libre'
}

// ── OSRM + modèle heure de la journée ────────────────────────────────────────
async function routeOSRM(waypoints, departureHHMM) {
  const cs = waypoints.map(p => `${p.lng},${p.lat}`).join(';')
  const r  = await fetch(`${OSRM_BASE}${cs}?overview=full&geometries=geojson`, { signal: AbortSignal.timeout(8000) })
  const d  = await r.json()
  if (!d.routes?.[0]) return null

  const rt     = d.routes[0]
  const factor = trafficFactor(departureHHMM)

  // Applique le facteur sur chaque leg individuellement
  // (les legs OSRM varient en longueur selon les stops)
  const legs = (rt.legs || []).map(leg => ({
    distanceKm:        Math.round(leg.distance / 100) / 10,
    durationMin:       Math.round(leg.duration / 60),
    trafficDurationMin: Math.round(leg.duration / 60 * factor)
  }))

  const totalDistanceKm   = Math.round(rt.distance / 100) / 10
  const totalDurationMin  = Math.round(rt.duration / 60)
  const trafficDurationMin = Math.round(rt.duration / 60 * factor)

  return {
    polylineGeoJson:  rt.geometry,
    totalDistanceKm,
    totalDurationMin,
    trafficDurationMin,
    delayMin:   trafficDurationMin - totalDurationMin,   // retard estimé en minutes
    trafficLabel: trafficLabel(factor),
    factor,
    legs,
    hasTraffic: true,
    source: 'osrm+heuristique'
  }
}

// ── Google Directions (optionnel, si clé dispo) ───────────────────────────────
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
  const trafficDurationMin = legs.reduce((s, l) => s + l.trafficDurationMin, 0)
  const totalDurationMin   = legs.reduce((s, l) => s + l.durationMin, 0)
  return {
    polylineGeoJson:  decodePolyline(route.overview_polyline.points),
    totalDistanceKm:  Math.round(legs.reduce((s, l) => s + l.distanceKm, 0) * 10) / 10,
    totalDurationMin,
    trafficDurationMin,
    delayMin:   trafficDurationMin - totalDurationMin,
    trafficLabel: trafficDurationMin > totalDurationMin * 1.3 ? 'Heure de pointe' : trafficDurationMin > totalDurationMin * 1.15 ? 'Trafic modéré' : 'Trafic fluide',
    legs,
    hasTraffic: true,
    source: 'google'
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

  // 1. Google Directions live (si clé disponible)
  const googleKey = process.env.GOOGLE_MAPS_KEY
  if (googleKey) {
    let ts = 'now'
    if (departureHHMM) {
      const [h, m] = departureHHMM.split(':').map(Number)
      const d = new Date(); d.setHours(h, m, 0, 0)
      ts = Math.max(Math.floor(d.getTime() / 1000), Math.floor(Date.now() / 1000) + 60)
    }
    result = await routeGoogle(waypoints, ts, googleKey).catch(() => null)
  }

  // 2. OSRM + modèle heure de la journée (toujours disponible)
  if (!result) result = await routeOSRM(waypoints, departureHHMM).catch(() => null)

  if (!result) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Routing indisponible' }) }
  return { statusCode: 200, headers: CORS, body: JSON.stringify(result) }
}
