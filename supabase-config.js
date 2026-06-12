// Supabase Configuration — clé anon publique
const SUPABASE_URL = 'https://yjcmfoxvyxzgixnrvcnn.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
  '.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqY21mb3h2eXh6Z2l4bnJ2Y25uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwNjYwNzMsImV4cCI6MjA5MTY0MjA3M30' +
  '.1aR7ZdyBMjqhb9DhpZgXOxvaw0FcPYfeWqlKAOoyHeg'

// CDN déjà chargé avant ce script — créer le client directement
let supabase = null
if (window.supabase?.createClient) {
  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
}
