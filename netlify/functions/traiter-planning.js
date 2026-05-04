// netlify/functions/traiter-planning.js
// POST /api/traiter-planning → lance le pipeline orchestrateur sur un batch Notion
// Body : { dateFrom: "YYYY-MM-DD", dateTo: "YYYY-MM-DD", tech?: "Nom Tech", updateNotion?: bool }

const { runPipeline } = require('./agent-orchestrateur-planning')

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) }

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

  // Limite 90 jours pour éviter les timeouts Netlify
  const diffDays = (dTo - dFrom) / (1000 * 60 * 60 * 24)
  if (diffDays > 90)
    return {
      statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'Plage maximale : 90 jours' })
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
