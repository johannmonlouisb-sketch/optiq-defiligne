// netlify/functions/auth.js  (Netlify Functions v2 — ESM)
import crypto from 'crypto'
import { getStore } from '@netlify/blobs'

const CORS = {
  'Access-Control-Allow-Origin':  'https://optitechx.netlify.app',
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

// Charge les PINs depuis le blob settings (source = Paramètres admin) ET depuis
// TECH_PINS env var — fusionnés (pas l'un OU l'autre) pour couvrir le cas où un
// technicien n'a pas encore de code personnalisé dans les Paramètres.
// Retourne une liste (pas un objet clé=nom) car le nom enregistré côté admin peut
// être le nom complet ("Johann Monlouis") alors que tech.html envoie le prénom
// seul — la correspondance se fait par id technicien en priorité (cf. findTechEntry).
async function loadTechPins() {
  const entries = []
  try {
    const store = getStore({ name: 'optiq-config', consistency: 'strong' })
    const settings = await store.get('settings', { type: 'json' })
    if (settings?.techs?.length) {
      settings.techs.forEach(t => { if (t.name && t.code) entries.push({ id: t.id, nom: t.name, pin: String(t.code) }) })
    }
  } catch {}
  try {
    const raw = JSON.parse(process.env.TECH_PINS || '{}')
    Object.entries(raw).forEach(([k, v]) => { if (v) entries.push({ id: null, nom: k, pin: String(v) }) })
  } catch {}
  return entries
}

// Résout l'entrée PIN correspondant à la connexion : priorité à l'id technicien
// (stable, insensible aux différences de nom/orthographe entre l'appli technicien
// et les Paramètres admin), puis correspondance sur le nom (exacte, puis sur le
// prénom seul, puis inclusion partielle en dernier recours).
function findTechEntry(entries, loginName, loginId) {
  if (loginId != null) {
    const byId = entries.find(e => e.id === loginId)
    if (byId) return byId
  }
  const n = (loginName || '').toLowerCase().trim()
  if (!n) return null
  return entries.find(e => e.nom.toLowerCase().trim() === n)
      || entries.find(e => e.nom.toLowerCase().trim().split(/\s+/)[0] === n)
      || entries.find(e => e.nom.toLowerCase().includes(n) || n.includes(e.nom.toLowerCase()))
      || null
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
    const { nom, pin, techId } = body
    if (!nom || !pin) return json({ ok: false, error: 'Nom et PIN requis' }, 400)

    const attemptKey = 'tech_' + nom.toLowerCase()
    const state = await getAttemptState(attemptKey)
    const now = Date.now()

    if (state.lockedUntil > now) {
      const remainingMin = Math.ceil((state.lockedUntil - now) / 60000)
      return json({ ok: false, error: `Trop de tentatives — réessayez dans ${remainingMin} min` }, 429)
    }

    const entries = await loadTechPins()
    const entry = findTechEntry(entries, nom, techId != null ? Number(techId) : null)

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
