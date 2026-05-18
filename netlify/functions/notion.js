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
        // Pagination
        let all = [], next = null
        do {
          if (next) payload.start_cursor = next
          const r = await fetch(`${NOTION_BASE}/databases/${dbId}/query`, {
            method: 'POST', headers, body: JSON.stringify(payload)
          })
          const d = await r.json()
          if (!r.ok) return { statusCode: r.status, headers: CORS, body: JSON.stringify(d) }
          all = all.concat(d.results || [])
          next = d.has_more ? d.next_cursor : null
        } while (next)
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ results: all }) }
      }

      // ── GET SINGLE PAGE ─────────────────────────────────────────────────
      case 'get_page': {
        const r = await fetch(`${NOTION_BASE}/pages/${pageId}`, { headers })
        return { statusCode: r.status, headers: CORS, body: JSON.stringify(await r.json()) }
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

      default:
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Action inconnue: ${action}` }) }
    }
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Proxy error: ' + e.message }) }
  }
}
