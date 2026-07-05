// netlify/functions/settings.js
// Persistance des paramètres OptiQ via Netlify Blobs (cross-device)

import { getStore } from '@netlify/blobs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
}

// Vérifie le token Supabase (Authorization: Bearer <token>) et confirme le rôle admin
// via la table profiles (protégée par RLS : chacun ne lit que sa propre ligne).
async function isAdminRequest(request) {
  const authHeader = request.headers.get('Authorization') || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  const SB_URL = process.env.SUPABASE_URL
  const SB_ANON = process.env.SUPABASE_ANON_KEY
  if (!token || !SB_URL || !SB_ANON) return false

  try {
    const userRes = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` }
    })
    if (!userRes.ok) return false
    const user = await userRes.json()
    if (!user?.id) return false

    const profRes = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${user.id}&select=role`, {
      headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` }
    })
    if (!profRes.ok) return false
    const rows = await profRes.json()
    return rows?.[0]?.role === 'admin'
  } catch {
    return false
  }
}

// Retire les secrets (mot de passe admin legacy, PIN techniciens) de la réponse publique
function sanitize(data) {
  const { adminCreds, ...safe } = data || {}
  if (Array.isArray(safe.techs)) {
    safe.techs = safe.techs.map(({ code, ...t }) => t)
  }
  return safe
}

export default async (request) => {
  if (request.method === 'OPTIONS')
    return new Response('', { status: 200, headers: CORS })

  try {
    const store = getStore({ name: 'optiq-config', consistency: 'strong' })

    if (request.method === 'GET') {
      const data = await store.get('settings', { type: 'json' }).catch(() => null) || {}
      const admin = await isAdminRequest(request)
      return new Response(JSON.stringify(admin ? data : sanitize(data)), { status: 200, headers: CORS })
    }

    if (request.method === 'POST') {
      if (!(await isAdminRequest(request)))
        return new Response(JSON.stringify({ error: 'Non autorisé' }), { status: 403, headers: CORS })

      let body
      try { body = await request.json() }
      catch { return new Response(JSON.stringify({ error: 'JSON invalide' }), { status: 400, headers: CORS }) }

      await store.set('settings', JSON.stringify({ ...body, _savedAt: new Date().toISOString() }))
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS })
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS })
  } catch (e) {
    console.error('Settings error:', e.message)
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS })
  }
}

export const config = { path: '/api/settings' }
