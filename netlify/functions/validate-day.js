// netlify/functions/validate-day.js
// Validation qu'une journée planifiée respecte toutes les contraintes métier
// Étape 3 du pipeline : geocode → cluster → validate-day → plan-day → agent-planning

const { haversine, roadDist, travelHours, DEPOT, DEFAULT_CONSTRAINTS } = require('./cluster')

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

// ── Règles métier ──────────────────────────────────────────────

const RULES = {
  MAX_RADIUS_KM:     150,   // distance max dépôt → intervention (hors zone sinon)
  MAX_DAY_KM:        400,   // km max par journée (aller-retour)
  MAX_TRANSIT_HOURS: 8,     // heures trajet max
  MAX_TOTAL_HOURS:   10,    // durée journée max
  OVERNIGHT_KM:      200,   // distance > X km → découcher
  AVG_SPEED_KMH:     60,
  ROAD_FACTOR:       1.4,
  DEFAULT_DURATION_H: 1.5
}

// ── Validateur d'une journée ───────────────────────────────────

/**
 * Valide qu'une séquence d'interventions est réalisable en une journée.
 * Les interventions doivent déjà être ordonnées (ordre de passage).
 *
 * @param {Object[]} interventions  — ordonnées, avec lat/lng et optionnel durationH
 * @param {Object}   options        — { depotLat, depotLng, rules }
 * @returns {ValidationResult}
 */
function validateDay(interventions, options = {}) {
  const {
    depotLat = DEPOT.lat,
    depotLng = DEPOT.lng,
    rules    = {}
  } = options

  const R = { ...RULES, ...rules }

  const violations  = []
  const warnings    = []
  const segments    = []

  let curLat = depotLat
  let curLng = depotLng
  let transitKm    = 0
  let transitHours = 0
  let workHours    = 0

  for (let i = 0; i < interventions.length; i++) {
    const iv = interventions[i]

    if (!iv.lat || !iv.lng) {
      violations.push({ type: 'no_coords', intervention: iv.id || iv.addr || i, message: 'Coordonnées manquantes' })
      continue
    }

    const toIv  = roadDist(curLat, curLng, iv.lat, iv.lng)
    const travelH = travelHours(toIv, R.AVG_SPEED_KMH)
    const durH  = iv.durationH || R.DEFAULT_DURATION_H

    // Distance au dépôt (hors zone ?)
    const distFromDepot = haversine(depotLat, depotLng, iv.lat, iv.lng)
    if (distFromDepot > R.MAX_RADIUS_KM) {
      warnings.push({
        type:          'out_of_zone',
        intervention:  iv.id || iv.addr || i,
        distFromDepot: Math.round(distFromDepot),
        message:       `Intervention à ${Math.round(distFromDepot)}km du dépôt (limite ${R.MAX_RADIUS_KM}km)`
      })
    }

    transitKm    += toIv
    transitHours += travelH
    workHours    += durH
    curLat = iv.lat
    curLng = iv.lng

    segments.push({
      order:    i + 1,
      id:       iv.id || iv.addr || i,
      addr:     iv.addr,
      distFromPrev: Math.round(toIv),
      travelMin:    Math.round(travelH * 60),
      durationMin:  Math.round(durH * 60),
      cumKm:    Math.round(transitKm),
      cumHours: Math.round((transitHours + workHours) * 10) / 10
    })
  }

  // Retour au dépôt
  const retourKm = interventions.length > 0
    ? roadDist(curLat, curLng, depotLat, depotLng)
    : 0
  const retourH  = travelHours(retourKm, R.AVG_SPEED_KMH)

  const totalKm    = Math.round(transitKm + retourKm)
  const totalTransitH = Math.round((transitHours + retourH) * 10) / 10
  const totalH        = Math.round((transitHours + retourH + workHours) * 10) / 10

  // ── Violations des contraintes dures ──────────────────────────

  if (totalKm > R.MAX_DAY_KM) {
    violations.push({
      type:    'max_km_exceeded',
      value:   totalKm,
      limit:   R.MAX_DAY_KM,
      message: `${totalKm}km > limite ${R.MAX_DAY_KM}km/jour`
    })
  }

  if (totalTransitH > R.MAX_TRANSIT_HOURS) {
    violations.push({
      type:    'max_transit_exceeded',
      value:   totalTransitH,
      limit:   R.MAX_TRANSIT_HOURS,
      message: `${totalTransitH}h de trajet > limite ${R.MAX_TRANSIT_HOURS}h`
    })
  }

  if (totalH > R.MAX_TOTAL_HOURS) {
    violations.push({
      type:    'max_hours_exceeded',
      value:   totalH,
      limit:   R.MAX_TOTAL_HOURS,
      message: `${totalH}h totales > limite ${R.MAX_TOTAL_HOURS}h`
    })
  }

  // ── Alertes (contraintes souples) ─────────────────────────────

  // Découcher : dernière intervention trop loin du dépôt pour rentrer le soir
  if (interventions.length > 0) {
    const last = interventions[interventions.length - 1]
    if (last.lat && last.lng) {
      const lastDist = haversine(depotLat, depotLng, last.lat, last.lng)
      if (lastDist > R.OVERNIGHT_KM) {
        warnings.push({
          type:    'overnight_required',
          dist:    Math.round(lastDist),
          message: `Dernier arrêt à ${Math.round(lastDist)}km du dépôt — découcher probable`
        })
      }
    }
  }

  // Journée chargée (>85% de la limite)
  if (totalH > R.MAX_TOTAL_HOURS * 0.85 && totalH <= R.MAX_TOTAL_HOURS) {
    warnings.push({
      type:    'heavy_day',
      value:   totalH,
      message: `Journée chargée : ${totalH}h/${R.MAX_TOTAL_HOURS}h`
    })
  }

  return {
    feasible:   violations.length === 0,
    violations,
    warnings,
    metrics: {
      interventions: interventions.length,
      totalKm,
      transitKm:    Math.round(transitKm + retourKm),
      workKm:       Math.round(transitKm),
      retourKm:     Math.round(retourKm),
      totalHours:   totalH,
      transitHours: totalTransitH,
      workHours:    Math.round(workHours * 10) / 10
    },
    segments
  }
}

/**
 * Valide plusieurs journées (tableau de DayCluster ou de tableaux d'interventions).
 * @param {Array}  days    — chaque élément peut être { interventions: [] } ou []
 * @param {Object} options
 * @returns {DayValidation[]}
 */
function validateDays(days, options = {}) {
  return days.map((day, i) => {
    const ivs    = Array.isArray(day) ? day : (day.interventions || [])
    const result = validateDay(ivs, options)
    return { day: i + 1, ...result }
  })
}

// ── Exports ───────────────────────────────────────────────────
module.exports = { validateDay, validateDays, RULES }

// ── Handler HTTP ──────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) }

  let body
  try { body = JSON.parse(event.body || '{}') }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) } }

  const { interventions, days, depotLat, depotLng, rules } = body
  const options = { depotLat, depotLng, rules }

  try {
    if (Array.isArray(days)) {
      // Mode multi-journées
      const results = validateDays(days, options)
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ days: results }) }
    }
    if (Array.isArray(interventions)) {
      // Mode journée unique
      const result = validateDay(interventions, options)
      return { statusCode: 200, headers: CORS, body: JSON.stringify(result) }
    }
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '"interventions" ou "days" requis' }) }
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) }
  }
}
