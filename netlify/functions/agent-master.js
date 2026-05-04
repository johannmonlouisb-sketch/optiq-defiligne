// netlify/functions/agent-master.js
// Agent planning OptiQ — analyse 14 jours, validation géo, rééquilibrage, découcher
// Schedule : chaque soir à 19h UTC (21h Paris été / 20h hiver)

export const config = { schedule: "0 19 * * *" }

const NOTION_BASE  = 'https://api.notion.com/v1'
const GROQ_BASE    = 'https://api.groq.com/openai/v1/chat/completions'
const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent'
const GEOCODE_FR   = 'https://api-adresse.data.gouv.fr/search'

// ── Coordonnées dépôt (Vernouillet 78540) ─────────────────────
const DEPOT_LAT_DEFAULT = 48.965
const DEPOT_LNG_DEFAULT = 1.967

// ── Limites légales & géographiques ───────────────────────────
const RULES = {
  departureMin:    7 * 60 + 30,
  returnMaxMin:    19 * 60 + 30,
  legalMaxMin:     12 * 60,
  warnLoadMin:     10 * 60,
  maxDailyKm:      600,
  overnightKm:     300,    // round-trip seuil découcher
  maxRadiusKm:     200,    // rayon max autour du dépôt
  transitSpeedKmh: 60,     // vitesse moyenne route
  roadFactor:      1.4,    // facteur route vs vol d'oiseau
  durations: {
    maintenance_simple:  15,
    maintenance_complex: 25,
    installation:        35,
    default:             20
  },
  formBonus: 10
}

// ═══════════════════════════════════════════════════════════════
// IA — Groq + Gemini fallback
// ═══════════════════════════════════════════════════════════════

const getGroqKey   = () => process.env.GROQ_API_KEY   || process.env.GROQ
const getGeminiKey = () => process.env.GEMINI_API_KEY || process.env.GEMINIV2 || process.env.GIMINI

async function callGroq(system, user, maxTokens = 2000) {
  const key = getGroqKey()
  if (!key) throw new Error('Clé Groq manquante')
  const r = await fetch(GROQ_BASE, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile', temperature: 0.1, max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    })
  })
  const d = await r.json()
  if (!r.ok) throw new Error(`Groq ${r.status}: ${d.error?.message}`)
  return d.choices[0].message.content
}

async function callGemini(prompt, maxTokens = 2000) {
  const key = getGeminiKey()
  if (!key) throw new Error('Clé Gemini manquante')
  const r = await fetch(`${GEMINI_BASE}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.1 } })
  })
  const d = await r.json()
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${d.error?.message}`)
  return d.candidates?.[0]?.content?.parts?.[0]?.text || ''
}

async function callAI(system, user, { useGemini = false, maxTokens = 2000 } = {}) {
  if (useGemini && getGeminiKey()) {
    try { return await callGemini(`${system}\n\n${user}`, maxTokens) } catch {}
  }
  if (getGroqKey()) {
    try { return await callGroq(system, user, maxTokens) } catch {}
  }
  if (getGeminiKey()) return await callGemini(`${system}\n\n${user}`, maxTokens)
  throw new Error('Aucune IA disponible')
}

function parseJSON(text) {
  const s = text.replace(/```json\n?|```\n?/g, '').trim()
  const a = s.indexOf('{'), b = s.lastIndexOf('}')
  if (a < 0 || b < 0) return null
  try { return JSON.parse(s.slice(a, b + 1)) } catch { return null }
}

// ═══════════════════════════════════════════════════════════════
// GÉOCODAGE — api-adresse.data.gouv.fr (pas de rate-limit)
// ═══════════════════════════════════════════════════════════════

const geoCache = {}

async function geocodeAddress(address) {
  const key = (address || '').trim().toLowerCase()
  if (!key || key === 'nan') return null
  if (geoCache[key] !== undefined) return geoCache[key]

  try {
    const r = await fetch(`${GEOCODE_FR}/?q=${encodeURIComponent(address)}&limit=1`, {
      headers: { 'User-Agent': 'OptiQ-Agent/1.0' }
    })
    const d = await r.json()
    const feat = d.features?.[0]
    if (feat) {
      const [lng, lat] = feat.geometry.coordinates
      geoCache[key] = { lat, lng }
      return { lat, lng }
    }
  } catch {}

  // Fallback Nominatim si adresse.data.gouv.fr échoue (hors France ou erreur)
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=fr`, {
      headers: { 'User-Agent': 'OptiQ-Agent/1.0', 'Accept-Language': 'fr' }
    })
    const d = await r.json()
    if (d[0]) {
      const result = { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) }
      geoCache[key] = result
      return result
    }
  } catch {}

  geoCache[key] = null
  return null
}

async function geocodeAll(interventions, push) {
  const unique = [...new Set(interventions.map(iv => iv.addr).filter(a => a && a !== 'nan'))]
  push(`🌍 Géocodage de ${unique.length} adresses...`)

  // Batch de 5 requêtes en parallèle
  for (let i = 0; i < unique.length; i += 5) {
    await Promise.all(unique.slice(i, i + 5).map(a => geocodeAddress(a)))
  }

  let found = 0
  for (const iv of interventions) {
    const coords = geoCache[(iv.addr || '').trim().toLowerCase()]
    if (coords) { iv.lat = coords.lat; iv.lng = coords.lng; found++ }
  }
  push(`   ✅ ${found}/${interventions.length} adresses géocodées`)
}

// ── Formule Haversine ──────────────────────────────────────────

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function distFromDepot(iv, depotLat, depotLng) {
  if (!iv.lat || !iv.lng) return 0
  return haversine(depotLat, depotLng, iv.lat, iv.lng)
}

function nnSort(pool, startLat, startLng) {
  const rem = [...pool], ordered = []
  let lat = startLat, lng = startLng
  while (rem.length) {
    let bi = 0, bd = Infinity
    for (let i = 0; i < rem.length; i++) {
      if (!rem[i].lat || !rem[i].lng) continue
      const d = haversine(lat, lng, rem[i].lat, rem[i].lng)
      if (d < bd) { bd = d; bi = i }
    }
    const nxt = rem.splice(bi, 1)[0]
    ordered.push(nxt)
    lat = nxt.lat || lat
    lng = nxt.lng || lng
  }
  return ordered
}

// ── Stats journée ──────────────────────────────────────────────

function calcDayKm(ivs, depotLat, depotLng) {
  const pts = [{ lat: depotLat, lng: depotLng }, ...ivs.filter(iv => iv.lat), { lat: depotLat, lng: depotLng }]
  let km = 0
  for (let i = 0; i < pts.length - 1; i++) {
    km += haversine(pts[i].lat, pts[i].lng, pts[i + 1].lat, pts[i + 1].lng)
  }
  return Math.round(km * RULES.roadFactor)
}

function calcDayMin(ivs, depotLat, depotLng) {
  const durMin     = ivs.reduce((acc, iv) => acc + (RULES.durations[iv.type] || RULES.durations.default), 0)
  const km         = calcDayKm(ivs, depotLat, depotLng)
  const transitMin = Math.round(km / RULES.transitSpeedKmh * 60)
  return durMin + transitMin
}

function minToTime(min) {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// ═══════════════════════════════════════════════════════════════
// NOTION helpers
// ═══════════════════════════════════════════════════════════════

function nProp(props, ...keys) {
  for (const k of keys) {
    const v = props[k]; if (!v) continue
    if (v.type === 'title')        return v.title?.map(t => t.plain_text).join('') || ''
    if (v.type === 'rich_text')    return v.rich_text?.map(t => t.plain_text).join('') || ''
    if (v.type === 'date')         return v.date?.start || ''
    if (v.type === 'select')       return v.select?.name || ''
    if (v.type === 'multi_select') return v.multi_select?.map(s => s.name).join(', ') || ''
    if (v.type === 'checkbox')     return !!v.checkbox
  }
  return ''
}

async function notionQuery(token, dbId, filter) {
  const headers = { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }
  let all = [], cursor = null
  do {
    const payload = { page_size: 100, sorts: [{ property: 'Date intervention', direction: 'ascending' }], ...(filter ? { filter } : {}), ...(cursor ? { start_cursor: cursor } : {}) }
    const r = await fetch(`${NOTION_BASE}/databases/${dbId}/query`, { method: 'POST', headers, body: JSON.stringify(payload) })
    const d = await r.json()
    if (!r.ok) throw new Error(`Notion: ${JSON.stringify(d)}`)
    all = all.concat(d.results || [])
    cursor = d.has_more ? d.next_cursor : null
  } while (cursor)
  return all
}

async function notionUpdate(token, pageId, properties) {
  const r = await fetch(`${NOTION_BASE}/pages/${pageId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties })
  })
  if (!r.ok) { const d = await r.json(); throw new Error(JSON.stringify(d)) }
}

// ═══════════════════════════════════════════════════════════════
// AGENT 1 — Lecture Notion 14 jours
// ═══════════════════════════════════════════════════════════════

async function agent1Data(token, dbId, dateFrom, dateTo, push) {
  push(`📥 Agent 1 — Notion ${dateFrom} → ${dateTo}...`)

  const pages = await notionQuery(token, dbId, {
    and: [
      { property: 'Date intervention', date: { on_or_after:  dateFrom } },
      { property: 'Date intervention', date: { on_or_before: dateTo   } },
      { property: 'Terminer',          checkbox: { equals: false }      }
    ]
  })

  const interventions = pages.map(page => {
    const p = page.properties || {}
    const typeStr = (nProp(p, 'INTERVENTION') || '').toLowerCase()
    let type = 'maintenance_simple'
    if (typeStr.includes('install') || typeStr.includes('livraison') || typeStr.includes('formation')) type = 'installation'
    else if (typeStr.includes('pad pak') || typeStr.includes('remplac') || typeStr.includes('armoir') || typeStr.includes('électrode')) type = 'maintenance_complex'

    const dateStr = nProp(p, 'Date intervention') || ''
    return {
      notionId: page.id,
      client:   nProp(p, 'Société'),
      addr:     nProp(p, 'Adresse Site') || nProp(p, 'Adresse Siéges') || '',
      date:     dateStr.substring(0, 10),
      tech:     nProp(p, 'Commercial '),
      type,
      notes:    nProp(p, 'INFO ') || '',
      urgent:   !!(nProp(p, 'Urgent')),
      echec:    !!(nProp(p, 'Echec')),
      lat: null, lng: null
    }
  }).filter(iv => iv.client && iv.date && !iv.echec)

  push(`   ✅ ${interventions.length} interventions`)
  return interventions
}

// ═══════════════════════════════════════════════════════════════
// VALIDATION GÉOGRAPHIQUE & OVERFLOW
// ═══════════════════════════════════════════════════════════════

function findNextFreeDay(fromDate, tech, byDateTech) {
  for (let i = 1; i <= 14; i++) {
    const d = new Date(fromDate + 'T12:00:00')
    d.setDate(d.getDate() + i)
    const ds = d.toISOString().split('T')[0]
    if (!byDateTech[ds]?.[tech]?.length) return ds
  }
  return null
}

function findAvailableTech(date, byDateTech, allTechs) {
  const active = Object.keys(byDateTech[date] || {})
  return allTechs.find(t => !active.includes(t)) || null
}

function handleGeoOverflow(byDateTech, depotLat, depotLng, allTechs, push) {
  const dateMoves = []       // interventions déplacées à une autre date
  const reassignments = []   // interventions réaffectées à un autre tech
  const overnights = []      // tournées nécessitant un découcher

  for (const date of Object.keys(byDateTech).sort()) {
    for (const [tech, ivs] of Object.entries(byDateTech[date])) {
      if (!ivs.length) continue

      // ── Vérif découcher (> OVERNIGHT_KM du dépôt aller)
      const farIvs = ivs.filter(iv => distFromDepot(iv, depotLat, depotLng) > RULES.overnightKm)
      if (farIvs.length) {
        overnights.push({
          date, tech,
          interventions: farIvs.map(iv => ({ client: iv.client, distKm: Math.round(distFromDepot(iv, depotLat, depotLng)) })),
          message: `Découcher nécessaire — ${farIvs.length} intervention(s) à plus de ${RULES.overnightKm}km aller`
        })
        push(`   🌙 ${date}/${tech}: découcher nécessaire (${farIvs.map(iv => `${iv.client} ${Math.round(distFromDepot(iv, depotLat, depotLng))}km`).join(', ')})`)
      }

      // ── Vérif hors rayon max (> MAX_RADIUS_KM)
      const outOfRange = ivs.filter(iv => distFromDepot(iv, depotLat, depotLng) > RULES.maxRadiusKm)
      if (outOfRange.length) {
        push(`   ⚠️  ${date}/${tech}: ${outOfRange.length} intervention(s) hors rayon ${RULES.maxRadiusKm}km (${outOfRange.map(iv => iv.client).join(', ')})`)
      }

      // ── Vérif surcharge km ou temps
      const totalKm  = calcDayKm(ivs, depotLat, depotLng)
      const totalMin = calcDayMin(ivs, depotLat, depotLng)
      const overKm   = totalKm  > RULES.maxDailyKm
      const overTime = totalMin > RULES.legalMaxMin

      if (!overKm && !overTime) continue

      push(`   ⚠️  ${date}/${tech}: surcharge (${totalKm}km, ${Math.round(totalMin/60*10)/10}h) — réorganisation...`)

      // Trier les interventions : urgentes en premier, puis par distance croissante du dépôt
      const nonUrgent = ivs.filter(iv => !iv.urgent).sort((a, b) =>
        distFromDepot(b, depotLat, depotLng) - distFromDepot(a, depotLat, depotLng)
      )

      // Extraire jusqu'à 3 interventions lointaines/non-urgentes
      const toMove = []
      let curKm = totalKm, curMin = totalMin
      for (const iv of nonUrgent) {
        if ((!overKm || curKm <= RULES.maxDailyKm) && (!overTime || curMin <= RULES.legalMaxMin)) break
        if (toMove.length >= 3) break
        toMove.push(iv)
        curKm  -= (RULES.roadFactor * distFromDepot(iv, depotLat, depotLng) * 2)
        curMin -= (RULES.durations[iv.type] || RULES.durations.default) + 30
      }

      for (const iv of toMove) {
        ivs.splice(ivs.indexOf(iv), 1)

        // Essayer un autre tech disponible ce jour
        const altTech = findAvailableTech(date, byDateTech, allTechs)
        if (altTech) {
          if (!byDateTech[date][altTech]) byDateTech[date][altTech] = []
          byDateTech[date][altTech].push(iv)
          iv.tech = altTech
          reassignments.push({ notionId: iv.notionId, client: iv.client, from: tech, to: altTech, date })
          push(`   🔄 "${iv.client}" réaffecté à ${altTech} le ${date}`)
        } else {
          // Trouver le prochain jour libre pour ce tech
          const nextDay = findNextFreeDay(date, tech, byDateTech)
          if (nextDay) {
            if (!byDateTech[nextDay]) byDateTech[nextDay] = {}
            if (!byDateTech[nextDay][tech]) byDateTech[nextDay][tech] = []
            byDateTech[nextDay][tech].push(iv)
            iv.date = nextDay
            dateMoves.push({ notionId: iv.notionId, client: iv.client, fromDate: date, toDate: nextDay, tech })
            push(`   📅 "${iv.client}" déplacé au ${nextDay}`)
          } else {
            push(`   ⚠️  "${iv.client}" non recasable dans les 14 prochains jours`)
          }
        }
      }
    }
  }

  return { dateMoves, reassignments, overnights }
}

// ═══════════════════════════════════════════════════════════════
// RÉÉQUILIBRAGE charge entre techs même jour
// ═══════════════════════════════════════════════════════════════

function rebalanceLoad(byDateTech, depotLat, depotLng, push) {
  const reassignments = []

  for (const date of Object.keys(byDateTech)) {
    const dayTechs = byDateTech[date]
    let changed = true

    while (changed) {
      changed = false
      const loads = Object.entries(dayTechs)
        .map(([tech, ivs]) => ({ tech, ivs, min: calcDayMin(ivs, depotLat, depotLng) }))
        .sort((a, b) => b.min - a.min)

      if (loads.length < 2) break
      const heavy = loads[0]
      const light  = loads[loads.length - 1]

      if (heavy.min > RULES.warnLoadMin && light.min < 480 && (heavy.min - light.min) > 120) {
        const candidates = heavy.ivs
          .filter(iv => !iv.urgent)
          .sort((a, b) => (RULES.durations[a.type] || 20) - (RULES.durations[b.type] || 20))

        if (candidates.length) {
          const iv = candidates[0]
          heavy.ivs.splice(heavy.ivs.indexOf(iv), 1)
          light.ivs.push(iv)
          iv.tech = light.tech
          reassignments.push({ notionId: iv.notionId, client: iv.client, from: heavy.tech, to: light.tech, date })
          push(`   ⚖️  ${date}: "${iv.client}" ${heavy.tech} → ${light.tech}`)
          changed = true
        }
      }
    }
  }
  return reassignments
}

// ═══════════════════════════════════════════════════════════════
// AGENT 2 — Optimisation tournée IA
// ═══════════════════════════════════════════════════════════════

async function agent2Routes(depot, date, tech, ivs, depotLat, depotLng, push) {
  push(`   🗺️  ${tech} — ${ivs.length} arrêt(s)`)

  const totalKm  = calcDayKm(ivs, depotLat, depotLng)
  const totalMin = calcDayMin(ivs, depotLat, depotLng)

  const system = `Tu es expert en optimisation de tournées pour techniciens DEA en France.
RÈGLES :
- Départ dépôt 07h30 | Retour max 19h30 | Max légal 12h/jour
- Transit moyen : 30min entre arrêts
- URGENTS en premier | Respecter les heures limites (timeEnd)
- Optimise géographiquement pour minimiser les km
Réponds UNIQUEMENT en JSON valide :
{"feasible":true,"reason":"ok","totalHours":7.5,"orderedRoute":[{"notionId":"...","client":"...","estimatedStart":"08:00","durationMin":20}],"alerts":[]}`

  const ivList = ivs.map((iv, i) => {
    const dur = (RULES.durations[iv.type] || RULES.durations.default) + (iv.notes?.includes('formation') ? RULES.formBonus : 0)
    const dist = iv.lat ? `${Math.round(distFromDepot(iv, depotLat, depotLng))}km du dépôt` : ''
    return `${i + 1}. [${iv.notionId}] ${iv.client}\n   ${iv.addr || 'Adresse N/A'} ${dist}\n   Type:${iv.type} Durée:${dur}min${iv.urgent ? ' ⚠️URGENT' : ''}`
  }).join('\n\n')

  try {
    const raw = await callAI(system, `DATE:${date} TECH:${tech} DÉPÔT:${depot}\nCharge estimée: ${Math.round(totalKm)}km, ${Math.round(totalMin/60*10)/10}h\n\n${ivList}`, { useGemini: true })
    const result = parseJSON(raw)
    if (result?.orderedRoute?.length) {
      push(`   ✅ ${result.totalHours}h, faisable=${result.feasible}`)
      return result
    }
  } catch (e) {
    push(`   ⚠️ IA: ${e.message} — fallback algo`)
  }

  // Fallback : nearest-neighbor depuis le dépôt (urgents priorisés)
  const urg    = nnSort(ivs.filter(iv => iv.urgent),   depotLat, depotLng)
  const last   = urg[urg.length - 1]
  const nonUrg = nnSort(ivs.filter(iv => !iv.urgent),  last?.lat ?? depotLat, last?.lng ?? depotLng)
  const sorted = [...urg, ...nonUrg]

  let tMin = RULES.departureMin
  return {
    feasible: totalMin <= RULES.legalMaxMin,
    reason: totalMin > RULES.legalMaxMin ? `Journée trop chargée (${Math.round(totalMin/60*10)/10}h)` : 'Fallback NN',
    totalHours: Math.round(totalMin / 60 * 10) / 10,
    orderedRoute: sorted.map(iv => {
      const dur = RULES.durations[iv.type] || RULES.durations.default
      const start = minToTime(tMin)
      tMin += dur + 30
      return { notionId: iv.notionId, client: iv.client, estimatedStart: start, durationMin: dur }
    }),
    alerts: totalMin > RULES.legalMaxMin ? [`Journée >12h légal — retour estimé ${minToTime(RULES.departureMin + totalMin)}`] : []
  }
}

// ═══════════════════════════════════════════════════════════════
// AGENT 3 — Analyse planning 14 jours
// ═══════════════════════════════════════════════════════════════

async function agent3Planning(dayResults, overnights, push) {
  push('📋 Agent 3 — Analyse 14 jours...')
  if (!dayResults.length) return { alerts: [], suggestions: [] }

  const summary = dayResults.map(r =>
    `${r.date}/${r.tech}: ${r.count} arrêts, ${r.km}km, ${r.totalHours}h${!r.feasible ? ' ⚠️INFAISABLE' : r.totalHours > 10 ? ' (surcharge)' : ''}`
  ).join('\n')

  const overnightSummary = overnights.length
    ? `\nDécochers détectés:\n${overnights.map(o => `${o.date}/${o.tech}: ${o.message}`).join('\n')}`
    : ''

  const system = `Expert planification RH techniciens DEA France. Règle légale: 12h/jour max.
Analyse les risques sur les 14 prochains jours et propose des actions concrètes.
Réponds en JSON : {"alerts":["..."],"suggestions":["..."]}`

  try {
    const raw = await callAI(system, `Planning 14 jours:\n${summary}${overnightSummary}`, { maxTokens: 800 })
    const result = parseJSON(raw)
    if (result) {
      if (result.alerts?.length)      push(`   ⚠️  ${result.alerts.length} alerte(s)`)
      if (result.suggestions?.length) push(`   💡 ${result.suggestions.length} suggestion(s)`)
      return result
    }
  } catch (e) {
    push(`   ⚠️ Agent 3: ${e.message}`)
  }

  // Fallback local
  const alerts = [
    ...dayResults.filter(r => !r.feasible).map(r => `❌ ${r.date}/${r.tech}: infaisable`),
    ...dayResults.filter(r => r.feasible && r.totalHours > 10).map(r => `⏱️ ${r.date}/${r.tech}: ${r.totalHours}h (surcharge)`),
    ...overnights.map(o => `🌙 ${o.date}/${o.tech}: ${o.message}`)
  ]
  return { alerts, suggestions: [] }
}

// ═══════════════════════════════════════════════════════════════
// ÉCRITURE NOTION
// ═══════════════════════════════════════════════════════════════

async function writePlanningTimes(token, route, date, push) {
  let n = 0
  for (const stop of route.orderedRoute || []) {
    if (!stop.notionId || !stop.estimatedStart) continue
    try {
      const isoDate = `${date}T${stop.estimatedStart}:00+02:00`
      await notionUpdate(token, stop.notionId, { 'Date intervention': { date: { start: isoDate } } })
      n++
      await new Promise(r => setTimeout(r, 150))
    } catch (e) {
      push(`   ⚠️ Heure Notion ${stop.client}: ${e.message}`)
    }
  }
  return n
}

async function writeReassignments(token, list, push) {
  for (const r of list) {
    try {
      await notionUpdate(token, r.notionId, { 'Commercial ': { select: { name: r.to } } })
      await new Promise(r2 => setTimeout(r2, 150))
    } catch (e) {
      push(`   ⚠️ Réaffectation Notion ${r.client}: ${e.message}`)
    }
  }
}

async function writeDateMoves(token, moves, push) {
  for (const m of moves) {
    try {
      await notionUpdate(token, m.notionId, { 'Date intervention': { date: { start: m.toDate } } })
      push(`   📅 "${m.client}" déplacé ${m.fromDate} → ${m.toDate} dans Notion`)
      await new Promise(r => setTimeout(r, 150))
    } catch (e) {
      push(`   ⚠️ Déplacement date ${m.client}: ${e.message}`)
    }
  }
}

async function sendAdminAlert(cfg, subject, body, push) {
  if (!cfg.brevoKey || !cfg.alertEmail) return
  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': cfg.brevoKey },
      body: JSON.stringify({
        sender: { name: 'OptiQ Agent', email: 'agent@defiligne.fr' },
        to: [{ email: cfg.alertEmail }],
        subject,
        htmlContent: `<pre style="font-family:sans-serif;line-height:1.6">${body}</pre>`
      })
    })
  } catch (e) {
    push(`   ⚠️ Alerte email: ${e.message}`)
  }
}

// ═══════════════════════════════════════════════════════════════
// ORCHESTRATEUR
// ═══════════════════════════════════════════════════════════════

export default async (req) => {
  const log = []
  const push = msg => { console.log(msg); log.push(msg) }

  push(`\n🤖 Agent Planning OptiQ — ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`)

  const token      = process.env.NOTION_TOKEN
  const dbId       = process.env.NOTION_DB_ID || '3ab30393-8dd2-4f10-98e4-b7f7b1c91f60'
  const depot      = process.env.OPTIQ_DEPOT_ADDRESS || '7 rue des entrepreneurs, 78540 Vernouillet'
  const depotLat   = parseFloat(process.env.OPTIQ_DEPOT_LAT || DEPOT_LAT_DEFAULT)
  const depotLng   = parseFloat(process.env.OPTIQ_DEPOT_LNG || DEPOT_LNG_DEFAULT)
  const allTechs   = (process.env.OPTIQ_TECHS || '').split(',').map(t => t.trim()).filter(Boolean)
  const cfg = {
    brevoKey:   process.env.OPTIQ_BREVO_KEY || '',
    alertEmail: process.env.OPTIQ_ALERT_EMAIL || '',
  }

  if (!token) {
    push('❌ NOTION_TOKEN manquant')
    return new Response(JSON.stringify({ status: 'error', log }), { status: 500 })
  }
  if (!getGroqKey() && !getGeminiKey()) {
    push('❌ Aucune clé IA')
    return new Response(JSON.stringify({ status: 'error', log }), { status: 500 })
  }

  try {
    const from = dateOffset(1)
    const to   = dateOffset(14)
    push(`📅 Fenêtre : ${from} → ${to} (14 jours)`)

    // ── Agent 1 : Données ──────────────────────────────────────
    const interventions = await agent1Data(token, dbId, from, to, push)
    if (!interventions.length) {
      push('Aucune intervention à venir.')
      return new Response(JSON.stringify({ status: 'ok', log }), { status: 200 })
    }

    // ── Géocodage ──────────────────────────────────────────────
    await geocodeAll(interventions, push)

    // ── Regrouper par date/tech ────────────────────────────────
    const byDateTech = {}
    for (const iv of interventions) {
      if (!byDateTech[iv.date]) byDateTech[iv.date] = {}
      const t = iv.tech || 'Non assigné'
      if (!byDateTech[iv.date][t]) byDateTech[iv.date][t] = []
      byDateTech[iv.date][t].push(iv)
    }

    // ── Rééquilibrage charge ───────────────────────────────────
    push('\n⚖️  Rééquilibrage charge...')
    const balReassign = rebalanceLoad(byDateTech, depotLat, depotLng, push)
    if (!balReassign.length) push('   ✅ Aucun rééquilibrage nécessaire')

    // ── Validation géo + gestion overflow ─────────────────────
    push('\n🌍 Validation géographique...')
    const { dateMoves, reassignments: geoReassign, overnights } = handleGeoOverflow(byDateTech, depotLat, depotLng, allTechs, push)
    if (!dateMoves.length && !geoReassign.length && !overnights.length) push('   ✅ Toutes les tournées sont dans les limites')

    // ── Écriture Notion : réaffectations + déplacements dates ──
    const allReassign = [...balReassign, ...geoReassign]
    if (allReassign.length) {
      push(`\n📝 Mise à jour techniciens Notion (${allReassign.length})...`)
      await writeReassignments(token, allReassign, push)
    }
    if (dateMoves.length) {
      push(`\n📅 Déplacement dates Notion (${dateMoves.length})...`)
      await writeDateMoves(token, dateMoves, push)
    }

    // ── Agent 2 : Optimisation routes ─────────────────────────
    push('\n🗺️  Agent 2 — Optimisation tournées...')
    const dayResults = []
    let totalWritten = 0

    for (const date of Object.keys(byDateTech).sort()) {
      push(`\n   📅 ${date}`)
      for (const [tech, ivs] of Object.entries(byDateTech[date])) {
        if (!ivs.length) continue
        const route = await agent2Routes(depot, date, tech, ivs, depotLat, depotLng, push)
        const written = await writePlanningTimes(token, route, date, push)
        totalWritten += written

        dayResults.push({
          date, tech,
          feasible:   route.feasible !== false,
          reason:     route.reason || '',
          count:      route.orderedRoute?.length || ivs.length,
          totalHours: route.totalHours || 0,
          km:         calcDayKm(ivs, depotLat, depotLng),
          alerts:     route.alerts || []
        })
      }
    }

    // ── Agent 3 : Analyse planning ─────────────────────────────
    push('')
    const planning = await agent3Planning(dayResults, overnights, push)

    // ── Alertes admin ──────────────────────────────────────────
    const criticals = [
      ...dayResults.filter(r => !r.feasible).map(r => `❌ ${r.date}/${r.tech}: infaisable — ${r.reason}`),
      ...overnights.map(o => `🌙 ${o.date}/${o.tech}: ${o.message}`)
    ]
    if (criticals.length) {
      await sendAdminAlert(cfg, `⚠️ OptiQ — ${criticals.length} alerte(s) planning`, criticals.join('\n'), push)
    }

    // ── Rapport ────────────────────────────────────────────────
    push('\n📊 RAPPORT FINAL :')
    dayResults.forEach(r => {
      const icon = !r.feasible ? '❌' : r.totalHours > 10 ? '⚠️' : '✅'
      push(`  ${icon} ${r.date}/${r.tech} — ${r.count} arrêts, ${r.km}km, ${r.totalHours}h`)
    })
    if (allReassign.length) push(`\n🔄 ${allReassign.length} réaffectation(s) Notion`)
    if (dateMoves.length)   push(`📅 ${dateMoves.length} déplacement(s) de date Notion`)
    if (overnights.length)  push(`🌙 ${overnights.length} tournée(s) avec découcher`)
    push(`💾 ${totalWritten} heures planifiées écrites dans Notion`)
    if (planning.alerts?.length)      push(`⚠️  ${planning.alerts.join(' | ')}`)
    if (planning.suggestions?.length) push(`💡 ${planning.suggestions.join(' | ')}`)
    push(`\n🏁 Terminé — ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`)

    return new Response(
      JSON.stringify({ status: 'ok', dayResults, reassignments: allReassign, dateMoves, overnights, planning, log }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )

  } catch (e) {
    push(`\n❌ Erreur fatale : ${e.message}`)
    return new Response(JSON.stringify({ status: 'error', error: e.message, log }), { status: 500 })
  }
}

function dateOffset(n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}
