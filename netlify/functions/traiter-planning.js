// netlify/functions/traiter-planning.js
// POST /api/traiter-planning → lance le pipeline orchestrateur sur un batch Notion
// Body : { dateFrom: "YYYY-MM-DD", dateTo: "YYYY-MM-DD", tech?: "Nom Tech", updateNotion?: bool }

const { runPipeline } = require('./agent-orchestrateur-planning')

const CORS = {
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin':  'https://optitechx.netlify.app',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
}

// SÉCURITÉ : réservé aux administrateurs (session Supabase Auth + profiles.role='admin').
async function verifyAdmin(authHeader) {
  const token = (authHeader || '').startsWith('Bearer ') ? authHeader.slice(7) : null
  const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '')
  const SB_ANON = process.env.SUPABASE_ANON_KEY
  if (!token || !SB_URL || !SB_ANON) return false
  try {
    const userRes = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` } })
    if (!userRes.ok) return false
    const user = await userRes.json()
    if (!user?.id) return false
    const profRes = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${user.id}&select=role`, { headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` } })
    if (!profRes.ok) return false
    const rows = await profRes.json()
    return rows?.[0]?.role === 'admin'
  } catch { return false }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) }

  const _authHeader = event.headers?.authorization || event.headers?.Authorization || ''
  if (!(await verifyAdmin(_authHeader))) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Réservé aux administrateurs' }) }

  let body
  try { body = JSON.parse(event.body || '{}') }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) } }

  const { dateFrom, dateTo, tech, updateNotion = false } = body

  if (!dateFrom || !dateTo)
    return {
      statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: '"dateFrom" et "dateTo" sont obligatoires (format YYYY-MM-DD)' })
    }

  // Validation basique des dates
  const dFrom = new Date(dateFrom)
  const dTo   = new Date(dateTo)
  if (isNaN(dFrom) || isNaN(dTo) || dFrom > dTo)
    return {
      statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'Dates invalides ou dateFrom > dateTo' })
    }

  // Limite 21 jours — le pipeline fait un appel Vroom externe par jour (+ Groq pour les
  // découchers) de façon séquentielle ; au-delà, le traitement dépasse le délai d'exécution
  // de la fonction Netlify et celle-ci renvoie une page d'erreur HTML (pas du JSON), ce qui
  // provoquait un message cryptique côté interface.
  const diffDays = (dTo - dFrom) / (1000 * 60 * 60 * 24)
  if (diffDays > 21)
    return {
      statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: `Plage maximale : 21 jours (demandé : ${Math.round(diffDays)} jours) — le traitement est trop long au-delà pour tenir dans le délai serveur` })
    }

  try {
    const report = await runPipeline({ dateFrom, dateTo, tech, updateNotion })
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: true,
        generatedAt: report.generatedAt,
        kpis:        report.kpis,
        anomalies:   report.anomalies?.length || 0,
        message:     `Planning analysé : ${report.kpis.totalInterventions} interventions, ${report.kpis.anomaliesCritiques} critique(s)`
      })
    }
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) }
  }
}
