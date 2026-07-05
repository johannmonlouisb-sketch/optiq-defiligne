-- ═══════════════════════════════════════════════════════════════
-- OptiQ — Activer la RLS sur les tables de données
-- À coller dans : Supabase → SQL Editor → New query → Run
--
-- Contexte : la clé anon (visible dans defiligne.html et tech.html) permet
-- aujourd'hui de lire ET écrire ces tables sans aucune authentification.
-- Vérifié le 2026-07-05 : une requête REST avec la seule clé anon a pu lire
-- de vraies données de production dans app_state, et y insérer une ligne.
--
-- Après ce script, seules les requêtes portant un token de session Supabase
-- valide (utilisateur connecté, voir sbAuthHeaders() dans defiligne.html)
-- pourront lire/écrire. La clé anon seule ne suffira plus.
-- ═══════════════════════════════════════════════════════════════

-- 1) app_state -----------------------------------------------------------
alter table public.app_state enable row level security;

drop policy if exists "authenticated read app_state"  on public.app_state;
drop policy if exists "authenticated write app_state" on public.app_state;

create policy "authenticated read app_state"
  on public.app_state for select
  using ( auth.role() = 'authenticated' );

create policy "authenticated write app_state"
  on public.app_state for all
  using ( auth.role() = 'authenticated' )
  with check ( auth.role() = 'authenticated' );

-- 2) kizeo_sites -----------------------------------------------------------
alter table public.kizeo_sites enable row level security;

drop policy if exists "authenticated read kizeo_sites"  on public.kizeo_sites;
drop policy if exists "authenticated write kizeo_sites" on public.kizeo_sites;

create policy "authenticated read kizeo_sites"
  on public.kizeo_sites for select
  using ( auth.role() = 'authenticated' );

create policy "authenticated write kizeo_sites"
  on public.kizeo_sites for all
  using ( auth.role() = 'authenticated' )
  with check ( auth.role() = 'authenticated' );

-- Vérification : doit lister les policies ci-dessus pour les deux tables
select schemaname, tablename, policyname, cmd
from pg_policies
where tablename in ('app_state','kizeo_sites')
order by tablename, policyname;
