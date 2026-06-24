// netlify/functions/auth.js
// Authentification OptiTechX — techniciens (PIN) et admin (identifiant/mot de passe)
//
// Variables d'environnement Netlify à configurer :
//   TECH_PINS   = JSON  ex: {"HERBET":"1234","BEUZELIN":"5678"}
//   ADMIN_USER  = string  ex: admin
//   ADMIN_PASS  = string  ex: monMotDePasse
//   AUTH_SECRET = string  clé de signature des tokens (aléatoire, longue)

const crypto = require('crypto')

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

// Signe un payload JSON → token opaque (base64.hmac)
function signToken(payload, secret) {
  const data = JSON.stringify(payload)
  const hmac = crypto.createHmac('sha256', secret).update(data).digest('hex')
  return Buffer.from(data).toString('base64url') + '.' + hmac
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return {
    statusCode: 200,
    headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST,OPTIONS' },
    body: ''
  }

  if (event.httpMethod !== 'POST') return {
    statusCode: 405, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'Méthode non autorisée' })
  }

  let body = {}
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ ok: false, error: 'Body JSON invalide' }) }
  }

  const secret = process.env.AUTH_SECRET || 'optitechx-dev-secret-changeme'
  const { type } = body

  // ── Authentification Technicien (PIN) ──────────────────────────────────
  if (type === 'tech') {
    const { nom, pin } = body
    if (!nom || !pin) return {
      statusCode: 400, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Nom et PIN requis' })
    }

    let pins = {}
    try { pins = JSON.parse(process.env.TECH_PINS || '{}') } catch {}

    const key = nom.toUpperCase()
    const expected = pins[key] || pins[nom]
    if (!expected || pin !== String(expected)) return {
      statusCode: 401, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Code PIN incorrect' })
    }

    const token = signToken(
      { nom, role: 'tech', exp: Date.now() + 12 * 3600 * 1000 },
      secret
    )
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: true, token, nom, role: 'tech' })
    }
  }

  // ── Authentification Admin (identifiant + mot de passe) ────────────────
  if (type === 'admin') {
    const { username, password } = body
    if (!username || !password) return {
      statusCode: 400, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Identifiant et mot de passe requis' })
    }

    const adminUser = process.env.ADMIN_USER || 'admin'
    const adminPass = process.env.ADMIN_PASS || ''

    if (!adminPass) return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'ADMIN_PASS non configuré' })
    }

    if (username !== adminUser || password !== adminPass) return {
      statusCode: 401, headers: CORS,
      body: JSON.stringify({ ok: false, error: 'Identifiants incorrects' })
    }

    const token = signToken(
      { nom: username, role: 'admin', exp: Date.now() + 12 * 3600 * 1000 },
      secret
    )
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: true, token, nom: username, role: 'admin' })
    }
  }

  return {
    statusCode: 400, headers: CORS,
    body: JSON.stringify({ ok: false, error: 'type doit être "tech" ou "admin"' })
  }
}
