// netlify/functions/kizeo-import.js
// Import CSV Kizeo → Notion avec classification Télémaintenance / physique
//
// POST /api/kizeo-import
// Body JSON : { csv: "<contenu CSV>", dryRun: false }
//
// Colonnes CSV Kizeo (ordre exact) :
// Terminer, Echec, Société, Commercial, Adresse Site, Date intervention,
// INTERVENTION, INFO, Urgent, Contact site, E-mail, Téléphone,
// Adresse Sièges, Contact sieges, E-mail Sièges, Téléphone sièges,
// Motif, Téléphone 1, valider par, EXTER

const NOTION_VERSION = '2022-06-28'
const NOTION_BASE    = 'https://api.notion.com/v1'
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json'
}

// Ordre exact des colonnes dans le CSV Kizeo
const CSV_COLUMNS = [
  'Terminer', 'Echec', 'Société', 'Commercial', 'Adresse Site',
  'Date intervention', 'INTERVENTION', 'INFO', 'Urgent', 'Contact site',
  'E-mail', 'Téléphone', 'Adresse Sièges', 'Contact sieges',
  'E-mail Sièges', 'Téléphone sièges', 'Motif', 'Téléphone 1',
  'valider par', 'EXTER'
]

// Types qui indiquent une intervention à distance (pas de déplacement)
const TELE_PATTERNS = /t[eé]l[eé]maintenance/i

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return {
    statusCode: 200,
    headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST,OPTIONS' },
    body: ''
  }
  if (event.httpMethod !== 'POST') return {
    statusCode: 405, headers: CORS,
    body: JSON.stringify({ error: 'Méthode non autorisée — utilisez POST' })
  }

  const token = process.env.NOTION_TOKEN
  const dbId  = process.env.NOTION_DB_ID || '3ab30393-8dd2-4f10-98e4-b7f7b1c91f60'

  if (!token) return {
    statusCode: 401, headers: CORS,
    body: JSON.stringify({ error: 'NOTION_TOKEN manquant dans les variables ENV Netlify' })
  }

  let body = {}
  try { body = JSON.parse(event.body || '{}') } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Body JSON invalide' }) }
  }

  const { csv, dryRun = false } = body
  if (!csv || typeof csv !== 'string') return {
    statusCode: 400, headers: CORS,
    body: JSON.stringify({ error: 'Champ "csv" manquant ou invalide dans le body' })
  }

  // ── 1. Parser le CSV ───────────────────────────────────────────────────────
  let rows
  try { rows = parseCSV(csv) } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Erreur parsing CSV : ' + e.message }) }
  }

  if (!rows.length) return {
    statusCode: 400, headers: CORS,
    body: JSON.stringify({ error: 'CSV vide ou sans lignes valides (20 colonnes requises)' })
  }

  // ── 2. Normaliser et classifier chaque intervention ────────────────────────
  const interventions = rows
    .map(row => normalizeRow(row))
    .filter(iv => iv.société && iv.dateISO) // ignorer les lignes sans client ni date

  if (!interventions.length) return {
    statusCode: 400, headers: CORS,
    body: JSON.stringify({ error: 'Aucune intervention valide (Société + Date intervention requis)' })
  }

  const summary = buildSummary(interventions)

  // ── 3. Mode aperçu sans écriture Notion ────────────────────────────────────
  if (dryRun) {
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ dryRun: true, summary, interventions })
    }
  }

  // ── 4. Créer les pages dans Notion ─────────────────────────────────────────
  const notionHeaders = {
    'Authorization':  `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type':   'application/json'
  }

  const results = []
  for (const iv of interventions) {
    try {
      const r = await fetch(`${NOTION_BASE}/pages`, {
        method:  'POST',
        headers: notionHeaders,
        body:    JSON.stringify({
          parent:     { database_id: dbId },
          properties: buildNotionProperties(iv)
        })
      })
      const data = await r.json()
      results.push({
        société:           iv.société,
        date:              iv.dateISO,
        technicien:        iv.technicien,
        typeStr:           iv.typeStr,
        isTeleMaintenance: iv.isTeleMaintenance,
        isUrgent:          iv.isUrgent,
        isExter:           iv.isExter,
        notionId:          data.id || null,
        ok:                r.ok,
        error:             r.ok ? null : (data.message || JSON.stringify(data))
      })
    } catch (e) {
      results.push({
        société:           iv.société,
        date:              iv.dateISO,
        technicien:        iv.technicien,
        typeStr:           iv.typeStr,
        isTeleMaintenance: iv.isTeleMaintenance,
        ok:    false,
        error: e.message
      })
    }
  }

  const created = results.filter(r => r.ok).length
  const failed  = results.filter(r => !r.ok).length

  return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({ summary, created, failed, results })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// NORMALISATION D'UNE LIGNE CSV
// ═══════════════════════════════════════════════════════════════════════════
function normalizeRow(row) {
  const typeStr = row['INTERVENTION']?.trim() || ''
  const types   = parseTypes(typeStr)

  // Un seul type "Télémaintenance" dans la liste suffit
  const isTeleMaintenance = types.some(t => TELE_PATTERNS.test(t))
  const isUrgent = yesNo(row['Urgent'])
  const isExter  = yesNo(row['EXTER'])
  const dateISO  = parseKizeoDate(row['Date intervention'])

  return {
    // Classification
    isTeleMaintenance,
    isPhysical: !isTeleMaintenance,
    isUrgent,
    isExter,
    // Données normalisées
    société:        row['Société']?.trim()           || '',
    technicien:     row['Commercial']?.trim()        || '',
    adresseSite:    row['Adresse Site']?.trim()      || '',
    dateISO,
    typeStr,
    types,
    info:           row['INFO']?.trim()              || '',
    contact:        row['Contact site']?.trim()      || '',
    email:          row['E-mail']?.trim()            || '',
    téléphone:      row['Téléphone']?.trim()         || '',
    adresseSiège:   row['Adresse Sièges']?.trim()    || '',
    contactSiège:   row['Contact sieges']?.trim()    || '',
    emailSiège:     row['E-mail Sièges']?.trim()     || '',
    télSiège:       row['Téléphone sièges']?.trim()  || '',
    motif:          row['Motif']?.trim()             || '',
    téléphone1:     row['Téléphone 1']?.trim()       || '',
    validéPar:      row['valider par']?.trim()       || '',
    terminer:       yesNo(row['Terminer']),
    echec:          yesNo(row['Echec']),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTRUCTION DES PROPRIÉTÉS NOTION
// ═══════════════════════════════════════════════════════════════════════════
function buildNotionProperties(iv) {
  const p = {}

  // Société — champ title (obligatoire Notion)
  p['Société'] = { title: [{ text: { content: iv.société } }] }

  // Commercial (technicien) — select. Note: espace trailing dans la DB Notion
  if (iv.technicien) p['Commercial '] = { select: { name: iv.technicien } }

  // Adresse site
  if (iv.adresseSite) p['Adresse Site'] = rt(iv.adresseSite)

  // Date intervention (ISO YYYY-MM-DD)
  if (iv.dateISO) p['Date intervention'] = { date: { start: iv.dateISO } }

  // INTERVENTION — multi_select (valeurs séparées par virgule dans le CSV)
  if (iv.types.length) p['INTERVENTION'] = { multi_select: iv.types.map(t => ({ name: t })) }

  // INFO — rich_text. Note: espace trailing dans la DB Notion
  if (iv.info) p['INFO '] = rt(iv.info)

  // Urgent — convention OptiQ : rich_text non vide = urgent
  p['Urgent'] = iv.isUrgent ? rt('Yes') : { rich_text: [] }

  // Contact site
  if (iv.contact) p['Contact site'] = rt(iv.contact)

  // E-mail
  if (iv.email) p['E-mail'] = { email: iv.email }

  // Téléphone
  if (iv.téléphone) p['Téléphone'] = { phone_number: iv.téléphone }

  // Adresse Sièges (accent é dans la DB Notion : "Siéges")
  if (iv.adresseSiège) p['Adresse Siéges'] = rt(iv.adresseSiège)

  // Motif
  if (iv.motif) p['Motif'] = rt(iv.motif)

  // Téléphone 1
  if (iv.téléphone1) p['Téléphone 1'] = { phone_number: iv.téléphone1 }

  // EXTER — checkbox
  p['EXTER'] = { checkbox: iv.isExter }

  // Terminer — toujours false à l'import (sinon l'intervention serait ignorée)
  p['Terminer'] = { checkbox: false }

  return p
}

// ═══════════════════════════════════════════════════════════════════════════
// RÉSUMÉ STATISTIQUE
// ═══════════════════════════════════════════════════════════════════════════
function buildSummary(interventions) {
  const physical        = interventions.filter(iv => iv.isPhysical)
  const teleMaintenance = interventions.filter(iv => iv.isTeleMaintenance)
  const urgent          = interventions.filter(iv => iv.isUrgent)
  const external        = interventions.filter(iv => iv.isExter)

  return {
    total:            interventions.length,
    physical:         physical.length,
    teleMaintenance:  teleMaintenance.length,
    urgent:           urgent.length,
    external:         external.length,
    // Listes pour affichage UI
    teleMaintenanceList: teleMaintenance.map(iv => ({
      société:    iv.société,
      technicien: iv.technicien,
      date:       iv.dateISO,
      typeStr:    iv.typeStr,
      isUrgent:   iv.isUrgent,
      isExter:    iv.isExter,
      motif:      iv.motif,
      info:       iv.info,
    })),
    urgentList: urgent.map(iv => ({
      société:           iv.société,
      technicien:        iv.technicien,
      date:              iv.dateISO,
      typeStr:           iv.typeStr,
      isTeleMaintenance: iv.isTeleMaintenance,
      adresseSite:       iv.adresseSite,
    })),
    externalList: external.map(iv => ({
      société:           iv.société,
      technicien:        iv.technicien,
      date:              iv.dateISO,
      typeStr:           iv.typeStr,
      isTeleMaintenance: iv.isTeleMaintenance,
    })),
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PARSING CSV ROBUSTE
// Gère : guillemets doubles, virgules dans champs, CRLF/LF, en-tête optionnel
// ═══════════════════════════════════════════════════════════════════════════
function parseCSV(raw) {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n')
  if (lines.length < 1) return []

  // Détecter si la première ligne est un en-tête Kizeo
  const firstFields = parseCSVLine(lines[0])
  const hasHeader   = firstFields.some(f => CSV_COLUMNS.includes(f.trim()))
  const dataStart   = hasHeader ? 1 : 0

  const rows = []
  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const fields = parseCSVLine(line)
    // Ignorer les lignes avec trop peu de colonnes (probablement malformées)
    if (fields.length < CSV_COLUMNS.length) continue

    const row = {}
    CSV_COLUMNS.forEach((col, idx) => { row[col] = fields[idx] ?? '' })
    rows.push(row)
  }
  return rows
}

function parseCSVLine(line) {
  const fields = []
  let current  = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        // Guillemet double échappé ("")
        if (line[i + 1] === '"') { current += '"'; i++ }
        else inQuotes = false
      } else {
        current += ch
      }
    } else {
      if      (ch === '"') inQuotes = true
      else if (ch === ',') { fields.push(current); current = '' }
      else                   current += ch
    }
  }
  fields.push(current)
  return fields
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITAIRES
// ═══════════════════════════════════════════════════════════════════════════

// "Yes"/"No" → boolean (insensible à la casse)
function yesNo(str) {
  return str?.trim()?.toLowerCase() === 'yes'
}

// DD/MM/YYYY → YYYY-MM-DD (format Notion)
function parseKizeoDate(str) {
  if (!str) return null
  const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  const [, d, mo, y] = m
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
}

// Splitter "CR2, Maintenance" → ['CR2', 'Maintenance']
function parseTypes(str) {
  if (!str) return []
  return str.split(',').map(t => t.trim()).filter(Boolean)
}

// Raccourci rich_text Notion
function rt(text) {
  return { rich_text: [{ text: { content: String(text) } }] }
}
