const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a))
const BASE = 'https://forms.kizeo.com/rest/v3'
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) }

  let req
  try { req = JSON.parse(event.body) } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) } }

  const { action, token: bodyToken, formId, data } = req
  const token = bodyToken || process.env.OPTIQ_KIZEO_TOKEN
  const fId = formId || process.env.OPTIQ_KIZEO_FORM_ID
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Token Kizeo manquant' }) }

  const h = { 'Content-Type': 'application/json', Authorization: token }

  try {
    switch (action) {
      case 'pull_unread': {
        const r = await fetch(`${BASE}/forms/${fId}/data/unread/optiq/100?includeupdated&format=basic`, { headers: h })
        return { statusCode: r.status, headers: CORS, body: JSON.stringify(await r.json()) }
      }
      case 'push_intervention': {
        const r = await fetch(`${BASE}/forms/${fId}/push`, { method: 'POST', headers: h, body: JSON.stringify({ recipient_user_id: data.recipientUserId, planningStart: data.planningStart || null, planningEnd: data.planningEnd || null, fields: data.fields }) })
        return { statusCode: r.status, headers: CORS, body: JSON.stringify(await r.json()) }
      }
      case 'push_batch': {
        const results = []
        for (const item of data) {
          const r = await fetch(`${BASE}/forms/${fId}/push`, { method: 'POST', headers: h, body: JSON.stringify({ recipient_user_id: item.recipientUserId, planningStart: item.planningStart || null, planningEnd: item.planningEnd || null, fields: item.fields }) })
          results.push({ status: r.status, data: await r.json() })
          await new Promise(res => setTimeout(res, 220))
        }
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'ok', results }) }
      }
      case 'mark_read': {
        const r = await fetch(`${BASE}/forms/${fId}/markasreadbyaction/optiq`, { method: 'POST', headers: h, body: JSON.stringify({ data_ids: data.dataIds }) })
        return { statusCode: r.status, headers: CORS, body: JSON.stringify(await r.json()) }
      }
      case 'get_users': {
        const r = await fetch(`${BASE}/users`, { headers: h })
        return { statusCode: r.status, headers: CORS, body: JSON.stringify(await r.json()) }
      }
      default:
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Action inconnue: ${action}` }) }
    }
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Proxy error: ' + e.message }) }
  }
}
