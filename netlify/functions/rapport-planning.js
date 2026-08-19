// netlify/functions/rapport-planning.js
// GET /api/rapport-planning → retourne le dernier rapport généré par l'orchestrateur
// Utilisé par le dashboard /report/index.html (polling 15 s)

const { getStore } = require('@netlify/blobs')

const CORS = {
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin':  'https://optitechx.netlify.app',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
}

const EMPTY_REPORT = {
  version: 'planning-report-v3',
  generatedAt: null,
  dateRange:   { from: null, to: null },
  kpis: {
    totalInterventions:    0,
    interventionsValidees: 0,
    anomaliesCritiques:    0,
    anomaliesWarnings:     0,
    kmTotal:               0,
    kmEconomies:           0,
    techCount:             0,
    tauxFaisabilite:       1
  },
  agents: {
    validateur:    { status: 'idle' },
    logistique:    { status: 'idle' },
    optimiseur:    { status: 'idle' },
    orchestrateur: { status: 'idle' }
  },
  anomalies:    [],
  groqDecision: null,
  log:          [{ ts: new Date().toISOString(), level: 'info', msg: 'Aucun rapport disponible — lancez un traitement via POST /api/traiter-planning' }],
  planning:     {}
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
  if (event.httpMethod !== 'GET')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) }

  const _authHeader = event.headers?.authorization || event.headers?.Authorization || ''
  if (!(await verifyAdmin(_authHeader))) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Réservé aux administrateurs' }) }

  try {
    const store = getStore({ name: 'optiq-planning', consistency: 'strong' })
    const raw   = await store.get('last-report')

    if (!raw) return { statusCode: 200, headers: CORS, body: JSON.stringify(EMPTY_REPORT) }

    return { statusCode: 200, headers: CORS, body: raw }
  } catch {
    return { statusCode: 200, headers: CORS, body: JSON.stringify(EMPTY_REPORT) }
  }
}
