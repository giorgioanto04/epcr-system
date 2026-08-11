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
    intervento_id UUID NOT NULL REFERENCES interventi(id),
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

ALTER TABLE interventi ADD COLUMN IF NOT EXISTS numero_missione TEXT;
ALTER TABLE interventi ADD COLUMN IF NOT EXISTS stato_missione TEXT DEFAULT 'Attivazione';
ALTER TABLE interventi ADD COLUMN IF NOT EXISTS scheda_missione JSONB DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS idx_interventi_numero_missione ON interventi(numero_missione) WHERE numero_missione IS NOT NULL;
CREATE TABLE IF NOT EXISTS eventi_missione (
 id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
 intervento_id UUID NOT NULL REFERENCES interventi(id) ON DELETE CASCADE,
 stato TEXT NOT NULL,
 dettagli JSONB NOT NULL DEFAULT '{}'::jsonb,
 creato_il TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE eventi_missione ADD COLUMN IF NOT EXISTS dettagli JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE interventi ADD COLUMN IF NOT EXISTS numero_missione TEXT;
ALTER TABLE interventi ADD COLUMN IF NOT EXISTS stato_missione TEXT DEFAULT 'Attivazione';
ALTER TABLE interventi ADD COLUMN IF NOT EXISTS scheda_missione JSONB DEFAULT '{}'::jsonb;
ALTER TABLE interventi ADD COLUMN IF NOT EXISTS rifiuto_trasporto BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE interventi ADD COLUMN IF NOT EXISTS ultimo_aggiornamento_missione TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_interventi_numero_missione ON interventi(numero_missione) WHERE numero_missione IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_eventi_missione_intervento ON eventi_missione(intervento_id, creato_il);

-- Compatibilità con database creati con la precedente versione MVP.
UPDATE interventi
SET scheda_missione = '{}'::jsonb
WHERE scheda_missione IS NULL;
