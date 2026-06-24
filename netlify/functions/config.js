const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
const { getStore } = require('@netlify/blobs')

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' }

  // Noms des techniciens actifs depuis le blob settings (source = panneau Paramètres admin)
  let techniciens = []
  try {
    const store = getStore({ name: 'optiq-config', consistency: 'strong' })
    const settings = await store.get('settings', { type: 'json' })
    if (settings?.techs?.length) {
      techniciens = settings.techs.filter(t => t.avail !== false).map(t => t.name)
    }
  } catch {}

  // Fallback : env var TECH_PINS (clés) puis défauts hardcodés
  if (!techniciens.length) {
    try {
      const pins = JSON.parse(process.env.TECH_PINS || '{}')
      const keys = Object.keys(pins)
      if (keys.length) techniciens = keys
    } catch {}
  }
  if (!techniciens.length) techniciens = ['Johann', 'Cindy', 'Priscillia', 'Nathan']

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      companyName:  process.env.OPTIQ_COMPANY_NAME  || 'Defiligne',
      depotAddress: process.env.OPTIQ_DEPOT_ADDRESS || '7 rue des entrepreneurs, 78540 Vernouillet',
      depotLat:     process.env.OPTIQ_DEPOT_LAT     || '48.965',
      depotLng:     process.env.OPTIQ_DEPOT_LNG     || '1.967',
      kizeoToken:   process.env.OPTIQ_KIZEO_TOKEN   || '',
      kizeoFormId:  process.env.OPTIQ_KIZEO_FORM_ID || '',
      brevoKey:     process.env.OPTIQ_BREVO_KEY      || '',
      techniciens,
    })
  }
}
