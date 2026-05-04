// netlify/functions/route-chat.js
// Agent IA interactif — Gestion des tournées OptiQ
// Provider : Groq (llama-3.3-70b) principal, Gemini Flash fallback

const GROQ_BASE   = 'https://api.groq.com/openai/v1/chat/completions'
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent'
const NOMINATIM   = 'https://nominatim.openstreetmap.org/search'
const OSRM        = 'https://router.project-osrm.org/route/v1/driving'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

// ─── Outils disponibles pour Claude ─────────────────────────────────────────

const TOOLS = [
  {
    name: 'geocode_address',
    description: "Géocode une adresse via Nominatim pour vérifier qu'elle existe et obtenir ses coordonnées GPS. Utilise cet outil pour valider les adresses des clients et détecter les erreurs (typos, code postal manquant, etc.).",
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: "L'adresse complète à géocoder (avec code postal et ville de préférence)" }
      },
      required: ['address']
    }
  },
  {
    name: 'calculate_route',
    description: "Calcule un itinéraire entre plusieurs points GPS via OSRM. Retourne la distance totale en km, le temps de trajet en minutes, et le détail par étape.",
    input_schema: {
      type: 'object',
      properties: {
        waypoints: {
          type: 'array',
          description: "Points dans l'ordre du trajet (depot → clients → depot)",
          items: {
            type: 'object',
            properties: {
              lat:   { type: 'number', description: 'Latitude' },
              lng:   { type: 'number', description: 'Longitude' },
              label: { type: 'string', description: 'Nom du lieu pour le rapport' }
            },
            required: ['lat', 'lng']
          }
        }
      },
      required: ['waypoints']
    }
  },
  {
    name: 'suggest_reorder',
    description: "Propose un ordre optimal pour les interventions. L'application pourra appliquer cet ordre directement.",
    input_schema: {
      type: 'object',
      properties: {
        tech_id:          { type: 'number', description: 'ID du technicien concerné (0 = tous)' },
        intervention_ids: { type: 'array', items: { type: 'number' }, description: "IDs des interventions dans l'ordre recommandé" },
        reason:           { type: 'string', description: 'Explication courte du raisonnement' }
      },
      required: ['intervention_ids', 'reason']
    }
  },
  {
    name: 'flag_issue',
    description: "Signale un problème spécifique sur une intervention (adresse invalide, contrainte horaire impossible, hors zone, etc.).",
    input_schema: {
      type: 'object',
      properties: {
        intervention_id: { type: 'number', description: "ID de l'intervention concernée (0 si problème global)" },
        severity:        { type: 'string', enum: ['error', 'warning', 'info'], description: 'Gravité du problème' },
        message:         { type: 'string', description: 'Description claire du problème et de la correction recommandée' }
      },
      required: ['intervention_id', 'severity', 'message']
    }
  }
]

// ─── Exécution des outils ────────────────────────────────────────────────────

async function geocodeAddress(address) {
  try {
    const url = `${NOMINATIM}?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=fr`
    const r = await fetch(url, { headers: { 'User-Agent': 'OptiQ-RouteAgent/1.0', 'Accept-Language': 'fr' } })
    const d = await r.json()
    if (d[0]) {
      return { found: true, lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon), display: d[0].display_name, importance: d[0].importance }
    }
    return { found: false, error: `Adresse introuvable : "${address}"` }
  } catch (e) {
    return { found: false, error: `Erreur réseau : ${e.message}` }
  }
}

async function calculateRoute(waypoints) {
  if (!waypoints || waypoints.length < 2)
    return { error: 'Au moins 2 points de passage sont nécessaires.' }
  try {
    const coords = waypoints.map(w => `${w.lng},${w.lat}`).join(';')
    const r = await fetch(`${OSRM}/${coords}?overview=false&steps=false`)
    const d = await r.json()
    if (d.routes?.[0]) {
      const route = d.routes[0]
      return {
        distance_km:  Math.round(route.distance / 1000),
        duration_min: Math.round(route.duration / 60),
        legs: (route.legs || []).map((leg, i) => ({
          from: waypoints[i]?.label   || `Point ${i+1}`,
          to:   waypoints[i+1]?.label || `Point ${i+2}`,
          km:   Math.round(leg.distance / 1000),
          min:  Math.round(leg.duration / 60)
        }))
      }
    }
    return { error: "OSRM n'a pas pu calculer l'itinéraire." }
  } catch (e) {
    return { error: `Erreur OSRM : ${e.message}` }
  }
}

async function executeTool(name, input) {
  switch (name) {
    case 'geocode_address': return geocodeAddress(input.address)
    case 'calculate_route': return calculateRoute(input.waypoints)
    case 'suggest_reorder': return { applied: false, tech_id: input.tech_id || 0, ids: input.intervention_ids, reason: input.reason }
    case 'flag_issue':      return { flagged: true, id: input.intervention_id, severity: input.severity, message: input.message }
    default:                return { error: `Outil inconnu : ${name}` }
  }
}

// ─── Prompt système ──────────────────────────────────────────────────────────

function buildSystemPrompt(context) {
  const { date, depot, techs, interventions } = context

  const totalWorkMin = (interventions || []).reduce((acc, iv) => {
    const base = iv.type === 'installation' ? 35 : iv.type === 'maintenance_complex' ? 25 : 15
    return acc + base + (iv.form ? 10 : 0)
  }, 0)

  const ivLines = (interventions || []).map((iv, i) => {
    const tc   = iv.timeStart || iv.timeEnd ? ` | Créneau : ${iv.timeStart || '?'}→${iv.timeEnd || '?'}` : ''
    const note = iv.notes ? ` | Note : "${iv.notes}"` : ''
    return `  ${i+1}. [ID:${iv.id}] ${iv.client}\n     Adresse : ${iv.addr}\n     Tech : ${iv.techName || iv.techId} | Type : ${iv.type} | Statut : ${iv.status}${tc}${note}`
  }).join('\n')

  return `Tu es l'agent IA de gestion des tournées pour OptiQ, une application française de gestion terrain pour techniciens DEA (défibrillateurs automatisés).

TON RÔLE : optimiser les tournées, vérifier les adresses, analyser la cohérence des journées, et proposer des corrections actionnables.

═══ CONTEXTE DE LA JOURNÉE ═══
Date          : ${date || 'non définie'}
Dépôt départ  : ${depot || 'non défini'}
Techniciens   : ${(techs || []).map(t => `${t.name} (${t.vehicle || '?'})`).join(', ') || 'non définis'}
Interventions : ${(interventions || []).length} au total
Travail total estimé : ${totalWorkMin} min (${(totalWorkMin/60).toFixed(1)}h)

═══ LISTE DES INTERVENTIONS ═══
${ivLines || '  Aucune intervention'}

═══ RÈGLES MÉTIER ═══
- Départ dépôt : 07:30 | Retour max : 19:30 | Légal max : 12h/jour
- Durées : Maintenance simple = 15min | Maintenance+ = 25min | Installation = 35min (+10min si formation)
- Interventions avec heure limite : à placer EN PREMIER dans la tournée (Earliest Deadline First)
- Une adresse introuvable = intervention à signaler immédiatement
- Journée de +9h total (travail + trajets) = surcharge à signaler

═══ COMPORTEMENT ATTENDU ═══
- Réponds en français, sois direct et concis
- Si tu analyses la journée complète, vérifie les adresses une par une avec geocode_address
- Si tu proposes un réordonnancement, utilise suggest_reorder avec les IDs dans le bon ordre
- Signale chaque problème avec flag_issue (erreur d'adresse, surcharge, contrainte impossible)
- Après analyse, donne toujours un résumé : ✅ OK / ⚠️ Avertissements / ❌ Erreurs bloquantes`
}

// ─── Appels IA : Groq principal, Gemini fallback ─────────────────────────────

async function callGroqChat(systemPrompt, messages, tools) {
  const key = process.env.GROQ_API_KEY
  if (!key) throw new Error('GROQ_API_KEY manquant')

  const groqMessages = [{ role: 'system', content: systemPrompt }, ...messages]
  const body = { model: 'llama-3.3-70b-versatile', max_tokens: 2048, temperature: 0.3, messages: groqMessages }
  if (tools?.length) body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))

  const r = await fetch(GROQ_BASE, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const d = await r.json()
  if (!r.ok) throw new Error(`Groq ${r.status}: ${d.error?.message}`)
  return d
}

async function callGeminiFallback(systemPrompt, messages) {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY manquant')
  const fullPrompt = `${systemPrompt}\n\n${messages.map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n')}`
  const r = await fetch(`${GEMINI_BASE}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: fullPrompt }] }], generationConfig: { maxOutputTokens: 2048 } })
  })
  const d = await r.json()
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${d.error?.message}`)
  return d.candidates?.[0]?.content?.parts?.[0]?.text || ''
}

// ─── Point d'entrée Netlify ───────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 200, headers: CORS, body: '' }

  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) }

  if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Aucune clé IA configurée (GROQ_API_KEY ou GEMINI_API_KEY requis)' }) }

  let body
  try { body = JSON.parse(event.body) }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) } }

  const { messages = [], context = {} } = body
  const systemPrompt = buildSystemPrompt(context)
  const collectedActions = []
  const collectedIssues  = []

  const chatMessages = messages.map(m => ({
    role:    m.role === 'agent' ? 'assistant' : 'user',
    content: m.content || m.text || ''
  }))

  let finalReply = ''

  // ── Tentative Groq avec tool_use (multi-tour) ──────────────────
  if (process.env.GROQ_API_KEY) {
    try {
      for (let turn = 0; turn < 8; turn++) {
        const data = await callGroqChat(systemPrompt, chatMessages, TOOLS)
        const choice = data.choices?.[0]
        const msg = choice?.message

        chatMessages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls })

        if (choice?.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            let input
            try { input = JSON.parse(tc.function.arguments) } catch { input = {} }
            const result = await executeTool(tc.function.name, input)

            if (tc.function.name === 'suggest_reorder' && result.ids?.length)
              collectedActions.push({ type: 'reorder', tech_id: result.tech_id, ids: result.ids, reason: result.reason })
            if (tc.function.name === 'flag_issue' && result.flagged)
              collectedIssues.push({ id: result.id, severity: result.severity, message: result.message })

            chatMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
          }
        } else {
          finalReply = msg.content || ''
          break
        }
      }
    } catch (e) {
      console.warn('Groq failed, fallback Gemini:', e.message)
      finalReply = '' // force fallback
    }
  }

  // ── Fallback Gemini (réponse simple, sans tool_use) ────────────
  if (!finalReply && process.env.GEMINI_API_KEY) {
    try {
      finalReply = await callGeminiFallback(systemPrompt, messages.map(m => ({
        role: m.role === 'agent' ? 'assistant' : 'user',
        content: m.content || m.text || ''
      })))
    } catch (e) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: `IA indisponible : ${e.message}` }) }
    }
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ reply: finalReply, actions: collectedActions, issues: collectedIssues })
  }
}
