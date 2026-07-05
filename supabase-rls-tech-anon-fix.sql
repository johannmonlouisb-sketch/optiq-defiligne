-- ═══════════════════════════════════════════════════════════════
-- OptiQ — Rétablit l'accès technicien (anon) sur les clés opérationnelles
-- À coller dans : Supabase → SQL Editor → New query → Run
--
-- Contexte : la RLS ajoutée le 2026-07-05 sur app_state exige
-- auth.role() = 'authenticated'. Seul l'admin a une vraie session
-- Supabase Auth — les techniciens utilisent encore le PIN legacy et
-- n'ont donc jamais ce rôle. Résultat : toute la synchro cloud côté
-- technicien (interventions, progression de tournée, matériel préparé,
-- ordre de tournée) a été bloquée en silence.
--
-- Ce script réouvre l'accès anon UNIQUEMENT pour les 4 clés que
-- l'app technicien utilise réellement. Toute autre clé (et toute clé
-- future) reste protégée authenticated-only.
-- ═══════════════════════════════════════════════════════════════

drop policy if exists "anon read tech keys"  on public.app_state;
drop policy if exists "anon write tech keys" on public.app_state;

create policy "anon read tech keys"
  on public.app_state for select
  using ( key in ('optiq_ivs_data','optiq_route_order','optiq_tour_progress','optiq_mat_prep') );

create policy "anon write tech keys"
  on public.app_state for all
  using ( key in ('optiq_ivs_data','optiq_route_order','optiq_tour_progress','optiq_mat_prep') )
  with check ( key in ('optiq_ivs_data','optiq_route_order','optiq_tour_progress','optiq_mat_prep') );

-- Vérification : doit maintenant lister 4 policies "anon" + les policies "authenticated" existantes
select schemaname, tablename, policyname, cmd
from pg_policies
where tablename = 'app_state'
order by policyname;
