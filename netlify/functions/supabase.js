// netlify/functions/supabase.js
// Proxy Supabase — kizeo sync, app state, opérations admin

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

function getEnv() {
  const url = process.env.SUPABASE_URL || 'https://yjcmfoxvyxzgixnrvcnn.supabase.co'
  const key = process.env.SUPABASE_ANON_KEY ||
    Buffer.from('ZXlKaGJHY2lPaUpJVXpJMU5pSXNJblI1Y0NJNklrcFhWQ0o5LmV5SnBjM01pT2lKemRYQmhZbUZ6WlNJc0luSmxaaUk2SW5scVkyMW1iM2gyZVhoNloybDRibkoyWTI1dUlpd2ljbTlzWlNJNkltRnViMjRpTENKcFlYUWlPakUzTnpZd05qWXdOek1zSW1WNGNDSTZNakE1TVRZME1qQTNNMzAuMWFSN1pkeUJNanFoYjlEaHBaZ1hPeHZhdzBGY1BZZmVXcWxLQU9veUhlZw==', 'base64').toString()
  return { url, key }
}

// GET depuis Supabase REST API
async function sbGet(table, query = '') {
  const { url, key } = getEnv()
  const endpoint = `${url}/rest/v1/${table}${query ? '?' + query : ''}`
  const r = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Accept': 'application/json'
    }
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`Supabase GET ${r.status}: ${text.substring(0, 200)}`)
  return text ? JSON.parse(text) : []
}

// POST/UPSERT vers Supabase REST API
async function sbPost(table, data, prefer = 'resolution=merge-duplicates,return=minimal') {
  const { url, key } = getEnv()
  const r = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': prefer
    },
    body: JSON.stringify(data)
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`Supabase POST ${r.status}: ${text.substring(0, 200)}`)
  return text ? JSON.parse(text) : []
}

// Lire la base Notion Kizeo
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

  const { action } = body

  try {
    switch (action) {

      // ── PING : tester la connexion Supabase ──────────────────────
      case 'ping': {
        const { url, key } = getEnv()
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({ ok: true, url: url.replace(/^https:\/\//, '').split('.')[0] + '...' })
        }
      }

      // ── GET KIZEO SITES : lecture depuis Supabase ────────────────
      case 'kizeo_get': {
        // Exclure les doublons archivés — encoder Annulée correctement
        const sites = await sbGet('kizeo_sites', 'statut=neq.Annul%C3%A9e&select=*&order=societe.asc')
        const normalized = sites.map(s => ({
          id:                    s.id,
          notionId:              s.notion_id,
          nomSite:               s.nom_site        || '',
          societe:               s.societe         || '',
          adresse:               s.adresse         || '',
          adresseSiege:          s.adresse_siege   || '',
          codePostal:            s.code_postal     || '',
          ville:                 s.ville           || '',
          technicien:            s.technicien      || '',
          commercial:            s.commercial      || '',
          daeModele:             s.dae_modele      || '',
          nSerie:                s.n_serie         || '',
          typeIntervention:      s.type_intervention || '',
          statut:                s.statut          || '',
          maintenancePlanifiee:  s.maintenance_planifiee || '',
          padPakDateAdulte:      s.pad_pak_date_adulte || '',
          padPakDatePed:         s.pad_pak_date_ped    || '',
          batDate:               s.bat_date            || '',
          electrodeDate:         s.electrode_date      || '',
          prochaineExpiration:   s.prochaine_expiration || '',
          pma:                   s.pma             || '',
          derniereIntervention:  s.derniere_intervention || '',
          urgencePadPak:         s.urgence_pad_pak    || '',
          urgenceElectrodes:     s.urgence_electrodes || '',
          urgenceAnnuelle:       s.urgence_annuelle   || '',
          lat:                   s.lat,
          lng:                   s.lng,
          contact:               s.contact || '',
          phone:                 s.phone   || '',
          email:                 s.email   || '',
          notes:                 s.notes   || '',
        }))
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ sites: normalized }) }
      }

      // ── SYNC KIZEO : Notion → Supabase ───────────────────────────
      case 'kizeo_sync': {
        console.log('[kizeo_sync] Démarrage fetch Notion...')
        const sites = await fetchNotionKizeo()
        console.log(`[kizeo_sync] ${sites.length} sites Notion récupérés`)

        if (!sites.length) return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({ synced: 0, msg: 'Aucun site trouvé dans Notion' })
        }

        let total = 0
        for (let i = 0; i < sites.length; i += 100) {
          const batch = sites.slice(i, i + 100)
          await sbPost('kizeo_sites', batch)
          total += batch.length
          console.log(`[kizeo_sync] Batch ${i}–${i + batch.length} → Supabase OK`)
        }

        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({ synced: total, msg: `${total} sites Kizeo synchronisés depuis Notion → Supabase` })
        }
      }

      // ── APP STATE : GET ──────────────────────────────────────────
      case 'state_get': {
        const { key } = body
        if (!key) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'key manquant' }) }
        const rows = await sbGet('app_state', `key=eq.${encodeURIComponent(key)}&select=value`)
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({ value: rows[0]?.value ?? null })
        }
      }

      // ── APP STATE : SET ──────────────────────────────────────────
      case 'state_set': {
        const { key, value } = body
        if (!key) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'key manquant' }) }
        await sbPost('app_state', { key, value })
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) }
      }

      default:
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Action inconnue: ${action}` }) }
    }
  } catch (e) {
    console.error('[supabase]', e.message)
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) }
  }
}
