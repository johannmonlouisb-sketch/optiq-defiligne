// Supabase Configuration
// À remplir avec tes credentials depuis https://supabase.com

const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co'
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY'

// Import dynamique de Supabase (via CDN)
let supabase = null

async function initSupabase() {
  if (typeof window === 'undefined') return

  // Charger la lib Supabase
  if (!window.supabase) {
    const script = document.createElement('script')
    script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
    document.head.appendChild(script)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  const { createClient } = window.supabase
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  console.log('✓ Supabase initialized')
  return supabase
}

// Initialiser au chargement
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSupabase)
} else {
  initSupabase()
}
