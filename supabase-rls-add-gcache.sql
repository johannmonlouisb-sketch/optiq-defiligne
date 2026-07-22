-- ═══════════════════════════════════════════════════════════════
-- OptiQ — Ajoute optiq_gcache aux clés accessibles par l'app technicien (anon)
-- À coller dans : Supabase → SQL Editor → New query → Run
--
-- Le cache de géocodage (adresse → coordonnées GPS) est maintenant synchronisé
-- via Supabase, comme les interventions et l'ordre de tournée. Sans ce script,
-- les techniciens (qui n'ont pas de session Supabase Auth) ne pourraient ni
-- lire ni écrire cette nouvelle clé.
-- ═══════════════════════════════════════════════════════════════

drop policy if exists "anon read tech keys"  on public.app_state;
drop policy if exists "anon write tech keys" on public.app_state;

create policy "anon read tech keys"
  on public.app_state for select
  using ( key in ('optiq_ivs_data','optiq_route_order','optiq_tour_progress','optiq_mat_prep','optiq_gcache') );

create policy "anon write tech keys"
  on public.app_state for all
  using ( key in ('optiq_ivs_data','optiq_route_order','optiq_tour_progress','optiq_mat_prep','optiq_gcache') )
  with check ( key in ('optiq_ivs_data','optiq_route_order','optiq_tour_progress','optiq_mat_prep','optiq_gcache') );

-- Vérification : doit maintenant lister les policies "anon" + "authenticated" existantes
select schemaname, tablename, policyname, cmd
from pg_policies
where tablename = 'app_state'
order by policyname;
