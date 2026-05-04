// netlify/functions/plan-day.js
// Ordonnancement optimal d'une journée : nearest-neighbor VRP depuis le dépôt
// Étape 4 du pipeline : geocode → cluster → validate-day → plan-day → agent-planning

const { roadDist, travelHours, DEPOT, DEFAULT_CONSTRAINTS } = require('./cluster')
const { validateDay } = require('./validate-day')

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

// ── Nearest-Neighbor VRP ───────────────────────────────────────

/**
 * Ordonne les interventions d'une journée avec l'algorithme nearest-neighbor.
 * Commence et finit au dépôt.
 *
 * @param {Object[]} interventions  — avec lat/lng, durationH optionnel
 * @param {Object}   options        — { depotLat, depotLng, startTime, avgSpeedKmh }
 * @returns {PlannedDay}
 */
function planDay(interventions, options = {}) {
  const {
    depotLat    = DEPOT.lat,
    depotLng    = DEPOT.lng,
    startTime   = '08:00',        // heure de départ du dépôt
    avgSpeedKmh = DEFAULT_CONSTRAINTS.avgSpeedKmh,
    defaultDurationH = DEFAULT_CONSTRAINTS.defaultDurationH
  } = options

  const withCoords = interventions.filter(iv => iv.lat && iv.lng)
  const noCoords   = interventions.filter(iv => !iv.lat || !iv.lng)

  if (withCoords.length === 0) {
    return {
      ordered:    [],
      unscheduled: interventions,
      route:      [],
      metrics:    { totalKm: 0, totalHours: 0, transitHours: 0, workHours: 0 },
      validation: { feasible: true, violations: [], warnings: [] }
    }
  }

  // Nearest-neighbor depuis le dépôt
  const ordered = nearestNeighbor(withCoords, depotLat, depotLng, avgSpeedKmh)

  // Calcul des horaires
  const route = buildRoute(ordered, depotLat, depotLng, startTime, avgSpeedKmh, defaultDurationH)

  // Validation finale
  const validation = validateDay(ordered, { depotLat, depotLng })

  return {
    ordered,
    unscheduled: noCoords,
    route,
    metrics:    validation.metrics,
    validation: {
      feasible:   validation.feasible,
      violations: validation.violations,
      warnings:   validation.warnings
    }
  }
}

// ── Algorithme nearest-neighbor ────────────────────────────────

function nearestNeighbor(interventions, depotLat, depotLng, speedKmh) {
  const pool    = [...interventions]
  const ordered = []
  let curLat = depotLat
  let curLng = depotLng

  while (pool.length > 0) {
    let bestIdx  = -1
    let bestDist = Infinity

    for (let i = 0; i < pool.length; i++) {
      const d = roadDist(curLat, curLng, pool[i].lat, pool[i].lng)
      if (d < bestDist) { bestDist = d; bestIdx = i }
    }

    const next = pool.splice(bestIdx, 1)[0]
    ordered.push(next)
    curLat = next.lat
    curLng = next.lng
  }

  return ordered
}

// ── Construction de la route horaire ──────────────────────────

/**
 * @returns {RouteStop[]}
 *   RouteStop = { order, id, addr, lat, lng, arriveAt, startAt, endAt, travelMin, durationMin, distFromPrev }
 */
function buildRoute(ordered, depotLat, depotLng, startTime, speedKmh, defaultDurationH) {
  const route = []
  let curLat    = depotLat
  let curLng    = depotLng
  let curMinutes = timeToMinutes(startTime)

  for (let i = 0; i < ordered.length; i++) {
    const iv = ordered[i]
    const dist      = roadDist(curLat, curLng, iv.lat, iv.lng)
    const travelMin = Math.round(travelHours(dist, speedKmh) * 60)
    const durMin    = Math.round((iv.durationH || defaultDurationH) * 60)
    const arriveMin = curMinutes + travelMin
    const startMin  = arriveMin   // pas de fenêtre horaire pour l'instant
    const endMin    = startMin + durMin

    route.push({
      order:       i + 1,
      id:          iv.id || iv.notionId,
      addr:        iv.addr,
      lat:         iv.lat,
      lng:         iv.lng,
      arriveAt:    minutesToTime(arriveMin),
      startAt:     minutesToTime(startMin),
      endAt:       minutesToTime(endMin),
      travelMin,
      durationMin: durMin,
      distFromPrev: Math.round(dist)
    })

    curMinutes = endMin
    curLat = iv.lat
    curLng = iv.lng
  }

  // Retour dépôt
  if (ordered.length > 0) {
    const retDist  = roadDist(curLat, curLng, depotLat, depotLng)
    const retMin   = Math.round(travelHours(retDist, speedKmh) * 60)
    route.push({
      order:        ordered.length + 1,
      id:           'depot_return',
      addr:         DEPOT.name,
      lat:          depotLat,
      lng:          depotLng,
      arriveAt:     minutesToTime(curMinutes + retMin),
      startAt:      minutesToTime(curMinutes + retMin),
      endAt:        minutesToTime(curMinutes + retMin),
      travelMin:    retMin,
      durationMin:  0,
      distFromPrev: Math.round(retDist)
    })
  }

  return route
}

// ── Utilitaires horaires ───────────────────────────────────────

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + (m || 0)
}

function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * Formate l'heure de début d'une intervention comme datetime ISO pour Notion.
 * Ex: '08:30' + '2024-01-15' → '2024-01-15T08:30:00+02:00'
 */
function toNotionDatetime(date, time, tzOffset = '+02:00') {
  return `${date}T${time}:00${tzOffset}`
}

/**
 * Planifie plusieurs journées (tableau de groupes d'interventions).
 * @param {Object[]} days     — chaque élément: { interventions, date? }
 * @param {Object}   options
 * @returns {PlannedDay[]}
 */
function planDays(days, options = {}) {
  return days.map((day, i) => {
    const ivs    = Array.isArray(day) ? day : (day.interventions || [])
    const date   = day.date || null
    const result = planDay(ivs, { ...options, startTime: options.startTime || '08:00' })
    return { dayIndex: i + 1, date, ...result }
  })
}

// ── Exports ───────────────────────────────────────────────────
module.exports = { planDay, planDays, nearestNeighbor, buildRoute, toNotionDatetime, timeToMinutes, minutesToTime }

// ── Handler HTTP ──────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) }

  let body
  try { body = JSON.parse(event.body || '{}') }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) } }

  const { interventions, days, depotLat, depotLng, startTime, avgSpeedKmh } = body
  const options = { depotLat, depotLng, startTime, avgSpeedKmh }

  try {
    if (Array.isArray(days)) {
      const results = planDays(days, options)
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ days: results }) }
    }
    if (Array.isArray(interventions)) {
      const result = planDay(interventions, options)
      return { statusCode: 200, headers: CORS, body: JSON.stringify(result) }
    }
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '"interventions" ou "days" requis' }) }
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) }
  }
}
