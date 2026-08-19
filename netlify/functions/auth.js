// netlify/functions/auth.js  (Netlify Functions v2 — ESM)
import crypto from 'crypto'
import { getStore } from '@netlify/blobs'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

// Durée de validité du token — alignée sur l'option "Rester connecté" côté tech.html
// (sessions longues attendues sur le terrain, pas une session web classique).
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000 // 30 jours

// Rate limiting PIN : 5 essais max, puis verrouillage progressif par technicien.
const MAX_ATTEMPTS   = 5
const LOCKOUT_MS     = 5 * 60 * 1000 // 5 minutes

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

// ── Rate limiting (Netlify Blobs — persiste entre invocations) ──────────────
async function getAttemptState(key) {
  try {
    const store = getStore({ name: 'optiq-auth-attempts', consistency: 'strong' })
    const state = await store.get(key, { type: 'json' })
    return state || { count: 0, lockedUntil: 0 }
  } catch { return { count: 0, lockedUntil: 0 } }
}
async function setAttemptState(key, state) {
  try {
    const store = getStore({ name: 'optiq-auth-attempts', consistency: 'strong' })
    await store.setJSON(key, state)
  } catch {}
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

    const attemptKey = 'tech_' + nom.toLowerCase()
    const state = await getAttemptState(attemptKey)
    const now = Date.now()

    if (state.lockedUntil > now) {
      const remainingMin = Math.ceil((state.lockedUntil - now) / 60000)
      return json({ ok: false, error: `Trop de tentatives — réessayez dans ${remainingMin} min` }, 429)
    }

    const pins = await loadTechPins()
    const entry = pins[nom.toLowerCase()]

    if (!entry || pin !== entry.pin) {
      const count = (state.count || 0) + 1
      const locked = count >= MAX_ATTEMPTS
      await setAttemptState(attemptKey, {
        count: locked ? 0 : count,
        lockedUntil: locked ? now + LOCKOUT_MS : 0
      })
      if (locked) return json({ ok: false, error: `Trop de tentatives — réessayez dans ${Math.ceil(LOCKOUT_MS / 60000)} min` }, 429)
      return json({ ok: false, error: 'Code PIN incorrect' }, 401)
    }

    // Succès — réinitialise le compteur de tentatives
    await setAttemptState(attemptKey, { count: 0, lockedUntil: 0 })

    const token = signToken({ nom: entry.nom, role: 'tech', exp: now + TOKEN_TTL_MS }, secret)
    return json({ ok: true, token, nom: entry.nom, role: 'tech' })
  }

  // L'authentification admin passe désormais par Supabase Auth (voir login.html) —
  // cette route ne gère plus que les techniciens.
  return json({ ok: false, error: 'type doit être "tech"' }, 400)
}

export const config = { path: '/api/auth/login' }
