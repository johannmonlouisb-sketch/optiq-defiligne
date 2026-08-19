-- ═══════════════════════════════════════════════════════════════
-- OptiTechX — Module Stock consommables (Pad-Pak, électrodes, batteries...)
-- À coller dans : Supabase → SQL Editor → New query → Run
--
-- Contrairement au reste de l'appli (tout stocké en JSON dans app_state),
-- ce module utilise de vraies tables relationnelles : les quantités et
-- l'historique de mouvements s'y prêtent beaucoup mieux (filtres, agrégats,
-- cohérence sous écritures concurrentes).
--
-- Sécurité : la quantité en stock n'est JAMAIS modifiable directement (ni par
-- l'admin, ni par un technicien) — elle est recalculée uniquement par un
-- trigger serveur (SECURITY DEFINER) à chaque insertion d'un mouvement.
-- Aucun mouvement ne peut être supprimé (traçabilité) : une correction se
-- fait via un nouveau mouvement inverse.
-- ═══════════════════════════════════════════════════════════════

-- 1) Table des articles ----------------------------------------------------
create table if not exists public.articles_stock (
  id                uuid primary key default gen_random_uuid(),
  nom               text not null,
  reference         text,
  code_barres       text unique,
  categorie         text,
  description       text,
  quantite_stock    integer not null default 0,
  stock_minimum     integer not null default 0,
  emplacement       text,
  fournisseur       text,
  prix              numeric(10,2),
  actif             boolean not null default true,
  date_creation     timestamptz not null default now(),
  date_modification timestamptz not null default now()
);

create index if not exists idx_articles_stock_code_barres on public.articles_stock(code_barres);
create index if not exists idx_articles_stock_actif on public.articles_stock(actif);

-- 2) Table des mouvements ---------------------------------------------------
-- intervention_id : pas de vraie clé étrangère possible — les interventions
-- ne vivent pas en table relationnelle dans ce projet (elles sont stockées en
-- JSON dans app_state.optiq_ivs_data, Notion étant la source de vérité). On
-- stocke donc l'id local (numérique) ou le notionId en texte libre, sans
-- contrainte FK.
create table if not exists public.mouvements_stock (
  id             uuid primary key default gen_random_uuid(),
  article_id     uuid not null references public.articles_stock(id),
  type           text not null check (type in ('entree','sortie')),
  quantite       integer not null check (quantite > 0),
  stock_avant    integer not null,
  stock_apres    integer not null,
  utilisateur    text,
  tech_id        integer,
  intervention_id text,
  intervention_label text,
  notes          text,
  date           timestamptz not null default now()
);

create index if not exists idx_mouvements_article on public.mouvements_stock(article_id);
create index if not exists idx_mouvements_date on public.mouvements_stock(date desc);
create index if not exists idx_mouvements_intervention on public.mouvements_stock(intervention_id);

-- 3) Trigger : recalcule la quantité + date_modification à chaque mouvement -
create or replace function public.apply_mouvement_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.articles_stock
  set quantite_stock = new.stock_apres,
      date_modification = now()
  where id = new.article_id;
  return new;
end;
$$;

drop trigger if exists trg_apply_mouvement_stock on public.mouvements_stock;
create trigger trg_apply_mouvement_stock
  after insert on public.mouvements_stock
  for each row execute function public.apply_mouvement_stock();

-- 4) RLS ---------------------------------------------------------------------
alter table public.articles_stock enable row level security;
alter table public.mouvements_stock enable row level security;

-- Admin (session Supabase Auth authentifiée) : accès complet
drop policy if exists "admin full articles_stock" on public.articles_stock;
create policy "admin full articles_stock"
  on public.articles_stock for all
  using ( auth.role() = 'authenticated' )
  with check ( auth.role() = 'authenticated' );

drop policy if exists "admin full mouvements_stock" on public.mouvements_stock;
create policy "admin full mouvements_stock"
  on public.mouvements_stock for all
  using ( auth.role() = 'authenticated' )
  with check ( auth.role() = 'authenticated' );

-- Technicien (clé anon, pas de session) : lecture + création d'article,
-- MAIS PAS de modification directe de quantite_stock (pas de droit UPDATE),
-- et lecture + création de mouvements SEULEMENT (pas de suppression/modif).
drop policy if exists "anon read articles_stock" on public.articles_stock;
create policy "anon read articles_stock"
  on public.articles_stock for select
  using ( true );

drop policy if exists "anon insert articles_stock" on public.articles_stock;
create policy "anon insert articles_stock"
  on public.articles_stock for insert
  with check ( true );

drop policy if exists "anon read mouvements_stock" on public.mouvements_stock;
create policy "anon read mouvements_stock"
  on public.mouvements_stock for select
  using ( true );

drop policy if exists "anon insert mouvements_stock" on public.mouvements_stock;
create policy "anon insert mouvements_stock"
  on public.mouvements_stock for insert
  with check ( true );

-- Vérification
select schemaname, tablename, policyname, cmd
from pg_policies
where tablename in ('articles_stock','mouvements_stock')
order by tablename, policyname;
