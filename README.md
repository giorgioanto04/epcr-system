# IRIS v2

Sistema operativo per Centrale Operativa, gestione mezzi e scheda missione.
La struttura del progetto è rimasta quella originale: `backend/`, `web-dashboard/`, `mezzo-web/` e `mobile/`.

## Deploy previsto

- **Vercel**: `web-dashboard/` e, se desiderato, `mezzo-web/` come progetto separato.
- **Render**: `backend/`.
- **Supabase**: database PostgreSQL tramite `DATABASE_URL`.

### Web dashboard Vercel
Impostare:

`VITE_API_URL=https://TUO-SERVIZIO.onrender.com`

### Postazione mezzo
La pagina usa il backend Render. Si può passare anche `?api=https://TUO-SERVIZIO.onrender.com`, senza usare IP locali.

### Mobile Expo
Impostare:

`EXPO_PUBLIC_API_URL=https://TUO-SERVIZIO.onrender.com`

## Funzioni principali

- attivazioni con priorità verde/giallo/rosso;
- numero missione progressivo giornaliero `AAAAMMGG-0001`;
- più mezzi associabili alla stessa missione;
- registro missioni filtrabile per giornata;
- mappa mezzi con marker trascinabili;
- flag colore del mezzo;
- stati missione con timestamp e conferma;
- scheda missione modificabile dalla CO;
- collegamento realtime via Socket.IO;
- push mobile tramite Firebase/Expo quando configurato.

## Backend

```bash
cd backend
npm install
npm run migrate
npm run build
npm start
```

Il server ascolta sulla porta `PORT` e su `0.0.0.0`, come richiesto da Render.
