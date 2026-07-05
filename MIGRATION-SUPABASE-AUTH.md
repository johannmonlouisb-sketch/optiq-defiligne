# OptiQ — Migration vers Supabase Auth (identifiant sécurisé)

Objectif : remplacer le login « maison » (mot de passe en clair, vérifié dans le navigateur)
par une vraie authentification : mots de passe **hachés par Supabase**, session **vérifiée
côté serveur** via JWT, et données protégées par **RLS**.

Ton projet existe déjà : `https://yjcmfoxvyxzgixnrvcnn.supabase.co`.
La clé `anon` dans `defiligne.html` est **publique par nature** — elle peut rester visible,
c'est le rôle de RLS de protéger les données.

---

## Étape 1 — Activer l'auth par email (dashboard Supabase)

1. Dashboard Supabase → **Authentication → Providers → Email** : activer.
2. Décocher **"Confirm email"** (sinon il faut valider chaque email) — Authentication → Providers → Email → *Confirm email = off*.
3. **Authentication → Users → Add user → Create new user** :
   - Email : `defiligne@optitechx.app` (ou ton vrai email)
   - Mot de passe : choisis-en un **fort** (12+ caractères). C'est ton nouvel identifiant admin.
   - Coche **"Auto Confirm User"**.

> Pour chaque technicien, crée un user de la même façon (email + mot de passe).
> Les PIN à 4 chiffres ne sont pas assez forts pour Supabase (min. 6 caractères) —
> donne-leur un mot de passe simple mais ≥ 6 caractères.

---

## Étape 2 — Table `profiles` avec les rôles (SQL Editor)

Colle ça dans **SQL Editor → New query → Run** :

```sql
-- Table des rôles liée aux comptes Auth
create table if not exists public.profiles (
  id    uuid primary key references auth.users(id) on delete cascade,
  role  text not null default 'tech',   -- 'admin' ou 'tech'
  nom   text,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

-- Chacun peut lire son propre profil
create policy "read own profile"
  on public.profiles for select
  using ( auth.uid() = id );

-- Crée automatiquement un profil à chaque nouvel utilisateur
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, nom)
  values (new.id, new.email);
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

Ensuite, marque ton compte comme admin (remplace l'email) :

```sql
update public.profiles
set role = 'admin'
where id = (select id from auth.users where email = 'defiligne@optitechx.app');
```

---

## Étape 3 — Protéger les données avec RLS

Aujourd'hui n'importe qui avec la clé anon peut lire/écrire. On restreint aux comptes connectés.
Pour **chaque** table de données (`app_state`, `kizeo_sites`, …) :

```sql
alter table public.app_state enable row level security;

create policy "authenticated read"  on public.app_state for select using ( auth.role() = 'authenticated' );
create policy "authenticated write" on public.app_state for all    using ( auth.role() = 'authenticated' ) with check ( auth.role() = 'authenticated' );

-- Répéter pour kizeo_sites, etc.
alter table public.kizeo_sites enable row level security;
create policy "authenticated read kizeo" on public.kizeo_sites for select using ( auth.role() = 'authenticated' );
```

> À partir de là, les appels `sbGet`/`sbUpsert` doivent utiliser le **token de session**
> de l'utilisateur connecté, pas la clé anon seule (voir étape 5).

---

## Étape 4 — Nouveau `login.html`

Remplace `loginAdmin()` et `saveSession()` par la version Supabase.
Assure-toi que `supabase-js` est chargé dans le `<head>` :

```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```

Puis, dans le `<script>` de `login.html` :

```js
const SB_URL = 'https://yjcmfoxvyxzgixnrvcnn.supabase.co'
const SB_KEY = 'TA_CLE_ANON'   // la même que dans defiligne.html
const sb = window.supabase.createClient(SB_URL, SB_KEY)

async function loginAdmin() {
  const email = document.getElementById('adm-user').value.trim()
  const password = document.getElementById('adm-pass').value
  if (!email || !password) { showMsg('Tous les champs sont requis'); return }
  const btn = document.getElementById('btn-adm-login')
  btn.disabled = true; btn.innerHTML = '<div class="spin"></div>Vérification…'

  const { data, error } = await sb.auth.signInWithPassword({ email, password })
  if (error) { showMsg('Identifiants incorrects'); btn.disabled=false; btn.innerHTML='Se connecter'; return }

  // Vérifier le rôle admin
  const { data: prof } = await sb.from('profiles').select('role,nom').eq('id', data.user.id).single()
  if (prof?.role !== 'admin') {
    await sb.auth.signOut()
    showMsg('Ce compte n\'a pas les droits admin')
    btn.disabled=false; btn.innerHTML='Se connecter'; return
  }
  showMsg('Accès autorisé','success')
  setTimeout(() => location.href='/defiligne', 700)
}
```

> Plus besoin de `saveSession()` : Supabase stocke lui-même la session (localStorage `sb-…-auth-token`)
> et la rafraîchit automatiquement. Tu peux supprimer l'appel à `/api/auth/login`.

Pour les techniciens, remplace le PIN par un mot de passe, ou garde le clavier PIN mais
appelle `sb.auth.signInWithPassword({ email: mapNomVersEmail(selectedTech), password: currentPin })`.

---

## Étape 5 — Contrôle d'accès dans `defiligne.html`

Remplace `_admAuthValid()` (ligne ~9314) par une vérification **serveur** de la session :

```js
const sb = window.supabase.createClient(SB_URL, SB_KEY)

async function requireAdmin() {
  const { data: { session } } = await sb.auth.getSession()
  if (!session) { location.href = '/login'; return false }
  const { data: prof } = await sb.from('profiles').select('role').eq('id', session.user.id).single()
  if (prof?.role !== 'admin') { await sb.auth.signOut(); location.href = '/login'; return false }
  return true
}

async function admLogout() {
  if (!confirm('Se déconnecter ?')) return
  await sb.auth.signOut()
  location.href = '/login'
}
```

Au démarrage de la page, appelle `await requireAdmin()` **avant** d'afficher/charger les données.

Et pour que `sbGet`/`sbUpsert` respectent RLS, utilise le token de session :

```js
async function sbAuthHeaders() {
  const { data: { session } } = await sb.auth.getSession()
  const token = session?.access_token || SB_KEY
  return { 'apikey': SB_KEY, 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
}
```
…puis remplace les `Authorization: Bearer ${SB_KEY}` par `await sbAuthHeaders()` dans `sbGet`/`sbUpsert`.

---

## Étape 6 — Nettoyage (une fois que ça marche)

- Supprimer `adminCreds` du blob settings et le champ `code` des techs (voir `CORRECTIFS-A-FAIRE.md` point 1).
- Supprimer la branche `admin` de `netlify/functions/auth.js` (remplacée par Supabase).
- Retirer les fallbacks de secrets en dur (auth.js `|| '7802'`, etc.).
- Optionnel : supprimer `login.html`/`auth.js` côté tech si tu migres aussi les techniciens.

---

## Résumé du gain

| Avant | Après (Supabase Auth) |
|-------|------------------------|
| Mot de passe `7802` en clair, lisible via `/api/settings` | Mot de passe haché, jamais exposé |
| Auth vérifiée dans le navigateur (contournable) | Session JWT vérifiée côté serveur |
| Données lisibles avec la clé anon | Données protégées par RLS (compte connecté requis) |
| Pas de reset password | Reset password intégré Supabase |
| Mono-client | Prêt pour le multi-tenant SaaS |

**Ordre conseillé :** étapes 1-2 (5 min) → étape 4 (login) → étape 5 (gating) → tester →
étape 3 (RLS, le vrai verrou) → étape 6 (nettoyage).
