# 🚀 Guide Installation Supabase Realtime

## Étape 1: Créer un compte Supabase

1. Va sur https://supabase.com
2. Crée un compte gratuit
3. Crée un nouveau projet
4. Attends la création (2-3 min)

## Étape 2: Récupérer tes credentials

Dans le dashboard Supabase:
1. Clique sur "Settings" → "API"
2. Copie:
   - `Project URL` → remplace `YOUR_PROJECT_ID.supabase.co`
   - `anon public` key → remplace `YOUR_ANON_KEY`

Exemple:
```javascript
const SUPABASE_URL = 'https://abcdef123456.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
```

## Étape 3: Exécuter les migrations SQL

1. Dans Supabase Dashboard → SQL Editor
2. Crée une nouvelle query
3. Copie/colle tout le contenu de `supabase-migrations.sql`
4. Clique "Run"

## Étape 4: Ajouter Supabase à tech.html

```html
<head>
  <!-- Ajouter après les autres scripts -->
  <script src="/supabase-config.js"></script>
  <script src="/supabase-realtime.js"></script>
</head>
```

## Étape 5: Ajouter Supabase à defiligne_v3.html

Même chose que tech.html

## Étape 6: Migrer données Notion → Supabase

(Voir script de migration ci-dessous)

---

## Test rapide

Ouvre la console (F12) et teste:

```javascript
await initSupabase()
const techs = await getTechniciens()
console.log(techs)
```

Devrait afficher tes techniciens!
