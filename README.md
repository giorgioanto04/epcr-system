# ePCR Open Source

Sistema open source ispirato ai CAD/ePCR professionali (es. Beta 80), pensato per
piccole associazioni di soccorso: attivazione mezzi in tempo reale, centrale
operativa con mappa GPS, gestione turni e storico interventi.

> ⚠️ Progetto in fase iniziale (MVP). Non è certificato per uso critico in produzione
> senza ulteriori test, ridondanze e validazione da parte di personale competente.

## Architettura

```
epcr-system/
├── backend/          Node.js + TypeScript + Fastify + PostgreSQL + Redis + Socket.IO
├── mobile/            App React Native (Expo) per i soccorritori
├── web-dashboard/     Centrale operativa: React + Leaflet (mappa) + Socket.IO
└── docs/              Documentazione tecnica
```

### Come funziona il flusso di attivazione

1. Un operatore in centrale crea un **intervento** dalla dashboard web.
2. Il backend seleziona/riceve il mezzo assegnato e invia:
   - un evento realtime via **Socket.IO** a tutte le dashboard connesse
   - una **push notification critica** (Firebase Cloud Messaging) al telefono
     del soccorritore assegnato, che suona a volume alto anche con telefono
     silenzioso o app in background
3. L'app mobile, ricevuta la notifica, invia una **conferma di ricezione** al backend.
4. Se non arriva conferma entro X secondi, il backend segnala "nessuna risposta"
   alla dashboard, così un operatore umano può intervenire (richiamare, riassegnare).
5. Tutti gli orari (attivazione, presa in carico, arrivo, rientro) vengono
   salvati per lo storico e le statistiche.

> Nota tecnica importante: un telefono **completamente spento** non può ricevere
> nulla in nessun modo (nessun sistema al mondo lo permette). Il sistema è
> progettato per squillare anche a schermo spento / silenzioso / app in background,
> e per attivare un fallback umano se il device non risponde o è irraggiungibile.

## Setup rapido (sviluppo locale)

Requisiti: Docker, Node.js 20+, npm.

```bash
cd backend
cp .env.example .env
docker compose up -d       # avvia PostgreSQL + Redis
npm install
npm run migrate            # crea le tabelle
npm run dev                # backend su http://localhost:3000
```

Dashboard web:
```bash
cd web-dashboard
npm install
npm run dev                 # http://localhost:5173
```

App mobile:
```bash
cd mobile
npm install
npx expo start
```

## Come caricarlo sul tuo GitHub

```bash
# dentro la cartella epcr-system, dopo aver scaricato ed estratto lo zip
git add .
git commit -m "Initial scaffold: backend, mobile, dashboard"
git branch -M main
git remote add origin https://github.com/TUO-USERNAME/epcr-system.git
git push -u origin main
```

Crea prima il repository vuoto (senza README) su github.com, poi esegui i comandi sopra.

## Roadmap MVP

- [x] Struttura progetto e schema database
- [x] API attivazione intervento + assegnazione mezzo
- [x] Realtime via Socket.IO (centrale ↔ app)
- [ ] Integrazione push FCM lato mobile (richiede tuo progetto Firebase gratuito)
- [ ] Mappa live mezzi su dashboard (Leaflet)
- [ ] Gestione turni
- [ ] Storico interventi con statistiche tempi di risposta
- [ ] Autenticazione utenti/ruoli (operatore centrale vs soccorritore)

Vedi `docs/` per dettagli tecnici.
