// netlify/functions/geocode.js
// Géocodage d'adresses avec cache Netlify Blobs
// Primaire : Google Maps Geocoding API (GOOGLE_MAPS_KEY)
// Fallback  : api-adresse.data.gouv.fr (France, sans clé)

const { getStore } = require('@netlify/blobs')

const GOOGLE_GEO   = 'https://maps.googleapis.com/maps/api/geocode/json'
const FR_GEO       = 'https://api-adresse.data.gouv.fr/search'
const NOMINATIM    = 'https://nominatim.openstreetmap.org/search'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
}

// ── Normalise une adresse en clé de cache ─────────────────────
function cacheKey(address) {
  return address.toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 120)
}

// ── Lecture / écriture cache Netlify Blobs ─────────────────────
async function cacheGet(key) {
  try {
    const store = getStore({ name: 'geocache', consistency: 'strong' })
    return await store.get(key, { type: 'json' })
  } catch { return null }
}

async function cacheSet(key, value) {
  try {
    const store = getStore({ name: 'geocache', consistency: 'strong' })
    await store.set(key, JSON.stringify(value))
  } catch { /* cache write failure is non-fatal */ }
}

// ── Géocodeurs ────────────────────────────────────────────────

async function withGoogle(address) {
  const key = process.env.GOOGLE_MAPS_KEY
  if (!key) return null
  const url = `${GOOGLE_GEO}?address=${encodeURIComponent(address)}&region=fr&language=fr&key=${key}`
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) })
  const d = await r.json()
  if (d.status !== 'OK' || !d.results?.[0]) return null
  const loc = d.results[0].geometry.location
  return {
    lat:       loc.lat,
    lng:       loc.lng,
    formatted: d.results[0].formatted_address,
    source:    'google'
  }
}

async function withFrGov(address) {
  const url = `${FR_GEO}/?q=${encodeURIComponent(address)}&limit=1`
  const r = await fetch(url, { headers: { 'User-Agent': 'OptiQ/1.0' }, signal: AbortSignal.timeout(5000) })
  const d = await r.json()
  const feat = d.features?.[0]
  if (!feat) return null
  const [lng, lat] = feat.geometry.coordinates
  return {
    lat,
    lng,
    formatted: feat.properties.label,
    score:     feat.properties.score,
    source:    'adresse.data.gouv.fr'
  }
}

async function withNominatim(address) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=fr&accept-language=fr`
  const r = await fetch(url, { headers: { 'User-Agent': 'OptiQ/1.0' }, signal: AbortSignal.timeout(5000) })
  const d = await r.json()
  if (!d[0]) return null
  return {
    lat:       parseFloat(d[0].lat),
    lng:       parseFloat(d[0].lon),
    formatted: d[0].display_name,
    source:    'nominatim'
  }
}

// ── Fonction principale d'export ─────────────────────────────

/**
 * Géocode une adresse avec cache.
 * @param {string} address
 * @returns {{ lat, lng, formatted, source, cached } | null}
 */
async function geocodeAddress(address) {
  const raw = (address || '').trim()
  if (!raw || raw === 'nan' || raw.length < 5) return null

  const key = cacheKey(raw)

  // 1. Lecture cache
  const cached = await cacheGet(key)
  if (cached?.lat && cached?.lng) return { ...cached, cached: true }

  // 2. Google Maps (le plus précis, nécessite clé)
  let result = await withGoogle(raw).catch(() => null)

  // 3. Fallback api-adresse.data.gouv.fr (France uniquement, sans clé, très rapide)
  if (!result) result = await withFrGov(raw).catch(() => null)

  // 4. Fallback Nominatim (dernier recours)
  if (!result) result = await withNominatim(raw).catch(() => null)

  if (!result) {
    // Mettre en cache l'échec pour éviter de retenter
    await cacheSet(key, { notFound: true, address: raw })
    return null
  }

  // 5. Mise en cache du résultat
  const toCache = { lat: result.lat, lng: result.lng, formatted: result.formatted, source: result.source }
  await cacheSet(key, toCache)

  return { ...toCache, cached: false }
}

/**
 * Géocode un tableau d'adresses en parallèle (batches de 5).
 * @param {string[]} addresses
 * @returns {Object} map adresse → { lat, lng, ... } | null
 */
async function batchGeocode(addresses) {
  const unique = [...new Set(addresses.filter(a => a && a !== 'nan' && a.length >= 5))]
  const results = {}

  for (let i = 0; i < unique.length; i += 5) {
    const batch = unique.slice(i, i + 5)
    const resolved = await Promise.allSettled(batch.map(addr =>
      geocodeAddress(addr).then(r => ({ addr, r }))
    ))
    for (const item of resolved) {
      if (item.status === 'fulfilled') results[item.value.addr] = item.value.r
    }
    // Petit délai entre batches si Nominatim est utilisé (rate-limit 1 req/s)
    if (!process.env.GOOGLE_MAPS_KEY && i + 5 < unique.length) {
      await new Promise(res => setTimeout(res, 200))
    }
  }
  return results
}

/**
 * Applique les coordonnées géocodées à un tableau d'interventions.
 * Modifie iv.lat et iv.lng in-place.
 * @returns {{ found: number, notFound: string[] }}
 */
async function geocodeInterventions(interventions) {
  const addresses = interventions.map(iv => iv.addr).filter(Boolean)
  const geoMap = await batchGeocode(addresses)

  let found = 0
  const notFound = []

  for (const iv of interventions) {
    if (!iv.addr) continue
    const geo = geoMap[iv.addr]
    if (geo?.lat && geo?.lng) {
      iv.lat = geo.lat
      iv.lng = geo.lng
      iv.geoFormatted = geo.formatted
      found++
    } else {
      notFound.push(iv.addr)
    }
  }

  return { found, notFound }
}

// ── Exports pour les autres fonctions Netlify ─────────────────
module.exports = { geocodeAddress, batchGeocode, geocodeInterventions }

// ── Handler HTTP ──────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' }
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'POST only' }) }

  let body
  try { body = JSON.parse(event.body || '{}') }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) } }

  // Mode batch : { addresses: ["addr1", "addr2", ...] }
  if (Array.isArray(body.addresses)) {
    const results = await batchGeocode(body.addresses)
    const stats = {
      total:    body.addresses.length,
      found:    Object.values(results).filter(Boolean).length,
      notFound: Object.values(results).filter(r => !r).length
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ results, stats }) }
  }

  // Mode unitaire : { address: "..." }
  if (typeof body.address === 'string') {
    const result = await geocodeAddress(body.address)
    if (result) return { statusCode: 200, headers: CORS, body: JSON.stringify({ found: true, ...result }) }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ found: false, address: body.address }) }
  }

  return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: '"address" ou "addresses" requis' }) }
}
