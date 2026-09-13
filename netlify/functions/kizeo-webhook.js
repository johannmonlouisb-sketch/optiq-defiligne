// netlify/functions/kizeo-webhook.js
// Reçoit les webhooks Kizeo Forms (fiche transférée / enregistrée / modifiée) et met à jour
// automatiquement l'intervention correspondante dans Supabase (optiq_ivs_data) avec tous les
// champs utiles — remplace le pull manuel limité de syncKizeo().
//
// Configuration côté Kizeo (Formulaire → Automatiser → Webhooks) :
//   Méthode : POST
//   Adresse : https://optitechx.netlify.app/api/kizeo-webhook
//   Header  : X-Webhook-Secret: <valeur de KIZEO_WEBHOOK_SECRET>
//   Déclencheurs : enregistrement + modification (transfert optionnel)

// SUPABASE_URL est parfois configurée avec le suffixe /rest/v1/ déjà inclus — on le retire
// pour reconstruire l'URL nous-mêmes et éviter un chemin doublé.
const SB_URL   = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '')
const SB_ANON  = process.env.SUPABASE_ANON_KEY
const WEBHOOK_SECRET = process.env.KIZEO_WEBHOOK_SECRET

const CORS = {
  'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

function fieldVal(fields, ...keys) {
  for (const k of keys) {
    const v = fields?.[k]?.value
    if (v !== undefined && v !== null && v !== '') return v
  }
  return ''
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) }

  if (WEBHOOK_SECRET) {
    const headers = event.headers || {}
    const provided = headers['x-webhook-secret'] || headers['X-Webhook-Secret']
    if (provided !== WEBHOOK_SECRET) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Secret invalide' }) }
    }
  }

  if (!SB_URL || !SB_ANON) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase non configuré côté serveur' }) }
  }

  let body
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) }
  }

  // Kizeo envoie la fiche avec une structure proche de l'API REST (fields: {clé: {value: ...}})
  const record  = body.data || body
  const fields  = record.fields || {}
  const dataId  = record.id || record.data_id || body.data_id || null

  const societe = fieldVal(fields, 'societe', 'client')
  const adresse = fieldVal(fields, 'adresse_site', 'adresse')

  const sbHeaders = { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}` }

  try {
    const r = await fetch(`${SB_URL}/rest/v1/app_state?key=eq.optiq_ivs_data&select=value`, { headers: sbHeaders })
    if (!r.ok) throw new Error(`Lecture app_state : ${r.status}`)
    const rows = await r.json()
    const ivs = Array.isArray(rows?.[0]?.value) ? rows[0].value : []

    // 1) Correspondance par kizeoDataId (fiche déjà liée lors d'un précédent webhook)
    let idx = dataId != null ? ivs.findIndex(i => i.kizeoDataId != null && String(i.kizeoDataId) === String(dataId)) : -1

    // 2) Sinon, correspondance par société + adresse (intervention la plus récente qui matche)
    if (idx === -1 && societe && adresse) {
      const sLow = societe.toLowerCase().slice(0, 12)
      const aLow = adresse.toLowerCase().slice(0, 12)
      const candidates = ivs
        .map((iv, k) => [iv, k])
        .filter(([iv]) => iv.client && iv.addr &&
          iv.client.toLowerCase().includes(sLow) && iv.addr.toLowerCase().includes(aLow))
      if (candidates.length) {
        candidates.sort((a, b) => (b[0].date || '').localeCompare(a[0].date || ''))
        idx = candidates[0][1]
      }
    }

    if (idx === -1) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, matched: false, reason: 'Aucune intervention correspondante trouvée' }) }
    }

    const statutStr = fieldVal(fields, 'statut_intervention')
    const terminer = statutStr === 'Terminé' || fields?.terminer?.value === true || fields?.Terminer?.value === true
    const echec    = statutStr === 'Échec / Non répondu' || fields?.echec?.value === true || fields?.Echec?.value === true

    const patch = {}
    if (dataId != null) patch.kizeoDataId = dataId
    if (terminer) patch.status = 'completed'
    else if (echec) patch.status = 'not_responded'

    const contact = fieldVal(fields, 'contact_site');        if (contact) patch.contact = contact
    const tel     = fieldVal(fields, 'telephone_site');      if (tel)     patch.cphone  = tel
    const email   = fieldVal(fields, 'email_site');          if (email)   patch.cemail  = email
    const notes   = fieldVal(fields, 'observations');        if (notes)   patch.notes   = notes
    const padChg  = fieldVal(fields, 'pad_pak_change');      if (padChg)  patch.padPak  = padChg === 'Oui'
    const padDate = fieldVal(fields, 'date_peremption_pad'); if (padDate) patch.padPakDate = padDate

    ivs[idx] = { ...ivs[idx], ...patch }

    const w = await fetch(`${SB_URL}/rest/v1/app_state?on_conflict=key`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: 'optiq_ivs_data', value: ivs })
    })
    if (!w.ok) throw new Error(`Écriture app_state : ${w.status}`)

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, matched: true, id: ivs[idx].id, patch }) }
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) }
  }
}
