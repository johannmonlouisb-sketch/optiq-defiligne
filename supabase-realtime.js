// ═══════════════════════════════════════════════════════
// SUPABASE REALTIME SYNC
// Gère la synchronisation en temps réel des données
// ═══════════════════════════════════════════════════════

let supabaseRealtimeSubscriptions = {}

// ── Écouter les interventions en temps réel ──
async function subscribeToInterventions(onChanged) {
  if (!supabase) {
    console.warn('Supabase not initialized')
    return
  }

  const subscription = supabase
    .channel('interventions_changes')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'interventions'
    }, (payload) => {
      console.log('Realtime intervention update:', payload)
      const { eventType, new: newData, old: oldData } = payload

      if (eventType === 'INSERT') {
        onChanged({ type: 'INSERT', data: newData })
      } else if (eventType === 'UPDATE') {
        onChanged({ type: 'UPDATE', data: newData, oldData })
      } else if (eventType === 'DELETE') {
        onChanged({ type: 'DELETE', id: oldData.id })
      }
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') console.log('✓ Subscribed to interventions')
      if (status === 'CHANNEL_ERROR') console.error('Channel error:', status)
    })

  supabaseRealtimeSubscriptions.interventions = subscription
  return subscription
}

// ── Écouter les techniciens en temps réel ──
async function subscribeToTechniciens(onChanged) {
  if (!supabase) return

  const subscription = supabase
    .channel('techniciens_changes')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'techniciens'
    }, (payload) => {
      console.log('Technicien update:', payload)
      onChanged(payload)
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') console.log('✓ Subscribed to techniciens')
    })

  supabaseRealtimeSubscriptions.techniciens = subscription
  return subscription
}

// ── Écouter les tournées en temps réel ──
async function subscribeToTournees(onChanged) {
  if (!supabase) return

  const subscription = supabase
    .channel('tournees_changes')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'tournees'
    }, (payload) => {
      console.log('Tournée update:', payload)
      onChanged(payload)
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') console.log('✓ Subscribed to tournees')
    })

  supabaseRealtimeSubscriptions.tournees = subscription
  return subscription
}

// ── Insérer une intervention ──
async function insertIntervention(data) {
  if (!supabase) return null
  const { data: result, error } = await supabase
    .from('interventions')
    .insert([data])
    .select()
  if (error) console.error('Insert error:', error)
  return result?.[0]
}

// ── Mettre à jour une intervention ──
async function updateIntervention(id, data) {
  if (!supabase) return null
  const { data: result, error } = await supabase
    .from('interventions')
    .update(data)
    .eq('id', id)
    .select()
  if (error) console.error('Update error:', error)
  return result?.[0]
}

// ── Charger les interventions du jour ──
async function getInterventionsByDate(date) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('interventions')
    .select('*')
    .eq('date', date)
    .order('date', { ascending: true })
  if (error) console.error('Fetch error:', error)
  return data || []
}

// ── Charger les interventions d'un technicien ──
async function getInterventionsByTech(techId, date) {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('interventions')
    .select('*')
    .eq('tech_id', techId)
    .eq('date', date)
    .order('date', { ascending: true })
  if (error) console.error('Fetch error:', error)
  return data || []
}

// ── Charger tous les techniciens ──
async function getTechniciens() {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('techniciens')
    .select('*')
    .eq('available', true)
  if (error) console.error('Fetch error:', error)
  return data || []
}

// ── Sauvegarder une tournée ──
async function saveTournee(techId, date, stats) {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('tournees')
    .upsert({
      tech_id: techId,
      date: date,
      ...stats,
      updated_at: new Date()
    })
    .select()
  if (error) console.error('Tournee save error:', error)
  return data?.[0]
}

// ── Nettoyer les subscriptions ──
function unsubscribeAll() {
  Object.values(supabaseRealtimeSubscriptions).forEach(sub => {
    if (sub) sub.unsubscribe()
  })
  supabaseRealtimeSubscriptions = {}
  console.log('✓ All subscriptions cleaned up')
}
