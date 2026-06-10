// netlify/functions/supabase.js
// Proxy Supabase — opérations qui nécessitent la clé service_role
// (kizeo sync depuis Notion, opérations admin)
// Les lectures simples peuvent appeler Supabase REST API directement depuis le browser.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

// Supabase REST API helper (PostgREST)
async function sb(url, opts = {}) {
  const SUPABASE_URL      = process.env.SUPABASE_URL
  const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_ROLE_KEY  // clé service (jamais exposée au browser)
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquant dans les variables ENV Netlify')

  const r = await fetch(`${SUPABASE_URL}/rest/v1/${url}`, {
    ...opts,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': opts.prefer || 'return=representation',
      ...(opts.headers || {})
    }
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text}`)
  return text ? JSON.parse(text) : []
}

// Lire la base Notion Kizeo (copie du cas query_kizeo de notion.js)
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

  const toDateOrNull = s => {
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
      pad_pak_date_adulte:   toDateOrNull(nP(p, 'Expiration PAD PAK Adulte')),
      pad_pak_date_ped:      toDateOrNull(nP(p, 'Expiration PAD PAK Pédiatrique')),
      bat_date:              toDateOrNull(nP(p, 'Expiration Batterie')),
      electrode_date:        toDateOrNull(nP(p, 'Expiration Électrodes')),
      prochaine_expiration:  toDateOrNull(nP(p, 'Prochaine Expiration')),
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
  }).filter(s => s.societe)  // exclure les entrées sans société
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

      // ── GET KIZEO SITES ─────────────────────────────────────────
      // Lecture depuis Supabase (rapide, remplace query_kizeo Notion)
      case 'kizeo_get': {
        // Seulement les sites actifs (pas les DOUBLON ARCHIVÉ)
        const sites = await sb('kizeo_sites?statut=neq.Annulée&select=*&order=societe.asc', {
          method: 'GET',
          prefer: 'return=representation'
        })
        // Normaliser le format pour être compatible avec l'existant (notion.js)
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
      // À déclencher manuellement depuis l'app ou un cron Netlify
      case 'kizeo_sync': {
        const sites = await fetchNotionKizeo()
        if (!sites.length) return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({ synced: 0, msg: 'Aucun site Notion trouvé' })
        }

        // Upsert par batch de 100 (limite PostgREST recommandée)
        let total = 0
        for (let i = 0; i < sites.length; i += 100) {
          const batch = sites.slice(i, i + 100)
          await sb('kizeo_sites', {
            method: 'POST',
            prefer: 'resolution=merge-duplicates,return=minimal',
            body: JSON.stringify(batch)
          })
          total += batch.length
        }

        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({ synced: total, msg: `${total} sites Kizeo synchronisés depuis Notion` })
        }
      }

      // ── APP STATE : GET ──────────────────────────────────────────
      // Lecture d'une clé d'état (route_orders, zone_assignments…)
      case 'state_get': {
        const { key } = body
        if (!key) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'key manquant' }) }
        const rows = await sb(`app_state?key=eq.${encodeURIComponent(key)}&select=value`, {
          method: 'GET', prefer: 'return=representation'
        })
        return {
          statusCode: 200, headers: CORS,
          body: JSON.stringify({ value: rows[0]?.value ?? null })
        }
      }

      // ── APP STATE : SET ──────────────────────────────────────────
      case 'state_set': {
        const { key, value } = body
        if (!key) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'key manquant' }) }
        await sb('app_state', {
          method: 'POST',
          prefer: 'resolution=merge-duplicates,return=minimal',
          body: JSON.stringify({ key, value })
        })
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) }
      }

      default:
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Action inconnue: ${action}` }) }
    }
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) }
  }
}
