// netlify/functions/agent-validateur.js
// Port JS de agents/validateur.py (PlanningOS → OptiQ)
// Valide email, téléphone (FR), code postal (FR) de chaque fiche

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

// ── Règles regex ──────────────────────────────────────────────

const RE_EMAIL = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/
const RE_PHONE = /^(\+33|0033|0)[1-9][0-9]{8}$/
const RE_CP    = /^[0-9]{5}$/

// ── Validateurs unitaires ─────────────────────────────────────

function validateEmail(email) {
  if (!email || String(email).trim() === '') return { valid: true, skip: true }
  return RE_EMAIL.test(String(email).trim().toLowerCase())
    ? { valid: true }
    : { valid: false, error: `Email invalide : "${email}"` }
}

function validatePhone(phone) {
  if (!phone || String(phone).trim() === '') return { valid: true, skip: true }
  const clean = String(phone).replace(/[\s.\-\/\(\)]/g, '')
  return RE_PHONE.test(clean)
    ? { valid: true }
    : { valid: false, error: `Téléphone invalide : "${phone}" (format attendu : 06 XX XX XX XX)` }
}

function validateCP(cp) {
  if (!cp || String(cp).trim() === '') return { valid: true, skip: true }
  return RE_CP.test(String(cp).trim())
    ? { valid: true }
    : { valid: false, error: `Code postal invalide : "${cp}" (5 chiffres attendus)` }
}

// ── Validation d'une intervention ─────────────────────────────

function validateIntervention(iv) {
  const errors   = []
  const warnings = []
  const fields   = {}

  const emailRes = validateEmail(iv.email)
  fields.email   = emailRes
  if (!emailRes.valid) errors.push(emailRes.error)

  const phoneRes = validatePhone(iv.phone || iv.telephone)
  fields.phone   = phoneRes
  if (!phoneRes.valid) errors.push(phoneRes.error)

  const cpSrc   = iv.cp || iv.codePostal || extractCP(iv.addr || iv.adresse || '')
  const cpRes   = validateCP(cpSrc)
  fields.cp     = cpRes
  if (!cpRes.valid) errors.push(cpRes.error)

  if (!iv.addr && !iv.adresse) warnings.push('Adresse manquante')
  if (!iv.client && !iv.societe) warnings.push('Société manquante')

  return {
    id:       iv.id    || iv.notionId || null,
    client:   iv.client || iv.societe  || '—',
    valid:    errors.length === 0,
    errors,
    warnings,
    fields
  }
}

// Extrait un code postal d'une adresse libre (ex: "12 rue X 75001 Paris")
function extractCP(addr) {
  const m = String(addr).match(/\b([0-9]{5})\b/)
  return m ? m[1] : null
}

// ── Validation d'un batch ─────────────────────────────────────

function validateBatch(interventions) {
  const t0      = Date.now()
  const results = (interventions || []).map(iv => validateIntervention(iv))
  const ok      = results.filter(r => r.valid).length

  return {
    processed:  results.length,
    valid:      ok,
    errors:     results.length - ok,
    durationMs: Date.now() - t0,
    results
  }
}

module.exports = { validateIntervention, validateBatch, validateEmail, validatePhone, validateCP }

// ── Handler HTTP ──────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) }

  let body
  try { body = JSON.parse(event.body || '{}') }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) } }

  const { intervention, interventions } = body

  if (Array.isArray(interventions))
    return { statusCode: 200, headers: CORS, body: JSON.stringify(validateBatch(interventions)) }

  if (intervention)
    return { statusCode: 200, headers: CORS, body: JSON.stringify(validateIntervention(intervention)) }

  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '"intervention" ou "interventions" requis' }) }
}
