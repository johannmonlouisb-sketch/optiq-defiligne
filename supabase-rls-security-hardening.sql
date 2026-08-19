-- ═══════════════════════════════════════════════════════════════════════
-- OptiTechX — Durcissement sécurité RLS (audit sécurité, branche security-hardening)
-- À coller dans : Supabase → SQL Editor → New query → Run
--
-- Ne remplace PAS les anciens scripts (supabase-rls-data-setup.sql,
-- supabase-rls-tech-anon-fix.sql, supabase-rls-add-gcache.sql,
-- supabase-rls-add-dae-stock.sql) — il s'exécute APRÈS eux et corrige
-- uniquement le problème identifié par l'audit :
--
--   Les policies "authenticated ... app_state" (et kizeo_sites) donnaient un
--   accès COMPLET (lecture + écriture) à TOUT utilisateur ayant une session
--   Supabase Auth valide, sans vérifier profiles.role='admin'. Comme seuls
--   les comptes admin ont une session Supabase Auth dans cette appli (les
--   techniciens utilisent un PIN + token HMAC séparé, jamais Supabase Auth),
--   le risque concret est : si les inscriptions publiques Supabase sont
--   activées, n'importe qui pourrait créer un compte et obtenir un accès
--   total à toutes les données (interventions, stock...) — cf. section
--   "INSCRIPTIONS SUPABASE" plus bas.
--
-- Vérifié empiriquement (tests curl avec la seule clé anon, sans session)
-- avant d'écrire ce script : l'écriture anon sur une clé app_state non
-- whitelistée échoue déjà (RLS correcte), de même que l'écriture anon sur
-- kizeo_sites. Les anciennes policies totalement ouvertes définies dans
-- supabase/schema.sql (USING(true) sans restriction) ne sont PAS actives
-- actuellement — mais ce script les supprime quand même par sécurité, au
-- cas où elles seraient un jour recréées par erreur (schema.sql ne doit
-- plus jamais être exécuté tel quel sur cette base : il fait aussi un
-- DROP TABLE ... CASCADE sur des tables contenant des données réelles).
-- ═══════════════════════════════════════════════════════════════════════

-- 1) app_state — accès complet réservé aux admins réels (pas "authenticated") ----
drop policy if exists "authenticated read app_state"  on public.app_state;
drop policy if exists "authenticated write app_state" on public.app_state;
-- Filet de sécurité : anciennes policies fully-open de supabase/schema.sql,
-- si jamais elles existent encore sous un nom différent.
drop policy if exists "anon_read_state"  on public.app_state;
drop policy if exists "anon_write_state" on public.app_state;

create policy "admin full app_state"
  on public.app_state for all
  using ( exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') )
  with check ( exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') );

-- Les policies anon existantes (clés précises : optiq_ivs_data, optiq_route_order,
-- optiq_tour_progress, optiq_mat_prep, optiq_gcache, optiq_dae_stock) sont
-- CONSERVÉES telles quelles — elles sont nécessaires au fonctionnement des
-- techniciens, qui n'ont pas de session Supabase Auth :
--   optiq_ivs_data     : lecture/écriture des interventions du jour (statut,
--                        notes...) — coeur du fonctionnement terrain.
--   optiq_route_order  : ordre de tournée choisi/réordonné sur le terrain.
--   optiq_tour_progress: suivi en direct (départ, validations) visible admin.
--   optiq_mat_prep     : confirmation "matériel préparé" par le technicien.
--   optiq_gcache       : cache de géocodage partagé, aucune donnée sensible.
--   optiq_dae_stock    : registre de sortie de stock DAE scanné sur le terrain.
-- Elles ne sont PAS supprimées ni recréées ici (cf. supabase-rls-add-dae-stock.sql
-- pour leur définition actuelle).

-- 2) kizeo_sites — même correctif (si la table existe sur ce projet) --------------
drop policy if exists "authenticated read kizeo_sites"  on public.kizeo_sites;
drop policy if exists "authenticated write kizeo_sites" on public.kizeo_sites;
drop policy if exists "anon_read_kizeo"  on public.kizeo_sites;
drop policy if exists "anon_write_kizeo" on public.kizeo_sites;

create policy "admin full kizeo_sites"
  on public.kizeo_sites for all
  using ( exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') )
  with check ( exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') );

-- 3) articles_stock / mouvements_stock — même correctif ---------------------------
-- (créées cette session, cf. supabase-stock-articles-setup.sql — la quantité en
-- stock n'est de toute façon jamais modifiable directement, ni par anon ni par un
-- compte authentifié non-admin : seul le trigger SECURITY DEFINER la modifie).
drop policy if exists "admin full articles_stock" on public.articles_stock;
create policy "admin full articles_stock"
  on public.articles_stock for all
  using ( exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') )
  with check ( exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') );

drop policy if exists "admin full mouvements_stock" on public.mouvements_stock;
create policy "admin full mouvements_stock"
  on public.mouvements_stock for all
  using ( exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') )
  with check ( exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') );
-- Les policies anon (lecture + création, pas de suppression/modification directe
-- de quantité) sont conservées telles quelles — nécessaires aux techniciens qui
-- scannent depuis le terrain, cf. supabase-stock-articles-setup.sql.

-- 4) interventions / techniciens (tables non utilisées activement, cf.
--    supabase/schema.sql — Notion reste la source de vérité) : on retire leur
--    lecture publique par précaution, elles ne servent à rien aujourd'hui et ne
--    doivent pas devenir un point d'exposition oublié si elles sont peuplées
--    un jour par erreur.
drop policy if exists "anon_read_iv"    on public.interventions;
drop policy if exists "anon_read_techs" on public.techniciens;

-- ── Vérification ──────────────────────────────────────────────────────────────
select schemaname, tablename, policyname, cmd
from pg_policies
where tablename in ('app_state','kizeo_sites','articles_stock','mouvements_stock','interventions','techniciens')
order by tablename, policyname;

-- ═══════════════════════════════════════════════════════════════════════
-- ACTION MANUELLE REQUISE — INSCRIPTIONS SUPABASE
-- ═══════════════════════════════════════════════════════════════════════
-- Ce script ne peut pas vérifier ni modifier ce réglage depuis du SQL — à
-- vérifier toi-même dans le Dashboard :
--   Supabase → Authentication → Providers → Email → "Allow new users to sign up"
-- Si activé : n'importe qui pourrait créer un compte Supabase Auth. Grâce à
-- ce script, un tel compte n'aurait PLUS d'accès à app_state (role='tech' par
-- défaut, policies désormais réservées à role='admin') — mais autant le
-- désactiver si aucune inscription publique n'est réellement nécessaire,
-- en défense en profondeur.
