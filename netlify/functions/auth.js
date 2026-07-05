// netlify/functions/auth.js  (Netlify Functions v2 — ESM)
import crypto from 'crypto'
import { getStore } from '@netlify/blobs'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS })
}

function signToken(payload, secret) {
  const data = JSON.stringify(payload)
  const hmac = crypto.createHmac('sha256', secret).update(data).digest('hex')
  return Buffer.from(data).toString('base64url') + '.' + hmac
}

// Charge les PINs depuis le blob settings (source = Paramètres admin)
// Fallback vers TECH_PINS env var si le blob est vide ou inaccessible
async function loadTechPins() {
  try {
    const store = getStore({ name: 'optiq-config', consistency: 'strong' })
    const settings = await store.get('settings', { type: 'json' })
    if (settings?.techs?.length) {
      const pins = {}
      settings.techs.forEach(t => { if (t.name && t.code) pins[t.name.toLowerCase()] = { nom: t.name, pin: String(t.code) } })
      if (Object.keys(pins).length) return pins
    }
  } catch {}
  // Fallback env var
  try {
    const raw = JSON.parse(process.env.TECH_PINS || '{}')
    const pins = {}
    Object.entries(raw).forEach(([k, v]) => { if (v) pins[k.toLowerCase()] = { nom: k, pin: String(v) } })
    return pins
  } catch {}
  return {}
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response('', { status: 200, headers: CORS })
  if (request.method !== 'POST') return json({ ok: false, error: 'Méthode non autorisée' }, 405)

  let body = {}
  try { body = await request.json() } catch {
    return json({ ok: false, error: 'Body JSON invalide' }, 400)
  }

  const secret = process.env.AUTH_SECRET
  const { type } = body

  // ── Authentification Technicien (PIN) ──────────────────────────────────
  if (type === 'tech') {
    const { nom, pin } = body
    if (!nom || !pin) return json({ ok: false, error: 'Nom et PIN requis' }, 400)

    const pins = await loadTechPins()
    const entry = pins[nom.toLowerCase()]

    if (!entry || pin !== entry.pin) return json({ ok: false, error: 'Code PIN incorrect' }, 401)

    const token = signToken({ nom: entry.nom, role: 'tech', exp: Date.now() + 12 * 3600 * 1000 }, secret)
    return json({ ok: true, token, nom: entry.nom, role: 'tech' })
  }

  // L'authentification admin passe désormais par Supabase Auth (voir login.html) —
  // cette route ne gère plus que les techniciens.
  return json({ ok: false, error: 'type doit être "tech"' }, 400)
}

export const config = { path: '/api/auth/login' }
