// netlify/functions/agent-optimiseur.js
// Port JS de agents/optimiseur.py (PlanningOS → OptiQ)
// Optimise l'ordre des interventions par TSP nearest-neighbour
// Calcule les km économisés vs ordre d'arrivée initial

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

const ROAD_FACTOR = 1.4
const DEPOT       = { lat: 48.965, lng: 1.967 }

// ── Géométrie ─────────────────────────────────────────────────

function haversine(lat1, lng1, lat2, lng2) {
  const R    = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a    = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function roadDist(lat1, lng1, lat2, lng2) {
  return haversine(lat1, lng1, lat2, lng2) * ROAD_FACTOR
}

function tourKm(ordered, depotLat, depotLng) {
  if (!ordered.length) return 0
  let km   = roadDist(depotLat, depotLng, ordered[0].lat, ordered[0].lng)
  for (let i = 1; i < ordered.length; i++)
    km += roadDist(ordered[i - 1].lat, ordered[i - 1].lng, ordered[i].lat, ordered[i].lng)
  km += roadDist(ordered[ordered.length - 1].lat, ordered[ordered.length - 1].lng, depotLat, depotLng)
  return Math.round(km)
}

// ── TSP Nearest-Neighbour ─────────────────────────────────────

/**
 * Trie les interventions pour minimiser la distance totale.
 * Les interventions sans coordonnées sont renvoyées à la fin.
 *
 * @param {Object[]} interventions  — chaque iv doit avoir lat/lng
 * @param {number}   depotLat
 * @param {number}   depotLng
 * @returns {{ ordered: Object[], kmOriginal: number, kmOptimise: number, kmEconomies: number }}
 */
function nearestNeighbour(interventions, depotLat = DEPOT.lat, depotLng = DEPOT.lng) {
  const withCoords    = interventions.filter(iv => iv.lat && iv.lng)
  const withoutCoords = interventions.filter(iv => !iv.lat || !iv.lng)

  if (withCoords.length <= 1) {
    const km = tourKm(withCoords, depotLat, depotLng)
    return { ordered: [...withCoords, ...withoutCoords], kmOriginal: km, kmOptimise: km, kmEconomies: 0 }
  }

  const kmOriginal = tourKm(withCoords, depotLat, depotLng)

  const remaining = [...withCoords]
  const ordered   = []
  let curLat = depotLat
  let curLng = depotLng

  while (remaining.length > 0) {
    let bestIdx  = 0
    let bestDist = Infinity

    for (let i = 0; i < remaining.length; i++) {
      const d = roadDist(curLat, curLng, remaining[i].lat, remaining[i].lng)
      if (d < bestDist) { bestDist = d; bestIdx = i }
    }

    const next = remaining.splice(bestIdx, 1)[0]
    ordered.push(next)
    curLat = next.lat
    curLng = next.lng
  }

  const kmOptimise  = tourKm(ordered, depotLat, depotLng)
  const kmEconomies = Math.max(0, kmOriginal - kmOptimise)

  return {
    ordered:     [...ordered, ...withoutCoords],
    kmOriginal,
    kmOptimise,
    kmEconomies,
    gainPct:     kmOriginal > 0 ? Math.round((kmEconomies / kmOriginal) * 100) : 0
  }
}

// ── Optimisation d'un batch de journées ──────────────────────

function optimizeBatch(days) {
  const t0        = Date.now()
  let totalSaved  = 0
  let totalInit   = 0

  const results = (days || []).map(d => {
    const res     = nearestNeighbour(
      d.interventions || [],
      d.depotLat,
      d.depotLng
    )
    totalSaved   += res.kmEconomies
    totalInit    += res.kmOriginal

    return {
      tech:         d.tech,
      date:         d.date,
      interventions: res.ordered,
      kmOriginal:   res.kmOriginal,
      kmOptimise:   res.kmOptimise,
      kmEconomies:  res.kmEconomies,
      gainPct:      res.gainPct
    }
  })

  return {
    processed:   results.length,
    kmSaved:     totalSaved,
    kmOrigTotal: totalInit,
    gainPct:     totalInit > 0 ? Math.round((totalSaved / totalInit) * 100) : 0,
    durationMs:  Date.now() - t0,
    days: results
  }
}

module.exports = { nearestNeighbour, optimizeBatch, tourKm }

// ── Handler HTTP ──────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) }

  let body
  try { body = JSON.parse(event.body || '{}') }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) } }

  const { day, days } = body

  if (Array.isArray(days)) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify(optimizeBatch(days)) }
  }
  if (day && Array.isArray(day.interventions)) {
    const res = nearestNeighbour(day.interventions, day.depotLat, day.depotLng)
    return { statusCode: 200, headers: CORS, body: JSON.stringify(res) }
  }

  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '"day" ou "days" requis' }) }
}
