-- ═══════════════════════════════════════════════════════════════════
-- SUPABASE SCHEMA — OptiTechX
-- À exécuter dans : Supabase Dashboard → SQL Editor → New Query → Run
-- ═══════════════════════════════════════════════════════════════════

-- Nettoyage des tables existantes (ancien schéma incompatible)
DROP TABLE IF EXISTS public.route_cache   CASCADE;
DROP TABLE IF EXISTS public.tournees      CASCADE;
DROP TABLE IF EXISTS public.interventions CASCADE;
DROP TABLE IF EXISTS public.techniciens   CASCADE;
DROP TABLE IF EXISTS public.kizeo_sites   CASCADE;
DROP TABLE IF EXISTS public.app_state     CASCADE;

-- ──────────────────────────────────────────────────────────────────
-- TABLE : kizeo_sites
-- Remplace la base Notion Kizeo Sites DB.
-- Gain de vitesse : ~800ms (Notion) → ~50ms (Supabase)
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kizeo_sites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notion_id       text UNIQUE,          -- ID page Notion pour la sync
  nom_site        text,
  societe         text NOT NULL,
  adresse         text DEFAULT '',
  adresse_siege   text DEFAULT '',
  code_postal     text DEFAULT '',
  ville           text DEFAULT '',
  technicien      text DEFAULT '',
  commercial      text DEFAULT '',
  dae_modele      text DEFAULT '',      -- HS500P, HS360P, HS350P, CR2, Rotaid
  n_serie         text DEFAULT '',
  type_intervention text DEFAULT '',
  statut          text DEFAULT 'Actif', -- 'Actif' | 'Annulée'
  maintenance_planifiee text DEFAULT '',
  pad_pak_date_adulte   date,
  pad_pak_date_ped      date,
  bat_date              date,
  electrode_date        date,
  prochaine_expiration  date,
  pma                   text DEFAULT '', -- Prochaine Maintenance Annuelle
  derniere_intervention text DEFAULT '',
  urgence_pad_pak       text DEFAULT '', -- 'expired' | 'critical' | 'urgent' | 'ok' | ''
  urgence_electrodes    text DEFAULT '',
  urgence_annuelle      text DEFAULT '',
  lat             numeric,
  lng             numeric,
  contact         text DEFAULT '',
  phone           text DEFAULT '',
  email           text DEFAULT '',
  notes           text DEFAULT '',
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- Index pour matchKizeoSite() → recherche par société + adresse
CREATE INDEX IF NOT EXISTS idx_kizeo_societe   ON public.kizeo_sites (lower(societe));
CREATE INDEX IF NOT EXISTS idx_kizeo_statut    ON public.kizeo_sites (statut);
CREATE INDEX IF NOT EXISTS idx_kizeo_notion_id ON public.kizeo_sites (notion_id);

-- ──────────────────────────────────────────────────────────────────
-- TABLE : app_state
-- Remplace localStorage et Netlify Blobs pour l'état cross-device.
-- Stocke : route_orders, zone_assignments, notif_config, dep_etas…
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz DEFAULT now()
);

-- ──────────────────────────────────────────────────────────────────
-- TABLE : interventions
-- Schéma complet — PRÊTE POUR MIGRATION FUTURE.
-- Non utilisée activement : Notion reste la source de vérité.
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.interventions (
  id              integer PRIMARY KEY,
  client          text NOT NULL,
  addr            text NOT NULL DEFAULT '',
  siege           text DEFAULT '',
  date            date NOT NULL,
  type            text NOT NULL DEFAULT 'maintenance_simple'
                  CHECK (type IN ('maintenance_simple','maintenance_complex','installation','tele_maintenance')),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','confirmed','completed','not_responded')),
  tech_id         integer NOT NULL DEFAULT 0,
  form            boolean DEFAULT false,
  arm             text DEFAULT '0',
  dea             text DEFAULT '',
  bat             integer DEFAULT 0,
  pad_pak         boolean DEFAULT false,
  pad_pak_date    date,
  bat_change      boolean DEFAULT false,
  bat_date        date,
  notes           text DEFAULT '',
  time_start      text DEFAULT '',
  time_end        text DEFAULT '',
  unplanned       boolean DEFAULT false,
  contact         text DEFAULT '',
  cphone          text DEFAULT '',
  cemail          text DEFAULT '',
  contact_siege   text DEFAULT '',
  email_siege     text DEFAULT '',
  phone_siege     text DEFAULT '',
  -- Matériel Kizeo (enrichi par enrichIvsWithKizeo)
  n_serie         text DEFAULT '',
  pad_pak_date_ped date,
  electrode_date  date,
  urgence_pad_pak       text DEFAULT '',
  urgence_electrodes    text DEFAULT '',
  urgence_annuelle      text DEFAULT '',
  pma             text DEFAULT '',
  kizeo_site_id   uuid REFERENCES public.kizeo_sites(id) ON DELETE SET NULL,
  -- Notion / Kizeo IDs
  notion_id       text UNIQUE,
  kizeo_id        text,
  -- Extras Notion
  commercial      text DEFAULT '',
  motif           text DEFAULT '',
  urgent          boolean DEFAULT false,
  exter           boolean DEFAULT false,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_iv_date    ON public.interventions (date);
CREATE INDEX IF NOT EXISTS idx_iv_status  ON public.interventions (status);
CREATE INDEX IF NOT EXISTS idx_iv_tech    ON public.interventions (tech_id);
CREATE INDEX IF NOT EXISTS idx_iv_client  ON public.interventions (lower(client));

-- ──────────────────────────────────────────────────────────────────
-- TABLE : techniciens
-- Remplace le tableau TECHS hardcodé dans defiligne.html
-- (migration future — pas utilisée activement)
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.techniciens (
  id          integer PRIMARY KEY,
  name        text NOT NULL,
  init        text NOT NULL DEFAULT '?',
  color       text DEFAULT '#1565C0',
  vehicle     text DEFAULT '',
  conso       numeric(4,1) DEFAULT 6.5,
  depot_addr  text DEFAULT '',
  available   boolean DEFAULT true,
  created_at  timestamptz DEFAULT now()
);

-- ──────────────────────────────────────────────────────────────────
-- TRIGGER : updated_at auto-refresh
-- ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE OR REPLACE TRIGGER trg_kizeo_updated_at
  BEFORE UPDATE ON public.kizeo_sites
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE TRIGGER trg_iv_updated_at
  BEFORE UPDATE ON public.interventions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE TRIGGER trg_state_updated_at
  BEFORE UPDATE ON public.app_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────
-- RLS (Row Level Security)
-- App single-tenant : anon peut lire kizeo_sites et app_state.
-- Les écritures passent par la fonction Netlify (service_role).
-- ──────────────────────────────────────────────────────────────────
ALTER TABLE public.kizeo_sites   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_state     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interventions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.techniciens   ENABLE ROW LEVEL SECURITY;

-- kizeo_sites : lecture publique, écriture via service_role uniquement
CREATE POLICY "anon_read_kizeo" ON public.kizeo_sites
  FOR SELECT TO anon USING (true);

-- app_state : lecture + écriture pour anon (l'app gère ses propres clés)
CREATE POLICY "anon_read_state"  ON public.app_state FOR SELECT TO anon USING (true);
CREATE POLICY "anon_write_state" ON public.app_state FOR ALL    TO anon USING (true) WITH CHECK (true);

-- interventions : lecture publique (future migration)
CREATE POLICY "anon_read_iv" ON public.interventions
  FOR SELECT TO anon USING (true);

-- techniciens : lecture publique
CREATE POLICY "anon_read_techs" ON public.techniciens
  FOR SELECT TO anon USING (true);
