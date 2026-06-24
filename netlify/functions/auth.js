// netlify/functions/auth.js
// Authentification OptiTechX — techniciens (PIN) et admin (identifiant/mot de passe)
//
// Variables d'environnement Netlify (fallback si le blob settings n'est pas disponible) :
//   TECH_PINS   = JSON  ex: {"Johann":"7802","Cindy":"1234"}
//   ADMIN_USER  = string  ex: defiligne
//   ADMIN_PASS  = string  ex: monMotDePasse
//   AUTH_SECRET = string  clé de signature des tokens

const crypto = require('crypto')
const { getStore } = require('@netlify/blobs')

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

function signToken(payload, secret) {
  const data = JSON.stringify(payload)
  const hmac = crypto.createHmac('sha256', secret).update(data).digest('hex')
  return Buffer.from(data).toString('base64url') + '.' + hmac
}

// Charge les PINs depuis le blob settings (source principale) ou depuis l'env var (fallback)
async function loadTechPins() {
  try {
    const store = getStore({ name: 'optiq-config', consistency: 'strong' })
    const settings = await store.get('settings', { type: 'json' })
    if (settings?.techs?.length) {
      const pins = {}
      settings.techs.forEach(t => { if (t.name && t.code) pins[t.name.toUpperCase()] = t.code })
      if (Object.keys(pins).length) return pins
    }
  } catch {}
  // Fallback env var
  try { return JSON.parse(process.env.TECH_PINS || '{"JOHANN MONLOUIS":"7802"}') } catch {}
  return {}
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

    const pins = await loadTechPins()
    const key = nom.toUpperCase()
    // Recherche insensible à la casse
    const entry = Object.entries(pins).find(([k]) => k.toUpperCase() === key)
    const expected = entry?.[1]

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

    const adminUser = process.env.ADMIN_USER || 'defiligne'
    const adminPass = process.env.ADMIN_PASS || '7802'

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
