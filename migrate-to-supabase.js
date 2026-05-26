// ═══════════════════════════════════════════════════════
// MIGRATION NOTION → SUPABASE
// À exécuter une seule fois dans la console (F12)
// ═══════════════════════════════════════════════════════

async function migrateNotionToSupabase() {
  if (!supabase) {
    console.error('❌ Supabase non initialisé')
    return
  }

  console.log('🔄 Démarrage migration...')

  try {
    // ── 1. Migrer les techniciens ──
    console.log('📋 Migration des techniciens...')
    const techsData = TECHS.map(t => ({
      id: t.id,
      name: t.name,
      vehicle: t.vehicle,
      conso: parseFloat(t.conso),
      color: t.color || '#1565C0',
      available: t.avail !== false,
      depot_addr: t.depotAddr,
      init: t.init
    }))

    const { error: techError } = await supabase
      .from('techniciens')
      .upsert(techsData, { onConflict: 'id' })

    if (techError) {
      console.error('❌ Erreur techniciens:', techError)
    } else {
      console.log(`✅ ${techsData.length} techniciens migrés`)
    }

    // ── 2. Migrer les interventions ──
    console.log('📋 Migration des interventions...')

    // Charger depuis localStorage (ivs global)
    const interventionsData = (ivs || []).map(iv => ({
      id: iv.id,
      client: iv.client,
      addr: iv.addr,
      siege: iv.siege,
      date: iv.date,
      type: iv.type,
      status: iv.status,
      tech_id: iv.techId,
      notes: iv.notes,
      contact: iv.contact,
      contact_phone: iv.cphone,
      contact_email: iv.cemail,
      pad_pak: iv.padPak || false,
      pad_pak_date: iv.padPakDate,
      kizeo_id: iv.kizeoId,
      notion_id: iv.notionId
    }))

    // Upload par batch de 100 (limite Supabase)
    for (let i = 0; i < interventionsData.length; i += 100) {
      const batch = interventionsData.slice(i, i + 100)
      const { error: ivError } = await supabase
        .from('interventions')
        .upsert(batch, { onConflict: 'id' })

      if (ivError) {
        console.error(`❌ Erreur interventions batch ${i}:`, ivError)
      } else {
        console.log(`✅ Batch ${i}-${i + batch.length} migrés`)
      }
    }

    console.log(`✅ ${interventionsData.length} interventions migrées`)

    // ── 3. Migrer les tournées (si dans localStorage) ──
    console.log('📋 Migration des tournées...')
    try {
      const tourneesData = JSON.parse(localStorage.getItem('techTourneesData') || '{}')

      const tourneesRows = Object.entries(tourneesData).flatMap(([techId, dates]) =>
        Object.entries(dates).map(([date, stats]) => ({
          tech_id: parseInt(techId),
          date: date,
          start_time: stats.startTime ? stats.startTime.substring(0, 5) : null,
          end_time: stats.endTime ? stats.endTime.substring(0, 5) : null,
          duration_minutes: stats.duration,
          validated_count: stats.validated,
          failed_count: stats.failed,
          success_rate: stats.totalClients ? ((stats.validated / stats.totalClients) * 100) : 0
        }))
      )

      if (tourneesRows.length > 0) {
        const { error: tourError } = await supabase
          .from('tournees')
          .upsert(tourneesRows, { onConflict: 'tech_id,date' })

        if (tourError) {
          console.error('❌ Erreur tournées:', tourError)
        } else {
          console.log(`✅ ${tourneesRows.length} tournées migrées`)
        }
      }
    } catch (e) {
      console.warn('⚠️ Pas de données tournées à migrer')
    }

    console.log('\n✅ MIGRATION COMPLÈTE!')
    console.log('Les données Supabase sont maintenant actives et en temps réel 🚀')

  } catch (e) {
    console.error('❌ Erreur globale:', e)
  }
}

// ── Lancer la migration ──
// Copie/colle dans la console (F12) et exécute:
// migrateNotionToSupabase()
