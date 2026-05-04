// netlify/functions/agent-planning.js
// Orchestrateur de planning : pipeline complet geocode→cluster→validate→plan
// + Groq pour l'analyse des alertes et alternatives, écriture dans Notion
// Étape 5 (finale) du pipeline

const { geocodeAndCluster, DEPOT }          = require('./cluster')
const { validateDays }                       = require('./validate-day')
const { planDay, planDays, toNotionDatetime } = require('./plan-day')

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

const NOTION_API = 'https://api.notion.com/v1'

// ── Helpers Notion ────────────────────────────────────────────

async function notionPatch(pageId, properties, token) {
  const r = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method:  'PATCH',
    headers: {
      Authorization:    `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type':   'application/json'
    },
    body: JSON.stringify({ properties }),
    signal: AbortSignal.timeout(8000)
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`Notion PATCH ${pageId}: ${r.status} ${txt.slice(0, 200)}`)
  }
  return r.json()
}

async function queryNotionDB(dbId, filter, token) {
  const r = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
    method:  'POST',
    headers: {
      Authorization:    `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type':   'application/json'
    },
    body:   JSON.stringify(filter ? { filter } : {}),
    signal: AbortSignal.timeout(10000)
  })
  if (!r.ok) throw new Error(`Notion query ${dbId}: ${r.status}`)
  const d = await r.json()
  return d.results || []
}

// ── Helpers Notion : écriture des résultats ───────────────────

async function writePlannedTime(notionId, date, time, token) {
  if (!notionId || !date || !time) return
  const dt = toNotionDatetime(date, time)
  await notionPatch(notionId, { 'Date intervention': { date: { start: dt } } }, token)
}

async function writeTechAssignment(notionId, techName, token) {
  if (!notionId || !techName) return
  await notionPatch(notionId, { 'Commercial ': { select: { name: techName } } }, token)
}

// ── Analyse Groq ──────────────────────────────────────────────

async function groqAnalyze(prompt) {
  const key = process.env.GROQ_API_KEY || process.env.GROQ
  if (!key) return null

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:  'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:       'llama-3.3-70b-versatile',
      temperature: 0.2,
      max_tokens:  1200,
      messages:    [{ role: 'user', content: prompt }]
    }),
    signal: AbortSignal.timeout(20000)
  }).catch(() => null)

  if (!r?.ok) return null
  const d = await r.json().catch(() => null)
  return d?.choices?.[0]?.message?.content || null
}

// ── Pipeline principal ─────────────────────────────────────────

/**
 * Pipeline complet pour un technicien sur une plage de dates.
 *
 * @param {Object} params
 *   - techName         string   — nom du technicien
 *   - interventions    Object[] — interventions à planifier (avec addr, notionId, durationH?)
 *   - dates            string[] — ['2024-01-15', '2024-01-16', ...] jours disponibles
 *   - notionToken      string
 *   - writeToNotion    bool     — écrire les résultats dans Notion (défaut: true)
 * @returns {PlanningResult}
 */
async function runPlanningPipeline(params) {
  const {
    techName,
    interventions  = [],
    dates          = [],
    notionToken,
    writeToNotion  = true,
    depotLat       = DEPOT.lat,
    depotLng       = DEPOT.lng
  } = params

  const log = []

  // ── ÉTAPE 1 : Géocodage + clustering géographique ─────────────
  log.push(`[geocode+cluster] ${interventions.length} interventions pour ${techName}`)
  const { inZoneDays, outOfZone, stats: geoStats } = await geocodeAndCluster(interventions, { depotLat, depotLng })
  log.push(`[geocode+cluster] ${geoStats.geocoded} géocodées, ${geoStats.inZone} en zone, ${geoStats.outOfZone} hors zone, ${geoStats.daysNeeded} journées`)

  // ── ÉTAPE 2 : Assignation des clusters aux dates disponibles ───
  const assignedDays = []
  for (let i = 0; i < inZoneDays.length; i++) {
    const date = dates[i] || null
    assignedDays.push({ ...inZoneDays[i], date })
  }

  // ── ÉTAPE 3 : Ordonnancement nearest-neighbor par journée ─────
  const plannedDays = planDays(assignedDays, { depotLat, depotLng })

  // ── ÉTAPE 4 : Validation de chaque journée ────────────────────
  const validations = validateDays(
    plannedDays.map(d => d.ordered),
    { depotLat, depotLng }
  )

  // Compile alertes
  const alerts = []
  for (let i = 0; i < plannedDays.length; i++) {
    const v = validations[i]
    if (!v.feasible) {
      alerts.push({
        day:        i + 1,
        date:       plannedDays[i].date,
        violations: v.violations,
        warnings:   v.warnings
      })
    } else if (v.warnings.length > 0) {
      alerts.push({ day: i + 1, date: plannedDays[i].date, warnings: v.warnings })
    }
  }

  if (outOfZone.length > 0) {
    alerts.push({ type: 'out_of_zone', count: outOfZone.length, interventions: outOfZone.map(iv => iv.addr || iv.id) })
  }

  if (geoStats.notFound.length > 0) {
    alerts.push({ type: 'geocode_failed', count: geoStats.notFound.length, addresses: geoStats.notFound })
  }

  // ── ÉTAPE 5 : Analyse Groq si des alertes existent ────────────
  let groqAnalysis = null
  if (alerts.length > 0) {
    const prompt = buildAnalysisPrompt(techName, plannedDays, alerts, outOfZone)
    groqAnalysis = await groqAnalyze(prompt)
    log.push(`[groq] analyse des alertes : ${groqAnalysis ? 'OK' : 'non disponible'}`)
  }

  // ── ÉTAPE 6 : Écriture dans Notion ────────────────────────────
  const notionWrites = { success: 0, errors: [] }
  if (writeToNotion && notionToken) {
    for (const day of plannedDays) {
      if (!day.date) continue
      for (const stop of day.route) {
        if (stop.id === 'depot_return') continue
        try {
          await writePlannedTime(stop.id, day.date, stop.startAt, notionToken)
          if (techName) await writeTechAssignment(stop.id, techName, notionToken)
          notionWrites.success++
        } catch (err) {
          notionWrites.errors.push({ id: stop.id, error: err.message })
        }
      }
    }
    log.push(`[notion] ${notionWrites.success} écritures, ${notionWrites.errors.length} erreurs`)
  }

  return {
    techName,
    plannedDays,
    outOfZone,
    alerts,
    groqAnalysis,
    notionWrites: writeToNotion ? notionWrites : null,
    stats: {
      ...geoStats,
      totalInterventions: interventions.length,
      planned:            plannedDays.reduce((s, d) => s + d.ordered.length, 0),
      daysPlanned:        plannedDays.length,
      datesNeeded:        Math.max(0, plannedDays.length - dates.length),
      alertCount:         alerts.length
    },
    log
  }
}

function buildAnalysisPrompt(techName, plannedDays, alerts, outOfZone) {
  const daysSummary = plannedDays.map((d, i) => {
    const m = d.metrics
    return `Jour ${i + 1} (${d.date || 'sans date'}) : ${d.ordered.length} interventions, ${m.totalKm}km, ${m.totalHours}h`
  }).join('\n')

  const alertsSummary = alerts.map(a => {
    if (a.violations) return `VIOLATION J${a.day}: ${a.violations.map(v => v.message).join('; ')}`
    if (a.warnings)   return `ALERTE J${a.day}: ${a.warnings.map(w => w.message).join('; ')}`
    if (a.type === 'out_of_zone') return `${a.count} interventions hors zone 150km`
    if (a.type === 'geocode_failed') return `${a.count} adresses non géocodées`
    return JSON.stringify(a)
  }).join('\n')

  return `Tu es un expert en planification de tournées techniciens DEA (appareils médicaux à domicile).

Technicien : ${techName}
Dépôt : Vernouillet (28)

Planning généré :
${daysSummary}

Alertes détectées :
${alertsSummary}

${outOfZone.length > 0 ? `Interventions hors zone (>150km du dépôt) : ${outOfZone.map(iv => iv.addr).join(', ')}` : ''}

En 3-5 phrases courtes, donne :
1. Une évaluation de la faisabilité globale du planning
2. Les principaux problèmes à résoudre (si violations)
3. Des suggestions concrètes (réassigner certaines interventions, reporter, découcher)
Réponds en français, de façon concise et actionnable.`
}

// ── Handler HTTP ──────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) }

  let body
  try { body = JSON.parse(event.body || '{}') }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) } }

  const {
    techName,
    interventions,
    dates,
    writeToNotion = true
  } = body

  if (!Array.isArray(interventions) || interventions.length === 0)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '"interventions" array requis' }) }

  const notionToken = process.env.NOTION_TOKEN

  try {
    const result = await runPlanningPipeline({
      techName,
      interventions,
      dates:       Array.isArray(dates) ? dates : [],
      notionToken,
      writeToNotion: writeToNotion && !!notionToken
    })
    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) }
  } catch (err) {
    console.error('[agent-planning]', err)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) }
  }
}
