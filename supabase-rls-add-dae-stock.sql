-- ═══════════════════════════════════════════════════════════════
-- OptiQ — Ajoute optiq_dae_stock aux clés accessibles par l'app technicien (anon)
-- À coller dans : Supabase → SQL Editor → New query → Run
--
-- Nouvelle fonctionnalité : scan des numéros de série DAE au moment où le
-- technicien prépare son matériel (sortie de stock). Sans ce script, ni les
-- techniciens ni l'appli admin ne peuvent lire/écrire cette nouvelle clé.
-- ═══════════════════════════════════════════════════════════════

drop policy if exists "anon read tech keys"  on public.app_state;
drop policy if exists "anon write tech keys" on public.app_state;

create policy "anon read tech keys"
  on public.app_state for select
  using ( key in ('optiq_ivs_data','optiq_route_order','optiq_tour_progress','optiq_mat_prep','optiq_gcache','optiq_dae_stock') );

create policy "anon write tech keys"
  on public.app_state for all
  using ( key in ('optiq_ivs_data','optiq_route_order','optiq_tour_progress','optiq_mat_prep','optiq_gcache','optiq_dae_stock') )
  with check ( key in ('optiq_ivs_data','optiq_route_order','optiq_tour_progress','optiq_mat_prep','optiq_gcache','optiq_dae_stock') );

-- Vérification : doit maintenant lister les policies "anon" + "authenticated" existantes
select schemaname, tablename, policyname, cmd
from pg_policies
where tablename = 'app_state'
order by policyname;
