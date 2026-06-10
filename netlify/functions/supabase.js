// netlify/functions/supabase.js
// Désactivé temporairement

exports.handler = async () => ({
  statusCode: 503,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error: 'Supabase non configuré' })
})
