-- ============================================================================
-- Fishing Intelligence 2.0 · schema PostgreSQL per Supabase
--
-- Si può eseguire più volte (SQL Editor, Run): crea ciò che manca e aggiorna lo
-- schema della v1 senza perdere righe. Ogni utente vede e modifica solo le
-- proprie righe (Row Level Security).
--
-- Regole della sincronizzazione (js/services/sync.js):
-- - updated_at è la versione decisa dal dispositivo che ha modificato: vince la
--   più recente. Il server lo imposta solo se manca o se una modifica non lo ha
--   cambiato (per esempio una correzione fatta a mano dal pannello).
-- - Le cancellazioni sono lapidi: deleted_at valorizzato e la riga resta, così la
--   cancellazione arriva anche agli altri dispositivi.
-- - synced_at è l'ora del server dell'ultima scrittura: l'app la usa per scaricare
--   solo le novità. Non si usa updated_at perché una modifica fatta offline e
--   inviata più tardi ha un updated_at vecchio.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- Funzioni dei trigger
-- ----------------------------------------------------------------------------

-- updated_at: si rispetta quello inviato dal client.
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.updated_at IS NULL THEN
    NEW.updated_at := now();
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.updated_at = OLD.updated_at THEN
      NEW.updated_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Tabelle sincronizzate: una versione più vecchia di quella salvata non
-- sovrascrive (l'aggiornamento di quella riga si salta) e synced_at prende l'ora
-- del server. Copre il caso di due dispositivi che inviano quasi insieme.
CREATE OR REPLACE FUNCTION public.handle_sync_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.updated_at IS NOT NULL AND OLD.updated_at IS NOT NULL AND NEW.updated_at < OLD.updated_at THEN
      RETURN NULL;
    END IF;
  END IF;
  NEW.synced_at := now();
  RETURN NEW;
END;
$$;

-- ============================================================================
-- 1. PROFILES (profilo legato a auth.users)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  display_name TEXT,
  preferred_spot_id TEXT DEFAULT 'salto-di-fondi',
  preferred_species_id TEXT DEFAULT 'orata',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Profilo creato alla registrazione. SECURITY DEFINER serve perché il trigger
-- gira su auth.users; search_path vuoto e nomi completi per sicurezza.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = id) WITH CHECK ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS "profiles_delete_own" ON public.profiles;
CREATE POLICY "profiles_delete_own" ON public.profiles
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = id);

-- ============================================================================
-- 2. CUSTOM_LOCATIONS (spot personali)
-- coast_orientation_deg: direzione verso cui guarda la spiaggia, 0..359.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.custom_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  region TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  coast_orientation_deg INTEGER NOT NULL,
  seabed_type TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_custom_locations_user_client UNIQUE (user_id, client_id)
);

-- Aggiornamento dallo schema v1: niente testi inventati come valore predefinito.
ALTER TABLE public.custom_locations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.custom_locations ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.custom_locations ALTER COLUMN region DROP NOT NULL;
ALTER TABLE public.custom_locations ALTER COLUMN region DROP DEFAULT;
ALTER TABLE public.custom_locations ALTER COLUMN seabed_type DROP NOT NULL;
ALTER TABLE public.custom_locations ALTER COLUMN seabed_type DROP DEFAULT;
ALTER TABLE public.custom_locations ALTER COLUMN coast_orientation_deg DROP DEFAULT;
ALTER TABLE public.custom_locations ALTER COLUMN notes DROP DEFAULT;

-- Vincoli: NOT VALID non ricontrolla le righe già presenti della v1 (per esempio
-- un orientamento 360), ma vale per ogni nuova scrittura.
ALTER TABLE public.custom_locations DROP CONSTRAINT IF EXISTS custom_locations_lat_check;
ALTER TABLE public.custom_locations ADD CONSTRAINT custom_locations_lat_check
  CHECK (lat BETWEEN -90 AND 90) NOT VALID;
ALTER TABLE public.custom_locations DROP CONSTRAINT IF EXISTS custom_locations_lng_check;
ALTER TABLE public.custom_locations ADD CONSTRAINT custom_locations_lng_check
  CHECK (lng BETWEEN -180 AND 180) NOT VALID;
ALTER TABLE public.custom_locations DROP CONSTRAINT IF EXISTS custom_locations_coast_orientation_deg_check;
ALTER TABLE public.custom_locations ADD CONSTRAINT custom_locations_coast_orientation_deg_check
  CHECK (coast_orientation_deg BETWEEN 0 AND 359) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_custom_locations_user_updated ON public.custom_locations (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_custom_locations_user_synced ON public.custom_locations (user_id, synced_at);

-- I trigger BEFORE partono in ordine alfabetico: prima _sync, poi _updated_at.
DROP TRIGGER IF EXISTS trg_custom_locations_sync ON public.custom_locations;
CREATE TRIGGER trg_custom_locations_sync
  BEFORE INSERT OR UPDATE ON public.custom_locations
  FOR EACH ROW EXECUTE FUNCTION public.handle_sync_row();
DROP TRIGGER IF EXISTS trg_custom_locations_updated_at ON public.custom_locations;
CREATE TRIGGER trg_custom_locations_updated_at
  BEFORE INSERT OR UPDATE ON public.custom_locations
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.custom_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "custom_locations_select_own" ON public.custom_locations;
CREATE POLICY "custom_locations_select_own" ON public.custom_locations
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "custom_locations_insert_own" ON public.custom_locations;
CREATE POLICY "custom_locations_insert_own" ON public.custom_locations
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "custom_locations_update_own" ON public.custom_locations;
CREATE POLICY "custom_locations_update_own" ON public.custom_locations
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "custom_locations_delete_own" ON public.custom_locations;
CREATE POLICY "custom_locations_delete_own" ON public.custom_locations
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

-- ============================================================================
-- 3. GEAR_ITEMS (canne, mulinelli, accessori)
-- I numerici sono facoltativi: un dato assente resta NULL.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.gear_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  brand TEXT,
  length_m NUMERIC,
  min_cast_g NUMERIC,
  max_cast_g NUMERIC,
  optimal_cast_g NUMERIC,
  reel_model TEXT,
  main_line_mm NUMERIC,
  shock_leader_mm NUMERIC,
  status TEXT NOT NULL DEFAULT 'pronta',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_gear_items_user_client UNIQUE (user_id, client_id)
);

-- Aggiornamento dallo schema v1: via i valori plausibili inventati (4.20 m,
-- 0.22 mm, 150 g...) e via i limiti di precisione che rifiuterebbero dati validi.
ALTER TABLE public.gear_items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.gear_items ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.gear_items ALTER COLUMN brand DROP DEFAULT;
ALTER TABLE public.gear_items ALTER COLUMN length_m DROP DEFAULT;
ALTER TABLE public.gear_items ALTER COLUMN length_m TYPE NUMERIC;
ALTER TABLE public.gear_items ALTER COLUMN min_cast_g DROP DEFAULT;
ALTER TABLE public.gear_items ALTER COLUMN min_cast_g TYPE NUMERIC;
ALTER TABLE public.gear_items ALTER COLUMN max_cast_g DROP DEFAULT;
ALTER TABLE public.gear_items ALTER COLUMN max_cast_g TYPE NUMERIC;
ALTER TABLE public.gear_items ALTER COLUMN optimal_cast_g DROP DEFAULT;
ALTER TABLE public.gear_items ALTER COLUMN optimal_cast_g TYPE NUMERIC;
ALTER TABLE public.gear_items ALTER COLUMN reel_model DROP DEFAULT;
ALTER TABLE public.gear_items ALTER COLUMN main_line_mm DROP DEFAULT;
ALTER TABLE public.gear_items ALTER COLUMN main_line_mm TYPE NUMERIC;
ALTER TABLE public.gear_items ALTER COLUMN shock_leader_mm DROP DEFAULT;
ALTER TABLE public.gear_items ALTER COLUMN shock_leader_mm TYPE NUMERIC;
ALTER TABLE public.gear_items ALTER COLUMN notes DROP DEFAULT;

ALTER TABLE public.gear_items DROP CONSTRAINT IF EXISTS gear_items_category_check;
ALTER TABLE public.gear_items ADD CONSTRAINT gear_items_category_check
  CHECK (category IN ('canna_surf', 'canna_fondo', 'mulinello_filo', 'accessorio')) NOT VALID;
ALTER TABLE public.gear_items DROP CONSTRAINT IF EXISTS gear_items_status_check;
ALTER TABLE public.gear_items ADD CONSTRAINT gear_items_status_check
  CHECK (status IN ('pronta', 'riserva', 'manutenzione')) NOT VALID;
ALTER TABLE public.gear_items DROP CONSTRAINT IF EXISTS gear_items_length_m_check;
ALTER TABLE public.gear_items ADD CONSTRAINT gear_items_length_m_check
  CHECK (length_m IS NULL OR length_m >= 0) NOT VALID;
ALTER TABLE public.gear_items DROP CONSTRAINT IF EXISTS gear_items_min_cast_g_check;
ALTER TABLE public.gear_items ADD CONSTRAINT gear_items_min_cast_g_check
  CHECK (min_cast_g IS NULL OR min_cast_g >= 0) NOT VALID;
ALTER TABLE public.gear_items DROP CONSTRAINT IF EXISTS gear_items_max_cast_g_check;
ALTER TABLE public.gear_items ADD CONSTRAINT gear_items_max_cast_g_check
  CHECK (max_cast_g IS NULL OR max_cast_g >= 0) NOT VALID;
ALTER TABLE public.gear_items DROP CONSTRAINT IF EXISTS gear_items_optimal_cast_g_check;
ALTER TABLE public.gear_items ADD CONSTRAINT gear_items_optimal_cast_g_check
  CHECK (optimal_cast_g IS NULL OR optimal_cast_g >= 0) NOT VALID;
ALTER TABLE public.gear_items DROP CONSTRAINT IF EXISTS gear_items_main_line_mm_check;
ALTER TABLE public.gear_items ADD CONSTRAINT gear_items_main_line_mm_check
  CHECK (main_line_mm IS NULL OR main_line_mm >= 0) NOT VALID;
ALTER TABLE public.gear_items DROP CONSTRAINT IF EXISTS gear_items_shock_leader_mm_check;
ALTER TABLE public.gear_items ADD CONSTRAINT gear_items_shock_leader_mm_check
  CHECK (shock_leader_mm IS NULL OR shock_leader_mm >= 0) NOT VALID;
ALTER TABLE public.gear_items DROP CONSTRAINT IF EXISTS gear_items_cast_range_check;
ALTER TABLE public.gear_items ADD CONSTRAINT gear_items_cast_range_check
  CHECK (min_cast_g IS NULL OR max_cast_g IS NULL OR max_cast_g >= min_cast_g) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_gear_items_user_updated ON public.gear_items (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_gear_items_user_synced ON public.gear_items (user_id, synced_at);

DROP TRIGGER IF EXISTS trg_gear_items_sync ON public.gear_items;
CREATE TRIGGER trg_gear_items_sync
  BEFORE INSERT OR UPDATE ON public.gear_items
  FOR EACH ROW EXECUTE FUNCTION public.handle_sync_row();
DROP TRIGGER IF EXISTS trg_gear_items_updated_at ON public.gear_items;
CREATE TRIGGER trg_gear_items_updated_at
  BEFORE INSERT OR UPDATE ON public.gear_items
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.gear_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gear_items_select_own" ON public.gear_items;
CREATE POLICY "gear_items_select_own" ON public.gear_items
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "gear_items_insert_own" ON public.gear_items;
CREATE POLICY "gear_items_insert_own" ON public.gear_items
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "gear_items_update_own" ON public.gear_items;
CREATE POLICY "gear_items_update_own" ON public.gear_items
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "gear_items_delete_own" ON public.gear_items;
CREATE POLICY "gear_items_delete_own" ON public.gear_items
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

-- ============================================================================
-- 4. BAITS_INVENTORY (esche)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.baits_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'altro',
  quantity INTEGER NOT NULL,
  available BOOLEAN NOT NULL DEFAULT TRUE,
  target_species TEXT[] NOT NULL DEFAULT '{}',
  water_condition TEXT NOT NULL DEFAULT 'tutte',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_baits_inventory_user_client UNIQUE (user_id, client_id)
);

ALTER TABLE public.baits_inventory ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.baits_inventory ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.baits_inventory ALTER COLUMN category SET DEFAULT 'altro';
ALTER TABLE public.baits_inventory ALTER COLUMN quantity DROP DEFAULT;
ALTER TABLE public.baits_inventory ALTER COLUMN notes DROP DEFAULT;

ALTER TABLE public.baits_inventory DROP CONSTRAINT IF EXISTS baits_inventory_category_check;
ALTER TABLE public.baits_inventory ADD CONSTRAINT baits_inventory_category_check
  CHECK (category IN ('anellide', 'sipunculide', 'mollusco', 'crostaceo', 'pesce', 'altro')) NOT VALID;
ALTER TABLE public.baits_inventory DROP CONSTRAINT IF EXISTS baits_inventory_water_condition_check;
ALTER TABLE public.baits_inventory ADD CONSTRAINT baits_inventory_water_condition_check
  CHECK (water_condition IN ('tutte', 'calmo_poco_mosso', 'mosso_scaduta')) NOT VALID;
ALTER TABLE public.baits_inventory DROP CONSTRAINT IF EXISTS baits_inventory_quantity_check;
ALTER TABLE public.baits_inventory ADD CONSTRAINT baits_inventory_quantity_check
  CHECK (quantity BETWEEN 0 AND 999) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_baits_inventory_user_updated ON public.baits_inventory (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_baits_inventory_user_synced ON public.baits_inventory (user_id, synced_at);

DROP TRIGGER IF EXISTS trg_baits_inventory_sync ON public.baits_inventory;
CREATE TRIGGER trg_baits_inventory_sync
  BEFORE INSERT OR UPDATE ON public.baits_inventory
  FOR EACH ROW EXECUTE FUNCTION public.handle_sync_row();
DROP TRIGGER IF EXISTS trg_baits_inventory_updated_at ON public.baits_inventory;
CREATE TRIGGER trg_baits_inventory_updated_at
  BEFORE INSERT OR UPDATE ON public.baits_inventory
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.baits_inventory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "baits_inventory_select_own" ON public.baits_inventory;
CREATE POLICY "baits_inventory_select_own" ON public.baits_inventory
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "baits_inventory_insert_own" ON public.baits_inventory;
CREATE POLICY "baits_inventory_insert_own" ON public.baits_inventory
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "baits_inventory_update_own" ON public.baits_inventory;
CREATE POLICY "baits_inventory_update_own" ON public.baits_inventory
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "baits_inventory_delete_own" ON public.baits_inventory;
CREATE POLICY "baits_inventory_delete_own" ON public.baits_inventory
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

-- ============================================================================
-- 5. CATCHES (diario delle catture)
-- Peso e lunghezza facoltativi, ma almeno uno dei due.
-- species_id: id dell'elenco specie dell'app (o NULL); spot_id: spot (o NULL).
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.catches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  species TEXT NOT NULL,
  species_id TEXT,
  weight_g INTEGER,
  length_cm NUMERIC(5,1),
  bait_used TEXT,
  gear_used TEXT,
  location_name TEXT,
  spot_id TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  caught_at TIMESTAMPTZ NOT NULL,
  released BOOLEAN NOT NULL DEFAULT FALSE,
  weather_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_catches_user_client UNIQUE (user_id, client_id)
);

-- Aggiornamento dallo schema v1: peso non più obbligatorio, esca e luogo
-- facoltativi, nessuna data di cattura inventata.
ALTER TABLE public.catches ADD COLUMN IF NOT EXISTS species_id TEXT;
ALTER TABLE public.catches ADD COLUMN IF NOT EXISTS spot_id TEXT;
ALTER TABLE public.catches ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE public.catches ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.catches ALTER COLUMN weight_g DROP NOT NULL;
ALTER TABLE public.catches ALTER COLUMN bait_used DROP NOT NULL;
ALTER TABLE public.catches ALTER COLUMN location_name DROP NOT NULL;
ALTER TABLE public.catches ALTER COLUMN gear_used DROP DEFAULT;
ALTER TABLE public.catches ALTER COLUMN caught_at DROP DEFAULT;
ALTER TABLE public.catches ALTER COLUMN notes DROP DEFAULT;

ALTER TABLE public.catches DROP CONSTRAINT IF EXISTS catches_weight_g_check;
ALTER TABLE public.catches ADD CONSTRAINT catches_weight_g_check
  CHECK (weight_g IS NULL OR weight_g > 0) NOT VALID;
ALTER TABLE public.catches DROP CONSTRAINT IF EXISTS catches_length_cm_check;
ALTER TABLE public.catches ADD CONSTRAINT catches_length_cm_check
  CHECK (length_cm IS NULL OR length_cm > 0) NOT VALID;
ALTER TABLE public.catches DROP CONSTRAINT IF EXISTS catches_weight_or_length_check;
ALTER TABLE public.catches ADD CONSTRAINT catches_weight_or_length_check
  CHECK (weight_g IS NOT NULL OR length_cm IS NOT NULL) NOT VALID;
ALTER TABLE public.catches DROP CONSTRAINT IF EXISTS catches_lat_check;
ALTER TABLE public.catches ADD CONSTRAINT catches_lat_check
  CHECK (lat BETWEEN -90 AND 90) NOT VALID;
ALTER TABLE public.catches DROP CONSTRAINT IF EXISTS catches_lng_check;
ALTER TABLE public.catches ADD CONSTRAINT catches_lng_check
  CHECK (lng BETWEEN -180 AND 180) NOT VALID;
ALTER TABLE public.catches DROP CONSTRAINT IF EXISTS catches_weather_snapshot_check;
ALTER TABLE public.catches ADD CONSTRAINT catches_weather_snapshot_check
  CHECK (jsonb_typeof(weather_snapshot) = 'object') NOT VALID;

CREATE INDEX IF NOT EXISTS idx_catches_user_updated ON public.catches (user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_catches_user_synced ON public.catches (user_id, synced_at);
CREATE INDEX IF NOT EXISTS idx_catches_user_caught_at ON public.catches (user_id, caught_at DESC);

DROP TRIGGER IF EXISTS trg_catches_sync ON public.catches;
CREATE TRIGGER trg_catches_sync
  BEFORE INSERT OR UPDATE ON public.catches
  FOR EACH ROW EXECUTE FUNCTION public.handle_sync_row();
DROP TRIGGER IF EXISTS trg_catches_updated_at ON public.catches;
CREATE TRIGGER trg_catches_updated_at
  BEFORE INSERT OR UPDATE ON public.catches
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.catches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "catches_select_own" ON public.catches;
CREATE POLICY "catches_select_own" ON public.catches
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "catches_insert_own" ON public.catches;
CREATE POLICY "catches_insert_own" ON public.catches
  FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "catches_update_own" ON public.catches;
CREATE POLICY "catches_update_own" ON public.catches
  FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "catches_delete_own" ON public.catches;
CREATE POLICY "catches_delete_own" ON public.catches
  FOR DELETE TO authenticated USING ((SELECT auth.uid()) = user_id);

COMMIT;
