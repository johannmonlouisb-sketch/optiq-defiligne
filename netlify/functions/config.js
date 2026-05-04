const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' }
  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      companyName:  process.env.OPTIQ_COMPANY_NAME  || 'Defiligne',
      depotAddress: process.env.OPTIQ_DEPOT_ADDRESS  || '7 rue des entrepreneurs, 78540 Vernouillet',
      depotLat:     process.env.OPTIQ_DEPOT_LAT      || '48.965',
      depotLng:     process.env.OPTIQ_DEPOT_LNG      || '1.967',
      kizeoToken:   process.env.OPTIQ_KIZEO_TOKEN    || '',
      kizeoFormId:  process.env.OPTIQ_KIZEO_FORM_ID  || '',
      brevoKey:     process.env.OPTIQ_BREVO_KEY      || '',
    })
  }
}
