// ═══════════════════════════════════════════════════════
// HYBRID MODE: Notion + Supabase en parallèle
// ═══════════════════════════════════════════════════════

// ── Mettre à jour une intervention (Notion + Supabase) ──
async function updateIvHybrid(id, data) {
  const iv = ivs.find(i => i.id === id)
  if (!iv) return

  // 1. Mettre à jour localement
  Object.assign(iv, data)
  saveIvs()

  // 2. Envoyer à Notion — checkboxes Terminer/Echec + Commercial si technicien changé
  if (iv.notionId) {
    try {
      const props = {}
      if (data.status !== undefined) {
        props['Terminer'] = { checkbox: data.status === 'completed' }
        props['Echec']    = { checkbox: data.status === 'not_responded' }
      }
      if (data.techId) {
        const techName = TB(data.techId)?.name
        if (techName) props['Commercial'] = { select: { name: techName } }
      }
      if (data.notes !== undefined) props['INFO '] = { rich_text: [{ text: { content: String(data.notes || '') } }] }
      if (Object.keys(props).length) {
        await notionCall('update_page', { pageId: iv.notionId, properties: props })
      }
    } catch (e) {
      console.warn('Notion update failed:', e.message)
    }
  }

  // 3. Envoyer à Supabase (nouveau)
  // typeof-check : updateIntervention vit dans supabase-realtime.js, pas toujours chargé
  if (supabase && typeof updateIntervention === 'function') {
    try {
      await updateIntervention(id, {
        status: data.status,
        tech_id: data.techId,
        notes: data.notes
      })
      console.log('✓ Supabase sync:', id)
    } catch (e) {
      console.warn('Supabase update failed:', e.message)
    }
  }
}

// ── Valider une intervention (Notion + Supabase) ──
async function validateIvHybrid(id) {
  const iv = ivs.find(i => i.id === id)
  if (!iv) return

  // Marquer comme validée
  iv.status = 'completed'
  saveIvs()

  // Sync Notion — Terminer=true, Echec=false
  if (iv.notionId) {
    try {
      await notionCall('update_page', {
        pageId: iv.notionId,
        properties: {
          'Terminer': { checkbox: true },
          'Echec':    { checkbox: false }
        }
      })
    } catch (e) {
      console.warn('Notion validation failed:', e.message)
    }
  }

  // Sync Supabase
  if (supabase && typeof updateIntervention === 'function') {
    try {
      await updateIntervention(id, { status: 'completed' })
      console.log('✓ Validation sync Supabase:', id)
    } catch (e) {
      console.warn('Supabase validation failed:', e.message)
    }
  }

  // Sync Kizeo si configuré
  if (techCfg.token && iv.kizeoId) {
    try {
      await syncKizeo()
    } catch (e) {
      console.warn('Kizeo sync failed:', e.message)
    }
  }
}

// ── Ajouter une intervention (Notion + Supabase) ──
async function createIvHybrid(clientData) {
  // 1. Créer localement
  const newId = Math.max(...ivs.map(i => i.id || 0)) + 1
  const iv = { id: newId, ...clientData, status: 'pending' }
  ivs.push(iv)
  saveIvs()

  // 2. Créer dans Supabase
  if (supabase && typeof insertIntervention === 'function') {
    try {
      const result = await insertIntervention({
        id: newId,
        client: clientData.client,
        addr: clientData.addr,
        date: clientData.date,
        type: clientData.type,
        status: 'pending',
        tech_id: clientData.techId,
        notes: clientData.notes
      })
      console.log('✓ Créé dans Supabase:', result?.id)
    } catch (e) {
      console.warn('Supabase create failed:', e.message)
    }
  }

  // 3. Créer dans Notion si configuré
  if (window.notionToken) {
    try {
      const notionResult = await notionCall('create_page', {
        properties: {
          'Client': { title: [{ text: { content: clientData.client } }] },
          'Adresse': { rich_text: [{ text: { content: clientData.addr } }] }
        }
      })
      iv.notionId = notionResult?.id
      saveIvs()
    } catch (e) {
      console.warn('Notion create failed:', e.message)
    }
  }

  return iv
}

// ── Archiver une intervention (Notion + Supabase) ──
async function archiveIvHybrid(id) {
  const iv = ivs.find(i => i.id === id)
  if (!iv) return

  // 1. Supprimer localement
  ivs = ivs.filter(i => i.id !== id)
  saveIvs()

  // 2. Archiver dans Notion
  if (iv.notionId) {
    try {
      await notionCall('archive_page', { pageId: iv.notionId })
    } catch (e) {
      console.warn('Notion archive failed:', e.message)
    }
  }

  // 3. Archiver dans Supabase (soft delete: archived=true)
  if (supabase) {
    try {
      // Supabase n'a pas de delete physique dans ce schema, on peut mettre status='archived'
      await updateIntervention(id, { status: 'archived' })
      console.log('✓ Archivé dans Supabase:', id)
    } catch (e) {
      console.warn('Supabase archive failed:', e.message)
    }
  }
}

// ── Charger les interventions (Supabase d'abord, fallback Notion) ──
async function loadIvsHybrid(date) {
  // 1. Essayer Supabase d'abord
  if (supabase) {
    try {
      const data = await getInterventionsByDate(date)
      if (data?.length > 0) {
        ivs = data.map(row => ({
          id: row.id,
          client: row.client,
          addr: row.addr,
          siege: row.siege,
          date: row.date,
          type: row.type,
          status: row.status,
          techId: row.tech_id,
          notes: row.notes,
          contact: row.contact,
          cphone: row.contact_phone,
          cemail: row.contact_email,
          notionId: row.notion_id,
          kizeoId: row.kizeo_id
        }))
        console.log('✓ Chargé depuis Supabase:', ivs.length)
        saveIvs()
        return ivs
      }
    } catch (e) {
      console.warn('Supabase load failed, fallback to localStorage:', e.message)
    }
  }

  // 2. Fallback Notion/localStorage
  try {
    const s = localStorage.getItem('optiq_ivs_data')
    if (s) {
      ivs = JSON.parse(s)
      console.log('✓ Chargé depuis localStorage (Notion backup):', ivs.length)
      return ivs
    }
  } catch (e) {
    console.error('localStorage load failed:', e.message)
  }

  return []
}

console.log('✓ Hybrid mode loaded - Notion + Supabase en parallèle')
