// netlify/functions/kizeo.js
// Proxy Kizeo Forms — résout le CORS navigateur.
//
// SÉCURITÉ : authentification obligatoire pour toutes les actions (admin =
// session Supabase Auth, technicien = token HMAC signé par auth.js — même
// pattern que notion.js). Le token Kizeo ne vient plus jamais du client : avant,
// n'importe qui pouvait appeler cet endpoint sans identité, et sans fournir de
// token le serveur retombait silencieusement sur le vrai secret d'entreprise
// (OPTIQ_KIZEO_TOKEN) — proxy Kizeo totalement ouvert. Le champ "token" envoyé
// par le corps de la requête (configuration Kizeo personnelle par utilisateur,
// stockée dans le navigateur) n'est plus utilisé : le serveur utilise toujours
// sa propre clé.

const crypto = require('crypto')
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a))
const BASE = 'https://forms.kizeo.com/rest/v3'
const CORS = {
  'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': 'https://optitechx.netlify.app', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' }

async function verifyAdmin(authHeader) {
  const token = (authHeader || '').startsWith('Bearer ') ? authHeader.slice(7) : null
  const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '')
  const SB_ANON = process.env.SUPABASE_ANON_KEY
  if (!token || !SB_URL || !SB_ANON) return null
  try {
    const userRes = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` } })
    if (!userRes.ok) return null
    const user = await userRes.json()
    if (!user?.id) return null
    const profRes = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${user.id}&select=role`, { headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` } })
    if (!profRes.ok) return null
    const rows = await profRes.json()
    return rows?.[0]?.role === 'admin' ? { role: 'admin' } : null
  } catch { return null }
}

function verifyTechToken(authHeader) {
  const token  = (authHeader || '').startsWith('Bearer ') ? authHeader.slice(7) : null
  const secret = process.env.AUTH_SECRET
  if (!token || !secret) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [dataB64, sig] = parts
  let data
  try { data = Buffer.from(dataB64, 'base64url').toString() } catch { return null }
  const expected = crypto.createHmac('sha256', secret).update(data).digest('hex')
  let sigBuf, expBuf
  try { sigBuf = Buffer.from(sig, 'hex'); expBuf = Buffer.from(expected, 'hex') } catch { return null }
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null
  let payload
  try { payload = JSON.parse(data) } catch { return null }
  if (payload.role !== 'tech' || !payload.nom) return null
  if (!payload.exp || Date.now() > payload.exp) return null
  return { role: 'tech', nom: payload.nom }
}

async function authenticate(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || ''
  const admin = await verifyAdmin(authHeader)
  if (admin) return admin
  const tech = verifyTechToken(authHeader)
  if (tech) return tech
  return null
}

// Actions utilisables par un technicien (usage réel observé dans tech.html :
// pull_unread + push_intervention). push_batch et get_users restent admin
// uniquement (envoi de masse vers toutes les tablettes / liste complète des
// utilisateurs Kizeo). mark_read n'est appelé nulle part actuellement mais
// suit logiquement pull_unread — autorisé aux deux par cohérence.
const TECH_ALLOWED_ACTIONS = new Set(['pull_unread', 'push_intervention', 'mark_read'])

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST,OPTIONS' }, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) }

  const actor = await authenticate(event)
  if (!actor) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authentification requise' }) }

  let req
  try { req = JSON.parse(event.body) } catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) } }

  const { action, formId, data } = req

  if (actor.role === 'tech' && !TECH_ALLOWED_ACTIONS.has(action)) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: `Action non autorisée pour un technicien : ${action}` }) }
  }

  // Le token Kizeo vient toujours du serveur, jamais du client (cf. commentaire en tête de fichier)
  const token = process.env.OPTIQ_KIZEO_TOKEN
  const fId = formId || process.env.OPTIQ_KIZEO_FORM_ID
  if (!token) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Token Kizeo manquant côté serveur' }) }

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
