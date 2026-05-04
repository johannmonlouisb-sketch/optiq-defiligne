// netlify/functions/agent-optimiseur-vroom.js
// Optimisation VRP multi-techniciens via Vroom (solveur open-source)
// Remplace nearest-neighbour par un vrai solveur TSP/VRP
// Fallback automatique vers NN si l'API Vroom est indisponible

const { nearestNeighbour, tourKm } = require('./agent-optimiseur')

// ── Config (variables d'env Netlify) ─────────────────────────
const VROOM_URL      = () => process.env.VROOM_API_URL  || 'https://solver.vroom-project.org'
const DEPOT_LAT      = () => parseFloat(process.env.DEPOT_LAT) || 48.965
const DEPOT_LNG      = () => parseFloat(process.env.DEPOT_LON || process.env.DEPOT_LNG) || 1.967
const GROQ_BASE      = 'https://api.groq.com/openai/v1/chat/completions'
const getGroqKey     = () => process.env.GROQ_API_KEY || process.env.GROQ

// Timeouts
const VROOM_TIMEOUT_MS = 22000  // 22 s — laisse 4 s de marge sur la limite Netlify Pro (26 s)
const MAX_JOBS_PER_REQ = 140    // limite publique solver.vroom-project.org

// Horaires journée (secondes depuis minuit)
const SHIFT_START_S = 8  * 3600   // 08:00
const SHIFT_END_S   = 18 * 3600   // 18:00
const MAX_TRAVEL_S  = 8  * 3600   // 8 h de trajet max
const OVERNIGHT_S   = 10 * 3600   // > 10 h totales → découcher

// Durée par type d'intervention (secondes)
const SERVICE_S = {
  maintenance:         20 * 60,
  maintenance_simple:  20 * 60,
  maintenance_complex: 30 * 60,
  'maintenance pad':   30 * 60,
  installation:        40 * 60,
  default:             25 * 60
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

// ── Utilitaires ────────────────────────────────────────────────

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, toR = Math.PI / 180
  const dLat = (lat2 - lat1) * toR, dLng = (lng2 - lng1) * toR
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function serviceSeconds(type) {
  const t = (type || '').toLowerCase().trim()
  for (const [key, s] of Object.entries(SERVICE_S)) {
    if (t.includes(key)) return s
  }
  return SERVICE_S.default
}

function nextDay(dateStr) {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

// ── Construction payload Vroom (une journée, N techniciens) ───

/**
 * @param {Array}  groups     — [{ vehicleId, tech, date, interventions, shiftStartS, shiftEndS }]
 * @param {number} depotLat
 * @param {number} depotLng
 * @returns {{ vehicles, jobs, jobIdToIv, withoutCoords }}
 */
function buildDayPayload(groups, depotLat, depotLng) {
  const jobIdToIv    = {}   // jobId (int) → intervention
  const withoutCoords = []  // interventions sans coordonnées
  let   jobCounter   = 1

  const vehicles = groups.map(g => ({
    id:           g.vehicleId,
    profile:      'car',
    start:        [depotLng, depotLat],   // Vroom : [lng, lat]
    end:          [depotLng, depotLat],
    time_window:  [g.shiftStartS ?? SHIFT_START_S, g.shiftEndS ?? SHIFT_END_S],
    max_travel_time: MAX_TRAVEL_S
  }))

  const jobs = []
  for (const g of groups) {
    for (const iv of (g.interventions || [])) {
      if (!iv.lat || !iv.lng) { withoutCoords.push(iv); continue }
      const jid = jobCounter++
      jobIdToIv[jid] = iv
      jobs.push({
        id:       jid,
        location: [iv.lng, iv.lat],       // Vroom : [lng, lat]
        service:  serviceSeconds(iv.type),
        priority: iv.urgent ? 100 : 0
      })
    }
  }

  return { vehicles, jobs, jobIdToIv, withoutCoords }
}

// ── Appel API Vroom avec timeout ───────────────────────────────

async function callVroom(payload) {
  const url        = VROOM_URL()
  const controller = new AbortController()
  const timer      = setTimeout(() => controller.abort(), VROOM_TIMEOUT_MS)

  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  controller.signal
    })
    clearTimeout(timer)
    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      throw new Error(`Vroom HTTP ${r.status}: ${txt.slice(0, 200)}`)
    }
    const data = await r.json()
    if (data.code !== 0) throw new Error(`Vroom solver code ${data.code}: ${data.error || '?'}`)
    return data
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// ── Parsing réponse Vroom → format OptiQ ──────────────────────

function parseVroomResult(vroomData, jobIdToIv, vehicleIdToGroup) {
  const routes     = []
  const unassigned = []

  for (const route of (vroomData.routes || [])) {
    const group   = vehicleIdToGroup[route.vehicle] || {}
    const ordered = []

    for (const step of (route.steps || [])) {
      if (step.type === 'job') {
        const iv = jobIdToIv[step.id]
        if (iv) ordered.push({
          ...iv,
          vroomArrival:   step.arrival || 0,
          vroomWaiting:   step.waiting_time || 0,
          vroomDeparture: (step.arrival || 0) + (step.service || 0)
        })
      }
    }

    routes.push({
      vehicleId:      route.vehicle,
      tech:           group.tech,
      date:           group.date,
      interventions:  ordered,
      kmTotal:        Math.round((route.distance || 0) / 1000),
      durationS:      route.duration || 0,
      waitingS:       route.waiting_time || 0,
      needsOvernight: (route.duration || 0) > OVERNIGHT_S
    })
  }

  for (const u of (vroomData.unassigned || [])) {
    const iv = jobIdToIv[u.id]
    if (iv) unassigned.push({ ...iv, reason: 'NON_ASSIGNABLE' })
  }

  return { routes, unassigned, summary: vroomData.summary || {} }
}

// ── Groq : point de coupure J1/J2 pour découcher ─────────────

async function groqOvernightCut(route) {
  const key = getGroqKey()
  const mid = Math.floor(route.interventions.length / 2)

  if (!key) return { cutAfterIndex: mid, reason: 'Coupure médiane (Groq absent)' }

  const ivList = route.interventions.map((iv, i) => ({
    index: i,
    client: iv.client || '—',
    lat: Math.round(iv.lat * 1000) / 1000,
    lng: Math.round(iv.lng * 1000) / 1000,
    heure: iv.vroomArrival ? (iv.vroomArrival / 3600).toFixed(1) + 'h' : '?'
  }))

  const prompt = `Technicien ${route.tech} le ${route.date} : tournée trop longue (${(route.durationS / 3600).toFixed(1)} h > 10 h max).

Interventions ordonnées par Vroom :
${JSON.stringify(ivList, null, 2)}

Dépôt retour : lat ${DEPOT_LAT()}, lng ${DEPOT_LNG()}.

Trouve la coupure J1/J2 géographiquement optimale (minimiser les retours à vide).
Réponds uniquement JSON : { "cutAfterIndex": <int 0..${route.interventions.length - 2}>, "reason": "<max 100 car>" }`

  try {
    const r = await fetch(GROQ_BASE, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile', temperature: 0.1, max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    })
    const d    = await r.json()
    const text = d.choices?.[0]?.message?.content || ''
    const s    = text.replace(/```json\n?|```\n?/g, '').trim()
    const a    = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a >= 0 && b >= 0) {
      const p = JSON.parse(s.slice(a, b + 1))
      const cut = Math.max(0, Math.min(route.interventions.length - 2, parseInt(p.cutAfterIndex) || mid))
      return { cutAfterIndex: cut, reason: p.reason || '' }
    }
  } catch {}

  return { cutAfterIndex: mid, reason: 'Coupure médiane (Groq fallback)' }
}

// ── Re-optimisation J2 à partir du "point hôtel" ──────────────

async function reoptimizeJ2(j2Ivs, hotelLat, hotelLng, depotLat, depotLng) {
  if (!j2Ivs.length) return j2Ivs
  const eligible = j2Ivs.filter(iv => iv.lat && iv.lng)
  if (eligible.length === 0) return j2Ivs

  try {
    const localMap = {}
    let   counter  = 1
    const j2Jobs   = eligible.map(iv => {
      const id = counter++
      localMap[id] = iv
      return { id, location: [iv.lng, iv.lat], service: serviceSeconds(iv.type) }
    })

    const payload = {
      vehicles: [{
        id: 1, profile: 'car',
        start: [hotelLng, hotelLat],  // départ depuis hôtel
        end:   [depotLng, depotLat],  // retour dépôt J2
        time_window: [SHIFT_START_S, SHIFT_END_S],
        max_travel_time: MAX_TRAVEL_S
      }],
      jobs: j2Jobs
    }
    const vr   = await callVroom(payload)
    const steps = vr.routes?.[0]?.steps || []
    const reordered = steps
      .filter(s => s.type === 'job')
      .map(s => localMap[s.id])
      .filter(Boolean)

    return reordered.length === eligible.length
      ? reordered
      : eligible   // si mapping incomplet → garder l'ordre Vroom initial
  } catch {
    return j2Ivs   // si Vroom échoue → ordre Groq
  }
}

// ── Calcul km original (pour comparaison NN) ──────────────────

function originalKm(group, depotLat, depotLng) {
  const ivs = (group.interventions || []).filter(iv => iv.lat && iv.lng)
  return tourKm(ivs, depotLat, depotLng)
}

// ── Optimisation principale ────────────────────────────────────

/**
 * Interface identique à optimizeBatch() de agent-optimiseur.js,
 * enrichi avec : unassigned[], overnight[], solver par journée.
 *
 * @param {Array} days  — [{ tech, date, interventions[], depotLat?, depotLng? }]
 */
async function optimizeWithVroom(days) {
  const t0       = Date.now()
  const depotLat = DEPOT_LAT()
  const depotLng = DEPOT_LNG()

  // ── Groupement par date ──
  const byDate = new Map()
  for (const d of (days || [])) {
    const date = (d.date || 'unknown').slice(0, 10)
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date).push(d)
  }

  const allDayResults  = []   // mêmes champs que optimizeBatch().days
  const allUnassigned  = []   // interventions non assignables
  const allOvernight   = []   // décisions découcher J1/J2
  let   totalKmSaved   = 0
  let   totalKmOriginal = 0

  for (const [date, dayGroups] of byDate) {
    // Numérotation des véhicules pour cette journée
    let   vehicleCounter = 1
    const vehicleIdToGroup = {}
    const groups = dayGroups.map(g => {
      const id  = vehicleCounter++
      const grp = { vehicleId: id, tech: g.tech, date, interventions: g.interventions,
                    shiftStartS: g.shiftStartS, shiftEndS: g.shiftEndS }
      vehicleIdToGroup[id] = grp
      return grp
    })

    // Km "brut" avant optimisation (pour calcul d'économies)
    const kmOrigByVehicle = {}
    for (const g of groups) {
      kmOrigByVehicle[g.vehicleId] = originalKm(g, depotLat, depotLng)
    }

    const { vehicles, jobs, jobIdToIv, withoutCoords } = buildDayPayload(groups, depotLat, depotLng)

    // ── Cas : aucun job géocodé ──
    if (jobs.length === 0) {
      for (const g of groups) {
        allDayResults.push({
          tech: g.tech, date, solver: 'no-geocode',
          interventions: [...withoutCoords],
          kmOriginal: 0, kmOptimise: 0, kmEconomies: 0, gainPct: 0
        })
      }
      continue
    }

    // ── Décision : Vroom ou fallback NN ──
    let vroomData      = null
    let fallbackReason = null

    if (jobs.length > MAX_JOBS_PER_REQ) {
      fallbackReason = `${jobs.length} jobs > limite publique Vroom (${MAX_JOBS_PER_REQ})`
    } else {
      try {
        vroomData = await callVroom({ vehicles, jobs })
      } catch (e) {
        fallbackReason = `API Vroom indisponible : ${e.message.slice(0, 120)}`
      }
    }

    // ── Fallback nearest-neighbour ──
    if (!vroomData) {
      for (const g of groups) {
        const res = nearestNeighbour(g.interventions, depotLat, depotLng)
        const kmOrig = kmOrigByVehicle[g.vehicleId]
        totalKmSaved    += res.kmEconomies
        totalKmOriginal += kmOrig
        allDayResults.push({
          tech:    g.tech, date, solver: 'nearest-neighbour',
          fallbackReason,
          interventions: res.ordered,
          kmOriginal:    kmOrig,
          kmOptimise:    res.kmOptimise,
          kmEconomies:   res.kmEconomies,
          gainPct:       res.gainPct
        })
      }
      continue
    }

    // ── Traitement réponse Vroom ──
    const parsed = parseVroomResult(vroomData, jobIdToIv, vehicleIdToGroup)
    allUnassigned.push(...parsed.unassigned)

    for (const route of parsed.routes) {
      let finalOrderedIvs = [...route.interventions]
      let planningJ1 = null
      let planningJ2 = null

      // ── Découcher : route trop longue ──
      if (route.needsOvernight && finalOrderedIvs.length >= 2) {
        const cut  = await groqOvernightCut(route)
        const idx  = cut.cutAfterIndex
        const j1   = finalOrderedIvs.slice(0, idx + 1)
        const j2   = finalOrderedIvs.slice(idx + 1)

        // Re-optimise J2 depuis le point hôtel (= dernier arrêt J1)
        const hotel = j1[j1.length - 1]
        const j2Opt = j2.length > 1 ? await reoptimizeJ2(j2, hotel.lat, hotel.lng, depotLat, depotLng) : j2

        planningJ1 = j1
        planningJ2 = j2Opt
        finalOrderedIvs = [...j1, ...j2Opt]  // conservé pour le champ interventions

        allOvernight.push({
          tech:        route.tech,
          date,
          dateJ2:      nextDay(date),
          durationH:   Math.round(route.durationS / 360) / 10,
          planningJ1:  j1.map(iv => iv.notionId || iv.id),
          planningJ2:  j2Opt.map(iv => iv.notionId || iv.id),
          hotelApprox: hotel ? `${hotel.lat.toFixed(4)}, ${hotel.lng.toFixed(4)}` : null,
          cutReason:   cut.reason,
          kmJ1:        Math.round(
            (haversine(depotLat, depotLng, j1[0].lat, j1[0].lng) +
             j1.reduce((s, iv, i) => i ? s + haversine(j1[i-1].lat, j1[i-1].lng, iv.lat, iv.lng) : s, 0)) * 1.4
          ),
          kmJ2: Math.round(
            (j2Opt.reduce((s, iv, i) => i ? s + haversine(j2Opt[i-1].lat, j2Opt[i-1].lng, iv.lat, iv.lng) : s, 0) +
             haversine(j2Opt[j2Opt.length - 1]?.lat || depotLat, j2Opt[j2Opt.length - 1]?.lng || depotLng, depotLat, depotLng)) * 1.4
          )
        })
      }

      // Réintégrer les non-géocodées à la fin
      const withoutForTech = withoutCoords.filter(iv => {
        const g = vehicleIdToGroup[route.vehicleId]
        return g?.interventions.some(giv => (giv.id || giv.notionId) === (iv.id || iv.notionId))
      })

      const kmOrig = kmOrigByVehicle[route.vehicleId] || 0
      const kmOpt  = route.kmTotal
      const saved  = Math.max(0, kmOrig - kmOpt)
      totalKmSaved    += saved
      totalKmOriginal += kmOrig

      allDayResults.push({
        tech:           route.tech,
        date,
        solver:         'vroom',
        interventions:  [...finalOrderedIvs, ...withoutForTech],
        kmOriginal:     kmOrig,
        kmOptimise:     kmOpt,
        kmEconomies:    saved,
        gainPct:        kmOrig > 0 ? Math.round(saved / kmOrig * 100) : 0,
        durationS:      route.durationS,
        needsOvernight: route.needsOvernight,
        planningJ1,
        planningJ2
      })
    }
  }

  return {
    processed:   allDayResults.length,
    kmSaved:     totalKmSaved,
    kmOrigTotal: totalKmOriginal,
    gainPct:     totalKmOriginal > 0 ? Math.round(totalKmSaved / totalKmOriginal * 100) : 0,
    durationMs:  Date.now() - t0,
    solver:      'vroom',
    days:        allDayResults,
    unassigned:  allUnassigned,
    overnight:   allOvernight
  }
}

module.exports = { optimizeWithVroom, callVroom, buildDayPayload, parseVroomResult }

// ── Handler HTTP ──────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) }

  let body
  try { body = JSON.parse(event.body || '{}') }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) } }

  const { days, day } = body
  const input = Array.isArray(days) ? days : (day ? [day] : null)
  if (!input)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '"days" (array) requis' }) }

  try {
    const result = await optimizeWithVroom(input)
    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) }
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) }
  }
}
