-- ═══════════════════════════════════════════════════════
-- SUPABASE SCHEMA — OptiTechX
-- À exécuter dans Supabase SQL Editor
-- ═══════════════════════════════════════════════════════

-- Table: interventions
CREATE TABLE public.interventions (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  client TEXT NOT NULL,
  addr TEXT NOT NULL,
  siege TEXT,
  date DATE NOT NULL,
  type TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  tech_id INT NOT NULL,
  notes TEXT,
  contact TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  pad_pak BOOLEAN DEFAULT FALSE,
  pad_pak_date DATE,
  kizeo_id TEXT UNIQUE,
  notion_id TEXT UNIQUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  INDEX idx_date (date),
  INDEX idx_tech_id (tech_id),
  INDEX idx_status (status)
);

-- Table: techniciens
CREATE TABLE public.techniciens (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name TEXT NOT NULL,
  vehicle TEXT,
  conso DECIMAL(3,1),
  color TEXT DEFAULT '#1565C0',
  available BOOLEAN DEFAULT TRUE,
  depot_addr TEXT,
  init TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Table: tournees (suivi des tournées par jour)
CREATE TABLE public.tournees (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  tech_id INT NOT NULL,
  date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  duration_minutes INT,
  validated_count INT DEFAULT 0,
  failed_count INT DEFAULT 0,
  success_rate DECIMAL(3,1),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tech_id, date),
  INDEX idx_tech_date (tech_id, date)
);

-- Table: route_cache (cache les calculs d'itinéraires)
CREATE TABLE public.route_cache (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  tech_id INT NOT NULL,
  date DATE NOT NULL,
  waypoints JSONB NOT NULL,
  total_km DECIMAL(6,2),
  traffic_duration_min INT,
  delay_min INT,
  polyline_geojson JSONB,
  legs JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(tech_id, date)
);

-- Enable Realtime on interventions table
ALTER PUBLICATION supabase_realtime ADD TABLE public.interventions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.techniciens;
ALTER PUBLICATION supabase_realtime ADD TABLE public.tournees;

-- RLS (Row Level Security) — optionnel pour multi-tenant
-- Chaque technicien voit que ses interventions
ALTER TABLE public.interventions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own interventions"
  ON public.interventions
  FOR SELECT
  USING (true);  -- À adapter selon ton auth

CREATE POLICY "Users can update their own interventions"
  ON public.interventions
  FOR UPDATE
  USING (true);  -- À adapter selon ton auth
