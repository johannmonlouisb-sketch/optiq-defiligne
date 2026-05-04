// netlify/functions/cluster.js
// Regroupement géographique des interventions en journées cohérentes
// Étape 2 du pipeline : geocode → cluster → validate-day → plan-day → agent-planning

const { geocodeInterventions } = require('./geocode')

const DEPOT = { lat: 48.965, lng: 1.967, name: 'Vernouillet' }

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

const DEFAULT_CONSTRAINTS = {
  maxRadiusKm:      150,   // distance max dépôt → intervention (inZone)
  maxDayKm:         400,   // km max aller-retour dans la journée
  maxTransitHours:  8,     // heures de trajet max dans la journée
  maxTotalHours:    10,    // durée totale journée max (trajet + interventions)
  avgSpeedKmh:      60,    // vitesse moyenne route
  roadFactor:       1.4,   // facteur vol d'oiseau → route
  defaultDurationH: 1.5    // durée par intervention si non précisée
}

// ── Géométrie ─────────────────────────────────────────────────

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Distance vol d'oiseau × facteur route (km)
function roadDist(lat1, lng1, lat2, lng2) {
  return haversine(lat1, lng1, lat2, lng2) * DEFAULT_CONSTRAINTS.roadFactor
}

// Temps de trajet en heures
function travelHours(distKm, speedKmh = DEFAULT_CONSTRAINTS.avgSpeedKmh) {
  return distKm / speedKmh
}

// ── Séparation zone / hors-zone ────────────────────────────────

/**
 * Sépare les interventions en deux groupes selon la distance au dépôt.
 * @param {Object[]} interventions  — chaque iv doit avoir lat/lng
 * @param {number}   depotLat
 * @param {number}   depotLng
 * @param {number}   radiusKm
 * @returns {{ inZone: Object[], outOfZone: Object[] }}
 */
function clusterByZone(interventions, depotLat = DEPOT.lat, depotLng = DEPOT.lng, radiusKm = DEFAULT_CONSTRAINTS.maxRadiusKm) {
  const inZone    = []
  const outOfZone = []

  for (const iv of interventions) {
    if (!iv.lat || !iv.lng) {
      iv._clusterNote = 'no_coords'
      outOfZone.push(iv)
      continue
    }
    const dist = haversine(depotLat, depotLng, iv.lat, iv.lng)
    iv._distFromDepot = Math.round(dist)
    if (dist <= radiusKm) {
      inZone.push(iv)
    } else {
      iv._clusterNote = `out_of_zone_${Math.round(dist)}km`
      outOfZone.push(iv)
    }
  }

  return { inZone, outOfZone }
}

// ── Regroupement en journées (greedy nearest-neighbor) ─────────

/**
 * Regroupe un tableau d'interventions (déjà géocodées, inZone) en journées.
 * Algorithme : greedy nearest-neighbor depuis le dépôt jusqu'à saturation des contraintes.
 *
 * @param {Object[]} interventions  — avec lat, lng, durationH (optionnel)
 * @param {number}   depotLat
 * @param {number}   depotLng
 * @param {Object}   constraints    — surcharge de DEFAULT_CONSTRAINTS
 * @returns {DayCluster[]}
 *   DayCluster = { interventions, totalKm, transitKm, totalHours, transitHours, feasible, overflowReason? }
 */
function clusterIntoDays(interventions, depotLat = DEPOT.lat, depotLng = DEPOT.lng, constraints = {}) {
  const C = { ...DEFAULT_CONSTRAINTS, ...constraints }
  const remaining = [...interventions]
  const days = []

  while (remaining.length > 0) {
    const day = buildOneDay(remaining, depotLat, depotLng, C)
    days.push(day)
    // Retire les interventions placées dans cette journée
    const placed = new Set(day.interventions.map(iv => iv._clusterId || iv.id || iv.notionId))
    for (let i = remaining.length - 1; i >= 0; i--) {
      const iv = remaining[i]
      const key = iv._clusterId || iv.id || iv.notionId
      if (placed.has(key)) remaining.splice(i, 1)
    }
    // Sécurité anti-boucle infinie : si aucune intervention n'a été placée, force la sortie
    if (day.interventions.length === 0) {
      // L'intervention impossible (trop loin, durée trop longue) est marquée et retirée
      remaining[0]._clusterNote = 'cannot_fit_in_day'
      remaining.splice(0, 1)
    }
  }

  return days
}

function buildOneDay(pool, depotLat, depotLng, C) {
  const placed = []
  let curLat  = depotLat
  let curLng  = depotLng
  let transitKm    = 0
  let transitHours = 0
  let workHours    = 0

  // Clone pour marquage sans mutation du pool original
  const available = pool.map((iv, idx) => ({ iv, idx, used: false }))

  while (true) {
    // Cherche le voisin le plus proche qui tient encore dans la journée
    let best      = null
    let bestDist  = Infinity
    let bestIdx   = -1

    for (const item of available) {
      if (item.used) continue
      const { iv } = item
      if (!iv.lat || !iv.lng) continue

      const toIv    = roadDist(curLat, curLng, iv.lat, iv.lng)
      const retourKm = roadDist(iv.lat, iv.lng, depotLat, depotLng)
      const durH     = iv.durationH || C.defaultDurationH

      // Vérifie si l'ajout de cet arrêt respecte encore toutes les contraintes
      const newTransitKm = transitKm + toIv
      const totalKmWithReturn  = newTransitKm + retourKm
      const newTransitH        = transitHours + travelHours(toIv, C.avgSpeedKmh)
      const retourH            = travelHours(retourKm, C.avgSpeedKmh)
      const totalH             = newTransitH + retourH + workHours + durH

      if (
        totalKmWithReturn  > C.maxDayKm        ||
        newTransitH + retourH > C.maxTransitHours ||
        totalH               > C.maxTotalHours
      ) continue

      if (toIv < bestDist) {
        bestDist = toIv
        best     = item
        bestIdx  = item.idx
      }
    }

    if (!best) break  // plus rien à ajouter sans violer les contraintes

    const { iv } = best
    best.used = true

    const toIv = roadDist(curLat, curLng, iv.lat, iv.lng)
    transitKm    += toIv
    transitHours += travelHours(toIv, C.avgSpeedKmh)
    workHours    += iv.durationH || C.defaultDurationH
    curLat = iv.lat
    curLng = iv.lng
    placed.push(iv)
  }

  // Retour dépôt
  const retourKm = placed.length > 0
    ? roadDist(curLat, curLng, depotLat, depotLng)
    : 0
  const retourH  = travelHours(retourKm, C.avgSpeedKmh)

  const totalKm    = Math.round(transitKm + retourKm)
  const totalH     = Math.round((transitHours + retourH + workHours) * 10) / 10
  const totalTransitH = Math.round((transitHours + retourH) * 10) / 10

  const feasible = (
    totalKm       <= C.maxDayKm       &&
    totalTransitH <= C.maxTransitHours &&
    totalH        <= C.maxTotalHours
  )

  const cluster = {
    interventions: placed,
    totalKm,
    transitKm:    Math.round(transitKm + retourKm),
    totalHours:   totalH,
    transitHours: totalTransitH,
    workHours:    Math.round(workHours * 10) / 10,
    feasible
  }

  if (!feasible) {
    const reasons = []
    if (totalKm       > C.maxDayKm)        reasons.push(`km_${totalKm}>${C.maxDayKm}`)
    if (totalTransitH > C.maxTransitHours) reasons.push(`transit_${totalTransitH}h>${C.maxTransitHours}h`)
    if (totalH        > C.maxTotalHours)   reasons.push(`total_${totalH}h>${C.maxTotalHours}h`)
    cluster.overflowReason = reasons.join(', ')
  }

  return cluster
}

// ── Pipeline complet : géocoder + clustériser ──────────────────

/**
 * Pipeline principal : géocode les interventions puis les regroupe en journées.
 * @param {Object[]} interventions  — avec iv.addr
 * @param {Object}   options        — { depotLat, depotLng, radiusKm, constraints }
 * @returns {{ inZoneDays, outOfZone, stats }}
 */
async function geocodeAndCluster(interventions, options = {}) {
  const {
    depotLat    = DEPOT.lat,
    depotLng    = DEPOT.lng,
    radiusKm    = DEFAULT_CONSTRAINTS.maxRadiusKm,
    constraints = {}
  } = options

  // 1. Géocodage
  const geoStats = await geocodeInterventions(interventions)

  // 2. Séparation zone / hors-zone
  const { inZone, outOfZone } = clusterByZone(interventions, depotLat, depotLng, radiusKm)

  // 3. Regroupement en journées pour les interventions en zone
  const inZoneDays = clusterIntoDays(inZone, depotLat, depotLng, constraints)

  const stats = {
    total:       interventions.length,
    geocoded:    geoStats.found,
    notGeocoded: geoStats.notFound.length,
    inZone:      inZone.length,
    outOfZone:   outOfZone.length,
    daysNeeded:  inZoneDays.length,
    notFound:    geoStats.notFound
  }

  return { inZoneDays, outOfZone, stats }
}

// ── Exports pour les autres fonctions Netlify ─────────────────
module.exports = {
  haversine,
  roadDist,
  travelHours,
  clusterByZone,
  clusterIntoDays,
  geocodeAndCluster,
  DEPOT,
  DEFAULT_CONSTRAINTS
}

// ── Handler HTTP ──────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) }

  let body
  try { body = JSON.parse(event.body || '{}') }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) } }

  const { interventions, depotLat, depotLng, radiusKm, constraints } = body

  if (!Array.isArray(interventions) || interventions.length === 0)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '"interventions" array requis' }) }

  try {
    const result = await geocodeAndCluster(interventions, { depotLat, depotLng, radiusKm, constraints })
    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) }
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) }
  }
}
