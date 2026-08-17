-- ═══════════════════════════════════════════════════════════════════
-- TABLE CLIENTS — OptiTechX / Defiligne
-- Base clients à facturer — à exécuter dans Supabase SQL Editor
-- Généré le 2026-08-17  |  256 clients
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Création de la table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.clients (
  id                     BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  nom                    TEXT    NOT NULL UNIQUE,      -- Nom client (clé de jointure avec interventions)
  adresse_site           TEXT,                         -- Adresse du site principal
  adresse_siege          TEXT,                         -- Adresse du siège social
  commercial             TEXT,                         -- Commercial Defiligne référent
  email_facturation      TEXT,                         -- Email pour l'envoi des factures
  telephone              TEXT,
  siret                  TEXT,                         -- Numéro SIRET (14 chiffres)
  tva_intracom           TEXT,                         -- N° TVA intracommunautaire
  tarif_contrat          DECIMAL(8,2),                 -- Tarif annuel contrat (€)
  type_contrat           TEXT DEFAULT 'ponctuel',      -- 'annuel', 'ponctuel', 'contrat_cadre'
  notes_facturation      TEXT,                         -- Instructions spéciales facturation
  actif                  BOOLEAN DEFAULT TRUE,
  notion_id              TEXT,                         -- ID page Notion client si créée
  created_at             TIMESTAMP DEFAULT NOW(),
  updated_at             TIMESTAMP DEFAULT NOW()
);

-- ── 2. Index ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_clients_nom        ON public.clients (nom);
CREATE INDEX IF NOT EXISTS idx_clients_commercial ON public.clients (commercial);
CREATE INDEX IF NOT EXISTS idx_clients_actif      ON public.clients (actif);

-- ── 3. Trigger updated_at ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_clients_updated_at ON public.clients;
CREATE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── 4. RLS (Row Level Security) ─────────────────────────────────────
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

-- Lecture : tout utilisateur authentifié peut lire
CREATE POLICY "clients_select" ON public.clients
  FOR SELECT USING (auth.role() = 'authenticated');

-- Écriture : uniquement les admins (service_role ou email Defiligne)
CREATE POLICY "clients_insert" ON public.clients
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "clients_update" ON public.clients
  FOR UPDATE USING (auth.role() = 'service_role');

-- ── 5. Realtime ─────────────────────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE public.clients;

-- ── 6. INSERT — 256 clients Defiligne ───────────────────────────────
INSERT INTO public.clients (nom, adresse_site, adresse_siege, commercial)
VALUES
  ('(BELLIN TP)', 'Rue du Petit Nieul 86360 Montamise', NULL, 'Cindy HERBET'),
  ('(CHANEL SAM)', 'One pl monte Carlo 98000 Monaco', NULL, 'Johann Monlouis'),
  ('(COMMINGES METAUX SERVICES)', NULL, NULL, 'Johann Monlouis'),
  ('(DAIS / ADSEA 77)', '509 rue Gauton Biron 77190 DAMMARIE LES LYS', 'Chemin du Coudray Menereaux 77950 Maincy', 'Cindy HERBET'),
  ('(JARDIREVE DEOLS - VILLAVERDE DEOLS)', NULL, NULL, 'Johann Monlouis'),
  ('(JARLISE - HOTEL PAVILLON BLEU)', NULL, NULL, 'Cindy HERBET'),
  ('(LE CAMPUS)', NULL, NULL, 'Cindy HERBET'),
  ('(RICHARD FRERES)', NULL, NULL, 'Johann Monlouis'),
  ('(ROY SA)', NULL, NULL, 'Johann Monlouis'),
  ('(World Medical association)', NULL, NULL, 'Johann Monlouis'),
  ('15 NANCY- HOTEL LE GRAND QUARTIER', NULL, NULL, 'Cindy HERBET'),
  ('34 SNA-N - DIRECTION GÉNÉRALE DE L’AVIATION CIVILE', 'Tour de contrôle , allée Royale Air force 62520 LE TOUQUET', NULL, 'Johann Monlouis'),
  ('911 (MEDISAFE)', NULL, NULL, 'Cindy HERBET'),
  ('ABSCIS BERTIN CONSTRUCTION', '21 Avenue de la grande plaine 14760 BretteVille sur Odon', '21 Avenue de la Grande Plaine 14760 BRETTEVILLE SUR ODON', 'Cindy HERBET'),
  ('ADAMAS - IXINA MENNEVAL', NULL, NULL, 'Cindy HERBET'),
  ('ADAPEI 64 - RESIDENCE LE CLOS FLEURI', NULL, NULL, 'Johann Monlouis'),
  ('ADSEA 77', '372 avenue générale leclerc 77000 Melun', NULL, 'Cindy HERBET'),
  ('ADVANCE - IXINA GUICHAINVILLE', NULL, NULL, 'Cindy HERBET'),
  ('AGATHEA - VILLAVERDE MONTPELLIER - LE CRÈS', NULL, NULL, 'Johann Monlouis'),
  ('AGOSPAP', NULL, NULL, 'Cindy HERBET'),
  ('AGRI MELESSE - BRICOPRO MELESSE', NULL, NULL, 'Johann Monlouis'),
  ('AGRI NORD 44', NULL, NULL, 'Johann Monlouis'),
  ('AGRI PIECES 88', NULL, NULL, 'Johann Monlouis'),
  ('AGY LIN SOCIETE COOPERATIVE AGRICOLE', '555 Rue de la Veslière 76110 Goderville', NULL, 'Cindy HERBET'),
  ('AIRBUS FLIGHT ACADEMY EUROPE', 'Chemin de saint jean BA 701 13661 Salon Air', NULL, 'Johann Monlouis'),
  ('AJIMATERIEL', NULL, NULL, 'Johann Monlouis'),
  ('AKINAS - CUISINES RÉFÉRENCES PONT AUDEMER', NULL, NULL, 'Cindy HERBET'),
  ('Alfa diffusion', '167-169 Quai de la bataille de Stalingrad 92130 Issy-les-Moulineaux', NULL, 'Cindy HERBET'),
  ('AMF ACHAT METAUX FERRAILLES', NULL, NULL, 'Cindy HERBET'),
  ('ANIMALIS', '98 avenue du grand sud 37170 Chambray les tours', NULL, 'Cindy HERBET'),
  ('APC 58 - NIEVRE PROTECTION CIVILE', NULL, NULL, 'Priscilla BEUZELIN'),
  ('ARAMIS - CUISINE PLUS BUCHELAY', NULL, NULL, 'Cindy HERBET'),
  ('ARBOISIE OPCO - HOTEL ARBOISIE MEGEVE', NULL, NULL, 'Johann Monlouis'),
  ('ARENAS - IXINA BOULOGNE BILLANCOURT', NULL, NULL, 'Cindy HERBET'),
  ('ARTEMIS - IXINA BUCHELAY', NULL, NULL, 'Cindy HERBET'),
  ('ATELIER INTERIOR SA', NULL, NULL, 'Cindy HERBET'),
  ('BATIFER', '19 rue de kingersheim 68120 Richwiller', NULL, 'Johann Monlouis'),
  ('BATIGERE EN ILE DE FRANCE', '17 Rue Victor Hugo 91290 Arpajon', NULL, 'Cindy HERBET'),
  ('BERSHKA FRANCE', '11 rue de bordeaux 37000 Tours', NULL, 'Cindy HERBET'),
  ('BIG MAT NOEL MATERIAUX', 'Espace Driant rue saint Michel 55100 Verdun', NULL, 'Johann Monlouis'),
  ('BOITEL ET FILS', NULL, NULL, 'Cindy HERBET'),
  ('Bowling de Chartres', NULL, NULL, 'Johann Monlouis'),
  ('BOYER', '35 rue de la république 94370 Sucy en Brie', NULL, 'Cindy HERBET'),
  ('BRANT''HOME LOISIRS - O''BRICO', NULL, NULL, 'Johann Monlouis'),
  ('BRICO THENON - BRICO PRO', NULL, NULL, 'Johann Monlouis'),
  ('BRICO TRAVO', NULL, NULL, 'Johann Monlouis'),
  ('CAISSE REGIONALE ASSURANCE MALADIE (CRAMIF)', '17-19 place de l’argonne 75019 Paris', NULL, 'Cindy HERBET'),
  ('Camping Les Pins bleu', NULL, NULL, 'Johann Monlouis'),
  ('CARGLASS SERVICES', '7 Avenue de la Patelle 95310 Saint-Ouen-l''Aumône', NULL, 'Cindy HERBET'),
  ('CERA', NULL, NULL, 'Cindy HERBET'),
  ('CFPTS', NULL, NULL, 'Cindy HERBET'),
  ('CHANEL', '40 rue delizy 93694 Pantin', NULL, 'Cindy HERBET'),
  ('CHANEL COORDINATION', 'Rue Haie Marteau 95470 Vemars', NULL, 'Cindy HERBET'),
  ('CHANEL PARFUMS BEAUTE', '4 rue du bois barbier 60880 Le Meux', NULL, 'Cindy HERBET'),
  ('CITY FUN - LECLERC-HORTALA', NULL, NULL, 'Johann Monlouis'),
  ('CLAAS RESEAU AGRICOLE', 'Camp de la vabre 30730 Gajan', NULL, 'Johann Monlouis'),
  ('CLUB ALPIN FRANCAIS DE BORDEAUX', '50 avenue Georges clemenceau 33400 TALENCE', NULL, 'Priscilla BEUZELIN'),
  ('COMITE ETUDES SOINS AUX POLYHANDICAPES - EEAP LES HEURES C', NULL, NULL, 'Priscilla BEUZELIN'),
  ('COMMUNAUTE COMMUNE VEXIN VAL DE SEINE (CCVVS)', '2 chemin  de l’Aubette 95450 Bray et lu', NULL, 'Cindy HERBET'),
  ('COMMUNAUTE DE COMMUNES DE BRUYERES - VALLONS DES VOSGES', '4 rue de la 36 eme division u.s 88600 bruyères', NULL, 'Cindy HERBET'),
  ('COMMUNAUTE DE COMMUNES DU PAYS HOUDANAIS (CCPH)', 'Chemin de ronde 78550 Houdan', NULL, 'Cindy HERBET'),
  ('COMMUNE D AUJARGUES', NULL, NULL, 'Johann Monlouis'),
  ('COMMUNE DE BONDY', '5 allée becquerel 93140 Bondy', NULL, 'Cindy HERBET'),
  ('COMMUNE DE BRUYERES', '3 rue léopold 88600 Bruyères', NULL, 'Cindy HERBET'),
  ('COMMUNE DE BUCHELAY', '18 rue pasteur 78200 Buchelay', NULL, 'Cindy HERBET'),
  ('COMMUNE DE CHAVANGES', NULL, NULL, 'Johann Monlouis'),
  ('COMMUNE DE COMPIEGNE', NULL, NULL, 'Priscilla BEUZELIN'),
  ('COMMUNE DE FOLLAINVILLE-DENNEMON', '5 rue des coteaux du vexin 78520 Follainville dennemont', NULL, 'Cindy HERBET'),
  ('COMMUNE DE GOMMECOURT', '18 Rue Robert Mennessier 78270 Gommecourt', NULL, 'Cindy HERBET'),
  ('COMMUNE DE LIMETZ VILLEZ', '4 rue de la mairie 78270 Limetz-Villez', NULL, 'Cindy HERBET'),
  ('COMMUNE DE LUNEL', '240 rue Mario roustan 34400 Lunel', NULL, 'Johann Monlouis'),
  ('COMMUNE DE MAGNANVILLE', '3 Rue François Franque 78200 Magnanville', NULL, 'Cindy HERBET'),
  ('COMMUNE DE MANTES LA JOLIE', '31 rue Gambetta 78200 MANTES LA JOLIE', NULL, 'Cindy HERBET'),
  ('COMMUNE DE NAVEIL', NULL, NULL, 'Johann Monlouis'),
  ('COMMUNE DE PONT SUR VANNE', '1 Bis Grande Rue 89190 Pont-sur-Vanne', NULL, 'Cindy HERBET'),
  ('COMMUNE DE PONTOISE', 'Place de la Fraternité 95300 Pontoise', '30 Bis Les Hauts de Marcouville 95300 Pontoise', 'Cindy HERBET'),
  ('COMMUNE DE SAINT MARTIN D''URIAGE', NULL, NULL, 'Priscilla BEUZELIN'),
  ('COMMUNE DE SAINT MICHEL DE VAX', NULL, NULL, 'Johann Monlouis'),
  ('COMMUNE DE SAINTE FAUSTE', NULL, NULL, 'Cindy HERBET'),
  ('Commune de Sorbiers', NULL, NULL, 'Johann Monlouis'),
  ('COMMUNE DE TRAPPES', '1 rue de l’abreuvoir 78190 Trappes', NULL, 'Cindy HERBET'),
  ('COMMUNE DE VAUX LE PENIL', '4 place beuve et gantier 77000 Vaux-le-Pénil', NULL, 'Cindy HERBET'),
  ('COMMUNE D''ECQUEVILLY', '1Ter Place Henri Deutsch de Meurthe 78920 Ecquevilly', NULL, 'Cindy HERBET'),
  ('COMMUNE NEUVY PAILLOUX', NULL, NULL, 'Cindy HERBET'),
  ('COMPTOIR DE PROMOTION DU VERRE (COPROVER)', NULL, NULL, 'Johann Monlouis'),
  ('COTE JARDIN', NULL, NULL, 'Cindy HERBET'),
  ('CREATIONS FUSALP', '9 Rue Alphonse de Neuville 75017 Paris', NULL, 'Cindy HERBET'),
  ('CREATIS', '14 bd haussmann 75009 Paris', NULL, 'Cindy HERBET'),
  ('CUISINE PLUS FRANCE', NULL, NULL, 'Cindy HERBET'),
  ('DECALA Studio Giverny', NULL, NULL, 'Johann Monlouis'),
  ('DECLIC', NULL, NULL, 'Cindy HERBET'),
  ('DESJARDINS CLEON', '1522 route de tourville 76410 Cleon', NULL, 'Johann Monlouis'),
  ('DESJARDINS MONTIVILLIERS', '1 route des 4 saisons 76290 Montivilliers', NULL, 'Johann Monlouis'),
  ('DESJARDINS TROUVILLE - ALLIQUERVILLE', NULL, NULL, 'Johann Monlouis'),
  ('DUHAMEL LOGISTIQUE', 'Parc d''affaires des Portes Voie du Futur 27100 Val-de-Reuil', NULL, 'Cindy HERBET'),
  ('EHPAD LE HAMEAU DE LA PELOU', NULL, NULL, 'Johann Monlouis'),
  ('ELDEC FRANCE', NULL, NULL, 'Johann Monlouis'),
  ('EMBALTEC', 'Voie du futur 27100 Val de Reuil', NULL, 'Cindy HERBET'),
  ('ENTREPRISE AURILLACOISE TRAVAUX PUBLICS (EATP)', NULL, NULL, 'Johann Monlouis'),
  ('ENTREPRISE CARCELLER', 'D86 81120 Realmont', NULL, 'Johann Monlouis'),
  ('ENTREPRISE REY-BETBEDER', NULL, NULL, 'Johann Monlouis'),
  ('EROME', NULL, NULL, 'Cindy HERBET'),
  ('ESC PACK (CARTON SERVICE)', 'Rue de l orme au loup 45130 Baule', NULL, 'Cindy HERBET'),
  ('ESPE SARL CHABANIS', NULL, NULL, 'Johann Monlouis'),
  ('ESSEO', '3 rue camille jenatzy 78260 Achères', NULL, 'Cindy HERBET'),
  ('ETABLISSEMENT MONTALIER', '18 Rue Sainte-Marie 33100 Bordeaux', NULL, 'Johann Monlouis'),
  ('ÉTABLISSEMENTS DELAGREE - BRICOPRO ETRELLES', NULL, NULL, 'Johann Monlouis'),
  ('ETPO - Entreprise de Travaux Publics de l''Ouest', '467 route de la claie 49940 Noyant - Villages', NULL, 'Priscilla BEUZELIN'),
  ('ETS BODIN-JOYEUX', NULL, NULL, 'Cindy HERBET'),
  ('FARASSE FLUIDES', 'Rue du Champ de Tir Parc d''activités de Cantimpré 59400 Cambrai', NULL, 'Cindy HERBET'),
  ('FBD INTERNATIONAL', '71 rue de Provence 75009 Paris', NULL, 'Cindy HERBET'),
  ('FLEFRO - MAGASIN 4 MURS', '16 rue Antoine de st exupery 54710 FLEVILLE DEVANT NANCY', NULL, 'Johann Monlouis'),
  ('FLEURS ET JARDINS POTIEZ - JARDINERIE POTIEZ', NULL, NULL, 'Johann Monlouis'),
  ('FONDATION MALLET', NULL, NULL, 'Cindy HERBET'),
  ('FORACO MANAGEMENT', NULL, NULL, 'Johann Monlouis'),
  ('FOYER RURAL VETHEUIL', 'Place Jean Moulin 95510 Vetheuil', NULL, 'Cindy HERBET'),
  ('FROFLE - MAGASIN IMAGINEA', '9 rue Antoine de st exupery 54710 FLEVILLE DEVANT NANCY', NULL, 'Johann Monlouis'),
  ('GENEVOIS FLEURS - VILLAVERDE MONTCEAU GOURDON', NULL, NULL, 'Johann Monlouis'),
  ('GRAND DISTRIBUTION (CARREFOUR CONTACT)', NULL, NULL, 'Johann Monlouis'),
  ('GRAND HÔTEL', NULL, NULL, 'Cindy HERBET'),
  ('GROUPAMA PARIS VAL DE LOIRE', '21 Rue des Boucheries 80600 Doullens', NULL, 'Cindy HERBET'),
  ('GSM', 'Rue de l''Industrie 57970 Yutz', NULL, 'Johann Monlouis'),
  ('HANDISERVICES', '3-5 R Marcellin Berthelot Zone Artisanale De Parc Lann 56000 Vannes', NULL, 'Cindy HERBET'),
  ('HANSGROHE', NULL, NULL, 'Cindy HERBET'),
  ('HPB SPIE BATIGNOLLES', NULL, NULL, 'Johann Monlouis'),
  ('IDRIS Centre National De La Recherche Scientifique CNRS', NULL, NULL, 'Cindy HERBET'),
  ('IMMOBILIERE DES TECHNODES', NULL, NULL, 'Johann Monlouis'),
  ('J2A - JARDINERIE DELBARD AUBEVOYE', NULL, NULL, 'Johann Monlouis'),
  ('JARDI FREJUS - VILLAVERDE ROCCHIETTA FREJUS', NULL, NULL, 'Johann Monlouis'),
  ('JARDI HYERES - VILLAVERDE ROCCHIETTA HYERES', NULL, NULL, 'Johann Monlouis'),
  ('JARDI SAINT DOULCHARD - VILLAVERDE BOURGES - ST DOULCHARD', NULL, NULL, 'Johann Monlouis'),
  ('JARDIFLEUR - VILLAVERDE BRETENIERE', NULL, NULL, 'Johann Monlouis'),
  ('JARDILAND BREST GUIPAVAS', NULL, NULL, 'Johann Monlouis'),
  ('JARDIMARNE - VILLAVERDE PIERRY', NULL, NULL, 'Johann Monlouis'),
  ('JARDIN LOISIRS 28  ( GAMMVERT)', '4 rue de l’ Ormeteau 28300 Lèves', NULL, 'Johann Monlouis'),
  ('JARDINERIE BONNEAU - VILLAVERDE NIORT', NULL, NULL, 'Johann Monlouis'),
  ('JARDINERIE DE BROU - VILLAVERDE BOURG EN BRESSE', NULL, NULL, 'Johann Monlouis'),
  ('JARDINERIE DES BREDANES - VILLAVERDE BAULE', NULL, NULL, 'Johann Monlouis'),
  ('JARDINERIE DU BRIVADOIS - VILLAVERDE BRIOUDE', NULL, NULL, 'Johann Monlouis'),
  ('JARDINERIE DU MOULIN - VILLAVERDE PIA', NULL, NULL, 'Johann Monlouis'),
  ('JARDINERIE DUPOIRIER - LIBOURNE', NULL, NULL, 'Johann Monlouis'),
  ('JARDINERIE GRANDEUR NATURE - VILLAVERDE TAVAUX', NULL, NULL, 'Johann Monlouis'),
  ('JARDINERIE GUNTHER', NULL, NULL, 'Johann Monlouis'),
  ('JARDINERIE LE GRAND VERT - VILLAVERDE ROCCHIETTA LE BEAUSSET', NULL, NULL, 'Johann Monlouis'),
  ('JARDINERIE LES ORCHIS - VILLAVERDE AMBRONAY', NULL, NULL, 'Johann Monlouis'),
  ('JARDINERIE SAUVEGRAIN - VILLAVERDE MONTARGIS - AMILLY', NULL, NULL, 'Johann Monlouis'),
  ('JARDINERIE TARNAISE ALBI', NULL, NULL, 'Johann Monlouis'),
  ('JARDINERIE TARNAISE FONLABOUR', NULL, NULL, 'Johann Monlouis'),
  ('JARDINERIE TARNAISE SUD CASTRES', NULL, NULL, 'Johann Monlouis'),
  ('JARDINERIES ET PAYSAGES - VILLAVERDE ANTIBES', NULL, NULL, 'Johann Monlouis'),
  ('JUNGLE PRESTATIONS', NULL, NULL, 'Johann Monlouis'),
  ('KOM - O BRICO LA MONTAGNE', NULL, NULL, 'Johann Monlouis'),
  ('LA FABRIQUE', '77 Allée des Carrières 93150 Le Blanc-Mesnil', NULL, 'Cindy HERBET'),
  ('LAIGNEL', '3 ROUTE NATIONALE 62138 AUCHY-LES-MINES', NULL, 'Cindy HERBET'),
  ('LARREY&CO', NULL, NULL, 'Johann Monlouis'),
  ('LE FIVE - TRIBAL FOOT', 'route de torcy 77360 Vaires-sur-Marne', '361 avenue du président Wilson 93210 Saint Denis', 'Cindy HERBET'),
  ('LE FIVE NANCY', NULL, NULL, 'Johann Monlouis'),
  ('LE FIVE OL', NULL, NULL, 'Johann Monlouis'),
  ('LE LUCERNAIRE FORUM', NULL, NULL, 'Johann Monlouis'),
  ('LES COURANTS ET CIE', NULL, NULL, 'Cindy HERBET'),
  ('LES JARDINERIES DU SALEVE ASL - FLEURS ET PLANTES DU LAC ANT', NULL, NULL, 'Johann Monlouis'),
  ('LES JARDINS DE PETRUS - VILLAVERDE BRIVE-LA-GAILLARDE', NULL, NULL, 'Johann Monlouis'),
  ('LES JARDINS DU FAUCIGNY - VILLAVERDE ST PIERRE EN FAUCIGNY', NULL, NULL, 'Johann Monlouis'),
  ('LES JARDINS DU VIDOURLE - VILLAVERDE LUNEL', NULL, NULL, 'Johann Monlouis'),
  ('LES NOUVEAUX CONSTRUCTEURS (LNC)', NULL, NULL, 'Cindy HERBET'),
  ('LES PEP DU CENTRE DE LA BOURGOGNE FRANCHE COMTE (CBFC)', NULL, NULL, 'Cindy HERBET'),
  ('LG - JARDINERIE ROCCHIETTA - VILLAVERDE  LA GARDE', NULL, NULL, 'Johann Monlouis'),
  ('LPO LYCEE DES METIERS HENRI POINCARE', NULL, NULL, 'Cindy HERBET'),
  ('Mairie de Bonnières sur Seine', 'hall du marché, église 45 rue Georges Herrewyn 78270 Bonnières-sur-Seine', NULL, 'Cindy HERBET'),
  ('MAIRIE DE CRAVENT', '36 Rue Magloire Douville 78270 Cravent', NULL, 'Cindy HERBET'),
  ('Mairie de Giroux', 'Étang des frênes 36150 Giroux', NULL, 'Cindy HERBET'),
  ('Mairie de GUILLY', NULL, NULL, 'Cindy HERBET'),
  ('Mairie de LIZERAY', NULL, NULL, 'Cindy HERBET'),
  ('Mairie de MENETREOLS SOUS VATAN', NULL, NULL, 'Cindy HERBET'),
  ('Mairie de Mézières-sur-Seine', 'Place du Commandant Grimblot, Rue Maurice Fricotte 78970 Mézières-sur-Seine', 'Place du commandant grimblot 78970 Mézières sur Seine', 'Cindy HERBET'),
  ('Mairie de Reboursin Le Bourg', NULL, NULL, 'Cindy HERBET'),
  ('Mairie de Saint Aubin', NULL, NULL, 'Cindy HERBET'),
  ('MAIRIE DE VERNEUIL SUR SEINE', '1 Place de la Galette 78480 Verneuil-sur-Seine', NULL, 'Johann Monlouis'),
  ('Mairie Saint Pierre de Jards', NULL, NULL, 'Cindy HERBET'),
  ('MAISON FRANCOIS CHOLAT (G.A.I.C.)', 'Roche plage 1310 route de thuile 38510 Morestel', NULL, 'Johann Monlouis'),
  ('MANUFACTURE DE SENLIS', NULL, NULL, 'Johann Monlouis'),
  ('MASSIMO DUTTI FRANCE', 'Rue royale, place de la Madeleine 75008 PARIS', NULL, 'Cindy HERBET'),
  ('MB MANAGEMENT - LA GALLERIE ART DE NUIT', NULL, NULL, 'Johann Monlouis'),
  ('MECANIQUE TOLERIE SERRURERIE (MTS)', NULL, NULL, 'Cindy HERBET'),
  ('MEDECINS DU MONDE', '33 rue fouret 44000 Nantes', NULL, 'Cindy HERBET'),
  ('MEONI MATERIAUX - BIGMAT ET LA BRIQUETERIE', 'Ancien meoni morta 20243 Prunelli di fiumorbo', NULL, 'Johann Monlouis'),
  ('MIRAHBEL - LA TERRE QUI CHANTE', NULL, NULL, 'Johann Monlouis'),
  ('MONT D''ARBOIS LUXURY RESORT (MALR)', '33/63 Route des crêtes 74170 Saint Gervais les bains', NULL, 'Johann Monlouis'),
  ('MONTBARD JARDIN - VILLAVERDE FAIN LES MONTBARD', NULL, NULL, 'Johann Monlouis'),
  ('MOURIER PARTICIPATION 3MMM', 'Impasse d’Angouleme 16230 Maine de boixe', NULL, 'Johann Monlouis'),
  ('NewCold Argentan SAS', NULL, NULL, 'Cindy HERBET'),
  ('N''PACK - intégré au client DUHAMEL', NULL, NULL, 'Cindy HERBET'),
  ('OFFICE PUBLIC HABITAT DU CHER - VAL DE BERRY', NULL, NULL, 'Johann Monlouis'),
  ('OGEC F. CABRINI', NULL, NULL, 'Cindy HERBET'),
  ('ORCA DISTRIBUTION', 'Parc d’activité des ajeux  Rue Pierre Gilles de Genne 72400 La Ferté-Bernard', NULL, 'Cindy HERBET'),
  ('ORVIA - COUVOIR DE LA MESANGERE LA POITEVINIERE', NULL, NULL, 'Johann Monlouis'),
  ('OUTAREX', '156 rue du Grand But 59160 LILLE', NULL, 'Cindy HERBET'),
  ('PAPREC GRAND ILE DE FRANCE AGENCE TRIVALORISATION', '16-24 route de la seine 92230 Gennevilliers', NULL, 'Cindy HERBET'),
  ('PARC HÔTEL', NULL, NULL, 'Cindy HERBET'),
  ('PEPINIERE MERCIER- VILLAVERDE DIJON - ASNIÈRES-LES-DIJON', NULL, NULL, 'Johann Monlouis'),
  ('PHARMACIE DE LA PAIX', NULL, NULL, 'Cindy HERBET'),
  ('PILKINGTON AUTOMOTIVE FRANCE', '12 Boulevard des Martyrs de Châteaubriant 95100 Argenteuil', NULL, 'Cindy HERBET'),
  ('PORT GRIMAUD GARDEN CENTER - VILLAVERDE ROCCHIETTA GRIMAUD', NULL, NULL, 'Johann Monlouis'),
  ('PULL & BEAR FRANCE', '90 rue d Antibes 06400 Cannes', NULL, 'Johann Monlouis'),
  ('PYLONES', NULL, NULL, 'Priscilla BEUZELIN'),
  ('RE TRAVAUX PUBLICS (RE TP)', '18 rue 11 novembre 17740 Sainte-Marie-de-Ré', NULL, 'Cindy HERBET'),
  ('RM-JARDINERIE ROCHIETTA–VILLAVERDE AIX EN PROVENCE MEYREUIL', NULL, NULL, 'Johann Monlouis'),
  ('SA ENTREPRISE GREGORY (EMG)', 'Gours 46270 Cuzac', NULL, 'Johann Monlouis'),
  ('SABLIERES ET CARRIERES DE LA MADELEINE', '46270 Cuzac', NULL, 'Johann Monlouis'),
  ('SAINT VIT MATERIAUX - BIGMAT', NULL, NULL, 'Johann Monlouis'),
  ('SARL ATHLETIC FORME', NULL, NULL, 'Priscilla BEUZELIN'),
  ('SAS SOCIETE EXPLOITATION LLM - MERCURE', NULL, NULL, 'Cindy HERBET'),
  ('SAS VOLTA', '2 Rue Vincent Van Gogh 76290 Montivilliers', NULL, 'Cindy HERBET'),
  ('SAUVEGARDE FORMATION', '11 Rue du Moulin À Poudre 76150 Maromme', NULL, 'Cindy HERBET'),
  ('SCI BOUCHAYER C/O ARTENA', '10 rue de l Arménie 38000 Grenoble', NULL, 'Johann Monlouis'),
  ('SCM DENTAIRE D''OSNY SEL SYMCHOWICZ', NULL, NULL, 'Cindy HERBET'),
  ('SEQENS SOCIETE ANONYME D''HABITATIONS A LOYER MODERE', '2-12 Parvis Colonel Arnaud Beltrame 78000 Versailles', NULL, 'Cindy HERBET'),
  ('SIARP', '58 Rue Gioacchino Rossini 95310 Saint-Ouen-l''Aumône', NULL, 'Cindy HERBET'),
  ('SICOREN', '2 avenue de la gare 78980 Breval', NULL, 'Cindy HERBET'),
  ('SOC EXPLOIT DES ETS CHARRIER - MASTERPRO CHARRIER LA CHATRE', '7 rue mirebeaux 36400 La chatre', NULL, 'Johann Monlouis'),
  ('SOC INSTALL TELEPHON SIGNALISATION (SITS)', NULL, NULL, 'Cindy HERBET'),
  ('SOCIETE DES ETABLISSEMENTS MAISONNIER', '32 avenue de bel air 86150 L’ISLE JOURDAIN', NULL, 'Johann Monlouis'),
  ('SOCIETE D''EXPLOITATION ET DE DETENTION HOTELIERE VISTA', '52 Avenue Sir Winston Churchill 06190 Roquebrune-Cap-Martin', NULL, 'Johann Monlouis'),
  ('SOCIETE EXPLOITATION TERRE ET MONTAGNE ( group moma)', '3461 route de la côte 2000 74120 Megeve', NULL, 'Johann Monlouis'),
  ('SOCIETE HOTELIERE AVENUE BOLLEE - KYRIAD LE MANS EST', NULL, NULL, 'Cindy HERBET'),
  ('SOCIETE NOUVELLE DEGUIL', NULL, NULL, 'Cindy HERBET'),
  ('SOGECER EQUIPEMENT ROUTIER', '22 Chemin d''Auguste 33610 Cestas', NULL, 'Johann Monlouis'),
  ('SOLUTION SECURITE INCENDIE', NULL, NULL, 'Priscilla BEUZELIN'),
  ('SPIE BATIGNOLLES', '34 Rue Benoît Frachon 94500 Champigny-sur-Marne', NULL, 'Cindy HERBET'),
  ('SPIE BATIGNOLLES BLONDET', NULL, NULL, 'Johann Monlouis'),
  ('SPIE BATIGNOLLES ENERGIE', '300 Rue de Lille Parc Tertiaire Rivéo I, Batiment A, RDC 59520 MARQUETTE LEZ LILLE', NULL, 'Cindy HERBET'),
  ('SPIE BATIGNOLLES ENERGIE - SOUCHON (SBE - SOUCHON)', '12 Rue de l''Europe 31150 Lespinasse', NULL, 'Johann Monlouis'),
  ('SPIE BATIGNOLLES ENERGIE GRAND SUD', '222 Chemin de la Pertuade 83140 Six-Fours-les-Plages', NULL, 'Johann Monlouis'),
  ('SPIE BATIGNOLLES GENIE CIVIL', '60 avenue d Aquitaine 33380 MARCHEPRIME', NULL, 'Johann Monlouis'),
  ('SPIE BATIGNOLLES GRAND OUEST', 'Rue André Marie ampère 33127 Saint-Jean-d''Illac', NULL, 'Johann Monlouis'),
  ('SPIE BATIGNOLLES ILE-DE-FRANCE (SCGPM)', '55 Chemin de le huniere 91120 Palaiseau', '113 Avenue Aristide Briand 94743 Accueil cedex', 'Cindy HERBET'),
  ('SPIE BATIGNOLLES MALET', '98 route de Cambarras 83440 Tourrettes', NULL, 'Johann Monlouis'),
  ('SPIE BATIGNOLLES NORD', '224 Avenue de la Dordogne 59140 Dunkerque', NULL, 'Cindy HERBET'),
  ('SPIE BATIGNOLLES PRESANCE IDF', 'Rue des vignes 77990 Le Mesnil Amelot', NULL, 'Cindy HERBET'),
  ('SPIE BATIGNOLLES SUD EST', 'Carrefour du caban D268 13270 Fos sur mer', NULL, 'Johann Monlouis'),
  ('SPIE BATIGNOLLES TP AURA', 'Lieu dit Fontaine 38510 Arandon', NULL, 'Johann Monlouis'),
  ('SPIE BATIGNOLLES VALERIAN', 'EOLE-Triangles de Mantes Impasse Sainte-Claire Déville 78200 Mantes-la-Jolie', NULL, 'Cindy HERBET'),
  ('STELO FORMATION', '13 rue des halles 71150 Chagny', NULL, 'Johann Monlouis'),
  ('STRADIVARIUS FRANCE', 'Promenade Sainte-Catherine 33000 Bordeaux', NULL, 'Johann Monlouis'),
  ('SYXPERIANE', '3 Mail du Front populaire 44200 Nantes', NULL, 'Cindy HERBET'),
  ('TARN ENROBES', 'Route d’aridité 81120 Terre de bancalie', NULL, 'Johann Monlouis'),
  ('TPF INVEST', NULL, NULL, 'Cindy HERBET'),
  ('TRANSPORTS RABOUIN SAS', 'Chemin des ânes 91790 Boissy sous saint yon', NULL, 'Johann Monlouis'),
  ('TRANSURBAIN EVREUX (TRANSURBAIN SPL)', '1 Rue Jean Jaurès 27000 Évreux', NULL, 'Cindy HERBET'),
  ('VASSE TRANSFERT', NULL, NULL, 'Cindy HERBET'),
  ('VILLAVERDE LA JARDINERIE D''AVALLON', NULL, NULL, 'Johann Monlouis'),
  ('WEISS - GEDIMAT - BRICO PRO WEISS', NULL, NULL, 'Johann Monlouis'),
  ('YACHT SOLUTIONS', '179 quai de brazza 33100 Bordeaux', NULL, 'Cindy HERBET'),
  ('ZARA FRANCE', 'Place de la madeleine 75008 Paris', NULL, 'Cindy HERBET'),
  ('ZARA HOME FRANCE', '1 bis place masséna 06000 Nice', NULL, 'Johann Monlouis'),
  ('ZARA MONACO SAM', 'Zara Avenue de l''Hermitage 98000 Monaco', NULL, 'Johann Monlouis')
ON CONFLICT (nom) DO NOTHING;

-- ── 7. Vue pratique pour la facturation ─────────────────────────────
CREATE OR REPLACE VIEW public.v_clients_facturation AS
SELECT
  c.id,
  c.nom,
  c.commercial,
  c.email_facturation,
  c.siret,
  c.tarif_contrat,
  c.type_contrat,
  COUNT(i.id)                                  AS nb_interventions,
  COUNT(i.id) FILTER (WHERE i.date >= date_trunc('year', NOW()))  AS interventions_annee,
  MAX(i.date)                                  AS derniere_intervention,
  c.actif,
  c.notes_facturation
FROM public.clients c
LEFT JOIN public.interventions i ON i.client = c.nom
GROUP BY c.id, c.nom, c.commercial, c.email_facturation, c.siret,
         c.tarif_contrat, c.type_contrat, c.actif, c.notes_facturation
ORDER BY c.nom;

SELECT 'Table clients créée avec ' || COUNT(*) || ' clients' AS resultat
FROM public.clients;
