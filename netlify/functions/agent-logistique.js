// netlify/functions/agent-logistique.js
// Port JS de agents/logistique.py (PlanningOS → OptiQ)
// Vérifie la faisabilité géographique des journées techniciens
// Anomalies : TRAJET_IMPOSSIBLE (error) · KM_EXCESSIF (warn)
// Si anomalies → appelle Groq llama-3.3-70b pour suggestions redistribution

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

// ── Paramètres PlanningOS (settings.py) ───────────────────────
const VITESSE_MAX_KMH   = 110
const KM_JOURNALIER_MAX = 600
const PAUSE_APRES_H     = 4.5    // pause obligatoire après 4h30 de travail continu
const PAUSE_DUREE_MIN   = 30     // durée pause minimum (minutes)
const KM_EXCESSIF_SEUIL = 480    // 80 % du max → warning
const ROAD_FACTOR       = 1.4    // vol d'oiseau → route
const DEPOT             = { lat: 48.965, lng: 1.967, name: 'Vernouillet' }

const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions'
const getGroqKey = () => process.env.GROQ_API_KEY || process.env.GROQ

// ── Géométrie haversine ───────────────────────────────────────

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

// Temps minimum théorique (à VITESSE_MAX) et réaliste (à 60 km/h moyen)
function travelTimeMin(distKm) {
  return (distKm / VITESSE_MAX_KMH) * 60
}

// ── Analyse d'une journée pour un technicien ──────────────────

/**
 * @param {Object[]} interventions  — ordonnées avec lat/lng/durationH
 * @param {string}   tech           — nom du technicien
 * @param {string}   date           — date YYYY-MM-DD
 * @param {Object}   opts           — { depotLat, depotLng }
 */
function analyzeDay(interventions, tech = '?', date = '?', opts = {}) {
  const depotLat = opts.depotLat || DEPOT.lat
  const depotLng = opts.depotLng || DEPOT.lng

  const anomalies = []
  const segments  = []

  let curLat      = depotLat
  let curLng      = depotLng
  let kmTotal     = 0
  let workHours   = 0
  let contWorkH   = 0  // travail continu sans pause

  for (let i = 0; i < interventions.length; i++) {
    const iv = interventions[i]
    if (!iv.lat || !iv.lng) {
      anomalies.push({
        type:     'COORDS_MANQUANTES',
        severity: 'warn',
        id:       iv.id || iv.addr || i,
        tech, date,
        message:  `Coordonnées manquantes pour "${iv.addr || iv.id}"`,
        suggestion: 'Géocoder l\'adresse avant le traitement logistique'
      })
      continue
    }

    const dist   = roadDist(curLat, curLng, iv.lat, iv.lng)
    const durH   = iv.durationH || 0.33  // 20 min par défaut
    kmTotal     += dist
    workHours   += durH
    contWorkH   += durH

    // Pause obligatoire si travail continu > 4h30
    if (contWorkH >= PAUSE_APRES_H) {
      workHours += PAUSE_DUREE_MIN / 60
      contWorkH  = 0
    }

    segments.push({
      order:       i + 1,
      id:          iv.id || i,
      addr:        iv.addr,
      distFromPrev: Math.round(dist),
      kmCumul:     Math.round(kmTotal)
    })

    curLat = iv.lat
    curLng = iv.lng
  }

  // Retour dépôt
  const retourKm  = interventions.length > 0
    ? roadDist(curLat, curLng, depotLat, depotLng) : 0
  kmTotal        += retourKm
  const kmRound   = Math.round(kmTotal)

  // ── Anomalie TRAJET_IMPOSSIBLE ──
  if (kmRound > KM_JOURNALIER_MAX) {
    anomalies.push({
      type:       'TRAJET_IMPOSSIBLE',
      severity:   'error',
      tech, date,
      km:         kmRound,
      limite:     KM_JOURNALIER_MAX,
      message:    `${tech} — ${date} : ${kmRound} km dépassent la limite journalière (${KM_JOURNALIER_MAX} km)`,
      suggestion: null  // rempli par Groq
    })
  }
  // ── Anomalie KM_EXCESSIF ──
  else if (kmRound > KM_EXCESSIF_SEUIL) {
    anomalies.push({
      type:       'KM_EXCESSIF',
      severity:   'warn',
      tech, date,
      km:         kmRound,
      seuil:      KM_EXCESSIF_SEUIL,
      message:    `${tech} — ${date} : ${kmRound} km (seuil d'alerte ${KM_EXCESSIF_SEUIL} km)`,
      suggestion: null  // rempli par Groq
    })
  }

  // ── Découcher probable ──
  const lastIv = interventions[interventions.length - 1]
  if (lastIv?.lat && lastIv?.lng) {
    const distRetour = haversine(depotLat, depotLng, lastIv.lat, lastIv.lng)
    if (distRetour > 200) {
      anomalies.push({
        type:       'DECOUCH_PROBABLE',
        severity:   'warn',
        tech, date,
        distRetour: Math.round(distRetour),
        message:    `Dernier arrêt à ${Math.round(distRetour)} km du dépôt — découcher probable`,
        suggestion: null
      })
    }
  }

  return {
    tech, date,
    feasible:   anomalies.filter(a => a.severity === 'error').length === 0,
    kmTotal:    kmRound,
    workHours:  Math.round(workHours * 10) / 10,
    anomalies,
    segments
  }
}

// ── Suggestions Groq ──────────────────────────────────────────

async function enrichWithGroq(dayResults) {
  const key = getGroqKey()
  if (!key) return dayResults  // pas de clé → on skip sans planter

  const anomaliesAvecSuggestions = dayResults
    .flatMap(d => d.anomalies)
    .filter(a => a.suggestion === null && ['TRAJET_IMPOSSIBLE', 'KM_EXCESSIF'].includes(a.type))

  if (anomaliesAvecSuggestions.length === 0) return dayResults

  const prompt = `Tu es expert en planification logistique pour techniciens de terrain.
Voici des anomalies détectées dans un planning d'interventions :
${JSON.stringify(anomaliesAvecSuggestions.map(a => ({ type: a.type, tech: a.tech, date: a.date, km: a.km, message: a.message })), null, 2)}

Pour chaque anomalie, propose UNE suggestion concrète courte (max 120 caractères) :
- TRAJET_IMPOSSIBLE → décalage RDV, réaffectation technicien plus proche, ou découpage sur 2 jours
- KM_EXCESSIF → redistribution sur autre technicien ou jour adjacent

Réponds UNIQUEMENT avec un JSON : [{ "index": 0, "suggestion": "..." }, ...]`

  try {
    const r = await fetch(GROQ_BASE, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile', temperature: 0.2, max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      })
    })
    const d    = await r.json()
    const text = d.choices?.[0]?.message?.content || ''
    const s    = text.replace(/```json\n?|```\n?/g, '').trim()
    const a    = s.indexOf('['), b = s.lastIndexOf(']')
    if (a < 0 || b < 0) return dayResults
    const suggestions = JSON.parse(s.slice(a, b + 1))

    suggestions.forEach(({ index, suggestion }) => {
      if (anomaliesAvecSuggestions[index]) anomaliesAvecSuggestions[index].suggestion = suggestion
    })
  } catch {}  // Groq optionnel — on ne bloque pas le pipeline

  return dayResults
}

// ── Analyse d'un batch de journées ───────────────────────────

async function analyzeBatch(days, useGroq = true) {
  const t0      = Date.now()
  let results   = days.map(d => analyzeDay(
    d.interventions || [],
    d.tech,
    d.date,
    { depotLat: d.depotLat, depotLng: d.depotLng }
  ))

  if (useGroq) results = await enrichWithGroq(results)

  const totalAnomalies = results.flatMap(r => r.anomalies)

  return {
    processed:  results.length,
    feasible:   results.filter(r => r.feasible).length,
    anomalies:  totalAnomalies.length,
    errors:     totalAnomalies.filter(a => a.severity === 'error').length,
    warnings:   totalAnomalies.filter(a => a.severity === 'warn').length,
    durationMs: Date.now() - t0,
    days: results
  }
}

module.exports = { analyzeDay, analyzeBatch, haversine, roadDist, DEPOT, VITESSE_MAX_KMH, KM_JOURNALIER_MAX }

// ── Handler HTTP ──────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) }

  let body
  try { body = JSON.parse(event.body || '{}') }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) } }

  const { day, days, useGroq = true } = body

  try {
    if (Array.isArray(days)) {
      const result = await analyzeBatch(days, useGroq)
      return { statusCode: 200, headers: CORS, body: JSON.stringify(result) }
    }
    if (day && Array.isArray(day.interventions)) {
      const result = await analyzeDay(day.interventions, day.tech, day.date, day)
      return { statusCode: 200, headers: CORS, body: JSON.stringify(result) }
    }
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '"day" ou "days" requis' }) }
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) }
  }
}
