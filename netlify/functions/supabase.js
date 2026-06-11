// netlify/functions/supabase.js
// Proxy Notion uniquement (résout CORS) — Supabase est appelé directement depuis le navigateur

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

async function fetchNotionKizeo() {
  const NOTION_VERSION = '2022-06-28'
  const NOTION_BASE    = 'https://api.notion.com/v1'
  const token          = process.env.NOTION_TOKEN
  const kizeoDbId      = process.env.NOTION_DB_KIZEO || '4326bdb2994b42509759a897ff7a4a1f'
  if (!token) throw new Error('NOTION_TOKEN manquant')

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  }

  const nP = (p, k) => {
    const v = p[k]; if (!v) return ''
    if (v.type === 'title')        return v.title?.map(t => t.plain_text).join('') || ''
    if (v.type === 'rich_text')    return v.rich_text?.map(t => t.plain_text).join('') || ''
    if (v.type === 'date')         return v.date?.start || ''
    if (v.type === 'select')       return v.select?.name || ''
    if (v.type === 'number')       return v.number ?? null
    if (v.type === 'phone_number') return v.phone_number || ''
    if (v.type === 'email')        return v.email || ''
    if (v.type === 'checkbox')     return !!v.checkbox
    return ''
  }

  const toDate = s => {
    if (!s || typeof s !== 'string') return null
    const d = s.substring(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
  }

  let all = [], next = null
  do {
    const payload = { page_size: 100, ...(next ? { start_cursor: next } : {}) }
    const r = await fetch(`${NOTION_BASE}/databases/${kizeoDbId}/query`, {
      method: 'POST', headers, body: JSON.stringify(payload)
    })
    const d = await r.json()
    if (!r.ok) throw new Error(`Notion ${r.status}`)
    all = all.concat(d.results || [])
    next = d.has_more ? d.next_cursor : null
  } while (next)

  return all.map(page => {
    const p = page.properties || {}
    return {
      notion_id:             page.id,
      nom_site:              nP(p, 'Nom Site')        || '',
      societe:               nP(p, 'Société')          || '',
      adresse:               nP(p, 'Adresse')          || '',
      adresse_siege:         nP(p, 'Adresse siège')    || '',
      code_postal:           nP(p, 'Code Postal')      || '',
      ville:                 nP(p, 'Ville')             || '',
      technicien:            nP(p, 'Technicien')       || '',
      commercial:            nP(p, 'Commercial')       || '',
      dae_modele:            nP(p, 'Modèle DAE')       || '',
      n_serie:               nP(p, 'N° Série DAE')     || '',
      type_intervention:     nP(p, 'Type intervention')|| '',
      statut:                nP(p, 'Statut intervention') || 'Actif',
      maintenance_planifiee: nP(p, 'Maintenance planifiée') || '',
      pad_pak_date_adulte:   toDate(nP(p, 'Expiration PAD PAK Adulte')),
      pad_pak_date_ped:      toDate(nP(p, 'Expiration PAD PAK Pédiatrique')),
      bat_date:              toDate(nP(p, 'Expiration Batterie')),
      electrode_date:        toDate(nP(p, 'Expiration Électrodes')),
      prochaine_expiration:  toDate(nP(p, 'Prochaine Expiration')),
      pma:                   nP(p, 'Prochaine Maintenance Annuelle') || '',
      derniere_intervention: nP(p, 'Dernière Intervention Kizeo')    || '',
      urgence_pad_pak:       nP(p, 'Urgence PAD PAK')      || '',
      urgence_electrodes:    nP(p, 'Urgence Électrodes')   || '',
      urgence_annuelle:      nP(p, 'Urgence Annuelle')     || '',
      lat:                   nP(p, 'Latitude')  || null,
      lng:                   nP(p, 'Longitude') || null,
      contact:               nP(p, 'Contact sur site') || '',
      phone:                 nP(p, 'Téléphone site')   || '',
      email:                 nP(p, 'Email site')       || '',
      notes:                 nP(p, 'Notes')             || '',
    }
  }).filter(s => s.societe)
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return {
    statusCode: 200,
    headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST,OPTIONS' },
    body: ''
  }

  if (event.httpMethod !== 'POST') return {
    statusCode: 405, headers: CORS,
    body: JSON.stringify({ error: 'Method not allowed' })
  }

  let body = {}
  try { body = JSON.parse(event.body || '{}') } catch {}

  try {
    if (body.action === 'kizeo_fetch_notion') {
      const sites = await fetchNotionKizeo()
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ sites }) }
    }
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Action inconnue: ${body.action}` }) }
  } catch (e) {
    console.error('[supabase]', e.message)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) }
  }
}
