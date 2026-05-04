// netlify/functions/settings.js
// Persistance des paramètres OptiQ via Netlify Blobs (cross-device)

import { getStore } from '@netlify/blobs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

export default async (request) => {
  if (request.method === 'OPTIONS')
    return new Response('', { status: 200, headers: CORS })

  try {
    const store = getStore({ name: 'optiq-config', consistency: 'strong' })

    if (request.method === 'GET') {
      const data = await store.get('settings', { type: 'json' }).catch(() => null)
      return new Response(JSON.stringify(data || {}), { status: 200, headers: CORS })
    }

    if (request.method === 'POST') {
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
