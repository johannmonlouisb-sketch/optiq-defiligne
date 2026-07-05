// netlify/functions/optimize-route.js
// Optimisation de tournée multi-technicien
// Algorithme : Multi-start Nearest Neighbor + 2-opt contraint + Or-opt
// Coût optimisé : temps de trajet réel (matrice OSRM Table Service, routes réelles)
// Fallback : estimation Haversine × facteur route si OSRM indisponible

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

const ROAD_FACTOR  = 1.30  // haversine → distance routière approx. (fallback uniquement)
const SPEED_KMH     = 50    // vitesse moyenne mix urbain/rural France (fallback uniquement)
const START_H       = 7     // heure de départ dépôt
const START_MIN     = 30    // minute de départ dépôt
const MAX_STOPS     = 50    // limite sécurité par technicien
const OSRM_TABLE    = 'https://router.project-osrm.org/table/v1/driving/'

// ─── Géométrie (fallback) ──────────────────────────────────────────────────────

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

// ─── Matrice de distances/durées réelles (OSRM Table Service) ─────────────────
// index 0 = dépôt, index i (i>=1) = stops[i-1]

async function fetchOsrmMatrix(depot, stops) {
  try {
    const points = [depot, ...stops]
    const coords = points.map(p => `${p.lng},${p.lat}`).join(';')
    const r = await fetch(`${OSRM_TABLE}${coords}?annotations=distance,duration`, { signal: AbortSignal.timeout(8000) })
    const d = await r.json()
    if (d.code !== 'Ok' || !d.distances || !d.durations) return null
    return {
      distKm: d.distances.map(row => row.map(v => v / 1000)),
      durMin: d.durations.map(row => row.map(v => v / 60))
    }
  } catch { return null }
}

// Fournit des fonctions de coût indexées (0=dépôt, 1..n=stops), sur matrice réelle si
// disponible, sinon sur l'estimation Haversine.
function makeCostFns(depot, stops, matrix) {
  if (matrix) {
    return {
      dist:   (i, j) => matrix.durMin[i][j],   // minutes réelles — c'est CE coût qu'on optimise
      distKm: (i, j) => matrix.distKm[i][j]
    }
  }
  const pts = [depot, ...stops]
  return {
    dist:   (i, j) => haversine(pts[i], pts[j]) / SPEED_KMH * 60,
    distKm: (i, j) => haversine(pts[i], pts[j])
  }
}

// ─── Coût d'une route (indices 1..n, dépôt implicite aux extrémités) ──────────

function routeCost(cost, route) {
  if (!route.length) return 0
  let d = cost.dist(0, route[0])
  for (let i = 1; i < route.length; i++) d += cost.dist(route[i - 1], route[i])
  d += cost.dist(route[route.length - 1], 0)
  return d
}
function routeCostKm(cost, route) {
  if (!route.length) return 0
  let d = cost.distKm(0, route[0])
  for (let i = 1; i < route.length; i++) d += cost.distKm(route[i - 1], route[i])
  d += cost.distKm(route[route.length - 1], 0)
  return d
}

// ─── Nearest Neighbor (indexé) ─────────────────────────────────────────────────

function buildNN(cost, n, seedIdx) {
  const unvis = Array.from({ length: n }, (_, i) => i + 1)
  const route = []
  let cur = 0
  if (seedIdx >= 1) { route.push(seedIdx); unvis.splice(unvis.indexOf(seedIdx), 1); cur = seedIdx }
  while (unvis.length) {
    let bestI = 0, bestD = Infinity
    for (let i = 0; i < unvis.length; i++) {
      const d = cost.dist(cur, unvis[i])
      if (d < bestD) { bestD = d; bestI = i }
    }
    cur = unvis[bestI]
    route.push(cur)
    unvis.splice(bestI, 1)
  }
  return route
}

// ─── 2-opt contraint (indexé) ───────────────────────────────────────────────────
// Ne déplace jamais les stops ancrés (RDV avec créneau horaire)

function twoOptConstrained(cost, route, anchorIdx) {
  let best = [...route], bestD = routeCost(cost, best), improved = true, iter = 0
  while (improved && iter++ < 100) {
    improved = false
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 2; j < best.length; j++) {
        if (best.slice(i + 1, j + 1).some(idx => anchorIdx.has(idx))) continue
        const cand = [...best.slice(0, i + 1), ...best.slice(i + 1, j + 1).reverse(), ...best.slice(j + 1)]
        const d = routeCost(cost, cand)
        if (d < bestD - 0.001) { best = cand; bestD = d; improved = true }
      }
    }
  }
  return best
}

// ─── Or-opt contraint (indexé) ──────────────────────────────────────────────────
// Déplace un stop vers sa meilleure position, sans toucher aux ancrés

function orOptConstrained(cost, route, anchorIdx) {
  let best = [...route], bestD = routeCost(cost, best), improved = true
  while (improved) {
    improved = false
    for (let i = 0; i < best.length; i++) {
      if (anchorIdx.has(best[i])) continue
      const pt = best[i]
      const without = best.filter((_, k) => k !== i)
      for (let j = 0; j <= without.length; j++) {
        const cand = [...without.slice(0, j), pt, ...without.slice(j)]
        const d = routeCost(cost, cand)
        if (d < bestD - 0.001) { best = cand; bestD = d; improved = true; break }
      }
      if (improved) break
    }
  }
  return best
}

// ─── Optimisation principale d'un technicien ─────────────────────────────────

async function optimizeTech(depot, stops, startH, startMin) {
  startH   = (startH   !== undefined) ? startH   : START_H
  startMin = (startMin !== undefined) ? startMin : START_MIN
  if (!stops.length) return { orderedIds: [], totalDistanceKm: 0, totalDurationMin: 0, conflicts: [], estimatedArrivals: {}, estimatedEnd: minsToHHMM(startH * 60 + startMin) }

  const matrix = await fetchOsrmMatrix(depot, stops)
  const cost   = makeCostFns(depot, stops, matrix)
  const n      = stops.length

  if (n === 1) {
    const s0     = stops[0]
    const travT  = Math.round(cost.dist(0, 1))
    const distKm = Math.round(cost.distKm(0, 1) * 2 * 10) / 10
    const arrMin = startH * 60 + startMin + travT
    return {
      orderedIds: [s0.id],
      totalDistanceKm:  distKm,
      totalDurationMin: travT * 2 + (s0.duration || 0),
      conflicts: [],
      estimatedArrivals: { [s0.id]: minsToHHMM(arrMin) },
      estimatedEnd: minsToHHMM(arrMin + (s0.duration || 0) + travT)
    }
  }

  const anchorIdx = new Set(stops.map((s, i) => s.timeWindow ? i + 1 : null).filter(x => x !== null))

  // Multi-start : essayer depuis le dépôt + depuis chaque stop
  let best = null, bestCost = Infinity
  const starts = [0, ...Array.from({ length: n }, (_, i) => i + 1)]
  for (const seed of starts) {
    let cand = buildNN(cost, n, seed)
    cand = twoOptConstrained(cost, cand, anchorIdx)
    cand = orOptConstrained(cost, cand, anchorIdx)
    const d = routeCost(cost, cand)
    if (d < bestCost) { bestCost = d; best = cand }
  }

  const routeIdx = best || Array.from({ length: n }, (_, i) => i + 1)
  const route    = routeIdx.map(idx => stops[idx - 1])

  // ── Calcul distances + durées ──
  const totalDistKm = Math.round(routeCostKm(cost, routeIdx) * 10) / 10
  const travelMin    = Math.round(routeCost(cost, routeIdx))
  const workMin      = route.reduce((a, s) => a + (s.duration || 0), 0)

  // ── Simulation horaire : conflits créneau + heure d'arrivée par arrêt ──
  const conflicts = []
  const estimatedArrivals = {}
  let curMin  = startH * 60 + startMin
  let prevIdx = 0
  routeIdx.forEach((idx, k) => {
    const s = stops[idx - 1]
    curMin += Math.round(cost.dist(prevIdx, idx))
    estimatedArrivals[s.id] = minsToHHMM(curMin)
    if (s.timeWindow) {
      const toMin = hhmm(s.timeWindow.end)
      if (curMin > toMin) {
        conflicts.push({ id: s.id, label: s.label || s.id, créneau: s.timeWindow.end, arrivée_est: minsToHHMM(curMin) })
      }
      const fromMin = hhmm(s.timeWindow.start)
      if (curMin < fromMin) curMin = fromMin
    }
    curMin += (s.duration || 0)
    prevIdx = idx
  })
  const retMin = curMin + Math.round(cost.dist(prevIdx, 0))

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
      results[id] = await optimizeTech(depot, stops, startH, startMin)
    } catch (e) {
      results[id] = { error: e.message }
    }
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ results, algorithm: 'multi-start NN + 2-opt contraint + or-opt (OSRM, temps réel)' })
  }
}
