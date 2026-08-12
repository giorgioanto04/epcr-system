-- Schema iniziale ePCR Open Source
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS operatori (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nome TEXT NOT NULL,
    cognome TEXT NOT NULL,
    ruolo TEXT NOT NULL CHECK (ruolo IN ('soccorritore', 'centrale', 'admin')),
    telefono TEXT,
    push_token TEXT,               -- token FCM del device attivo
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    creato_il TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mezzi (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nome TEXT NOT NULL,                 -- es. "Ambulanza 1"
    targa TEXT,
    stato TEXT NOT NULL DEFAULT 'disponibile'
        CHECK (stato IN ('disponibile', 'impegnato', 'fuori_servizio')),
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    ultimo_aggiornamento_gps TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS turni (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    operatore_id UUID NOT NULL REFERENCES operatori(id),
    mezzo_id UUID REFERENCES mezzi(id),
    inizio TIMESTAMPTZ NOT NULL,
    fine TIMESTAMPTZ,
    creato_il TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS interventi (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mezzo_id UUID REFERENCES mezzi(id),
    indirizzo TEXT NOT NULL,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    tipologia TEXT,                     -- es. codice/priorità intervento
    note TEXT,
    stato TEXT NOT NULL DEFAULT 'in_attesa'
        CHECK (stato IN ('in_attesa', 'assegnato', 'in_corso', 'concluso', 'annullato')),
    creato_il TIMESTAMPTZ NOT NULL DEFAULT now(),
    ora_assegnazione TIMESTAMPTZ,
    ora_presa_in_carico TIMESTAMPTZ,    -- conferma ricezione da app
    ora_arrivo TIMESTAMPTZ,
    ora_rientro TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS notifiche_attivazione (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    intervento_id UUID NOT NULL REFERENCES interventi(id) ON DELETE CASCADE,
    operatore_id UUID REFERENCES operatori(id),   -- opzionale: attivazione via account operatore (push FCM)
    mezzo_id UUID REFERENCES mezzi(id),            -- opzionale: attivazione via pagina web del mezzo (Socket.IO)
    inviata_il TIMESTAMPTZ NOT NULL DEFAULT now(),
    confermata_il TIMESTAMPTZ,          -- NULL = nessuna risposta -> fallback
    esito TEXT DEFAULT 'inviata' CHECK (esito IN ('inviata', 'confermata', 'fallita', 'timeout')),
    CHECK (operatore_id IS NOT NULL OR mezzo_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_interventi_stato ON interventi(stato);
CREATE INDEX IF NOT EXISTS idx_mezzi_stato ON mezzi(stato);

-- Migrazione idempotente per database già esistenti (creati prima dell'introduzione
-- della pagina web del mezzo): rende operatore_id opzionale e aggiunge mezzo_id.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'notifiche_attivazione' AND column_name = 'operatore_id'
          AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE notifiche_attivazione ALTER COLUMN operatore_id DROP NOT NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'notifiche_attivazione' AND column_name = 'mezzo_id'
    ) THEN
        ALTER TABLE notifiche_attivazione ADD COLUMN mezzo_id UUID REFERENCES mezzi(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'notifiche_attivazione' AND constraint_name = 'notifiche_attivazione_operatore_o_mezzo'
    ) THEN
        ALTER TABLE notifiche_attivazione
            ADD CONSTRAINT notifiche_attivazione_operatore_o_mezzo
            CHECK (operatore_id IS NOT NULL OR mezzo_id IS NOT NULL);
    END IF;
END $$;


-- IRIS v2: missione estesa, più mezzi, scheda e cronologia stati
ALTER TABLE interventi ADD COLUMN IF NOT EXISTS missione_numero TEXT;
ALTER TABLE interventi ADD COLUMN IF NOT EXISTS priorita TEXT NOT NULL DEFAULT 'verde' CHECK (priorita IN ('verde','giallo','rosso'));
ALTER TABLE interventi ADD COLUMN IF NOT EXISTS ospedale TEXT;
ALTER TABLE interventi ADD COLUMN IF NOT EXISTS scheda JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_interventi_missione_numero ON interventi(missione_numero);

CREATE TABLE IF NOT EXISTS intervento_mezzi (
  intervento_id UUID NOT NULL REFERENCES interventi(id) ON DELETE CASCADE,
  mezzo_id UUID NOT NULL REFERENCES mezzi(id) ON DELETE RESTRICT,
  assegnato_il TIMESTAMPTZ NOT NULL DEFAULT now(),
  attivato_il TIMESTAMPTZ,
  PRIMARY KEY (intervento_id, mezzo_id)
);

CREATE TABLE IF NOT EXISTS stati_intervento (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  intervento_id UUID NOT NULL REFERENCES interventi(id) ON DELETE CASCADE,
  mezzo_id UUID REFERENCES mezzi(id) ON DELETE SET NULL,
  stato TEXT NOT NULL,
  registrato_il TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stati_intervento_intervento ON stati_intervento(intervento_id, registrato_il);

-- Numero progressivo per giornata: AAAAMMGG-0001
CREATE OR REPLACE FUNCTION genera_numero_missione()
RETURNS TEXT AS $$
DECLARE
  giorno TEXT := to_char(now(), 'YYYYMMDD');
  progressivo INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(split_part(missione_numero, '-', 2) AS INTEGER)), 0) + 1
    INTO progressivo
  FROM interventi
  WHERE missione_numero LIKE giorno || '-%';
  RETURN giorno || '-' || lpad(progressivo::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

UPDATE interventi
SET missione_numero = genera_numero_missione()
WHERE missione_numero IS NULL;

CREATE OR REPLACE FUNCTION set_missione_numero()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.missione_numero IS NULL OR NEW.missione_numero = '' THEN
    NEW.missione_numero := genera_numero_missione();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_interventi_missione_numero ON interventi;
CREATE TRIGGER trg_interventi_missione_numero
BEFORE INSERT ON interventi
FOR EACH ROW EXECUTE FUNCTION set_missione_numero();


DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='notifiche_attivazione_intervento_id_fkey' AND table_name='notifiche_attivazione') THEN
    ALTER TABLE notifiche_attivazione DROP CONSTRAINT notifiche_attivazione_intervento_id_fkey;
    ALTER TABLE notifiche_attivazione ADD CONSTRAINT notifiche_attivazione_intervento_id_fkey FOREIGN KEY (intervento_id) REFERENCES interventi(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Punti di interesse sulla mappa operativa: squadre a piedi, punti di raccolta,
-- posti di comando, o qualsiasi altro segnalino utile alla centrale.
CREATE TABLE IF NOT EXISTS punti_interesse (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tipo TEXT NOT NULL DEFAULT 'altro' CHECK (tipo IN ('squadra','intervento','posto_comando','punto_raccolta','altro')),
  etichetta TEXT NOT NULL,
  note TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  creato_il TIMESTAMPTZ NOT NULL DEFAULT now()
);
