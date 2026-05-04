// netlify/functions/rapport-planning.js
// GET /api/rapport-planning → retourne le dernier rapport généré par l'orchestrateur
// Utilisé par le dashboard /report/index.html (polling 15 s)

const { getStore } = require('@netlify/blobs')

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'GET')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'GET only' }) }

  try {
    const store = getStore({ name: 'optiq-planning', consistency: 'strong' })
    const raw   = await store.get('last-report')

    if (!raw) return { statusCode: 200, headers: CORS, body: JSON.stringify(EMPTY_REPORT) }

    return { statusCode: 200, headers: CORS, body: raw }
  } catch {
    return { statusCode: 200, headers: CORS, body: JSON.stringify(EMPTY_REPORT) }
  }
}
