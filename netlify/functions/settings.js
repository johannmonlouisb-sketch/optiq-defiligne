// netlify/functions/settings.js
// Persistance des paramètres OptiQ via Netlify Blobs (stockage cloud cross-device)

const { getStore } = require('@netlify/blobs')

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS')
    return { statusCode: 200, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }, body: '' }

  try {
    const store = getStore({ name: 'optiq-config', consistency: 'strong' })

    // GET — charger les paramètres
    if (event.httpMethod === 'GET') {
      const data = await store.get('settings', { type: 'json' }).catch(() => null)
      return { statusCode: 200, headers: CORS, body: JSON.stringify(data || {}) }
    }

    // POST — sauvegarder les paramètres
    if (event.httpMethod === 'POST') {
      let body
      try { body = JSON.parse(event.body || '{}') }
      catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) } }

      await store.set('settings', JSON.stringify({ ...body, _savedAt: new Date().toISOString() }))
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) }
    }

    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) }
  } catch (e) {
    console.error('Settings error:', e.message)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) }
  }
}
