// netlify/functions/notion.js
// Proxy Notion API — résout le CORS navigateur
// DB ID Defiligne : 3ab30393-8dd2-4f10-98e4-b7f7b1c91f60

const NOTION_VERSION = '2022-06-28'
const NOTION_BASE    = 'https://api.notion.com/v1'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return {
    statusCode: 200,
    headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS' },
    body: ''
  }

  const token  = process.env.NOTION_TOKEN
  const dbId   = process.env.NOTION_DB_ID || '3ab30393-8dd2-4f10-98e4-b7f7b1c91f60'

  if (!token) return {
    statusCode: 401, headers: CORS,
    body: JSON.stringify({ error: 'NOTION_TOKEN manquant dans les variables ENV Netlify' })
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  }

  let body = {}
  try { if (event.body) body = JSON.parse(event.body) } catch {}

  const { action, pageId, filter, sorts, startCursor } = body

  try {
    switch (action) {

      // ── QUERY : lire les interventions avec filtres ─────────────────────
      case 'query': {
        const payload = {
          page_size: 100,
          sorts: sorts || [{ property: 'Date intervention', direction: 'ascending' }],
          ...(startCursor ? { start_cursor: startCursor } : {}),
          ...(filter ? { filter } : {})
        }
        const r = await fetch(`${NOTION_BASE}/databases/${dbId}/query`, {
          method: 'POST', headers,
          body: JSON.stringify(payload)
        })
        const data = await r.json()
        return { statusCode: r.status, headers: CORS, body: JSON.stringify(data) }
      }

      // ── QUERY DATE RANGE : interventions entre 2 dates ─────────────────
      case 'query_range': {
        const { dateFrom, dateTo } = body
        const payload = {
          page_size: 100,
          sorts: [{ property: 'Date intervention', direction: 'ascending' }],
          filter: {
            and: [
              { property: 'Date intervention', date: { on_or_after: dateFrom } },
              { property: 'Date intervention', date: { on_or_before: dateTo  } }
            ]
          }
        }
        // Pagination — max 5 pages (500 interventions) pour rester sous le timeout Netlify
        let all = [], next = null, pageCount = 0
        do {
          if (next) payload.start_cursor = next
          const r = await fetch(`${NOTION_BASE}/databases/${dbId}/query`, {
            method: 'POST', headers, body: JSON.stringify(payload)
          })
          const d = await r.json()
          if (!r.ok) return { statusCode: r.status, headers: CORS, body: JSON.stringify(d) }
          all = all.concat(d.results || [])
          next = d.has_more ? d.next_cursor : null
          pageCount++
        } while (next && pageCount < 5)
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ results: all, truncated: !!next }) }
      }

      // ── GET SINGLE PAGE ─────────────────────────────────────────────────
      case 'get_page': {
        const r = await fetch(`${NOTION_BASE}/pages/${pageId}`, { headers })
        return { statusCode: r.status, headers: CORS, body: JSON.stringify(await r.json()) }
      }

      // ── GET DB SCHEMA : liste les propriétés réelles de la DB ───────────
      case 'get_db': {
        const r = await fetch(`${NOTION_BASE}/databases/${dbId}`, { headers })
        const d = await r.json()
        const props = Object.keys(d.properties || {})
        return { statusCode: r.status, headers: CORS, body: JSON.stringify({ properties: props }) }
      }

      // ── UPDATE PAGE : modifier statut, technicien, etc. ─────────────────
      case 'update_page': {
        const { properties } = body
        const r = await fetch(`${NOTION_BASE}/pages/${pageId}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ properties })
        })
        return { statusCode: r.status, headers: CORS, body: JSON.stringify(await r.json()) }
      }

      // ── ARCHIVE PAGE : suppression (archivage Notion) ──────────────────
      case 'archive_page': {
        const r = await fetch(`${NOTION_BASE}/pages/${pageId}`, {
          method: 'PATCH', headers,
          body: JSON.stringify({ archived: true })
        })
        return { statusCode: r.status, headers: CORS, body: JSON.stringify(await r.json()) }
      }

      // ── CREATE PAGE : nouvelle intervention ─────────────────────────────
      case 'create_page': {
        const { properties } = body
        const r = await fetch(`${NOTION_BASE}/pages`, {
          method: 'POST', headers,
          body: JSON.stringify({ parent: { database_id: dbId }, properties })
        })
        return { statusCode: r.status, headers: CORS, body: JSON.stringify(await r.json()) }
      }

      // ── SYNC COMPLETION → BASE KIZEO ────────────────────────────────────
      // Quand une intervention est marquée terminée, met à jour (ou crée) la fiche
      // dans la base Kizeo (suivi des sites) avec la date de dernière intervention.
      case 'sync_kizeo_completion': {
        const { client, addr, date, techName } = body
        const kizeoDbId = process.env.NOTION_DB_KIZEO || '4326bdb2994b42509759a897ff7a4a1f'

        // Calculer la prochaine maintenance annuelle (date + 1 an)
        const next = new Date(date)
        next.setFullYear(next.getFullYear() + 1)
        const nextAnnual = next.toISOString().split('T')[0]

        // Chercher le site existant dans la base Kizeo (par nom client)
        const sq = await fetch(`${NOTION_BASE}/databases/${kizeoDbId}/query`, {
          method: 'POST', headers,
          body: JSON.stringify({
            page_size: 5,
            filter: { or: [
              { property: 'Nom Site', title:       { contains: (client||'').substring(0,100) } },
              { property: 'Société',  rich_text:   { contains: (client||'').substring(0,100) } }
            ]}
          })
        })
        const sd = await sq.json()
        if (!sq.ok) return { statusCode: sq.status, headers: CORS, body: JSON.stringify(sd) }

        const existing = sd.results?.[0]

        const updateProps = {
          'Dernière Intervention Kizeo':    { date: { start: date } },
          'Prochaine Maintenance Annuelle': { date: { start: nextAnnual } },
        }
        if (techName) updateProps['Technicien référent'] = { rich_text: [{ text: { content: techName } }] }

        if (existing) {
          const ur = await fetch(`${NOTION_BASE}/pages/${existing.id}`, {
            method: 'PATCH', headers, body: JSON.stringify({ properties: updateProps })
          })
          const ud = await ur.json()
          return { statusCode: ur.status, headers: CORS, body: JSON.stringify({ action: 'updated', pageId: existing.id, client, ...ud }) }
        } else {
          const createProps = {
            'Nom Site':  { title:     [{ text: { content: (client||'Inconnu').substring(0,2000) } }] },
            'Société':   { rich_text: [{ text: { content: (client||'').substring(0,2000) } }] },
            ...updateProps
          }
          if (addr) createProps['Adresse'] = { rich_text: [{ text: { content: addr.substring(0,2000) } }] }
          const cr = await fetch(`${NOTION_BASE}/pages`, {
            method: 'POST', headers, body: JSON.stringify({ parent: { database_id: kizeoDbId }, properties: createProps })
          })
          const cd = await cr.json()
          return { statusCode: cr.status, headers: CORS, body: JSON.stringify({ action: 'created', client, ...cd }) }
        }
      }

      // ── QUERY KIZEO : lecture base Sites & PAD PAK ─────────────────────
      case 'query_kizeo': {
        const kizeoDbId = process.env.NOTION_DB_KIZEO || '4326bdb2994b42509759a897ff7a4a1f'
        let all = [], next = null
        do {
          const payload = { page_size: 100, ...(next ? { start_cursor: next } : {}) }
          const r = await fetch(`${NOTION_BASE}/databases/${kizeoDbId}/query`, {
            method: 'POST', headers, body: JSON.stringify(payload)
          })
          const d = await r.json()
          if (!r.ok) return { statusCode: r.status, headers: CORS, body: JSON.stringify(d) }
          all = all.concat(d.results || [])
          next = d.has_more ? d.next_cursor : null
        } while (next)

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

        const sites = all.map(page => {
          const p = page.properties || {}
          return {
            id:               page.id,
            nomSite:          nP(p, 'Nom Site'),
            societe:          nP(p, 'Société'),
            adresse:          nP(p, 'Adresse'),
            adresseSiege:     nP(p, 'Adresse siège'),
            codePostal:       nP(p, 'Code Postal'),
            ville:            nP(p, 'Ville'),
            technicien:       nP(p, 'Technicien'),
            commercial:       nP(p, 'Commercial'),
            daeModele:        nP(p, 'Modèle DAE'),
            nSerie:           nP(p, 'N° Série DAE'),
            typeIntervention: nP(p, 'Type intervention'),
            statut:           nP(p, 'Statut intervention'),
            maintenancePlanifiee: nP(p, 'Maintenance planifiée'),
            padPakDateAdulte: nP(p, 'Expiration PAD PAK Adulte'),
            padPakDatePed:    nP(p, 'Expiration PAD PAK Pédiatrique'),
            batDate:          nP(p, 'Expiration Batterie'),
            electrodeDate:    nP(p, 'Expiration Électrodes'),
            prochaineExpiration: nP(p, 'Prochaine Expiration'),
            pma:              nP(p, 'Prochaine Maintenance Annuelle'),
            derniereIntervention: nP(p, 'Dernière Intervention Kizeo'),
            urgencePadPak:    nP(p, 'Urgence PAD PAK'),
            urgenceElectrodes: nP(p, 'Urgence Électrodes'),
            urgenceAnnuelle:  nP(p, 'Urgence Annuelle'),
            lat:              nP(p, 'Latitude'),
            lng:              nP(p, 'Longitude'),
            contact:          nP(p, 'Contact sur site'),
            phone:            nP(p, 'Téléphone site'),
            email:            nP(p, 'Email site'),
            notes:            nP(p, 'Notes'),
          }
        })

        return { statusCode: 200, headers: CORS, body: JSON.stringify({ sites }) }
      }

      // ── FETCH ARCHIVE : historique interventions par plage de dates ────
      // Retourne des objets déjà mappés (pas de pages Notion brutes)
      case 'fetch_archive': {
        const { dateFrom, dateTo } = body
        if (!dateFrom || !dateTo)
          return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'dateFrom et dateTo requis' }) }

        const nP = (p, k) => {
          const v = p[k]; if (!v) return ''
          if (v.type === 'title')        return v.title?.map(t => t.plain_text).join('') || ''
          if (v.type === 'rich_text')    return v.rich_text?.map(t => t.plain_text).join('') || ''
          if (v.type === 'date')         return v.date?.start || ''
          if (v.type === 'select')       return v.select?.name || ''
          if (v.type === 'multi_select') return v.multi_select?.map(m => m.name).join(', ') || ''
          if (v.type === 'checkbox')     return !!v.checkbox
          return ''
        }

        const payload = {
          page_size: 100,
          sorts: [{ property: 'Date intervention', direction: 'ascending' }],
          filter: {
            and: [
              { property: 'Date intervention', date: { on_or_after:  dateFrom } },
              { property: 'Date intervention', date: { on_or_before: dateTo   } }
            ]
          }
        }

        let all = [], next = null, pageCount2 = 0
        do {
          if (next) payload.start_cursor = next
          const r = await fetch(`${NOTION_BASE}/databases/${dbId}/query`, {
            method: 'POST', headers, body: JSON.stringify(payload)
          })
          const d = await r.json()
          if (!r.ok) return { statusCode: r.status, headers: CORS, body: JSON.stringify(d) }
          all = all.concat(d.results || [])
          next = d.has_more ? d.next_cursor : null
          pageCount2++
        } while (next && pageCount2 < 5)

        const ivs = all.map(page => {
          const p   = page.properties || {}
          const dateStr = nP(p, 'Date intervention') || ''
          const terminer = nP(p, 'Terminer')
          const echec    = nP(p, 'Echec')
          return {
            notionId: page.id,
            client:   nP(p, 'Société') || nP(p, 'Nom Site') || '',
            addr:     nP(p, 'Adresse Site') || nP(p, 'Adresse Siéges') || nP(p, 'Adresse') || '',
            date:     dateStr.substring(0, 10),
            tech:     (nP(p, 'Technicien') || nP(p, 'Technicien ') || '').trim(),
            type:     nP(p, 'INTERVENTION'),
            notes:    nP(p, 'INFO ') || nP(p, 'Motif') || '',
            status:   echec ? 'not_responded' : terminer ? 'completed' : 'pending',
            contact:  nP(p, 'Contact sur site') || '',
            cphone:   nP(p, 'Téléphone site') || '',
          }
        }).filter(iv => iv.client && iv.date)

        return { statusCode: 200, headers: CORS, body: JSON.stringify({ ivs }) }
      }

      default:
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Action inconnue: ${action}` }) }
    }
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Proxy error: ' + e.message }) }
  }
}
