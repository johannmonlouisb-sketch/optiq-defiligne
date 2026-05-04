// netlify/functions/optimize-route.js
// Optimisation de tournée multi-technicien
// Algorithme : Multi-start Nearest Neighbor + 2-opt contraint + Or-opt
// Aucune dépendance externe — calcul 100 % local avec Haversine

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

const ROAD_FACTOR  = 1.30  // haversine → distance routière approx.
const SPEED_KMH    = 50    // vitesse moyenne mix urbain/rural France
const START_H      = 7     // heure de départ dépôt
const START_MIN    = 30    // minute de départ dépôt
const MAX_STOPS    = 50    // limite sécurité par technicien

// ─── Géométrie ───────────────────────────────────────────────────────────────

function haversine(a, b) {
  const R = 6371
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const s = Math.sin(dLat / 2) ** 2
        + Math.cos(a.lat * Math.PI / 180)
        * Math.cos(b.lat * Math.PI / 180)
        * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(s)) * ROAD_FACTOR
}

function routeDist(depot, route) {
  if (!route.length) return 0
  let d = haversine(depot, route[0])
  for (let i = 1; i < route.length; i++) d += haversine(route[i-1], route[i])
  d += haversine(route[route.length - 1], depot)
  return d
}

// ─── Nearest Neighbor ────────────────────────────────────────────────────────

function buildNN(depot, stops, startIdx) {
  const unvis = [...stops]
  const route = []
  let cur = startIdx === -1 ? depot : stops[startIdx]
  if (startIdx >= 0) { route.push(unvis[startIdx]); unvis.splice(startIdx, 1) }
  while (unvis.length) {
    let bestIdx = 0, bestD = Infinity
    for (let i = 0; i < unvis.length; i++) {
      const d = haversine(cur, unvis[i])
      if (d < bestD) { bestD = d; bestIdx = i }
    }
    cur = unvis[bestIdx]
    route.push(cur)
    unvis.splice(bestIdx, 1)
  }
  return route
}

// ─── 2-opt contraint ─────────────────────────────────────────────────────────
// Ne déplace jamais les stops ancrés (RDV avec créneau horaire)

function twoOptConstrained(depot, route, anchorIds) {
  let best = [...route], bestD = routeDist(depot, best), improved = true, iter = 0
  while (improved && iter++ < 100) {
    improved = false
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 2; j < best.length; j++) {
        // Sauter si le segment à inverser contient un stop ancré
        if (best.slice(i + 1, j + 1).some(s => anchorIds.has(s.id))) continue
        const cand = [...best.slice(0, i+1), ...best.slice(i+1, j+1).reverse(), ...best.slice(j+1)]
        const d = routeDist(depot, cand)
        if (d < bestD - 0.001) { best = cand; bestD = d; improved = true }
      }
    }
  }
  return best
}

// ─── Or-opt contraint ────────────────────────────────────────────────────────
// Déplace un stop vers sa meilleure position, sans toucher aux ancrés

function orOptConstrained(depot, route, anchorIds) {
  let best = [...route], bestD = routeDist(depot, best), improved = true
  while (improved) {
    improved = false
    for (let i = 0; i < best.length; i++) {
      if (anchorIds.has(best[i].id)) continue  // ne pas déplacer un RDV
      const pt = best[i]
      const without = best.filter((_, k) => k !== i)
      for (let j = 0; j <= without.length; j++) {
        const cand = [...without.slice(0, j), pt, ...without.slice(j)]
        const d = routeDist(depot, cand)
        if (d < bestD - 0.001) { best = cand; bestD = d; improved = true; break }
      }
      if (improved) break
    }
  }
  return best
}

// ─── Optimisation principale d'un technicien ─────────────────────────────────

function optimizeTech(depot, stops, startH, startMin) {
  startH   = (startH   !== undefined) ? startH   : START_H
  startMin = (startMin !== undefined) ? startMin : START_MIN
  if (!stops.length) return { orderedIds: [], totalDistanceKm: 0, totalDurationMin: 0, conflicts: [], estimatedArrivals: {}, estimatedEnd: minsToHHMM(startH * 60 + startMin) }
  if (stops.length === 1) {
    const s0 = stops[0]
    const travT = Math.round(haversine(depot, s0) / SPEED_KMH * 60)
    const arrMin = startH * 60 + startMin + travT
    return { orderedIds: [s0.id], totalDistanceKm: Math.round(haversine(depot, s0) * 2 * 10) / 10, totalDurationMin: Math.round(haversine(depot, s0) * 2 / SPEED_KMH * 60) + (s0.duration || 0), conflicts: [], estimatedArrivals: { [s0.id]: minsToHHMM(arrMin) }, estimatedEnd: minsToHHMM(arrMin + (s0.duration || 0) + travT) }
  }

  const anchored = stops.filter(s => s.timeWindow)
  const free     = stops.filter(s => !s.timeWindow)
  const anchorIds = new Set(anchored.map(s => s.id))

  // Trier les ancrés par créneau de début
  anchored.sort((a, b) => a.timeWindow.start.localeCompare(b.timeWindow.start))

  // Multi-start : essayer depuis le dépôt + depuis chaque point
  let best = null, bestDist = Infinity
  const starts = [-1, ...stops.map((_, i) => i)]
  for (const startIdx of starts) {
    let cand = buildNN(depot, stops, startIdx)
    cand = twoOptConstrained(depot, cand, anchorIds)
    cand = orOptConstrained(depot, cand, anchorIds)
    const d = routeDist(depot, cand)
    if (d < bestDist) { bestDist = d; best = cand }
  }

  const route = best || stops

  // ── Calcul distances + durées avec simulation horaire ──
  const totalDistKm = Math.round(routeDist(depot, route) * 10) / 10
  const travelMin   = Math.round(totalDistKm / SPEED_KMH * 60)
  const workMin     = route.reduce((a, s) => a + (s.duration || 0), 0)

  // ── Simulation horaire : conflits créneau + heure d'arrivée par arrêt ──
  const conflicts = []
  const estimatedArrivals = {}
  let curMin  = startH * 60 + startMin
  let prevPt  = depot
  for (const s of route) {
    const trav = Math.round(haversine(prevPt, s) / SPEED_KMH * 60)
    curMin += trav
    estimatedArrivals[s.id] = minsToHHMM(curMin)
    if (s.timeWindow) {
      const toMin = hhmm(s.timeWindow.end)
      if (curMin > toMin) {
        conflicts.push({
          id:          s.id,
          label:       s.label || s.id,
          créneau:     s.timeWindow.end,
          arrivée_est: minsToHHMM(curMin)
        })
      }
      // Attendre si on arrive trop tôt
      const fromMin = hhmm(s.timeWindow.start)
      if (curMin < fromMin) curMin = fromMin
    }
    curMin += (s.duration || 0)
    prevPt = s
  }
  const retMin = curMin + Math.round(haversine(route[route.length - 1], depot) / SPEED_KMH * 60)

  return {
    orderedIds:       route.map(s => s.id),
    totalDistanceKm:  totalDistKm,
    totalDurationMin: travelMin + workMin,
    conflicts,
    estimatedArrivals,
    estimatedEnd:     minsToHHMM(retMin)
  }
}

// ─── Helpers temps ────────────────────────────────────────────────────────────

function hhmm(str) {
  const [h, m] = str.split(':').map(Number)
  return h * 60 + m
}
function minsToHHMM(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

// ─── Handler Netlify ──────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) }

  let body
  try { body = JSON.parse(event.body) }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) } }

  const { techs } = body
  if (!Array.isArray(techs) || !techs.length)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Champ "techs" requis (tableau non vide)' }) }

  const results = {}
  for (const tech of techs) {
    const { id, depot, stops, startH, startMin } = tech
    if (!depot || !Array.isArray(stops)) { results[id] = { error: 'depot et stops requis' }; continue }
    if (stops.length > MAX_STOPS)        { results[id] = { error: `Maximum ${MAX_STOPS} stops par technicien (reçu: ${stops.length})` }; continue }
    try {
      results[id] = optimizeTech(depot, stops, startH, startMin)
    } catch (e) {
      results[id] = { error: e.message }
    }
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ results, algorithm: 'multi-start NN + 2-opt contraint + or-opt' })
  }
}
