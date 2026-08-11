-- IRIS v2 - schema compatibile con la struttura originale.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS operatori (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nome TEXT NOT NULL,
    cognome TEXT NOT NULL,
    ruolo TEXT NOT NULL CHECK (ruolo IN ('soccorritore', 'centrale', 'admin')),
    telefono TEXT,
    push_token TEXT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    creato_il TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mezzi (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nome TEXT NOT NULL,
    targa TEXT,
    stato TEXT NOT NULL DEFAULT 'disponibile'
        CHECK (stato IN ('disponibile', 'impegnato', 'fuori_servizio')),
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    flag_colore TEXT NOT NULL DEFAULT 'verde'
        CHECK (flag_colore IN ('verde', 'giallo', 'rosso')),
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

CREATE TABLE IF NOT EXISTS mission_progressivi (
    giorno DATE PRIMARY KEY,
    progressivo INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS interventi (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    numero_missione TEXT UNIQUE,
    mezzo_id UUID REFERENCES mezzi(id),
    indirizzo TEXT NOT NULL,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    tipologia TEXT,
    priorita TEXT NOT NULL DEFAULT 'verde'
        CHECK (priorita IN ('verde', 'giallo', 'rosso')),
    note TEXT,
    stato TEXT NOT NULL DEFAULT 'in_attesa'
        CHECK (stato IN ('in_attesa', 'assegnato', 'in_corso', 'concluso', 'annullato')),
    stato_operativo TEXT NOT NULL DEFAULT 'Attivazione',
    creato_il TIMESTAMPTZ NOT NULL DEFAULT now(),
    ora_assegnazione TIMESTAMPTZ,
    ora_presa_in_carico TIMESTAMPTZ,
    ora_arrivo TIMESTAMPTZ,
    ora_rientro TIMESTAMPTZ,
    scheda_missione JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS missione_mezzi (
    intervento_id UUID NOT NULL REFERENCES interventi(id) ON DELETE CASCADE,
    mezzo_id UUID NOT NULL REFERENCES mezzi(id),
    assegnato_il TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (intervento_id, mezzo_id)
);

CREATE TABLE IF NOT EXISTS eventi_missione (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    intervento_id UUID NOT NULL REFERENCES interventi(id) ON DELETE CASCADE,
    mezzo_id UUID REFERENCES mezzi(id),
    stato TEXT NOT NULL,
    creato_il TIMESTAMPTZ NOT NULL DEFAULT now(),
    nota TEXT
);

CREATE TABLE IF NOT EXISTS notifiche_attivazione (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    intervento_id UUID NOT NULL REFERENCES interventi(id),
    operatore_id UUID REFERENCES operatori(id),
    mezzo_id UUID REFERENCES mezzi(id),
    inviata_il TIMESTAMPTZ NOT NULL DEFAULT now(),
    confermata_il TIMESTAMPTZ,
    esito TEXT DEFAULT 'inviata' CHECK (esito IN ('inviata', 'confermata', 'fallita', 'timeout')),
    CHECK (operatore_id IS NOT NULL OR mezzo_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_interventi_numero_missione ON interventi(numero_missione) WHERE numero_missione IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_interventi_stato ON interventi(stato);
CREATE INDEX IF NOT EXISTS idx_interventi_creato_il ON interventi(creato_il);
CREATE INDEX IF NOT EXISTS idx_mezzi_stato ON mezzi(stato);
CREATE INDEX IF NOT EXISTS idx_eventi_missione_intervento ON eventi_missione(intervento_id, creato_il);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='mezzi' AND column_name='flag_colore') THEN
    ALTER TABLE mezzi ADD COLUMN flag_colore TEXT NOT NULL DEFAULT 'verde';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='interventi' AND column_name='numero_missione') THEN
    ALTER TABLE interventi ADD COLUMN numero_missione TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='interventi' AND column_name='priorita') THEN
    ALTER TABLE interventi ADD COLUMN priorita TEXT NOT NULL DEFAULT 'verde';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='interventi' AND column_name='stato_operativo') THEN
    ALTER TABLE interventi ADD COLUMN stato_operativo TEXT NOT NULL DEFAULT 'Attivazione';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='interventi' AND column_name='scheda_missione') THEN
    ALTER TABLE interventi ADD COLUMN scheda_missione JSONB NOT NULL DEFAULT '{}'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='interventi' AND column_name='ora_arrivo') THEN
    ALTER TABLE interventi ADD COLUMN ora_arrivo TIMESTAMPTZ;
  END IF;
END $$;
