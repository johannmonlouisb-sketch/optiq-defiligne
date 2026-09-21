// stock-module.js — Module Stock consommables (Pad-Pak, électrodes, batteries...)
// Partagé entre defiligne.html (admin) et tech.html (technicien).
// Couche données pure (fetch/insert Supabase) — le rendu HTML reste dans chaque page,
// qui a ses propres conventions CSS. Utilise de vraies tables (articles_stock,
// mouvements_stock), pas le pattern app_state en JSON utilisé ailleurs dans l'appli :
// les quantités/mouvements s'y prêtent mal (concurrence, filtres, historique).
//
// La quantité en stock n'est jamais écrite directement par le client : un trigger
// Postgres (SECURITY DEFINER) la recalcule à chaque insertion dans mouvements_stock.
// Voir supabase-stock-articles-setup.sql.

const StockModule = (() => {
  let _baseUrl = null       // ex: https://xxx.supabase.co/rest/v1
  let _getHeaders = null    // async () => {apikey, Authorization, ...}
  let _getActor = null      // () => {techId, label}  — qui fait le mouvement

  function init({ baseUrl, getHeaders, getActor }) {
    _baseUrl = baseUrl.replace(/\/$/, '')
    _getHeaders = getHeaders
    _getActor = getActor || (() => ({ techId: null, label: 'Admin' }))
  }

  async function _headers(extra) {
    const h = await _getHeaders()
    return { ...h, ...extra }
  }

  // PGRST205 = PostgREST ne trouve pas la table dans son cache de schéma — dans ce
  // module ça veut dire quasi toujours que supabase-stock-articles-setup.sql n'a
  // jamais été exécuté sur ce projet Supabase (tables absentes), pas une vraie
  // erreur applicative. Sans ça, chaque appelant affichait un JSON brut illisible
  // ("Stock GET 404: {"code":"PGRST205",...}") au technicien comme à l'admin.
  function _friendlyError(status, rawText) {
    let body = null
    try { body = JSON.parse(rawText) } catch (e) {}
    if (body?.code === 'PGRST205') {
      const err = new Error("Module Stock pas encore configuré — contacte l'administrateur (tables Supabase manquantes).")
      err.code = 'STOCK_NOT_SETUP'
      return err
    }
    const err = new Error(`Stock ${status}: ${rawText.substring(0, 150)}`)
    return err
  }

  async function _get(path) {
    const r = await fetch(`${_baseUrl}/${path}`, { headers: await _headers(), signal: AbortSignal.timeout(10000) })
    if (!r.ok) throw _friendlyError(r.status, await r.text())
    return r.json()
  }

  async function _post(path, body, prefer) {
    const r = await fetch(`${_baseUrl}/${path}`, {
      method: 'POST',
      headers: await _headers({ 'Content-Type': 'application/json', Prefer: prefer || 'return=representation' }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    })
    if (!r.ok) throw _friendlyError(r.status, await r.text())
    const t = await r.text()
    return t ? JSON.parse(t) : null
  }

  // ── Articles ──────────────────────────────────────────────────────────
  async function listArticles({ activeOnly = true } = {}) {
    const q = activeOnly ? 'articles_stock?actif=eq.true&order=nom.asc' : 'articles_stock?order=nom.asc'
    return _get(q)
  }

  async function findByBarcode(code) {
    if (!code) return null
    const rows = await _get(`articles_stock?code_barres=eq.${encodeURIComponent(code)}&limit=1`)
    return rows[0] || null
  }

  async function createArticle(data) {
    const rows = await _post('articles_stock', {
      nom: data.nom, reference: data.reference || null, code_barres: data.code_barres || null,
      categorie: data.categorie || null, description: data.description || null,
      quantite_stock: 0, stock_minimum: data.stock_minimum || 0,
      emplacement: data.emplacement || null, fournisseur: data.fournisseur || null,
      prix: data.prix || null, actif: true
    })
    return rows[0]
  }

  async function updateArticle(id, patch) {
    await fetch(`${_baseUrl}/articles_stock?id=eq.${id}`, {
      method: 'PATCH',
      headers: await _headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ ...patch, date_modification: new Date().toISOString() }),
      signal: AbortSignal.timeout(10000)
    })
  }

  // ── Mouvements ────────────────────────────────────────────────────────
  // Recharge la quantité actuelle juste avant d'écrire pour limiter (sans l'éliminer
  // totalement — cohérent avec le reste de l'appli qui n'a pas de verrou serveur) la
  // fenêtre de course entre deux scans concurrents sur le même article.
  async function recordMovement({ articleId, type, quantite, interventionId, interventionLabel, notes }) {
    const fresh = await _get(`articles_stock?id=eq.${articleId}&select=quantite_stock&limit=1`)
    const before = fresh[0]?.quantite_stock ?? 0
    const after = type === 'entree' ? before + quantite : before - quantite
    if (type === 'sortie' && after < 0) {
      const e = new Error(`Stock insuffisant (disponible : ${before}, demandé : ${quantite})`)
      e.code = 'INSUFFICIENT_STOCK'
      throw e
    }
    const actor = _getActor()
    const rows = await _post('mouvements_stock', {
      article_id: articleId, type, quantite,
      stock_avant: before, stock_apres: after,
      utilisateur: actor.label, tech_id: actor.techId,
      intervention_id: interventionId || null, intervention_label: interventionLabel || null,
      notes: notes || null
    })
    return rows[0]
  }

  // Plusieurs mouvements en une fois (validation du scan continu) — séquentiel pour
  // garder stock_avant/stock_apres cohérents même si le même article apparaît 2x.
  async function recordMovements(list) {
    const results = []
    for (const m of list) {
      results.push(await recordMovement(m))
    }
    return results
  }

  async function listMovements({ type, articleId, techId, interventionId, dateFrom, dateTo, search, limit = 200 } = {}) {
    const parts = ['mouvements_stock?select=*,articles_stock(nom,reference,code_barres)&order=date.desc', `limit=${limit}`]
    if (type) parts.push(`type=eq.${type}`)
    if (articleId) parts.push(`article_id=eq.${articleId}`)
    if (techId) parts.push(`tech_id=eq.${techId}`)
    if (interventionId) parts.push(`intervention_id=eq.${encodeURIComponent(interventionId)}`)
    if (dateFrom) parts.push(`date=gte.${dateFrom}`)
    if (dateTo) parts.push(`date=lte.${dateTo}T23:59:59`)
    let rows = await _get(parts.join('&'))
    if (search) {
      const s = search.toLowerCase()
      rows = rows.filter(r => (r.articles_stock?.nom || '').toLowerCase().includes(s) ||
        (r.utilisateur || '').toLowerCase().includes(s) ||
        (r.intervention_label || '').toLowerCase().includes(s))
    }
    return rows
  }

  // ── Alertes ───────────────────────────────────────────────────────────
  async function lowStockArticles() {
    const all = await listArticles()
    return all.filter(a => a.quantite_stock <= a.stock_minimum)
  }

  return {
    init, listArticles, findByBarcode, createArticle, updateArticle,
    recordMovement, recordMovements, listMovements, lowStockArticles
  }
})()
