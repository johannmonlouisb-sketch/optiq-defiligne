// netlify/functions/config.js  (Netlify Functions v2 — ESM)
import { getStore } from '@netlify/blobs'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }

export default async (request) => {
  if (request.method === 'OPTIONS')
    return new Response('', { status: 200, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } })

  // Noms des techniciens depuis le blob settings (Paramètres admin → techs actifs)
  let techniciens = []
  try {
    const store = getStore({ name: 'optiq-config', consistency: 'strong' })
    const settings = await store.get('settings', { type: 'json' })
    if (settings?.techs?.length) {
      techniciens = settings.techs
        .filter(t => t.avail !== false)
        .map(t => ({ nom: t.name, color: t.color || '#1565C0' }))
    }
  } catch {}

  // Fallback → env var TECH_PINS (clés) puis noms par défaut
  if (!techniciens.length) {
    try {
      const keys = Object.keys(JSON.parse(process.env.TECH_PINS || '{}'))
      if (keys.length) techniciens = keys
    } catch {}
  }
  if (!techniciens.length) techniciens = [
    { nom: 'Johann',     color: '#E65100' },
    { nom: 'Cindy',      color: '#1565C0' },
    { nom: 'Priscillia', color: '#7B1FA2' },
    { nom: 'Nathan',     color: '#B71C1C' },
  ]

  return new Response(JSON.stringify({
    companyName:  process.env.OPTIQ_COMPANY_NAME  || 'Defiligne',
    depotAddress: process.env.OPTIQ_DEPOT_ADDRESS || '7 rue des entrepreneurs, 78540 Vernouillet',
    depotLat:     process.env.OPTIQ_DEPOT_LAT     || '48.965',
    depotLng:     process.env.OPTIQ_DEPOT_LNG     || '1.967',
    kizeoToken:   process.env.OPTIQ_KIZEO_TOKEN   || '',
    kizeoFormId:  process.env.OPTIQ_KIZEO_FORM_ID || '',
    brevoKey:     process.env.OPTIQ_BREVO_KEY      || '',
    techniciens,
  }), { status: 200, headers: CORS })
}

export const config = { path: '/api/config' }
