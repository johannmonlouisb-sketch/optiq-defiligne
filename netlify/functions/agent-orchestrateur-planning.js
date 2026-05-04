// netlify/functions/agent-orchestrateur-planning.js
// Port JS de agents/orchestrateur.py (PlanningOS → OptiQ)
// Pipeline : Notion → Géocodage → Validation → Optimisation → Logistique → Groq → Notion
// Stocke le rapport final dans Netlify Blobs (store: optiq-planning)

const { getStore }          = require('@netlify/blobs')
const { validateBatch }     = require('./agent-validateur')
const { analyzeBatch }      = require('./agent-logistique')
const { optimizeWithVroom } = require('./agent-optimiseur-vroom')

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

const NOTION_BASE    = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const GROQ_BASE      = 'https://api.groq.com/openai/v1/chat/completions'
const GEOCODE_FR     = 'https://api-adresse.data.gouv.fr/search'

const getNotionToken = () => process.env.NOTION_TOKEN
const getGroqKey     = () => process.env.GROQ_API_KEY || process.env.GROQ
const DB_ID          = process.env.NOTION_DB_ID || '3ab30393-8dd2-4f10-98e4-b7f7b1c91f60'

// ── Utilitaire log ────────────────────────────────────────────

function mkLog(entries = []) {
  return {
    entries,
    add(level, msg) { entries.push({ ts: new Date().toISOString(), level, msg }) }
  }
}

// ── Géocodage ─────────────────────────────────────────────────

const geoCache = {}

async function geocodeAddr(address) {
  const key = (address || '').trim().toLowerCase()
  if (!key || key === 'nan') return null
  if (geoCache[key]) return geoCache[key]

  try {
    const r = await fetch(`${GEOCODE_FR}/?q=${encodeURIComponent(address)}&limit=1`, {
      headers: { 'User-Agent': 'OptiQ-Planning/1.0' }
    })
    const d    = await r.json()
    const feat = d.features?.[0]
    if (feat) {
      const [lng, lat] = feat.geometry.coordinates
      return (geoCache[key] = { lat, lng })
    }
  } catch {}

  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=fr`,
      { headers: { 'User-Agent': 'OptiQ-Planning/1.0', 'Accept-Language': 'fr' } }
    )
    const d = await r.json()
    if (d[0]) return (geoCache[key] = { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) })
  } catch {}

  return null
}

// ── Lecture Notion ────────────────────────────────────────────

function nVal(props, name) {
  const p = props[name]
  if (!p) return null
  if (p.type === 'title')       return p.title?.[0]?.plain_text || null
  if (p.type === 'rich_text')   return p.rich_text?.[0]?.plain_text || null
  if (p.type === 'select')      return p.select?.name || null
  if (p.type === 'date')        return p.date?.start || null
  if (p.type === 'phone_number')return p.phone_number || null
  if (p.type === 'email')       return p.email || null
  if (p.type === 'checkbox')    return !!p.checkbox
  return null
}

async function fetchInterventionsFromNotion(dateFrom, dateTo, tech) {
  const token = getNotionToken()
  if (!token) throw new Error('NOTION_TOKEN manquant')

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  }

  const filter = {
    and: [
      { property: 'Date intervention', date: { on_or_after: dateFrom } },
      { property: 'Date intervention', date: { on_or_before: dateTo  } },
      ...(tech ? [{ property: 'Commercial ', select: { equals: tech } }] : [])
    ]
  }

  let all = [], next = null
  do {
    const payload = {
      page_size: 100,
      sorts: [{ property: 'Date intervention', direction: 'ascending' }],
      filter,
      ...(next ? { start_cursor: next } : {})
    }
    const r = await fetch(`${NOTION_BASE}/databases/${DB_ID}/query`, {
      method: 'POST', headers, body: JSON.stringify(payload)
    })
    const d = await r.json()
    if (!r.ok) throw new Error(`Notion ${r.status}: ${JSON.stringify(d)}`)
    all  = all.concat(d.results || [])
    next = d.has_more ? d.next_cursor : null
  } while (next)

  return all.map(page => {
    const p = page.properties
    return {
      id:       page.id,
      notionId: page.id,
      client:   nVal(p, 'Société') || nVal(p, 'Client') || '—',
      addr:     nVal(p, 'Adresse Site') || nVal(p, 'Adresse Siéges') || '',
      date:     nVal(p, 'Date intervention'),
      tech:     nVal(p, 'Commercial ') || 'Non assigné',
      type:     nVal(p, 'INTERVENTION') || 'maintenance',
      phone:    nVal(p, 'Téléphone'),
      email:    nVal(p, 'E-mail'),
      notes:    nVal(p, 'INFO '),
      urgent:   !!nVal(p, 'Urgent'),
      lat: null, lng: null
    }
  })
}

// ── Mise à jour Notion après optimisation ─────────────────────

async function updateNotionIntervention(notionId, properties) {
  const token = getNotionToken()
  if (!token) return
  try {
    await fetch(`${NOTION_BASE}/pages/${notionId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ properties })
    })
  } catch {}
}

// ── Décision Groq : découcher + planning J1/J2 ───────────────

async function groqDecideOvernight(anomalies, dayPlans) {
  const key = getGroqKey()
  if (!key || !anomalies.length) return null

  const overnightAnomalies = anomalies.filter(a => a.type === 'DECOUCH_PROBABLE')
  if (!overnightAnomalies.length) return null

  const prompt = `Tu es expert en planification de tournées pour techniciens de terrain.

Anomalies de type "découcher" détectées :
${JSON.stringify(overnightAnomalies.map(a => ({ tech: a.tech, date: a.date, distRetour: a.distRetour })), null, 2)}

Planning concerné :
${JSON.stringify(dayPlans.slice(0, 5), null, 2)}

Décide pour chaque cas :
1. Découcher nécessaire ? (oui/non)
2. Si oui : propose un découpage en planning J1/J2 (quelles interventions chaque jour)
3. Alternative : réorganisation pour rentrer le soir

Réponds avec un JSON compact :
{
  "decisions": [
    {
      "tech": "...",
      "date": "...",
      "decouch": true,
      "planningJ1": ["id1", "id2"],
      "planningJ2": ["id3"],
      "alternative": "..."
    }
  ]
}`

  try {
    const r = await fetch(GROQ_BASE, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile', temperature: 0.1, max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      })
    })
    const d    = await r.json()
    const text = d.choices?.[0]?.message?.content || ''
    const s    = text.replace(/```json\n?|```\n?/g, '').trim()
    const a    = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a >= 0 && b >= 0) return JSON.parse(s.slice(a, b + 1))
  } catch {}

  return null
}

// ── Pipeline principal ────────────────────────────────────────

async function runPipeline({ dateFrom, dateTo, tech, updateNotion = false }) {
  const log    = mkLog()
  const tStart = Date.now()

  log.add('info', `Démarrage analyse planning du ${dateFrom} au ${dateTo}${tech ? ` · ${tech}` : ''}`)

  // ── 1. Chargement Notion ──────────────────────────────────
  log.add('info', 'Chargement des interventions depuis Notion...')
  let interventions
  try {
    interventions = await fetchInterventionsFromNotion(dateFrom, dateTo, tech)
  } catch (e) {
    log.add('error', `Notion : ${e.message}`)
    throw e
  }
  log.add('info', `${interventions.length} interventions chargées`)

  if (interventions.length === 0) {
    const emptyReport = buildReport({ interventions: [], agentResults: {}, anomalies: [], log: log.entries, tStart, dateFrom, dateTo, groqDecision: null })
    await saveReport(emptyReport)
    return emptyReport
  }

  // ── 2. Géocodage ──────────────────────────────────────────
  log.add('info', 'Géocodage des adresses...')
  let geocoded = 0
  await Promise.all(
    interventions.map(async iv => {
      if (iv.addr) {
        const coords = await geocodeAddr(iv.addr)
        if (coords) { iv.lat = coords.lat; iv.lng = coords.lng; geocoded++ }
      }
    })
  )
  log.add('info', `${geocoded}/${interventions.length} adresses géocodées`)

  // ── 3. Groupement par technicien × jour ───────────────────
  const dayMap = new Map()
  for (const iv of interventions) {
    const k   = `${iv.tech}||${(iv.date || '').slice(0, 10)}`
    if (!dayMap.has(k)) dayMap.set(k, { tech: iv.tech, date: (iv.date || '').slice(0, 10), interventions: [] })
    dayMap.get(k).interventions.push(iv)
  }
  const days = [...dayMap.values()]
  log.add('info', `${days.length} journées-technicien à analyser`)

  // ── 4. Validation (agent-validateur) — parallèle ──────────
  log.add('info', 'Agent validateur : vérification des données...')
  const valResult = validateBatch(interventions)
  if (valResult.errors > 0) log.add('warn', `${valResult.errors} fiche(s) avec données invalides`)

  // ── 5. Optimisation Vroom VRP (multi-techniciens par jour) ──
  log.add('info', 'Agent optimiseur : lancement Vroom VRP multi-techniciens...')
  const optResult = await optimizeWithVroom(days)

  // Réinjecter les interventions ordonnées (matching par tech+date, robuste à l'ordre)
  const dayOptMap = new Map()
  for (const od of optResult.days) dayOptMap.set(`${od.tech}||${od.date}`, od)
  for (const d of days) {
    const od = dayOptMap.get(`${d.tech}||${d.date}`)
    if (od) d.interventions = od.interventions
  }

  const solverUsed    = optResult.days.some(d => d.solver === 'vroom') ? 'Vroom VRP' : 'nearest-neighbour (fallback)'
  const fallbackDays  = optResult.days.filter(d => d.solver === 'nearest-neighbour').length
  log.add('info', `Optimisation : ${optResult.kmSaved} km économisés (${optResult.gainPct} %) · ${solverUsed}${fallbackDays ? ` · ${fallbackDays} jour(s) en fallback NN` : ''}`)

  // Anomalies Vroom : interventions non assignables
  const vroomUnassigned = (optResult.unassigned || [])
  if (vroomUnassigned.length > 0)
    log.add('warn', `${vroomUnassigned.length} intervention(s) non assignable(s) par Vroom`)

  // Découchers détectés par Vroom
  const vroomOvernight = (optResult.overnight || [])
  if (vroomOvernight.length > 0)
    log.add('info', `${vroomOvernight.length} découcher(s) requis → planning J1/J2 généré`)

  // ── 6. Logistique (agent-logistique) ─────────────────────
  log.add('info', 'Agent logistique : vérification faisabilité et anomalies...')
  const logiResult = await analyzeBatch(days, true)

  // Fusion des anomalies : Vroom non-assignables + logistique
  const nonAssignableAnomalies = vroomUnassigned.map(iv => ({
    type:       'NON_ASSIGNABLE',
    severity:   'error',
    id:         iv.notionId || iv.id,
    tech:       iv.tech || '—',
    date:       iv.date || '—',
    client:     iv.client || iv.addr || '—',
    message:    `"${iv.client || iv.addr || iv.id}" — impossible à intégrer dans un planning Vroom`,
    suggestion: 'Réaffecter à un autre technicien ou décaler à une date différente'
  }))

  const allAnomalies = [...nonAssignableAnomalies, ...logiResult.days.flatMap(d => d.anomalies)]
  const critiques    = allAnomalies.filter(a => a.severity === 'error')
  const warnings     = allAnomalies.filter(a => a.severity === 'warn')
  log.add(critiques.length > 0 ? 'warn' : 'info',
    `${allAnomalies.length} anomalie(s) : ${critiques.length} critique(s), ${warnings.length} avertissement(s)`)

  // ── 7. Groq — découcher + J1/J2 ──────────────────────────
  log.add('info', 'Groq : analyse décisions de découcher...')
  const groqDecision = await groqDecideOvernight(allAnomalies, logiResult.days.slice(0, 8))
  if (groqDecision?.decisions?.length)
    log.add('info', `Groq : ${groqDecision.decisions.length} décision(s) de découcher générée(s)`)

  // ── 8. Mise à jour Notion (optionnel) ─────────────────────
  if (updateNotion) {
    log.add('info', 'Mise à jour des statuts Notion...')
    let updated = 0
    for (const iv of interventions) {
      if (!iv.notionId) continue
      const isUnassigned = vroomUnassigned.some(u => (u.notionId || u.id) === iv.notionId)
      await updateNotionIntervention(iv.notionId, {
        'Statut planning': { select: { name: isUnassigned ? 'Non assignable' : 'Planifié' } }
      })
      updated++
    }
    log.add('info', `${updated} intervention(s) mises à jour dans Notion`)
  }

  // ── 9. Rapport final ──────────────────────────────────────
  const report = buildReport({
    interventions,
    agentResults: {
      validateur:    { processed: valResult.processed, errors: valResult.errors, valid: valResult.valid, durationMs: valResult.durationMs },
      optimiseur:    { processed: optResult.processed, kmSaved: optResult.kmSaved, gainPct: optResult.gainPct, solver: solverUsed, unassigned: vroomUnassigned.length, overnight: vroomOvernight.length, durationMs: optResult.durationMs },
      logistique:    { processed: logiResult.processed, feasible: logiResult.feasible, anomalies: logiResult.anomalies, errors: logiResult.errors, warnings: logiResult.warnings, durationMs: logiResult.durationMs },
      orchestrateur: { durationMs: Date.now() - tStart }
    },
    anomalies:    allAnomalies,
    unassigned:   vroomUnassigned,
    overnight:    vroomOvernight,
    log:          log.entries,
    tStart, dateFrom, dateTo,
    groqDecision,
    planning: {
      days: logiResult.days.map(d => {
        const optDay = dayOptMap.get(`${d.tech}||${d.date}`) || {}
        return {
          tech:           d.tech,
          date:           d.date,
          kmTotal:        d.kmTotal,
          feasible:       d.feasible,
          count:          d.segments.length,
          anomaliesCount: d.anomalies.length,
          solver:         optDay.solver || 'nearest-neighbour',
          needsOvernight: optDay.needsOvernight || false,
          kmEconomies:    optDay.kmEconomies || 0,
          gainPct:        optDay.gainPct || 0
        }
      })
    }
  })

  await saveReport(report)
  log.add('info', 'Rapport sauvegardé')

  return report
}

function buildReport({ interventions, agentResults, anomalies, unassigned, overnight, log, tStart, dateFrom, dateTo, groqDecision, planning }) {
  const critiques    = (anomalies || []).filter(a => a.severity === 'error')
  const warns        = (anomalies || []).filter(a => a.severity === 'warn')
  const techs        = [...new Set((interventions || []).map(iv => iv.tech).filter(Boolean))]
  const kmTotaux     = (planning?.days || []).reduce((s, d) => s + (d.kmTotal || 0), 0)
  const feasibles    = (planning?.days || []).filter(d => d.feasible).length
  const total        = (planning?.days || []).length
  const naCount      = (unassigned || []).length
  const ovCount      = (overnight || []).length

  return {
    version:     'planning-report-v3',
    generatedAt: new Date().toISOString(),
    dateRange:   { from: dateFrom, to: dateTo },
    kpis: {
      totalInterventions:    (interventions || []).length,
      interventionsValidees: agentResults.validateur?.valid || 0,
      nonAssignables:        naCount,
      decourchersRequis:     ovCount,
      anomaliesCritiques:    critiques.length,
      anomaliesWarnings:     warns.length,
      kmTotal:               kmTotaux,
      kmEconomies:           agentResults.optimiseur?.kmSaved || 0,
      gainPct:               agentResults.optimiseur?.gainPct || 0,
      techCount:             techs.length,
      tauxFaisabilite:       total > 0 ? Math.round((feasibles / total) * 100) / 100 : 1,
      solver:                agentResults.optimiseur?.solver || 'nearest-neighbour'
    },
    agents: {
      validateur:    { status: 'ok', ...agentResults.validateur },
      logistique:    { status: 'ok', ...agentResults.logistique },
      optimiseur:    { status: 'ok', ...agentResults.optimiseur },
      orchestrateur: { status: 'ok', durationMs: Date.now() - tStart }
    },
    anomalies:    anomalies    || [],
    unassigned:   unassigned   || [],
    overnight:    overnight    || [],
    groqDecision: groqDecision || null,
    log:          log          || [],
    planning:     planning     || {}
  }
}

async function saveReport(report) {
  try {
    const store = getStore({ name: 'optiq-planning', consistency: 'strong' })
    await store.set('last-report', JSON.stringify(report))
  } catch {}
}

module.exports = { runPipeline, buildReport }

// ── Handler HTTP ──────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) }

  let body
  try { body = JSON.parse(event.body || '{}') }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) } }

  const { dateFrom, dateTo, tech, updateNotion } = body

  if (!dateFrom || !dateTo)
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '"dateFrom" et "dateTo" requis (YYYY-MM-DD)' }) }

  try {
    const report = await runPipeline({ dateFrom, dateTo, tech, updateNotion })
    return { statusCode: 200, headers: CORS, body: JSON.stringify(report) }
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) }
  }
}
