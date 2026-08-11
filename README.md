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
├── mobile/            App React Native (Expo) per i soccorritori (login con account operatore)
├── mezzo-web/          Pagina web (HTML/JS, no build) per il cellulare del mezzo: si
│                       seleziona il mezzo da una lista, nessun login richiesto
├── web-dashboard/     Centrale operativa: React + Leaflet (mappa) + Socket.IO
└── docs/              Documentazione tecnica
```

### Pagina web del mezzo (`mezzo-web/`)

Pensata per il caso d'uso "il cellulare resta in postazione sul mezzo": l'operatore
apre il sito, sceglie il proprio mezzo da una lista (niente password), e la pagina
resta in ascolto in tempo reale via Socket.IO. Quando la centrale assegna un
intervento a quel mezzo, compare a schermo intero l'indirizzo, la tipologia e le
note, con suono e vibrazione; un tap su "Conferma presa in carico" avvisa la
centrale.

Per usarla:
1. Apri `mezzo-web/index.html` (in locale con un qualsiasi server statico, es.
   `npx serve mezzo-web`, oppure pubblicala come sito statico su Render).
2. Se il backend non gira su `http://localhost:3000`, apri la pagina con
   `?api=https://tuo-backend.onrender.com`: l'indirizzo viene salvato e riusato
   automaticamente ai prossimi accessi.
3. Su iOS/Android puoi usare "Aggiungi a schermata Home" dal browser per
   trasformarla in un'icona a tutto schermo.
4. (Opzionale) aggiungi un file `mezzo-web/attivazione.mp3` con un suono di
   allarme: verrà riprodotto automaticamente all'attivazione.

> Limite importante: essendo una pagina web (non un'app nativa con push), riceve
> l'attivazione in tempo reale **solo se rimane aperta** (va bene anche in
> background su molti browser, ma non a schermo completamente spento/bloccato
> a lungo). Per un allarme affidabile anche a telefono bloccato serve l'app
> nativa in `mobile/` (push FCM) oppure, in futuro, Web Push + Service Worker.
> Per questo motivo il backend genera comunque, dopo `ACTIVATION_TIMEOUT_SECONDS`,
> un avviso "nessuna risposta" alla centrale se non arriva conferma.

### Come funziona il flusso di attivazione

1. Un operatore in centrale crea un **intervento** dalla dashboard web.
2. Il backend seleziona/riceve il mezzo assegnato e invia:
   - un evento realtime via **Socket.IO** a tutte le dashboard connesse
   - un evento realtime via **Socket.IO** alla pagina web del mezzo assegnato
     (`mezzo-web/`), che mostra subito i dettagli a schermo intero
   - (se l'operatore ha un account con l'app nativa) una **push notification
     critica** (Firebase Cloud Messaging), che suona a volume alto anche con
     telefono silenzioso o app in background
3. Il mezzo (pagina web o app mobile) invia una **conferma di ricezione** al backend.
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
- [x] Pagina web selezione mezzo + schermata di attivazione (`mezzo-web/`)
- [ ] Integrazione push FCM lato mobile (richiede tuo progetto Firebase gratuito)
- [ ] Mappa live mezzi su dashboard (Leaflet)
- [ ] Gestione turni
- [ ] Storico interventi con statistiche tempi di risposta
- [ ] Autenticazione utenti/ruoli (operatore centrale vs soccorritore)

Vedi `docs/` per dettagli tecnici.
