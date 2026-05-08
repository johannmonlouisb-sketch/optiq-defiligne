// netlify/functions/agent.js
// Agent IA OptiQ — Planification autonome des tournées
// Se déclenche automatiquement chaque soir à 20h00
// Lit Notion → Optimise → Écrit Kizeo → Notifie Brevo

// ─────────────────────────────────────────────────────────────
// SCHEDULE : tous les soirs à 20h (heure Paris = 19h UTC)
// ─────────────────────────────────────────────────────────────
export const config = {
  schedule: "0 19 * * *"   // 20h Paris (UTC+1) — chaque jour
}

const NOTION_VERSION = '2022-06-28'
const NOTION_BASE    = 'https://api.notion.com/v1'
const KIZEO_BASE     = 'https://forms.kizeo.com/rest/v3'
const GROQ_BASE      = 'https://api.groq.com/openai/v1'
const BREVO_BASE     = 'https://api.brevo.com/v3'

// ─────────────────────────────────────────────────────────────
// POINT D'ENTRÉE PRINCIPAL
// ─────────────────────────────────────────────────────────────
export default async (req) => {

  const log = []
  const push = (msg) => { console.log(msg); log.push(msg) }

  push(`\n🤖 Agent OptiQ démarré — ${new Date().toLocaleString('fr-FR', {timeZone:'Europe/Paris'})}`)

  // Config depuis ENV Netlify
  const cfg = {
    notionToken:   process.env.NOTION_TOKEN,
    notionDbId:    process.env.NOTION_DB_ID || '3ab30393-8dd2-4f10-98e4-b7f7b1c91f60',
    kizeoToken:    process.env.OPTIQ_KIZEO_TOKEN,
    kizeoFormId:   process.env.OPTIQ_KIZEO_FORM_ID,
    brevoKey:      process.env.OPTIQ_BREVO_KEY,
    groqKey:       process.env.GROQ_API_KEY || process.env.GROQ,
    depotAddress:  process.env.OPTIQ_DEPOT_ADDRESS || '7 rue des entrepreneurs, 78540 Vernouillet',
    alertEmail:    process.env.OPTIQ_ALERT_EMAIL || '',
  }

  // Vérifications
  if (!cfg.notionToken) { push('❌ NOTION_TOKEN manquant'); return new Response('Missing NOTION_TOKEN', {status:500}) }
  if (!cfg.groqKey)     { push('❌ GROQ_API_KEY manquant'); return new Response('Missing GROQ_API_KEY', {status:500}) }

  try {
    // ── ÉTAPE 1 : Lire les interventions de demain dans Notion ─────────────
    push('\n📖 ÉTAPE 1 — Lecture Notion...')
    const tomorrow = getTomorrow()
    const in7days  = getDatePlus(7)
    push(`   Fenêtre : ${tomorrow} → ${in7days}`)

    const interventions = await fetchNotionInterventions(cfg, tomorrow, in7days)
    push(`   ✅ ${interventions.length} interventions trouvées`)

    if (!interventions.length) {
      push('   Aucune intervention — agent terminé.')
      return new Response(JSON.stringify({status:'ok', log}), {status:200})
    }

    // ── ÉTAPE 2 : Grouper par date puis par technicien ─────────────────────
    push('\n📊 ÉTAPE 2 — Groupement par date/technicien...')
    const byDateTech = groupByDateTech(interventions)
    const days = Object.keys(byDateTech).sort()
    push(`   ${days.length} jour(s) à planifier : ${days.join(', ')}`)

    const results = []

    for (const date of days) {
      push(`\n📅 Traitement du ${date}...`)
      const techGroups = byDateTech[date]

      for (const [techName, ivs] of Object.entries(techGroups)) {
        push(`   👤 ${techName} — ${ivs.length} interventions`)

        // ── ÉTAPE 3 : Analyse IA de la tournée ─────────────────────────────
        push(`   🤖 Analyse IA...`)
        const analysis = await analyzeWithClaude(cfg, date, techName, ivs)

        if (analysis.impossible) {
          push(`   ⚠️ Journée impossible : ${analysis.reason}`)
          push(`   📋 Suggestions : ${analysis.suggestions?.join(' | ')}`)
          if (cfg.alertEmail) await sendAlertEmail(cfg, techName, date, analysis)
          results.push({ date, tech: techName, status: 'impossible', reason: analysis.reason, suggestions: analysis.suggestions })
          continue
        }

        push(`   ✅ Route optimisée : ${analysis.totalKm}km, ~${analysis.totalHours}h`)
        push(`   Ordre : ${analysis.orderedRoute?.map(i=>i.client).join(' → ')}`)

        // ── ÉTAPE 4 : Push planning dans Kizeo ─────────────────────────────
        if (cfg.kizeoToken && cfg.kizeoFormId) {
          push(`   📲 Envoi Kizeo...`)
          const kizeoResult = await pushToKizeo(cfg, analysis.orderedRoute, techName, date)
          push(`   ${kizeoResult.ok ? '✅' : '⚠️'} Kizeo : ${kizeoResult.message}`)
        } else {
          push(`   ⏭️  Kizeo non configuré — skipped`)
        }

        // ── ÉTAPE 5 : Notifications clients J+1 ────────────────────────────
        if (cfg.brevoKey && date === tomorrow) {
          push(`   📧 Notifications clients...`)
          const notifResult = await sendClientNotifications(cfg, analysis.orderedRoute, date)
          push(`   ✅ ${notifResult.sent} notification(s) envoyée(s)`)
        }

        results.push({
          date, tech: techName, status: 'ok',
          totalKm: analysis.totalKm,
          totalHours: analysis.totalHours,
          count: analysis.orderedRoute?.length
        })
      }
    }

    // ── ÉTAPE 6 : Rapport final ─────────────────────────────────────────────
    push('\n📋 RAPPORT FINAL :')
    results.forEach(r => {
      const s = r.status==='ok' ? '✅' : '⚠️'
      push(`  ${s} ${r.date} / ${r.tech} : ${r.status==='ok' ? `${r.count} arrêts, ${r.totalKm}km, ${r.totalHours}h` : r.reason}`)
    })
    push(`\n🏁 Agent terminé — ${new Date().toLocaleString('fr-FR', {timeZone:'Europe/Paris'})}`)

    return new Response(JSON.stringify({status:'ok', results, log}), {
      status: 200,
      headers: {'Content-Type':'application/json'}
    })

  } catch (e) {
    push(`\n❌ Erreur fatale : ${e.message}`)
    console.error(e)
    return new Response(JSON.stringify({status:'error', error:e.message, log}), {status:500})
  }
}

// ═══════════════════════════════════════════════════════════════
// NOTION — Lire les interventions
// ═══════════════════════════════════════════════════════════════
async function fetchNotionInterventions(cfg, dateFrom, dateTo) {
  const headers = {
    'Authorization': `Bearer ${cfg.notionToken}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  }

  const payload = {
    page_size: 100,
    sorts: [{ property: 'Date intervention', direction: 'ascending' }],
    filter: {
      and: [
        { property: 'Date intervention', date: { on_or_after: dateFrom } },
        { property: 'Date intervention', date: { on_or_before: dateTo  } },
        { property: 'Terminer', checkbox: { equals: false } }
      ]
    }
  }

  let all = [], next = null
  do {
    if (next) payload.start_cursor = next
    const r = await fetch(`${NOTION_BASE}/databases/${cfg.notionDbId}/query`, {
      method:'POST', headers, body: JSON.stringify(payload)
    })
    const d = await r.json()
    if (!r.ok) throw new Error(`Notion query failed: ${JSON.stringify(d)}`)
    all = all.concat(d.results || [])
    next = d.has_more ? d.next_cursor : null
  } while (next)

  return all.map(page => {
    const p = page.properties || {}
    return {
      notionId: page.id,
      client:   nProp(p, 'Société'),
      addr:     nProp(p, 'Adresse Site'),
      siege:    nProp(p, 'Adresse Siéges'),
      date:     nProp(p, 'Date intervention'),
      tech:     nProp(p, 'Technicien') || nProp(p, 'Technicien ') || 'Non assigné',
      commercial: nProp(p, 'Commercial '),
      type:     nProp(p, 'INTERVENTION'),  // multi_select → CSV
      notes:    nProp(p, 'INFO '),
      motif:    nProp(p, 'Motif'),
      contact:  nProp(p, 'Contact site'),
      phone:    nProp(p, 'Téléphone'),
      phone1:   nProp(p, 'Téléphone 1'),
      email:    nProp(p, 'E-mail'),
      urgent:   !!(nProp(p, 'Urgent')),   // texte non vide = urgent
      exter:    nProp(p, 'EXTER') === true,
    }
  }).filter(iv => iv.client && iv.date)
}

function nProp(props, ...keys) {
  for (const k of keys) {
    const v = props[k]
    if (!v) continue
    if (v.type==='title')        return v.title?.map(t=>t.plain_text).join('') || ''
    if (v.type==='rich_text')    return v.rich_text?.map(t=>t.plain_text).join('') || ''
    if (v.type==='date')         return v.date?.start || ''
    if (v.type==='select')       return v.select?.name || ''
    if (v.type==='multi_select') return v.multi_select?.map(s=>s.name).join(', ') || ''
    if (v.type==='checkbox')     return !!v.checkbox
    if (v.type==='email')        return v.email || ''
    if (v.type==='phone_number') return v.phone_number || ''
    if (v.type==='people')       return v.people?.map(p=>p.name).join(', ') || ''
    if (v.type==='files')        return v.files?.length > 0
  }
  return ''
}

// ═══════════════════════════════════════════════════════════════
// GROUPEMENT
// ═══════════════════════════════════════════════════════════════
function groupByDateTech(interventions) {
  const result = {}
  for (const iv of interventions) {
    const date = iv.date?.substring(0,10) || 'unknown'
    const tech = iv.tech || 'Non assigné'
    if (!result[date]) result[date] = {}
    if (!result[date][tech]) result[date][tech] = []
    result[date][tech].push(iv)
  }
  return result
}

// ═══════════════════════════════════════════════════════════════
// CLAUDE — Analyse et optimisation de la tournée
// ═══════════════════════════════════════════════════════════════
async function analyzeWithClaude(cfg, date, techName, interventions) {
  const prompt = `Tu es un expert en optimisation de tournées pour des techniciens de maintenance DEA (défibrillateurs) en France.

DATE : ${date}
TECHNICIEN : ${techName}
DÉPÔT : 7 rue des entrepreneurs, 78540 Vernouillet (coordonnées: 48.965, 1.967)

INTERVENTIONS À PLANIFIER (${interventions.length}) :
${interventions.map((iv,i) => `${i+1}. ${iv.client}
   Adresse: ${iv.addr || iv.siege || 'Non renseignée'}
   Type: ${iv.type || 'Maintenance'}
   ${iv.urgent ? '⚠️ URGENT' : ''}
   ${iv.notes ? `Notes: ${iv.notes}` : ''}`).join('\n\n')}

CONTRAINTES LÉGALES (Code du travail FR) :
- Maximum 9h de travail effectif par jour (objectif)
- Maximum 12h légal absolu (Art. L3121-18)
- Pause 20min obligatoire après 6h (Art. L3121-33)
- Durée par intervention : Maintenance=20min, Installation=40min, Maintenance+pad pak=30min
- Temps de trajet moyen entre adresses : 20-30min en région parisienne, 45min en rural

ANALYSE REQUISE :
1. Est-ce que cette journée est RÉALISABLE par UN technicien ?
2. Quel est l'ordre optimal des visites (minimiser les km) ?
3. Si impossible, comment redistribuer ?

Réponds UNIQUEMENT en JSON valide, sans markdown :
{
  "possible": true/false,
  "impossible": false/true,
  "reason": "explication si impossible",
  "totalKm": 120,
  "totalHours": 7.5,
  "workHours": 4.5,
  "travelHours": 3.0,
  "orderedRoute": [
    {"index": 0, "client": "...", "addr": "...", "notionId": "...", "estimatedTime": "09:00", "durationMin": 20, "notes": "..."},
    ...
  ],
  "suggestions": ["Si impossible : suggestion 1", "suggestion 2"],
  "alerts": ["Points d'attention éventuels"],
  "startTime": "07:30",
  "endTime": "17:00"
}`

  if (!cfg.groqKey) throw new Error('GROQ_API_KEY manquante — configurez-la dans Netlify')
  const r = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.groqKey}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 2000,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }]
    })
  })

  const data = await r.json()
  if (!r.ok) throw new Error(`Groq API error: ${JSON.stringify(data)}`)

  const text = data.choices?.[0]?.message?.content || '{}'
  try {
    return JSON.parse(text.replace(/```json|```/g,'').trim())
  } catch(e) {
    // Fallback si JSON malformé
    return {
      impossible: false,
      possible: true,
      totalKm: 50,
      totalHours: 6,
      orderedRoute: interventions.map((iv,i) => ({
        index: i, client: iv.client, addr: iv.addr||iv.siege,
        notionId: iv.notionId, estimatedTime: '', durationMin: 20
      })),
      alerts: ['Analyse IA partielle — vérifiez manuellement']
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// KIZEO — Push planning vers tablette technicien
// ═══════════════════════════════════════════════════════════════
async function pushToKizeo(cfg, route, techName, date) {
  if (!route?.length) return { ok: false, message: 'Route vide' }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': cfg.kizeoToken
  }

  let sent = 0
  for (const stop of route) {
    try {
      const r = await fetch(`${KIZEO_BASE}/forms/${cfg.kizeoFormId}/push`, {
        method: 'POST', headers,
        body: JSON.stringify({
          fields: {
            'societe':           { value: stop.client || '' },
            'adresse_site':      { value: stop.addr || '' },
            'date_intervention': { value: date },
            'technicien':        { value: techName },
            'heure_prevue':      { value: stop.estimatedTime || '' },
            'observations':      { value: stop.notes || '' },
          }
        })
      })
      if (r.ok) sent++
      await new Promise(res => setTimeout(res, 250)) // rate limit
    } catch(e) {
      console.warn('Kizeo push error:', e.message)
    }
  }

  return { ok: sent > 0, message: `${sent}/${route.length} fiches envoyées` }
}

// ═══════════════════════════════════════════════════════════════
// BREVO — Notifications clients
// ═══════════════════════════════════════════════════════════════
async function sendClientNotifications(cfg, route, date) {
  if (!cfg.brevoKey || !route?.length) return { sent: 0 }

  let sent = 0
  const dateFormatted = new Date(date+'T12:00:00').toLocaleDateString('fr-FR', {
    weekday:'long', day:'numeric', month:'long'
  })

  for (const stop of route) {
    if (!stop.email && !stop.phone) continue
    try {
      await fetch(`${BREVO_BASE}/smtp/email`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'api-key': cfg.brevoKey },
        body: JSON.stringify({
          sender: { name: 'Defiligne', email: 'contact@defiligne.fr' },
          to: [{ email: stop.email || 'noreply@defiligne.fr', name: stop.client }],
          subject: `Votre intervention DEA — ${dateFormatted}`,
          htmlContent: `<p>Bonjour,</p>
            <p>Un technicien Defiligne interviendra chez vous le <strong>${dateFormatted}</strong>
            ${stop.estimatedTime ? ` vers <strong>${stop.estimatedTime}</strong>` : ''}.</p>
            <p>Adresse : ${stop.addr}</p>
            <p>N'hésitez pas à nous contacter pour toute question.</p>
            <p>Cordialement,<br>L'équipe Defiligne</p>`
        })
      })
      sent++
      await new Promise(res => setTimeout(res, 200))
    } catch(e) {
      console.warn('Brevo error:', e.message)
    }
  }
  return { sent }
}

// ═══════════════════════════════════════════════════════════════
// ALERTE EMAIL — Si journée impossible
// ═══════════════════════════════════════════════════════════════
async function sendAlertEmail(cfg, techName, date, analysis) {
  if (!cfg.brevoKey || !cfg.alertEmail) return
  try {
    await fetch(`${BREVO_BASE}/smtp/email`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'api-key': cfg.brevoKey },
      body: JSON.stringify({
        sender: { name: 'OptiQ Agent', email: 'agent@defiligne.fr' },
        to: [{ email: cfg.alertEmail }],
        subject: `⚠️ OptiQ — Tournée impossible : ${techName} le ${date}`,
        htmlContent: `<h2>⚠️ Tournée impossible détectée</h2>
          <p><strong>Technicien :</strong> ${techName}</p>
          <p><strong>Date :</strong> ${date}</p>
          <p><strong>Raison :</strong> ${analysis.reason}</p>
          <h3>Suggestions de l'agent :</h3>
          <ul>${(analysis.suggestions||[]).map(s=>`<li>${s}</li>`).join('')}</ul>
          <p><a href="https://optiqtech.netlify.app/defiligne.html">👉 Ouvrir OptiQ pour corriger</a></p>`
      })
    })
  } catch(e) { console.warn('Alert email error:', e.message) }
}

// ═══════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════
function getTomorrow() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().split('T')[0]
}
function getDatePlus(n) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}
