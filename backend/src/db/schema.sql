-- Schema iniziale ePCR Open Source
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
    tipologia TEXT,
    note TEXT,
    stato TEXT NOT NULL DEFAULT 'in_attesa'
        CHECK (stato IN ('in_attesa', 'assegnato', 'in_corso', 'concluso', 'annullato')),
    creato_il TIMESTAMPTZ NOT NULL DEFAULT now(),
    ora_assegnazione TIMESTAMPTZ,
    ora_presa_in_carico TIMESTAMPTZ,
    ora_arrivo TIMESTAMPTZ,
    ora_rientro TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS notifiche_attivazione (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    intervento_id UUID NOT NULL REFERENCES interventi(id),
    operatore_id UUID NOT NULL REFERENCES operatori(id),
    inviata_il TIMESTAMPTZ NOT NULL DEFAULT now(),
    confermata_il TIMESTAMPTZ,
    esito TEXT DEFAULT 'inviata' CHECK (esito IN ('inviata', 'confermata', 'fallita', 'timeout'))
);

CREATE INDEX IF NOT EXISTS idx_interventi_stato ON interventi(stato);
CREATE INDEX IF NOT EXISTS idx_mezzi_stato ON mezzi(stato);
