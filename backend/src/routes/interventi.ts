import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { getIO } from "../ws/socket.js";
import { inviaNotificaAttivazione } from "../ws/push.js";

const TIMEOUT_SECONDI = Number(process.env.ACTIVATION_TIMEOUT_SECONDS ?? 60);

const STATI = [
  "Attivazione",
  "Partenza",
  "Arrivo sul posto",
  "Paziente visto",
  "Partenza per ospedale",
  "Arrivo ospedale",
  "Libero in Ospedale",
  "Rientro",
  "Disponibile",
] as const;

type StatoMissione = (typeof STATI)[number];

const TRANSIZIONI: Record<StatoMissione, StatoMissione[]> = {
  "Attivazione": ["Partenza"],
  "Partenza": ["Arrivo sul posto"],
  "Arrivo sul posto": ["Paziente visto"],
  "Paziente visto": ["Partenza per ospedale", "Rientro"],
  "Partenza per ospedale": ["Arrivo ospedale"],
  "Arrivo ospedale": ["Libero in Ospedale"],
  "Libero in Ospedale": ["Rientro"],
  "Rientro": ["Disponibile"],
  "Disponibile": [],
};

function generaNumeroMissione() {
  const giorno = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const casuale = Math.floor(Math.random() * 9000 + 1000);
  return `M-${giorno}-${casuale}`;
}

async function creaNumeroMissione() {
  for (let i = 0; i < 10; i++) {
    const numero = generaNumeroMissione();
    const { rowCount } = await pool.query(
      "SELECT 1 FROM interventi WHERE numero_missione = $1 LIMIT 1",
      [numero]
    );
    if (!rowCount) return numero;
  }
  return `M-${Date.now()}`;
}

async function registraStato(interventoId: string, stato: StatoMissione, dettagli: Record<string, unknown> = {}) {
  await pool.query(
    "INSERT INTO eventi_missione (intervento_id, stato, dettagli) VALUES ($1, $2, $3::jsonb)",
    [interventoId, stato, JSON.stringify(dettagli)]
  );
}

async function leggiIntervento(id: string) {
  const { rows } = await pool.query("SELECT * FROM interventi WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function interventiRoutes(app: FastifyInstance) {
  app.get("/interventi", async (req) => {
    const { stato } = req.query as { stato?: string };
    const { rows } = stato
      ? await pool.query(
          "SELECT * FROM interventi WHERE stato = $1 ORDER BY creato_il DESC",
          [stato]
        )
      : await pool.query("SELECT * FROM interventi ORDER BY creato_il DESC LIMIT 500");
    return rows;
  });

  app.get("/interventi/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const intervento = await leggiIntervento(id);
    if (!intervento) return reply.code(404).send({ errore: "Intervento non trovato" });
    const { rows: registro } = await pool.query(
      "SELECT * FROM eventi_missione WHERE intervento_id=$1 ORDER BY creato_il",
      [id]
    );
    return { ...intervento, registro };
  });

  app.post("/interventi", async (req, reply) => {
    const { indirizzo, lat, lon, tipologia, note } = req.body as {
      indirizzo: string;
      lat?: number;
      lon?: number;
      tipologia?: string;
      note?: string;
    };

    if (!indirizzo?.trim()) {
      return reply.code(400).send({ errore: "Indirizzo obbligatorio" });
    }

    const numeroMissione = await creaNumeroMissione();
    const { rows } = await pool.query(
      `INSERT INTO interventi
       (indirizzo, lat, lon, tipologia, note, numero_missione, stato_missione, scheda_missione)
       VALUES ($1,$2,$3,$4,$5,$6,'Attivazione',$7::jsonb) RETURNING *`,
      [indirizzo.trim(), lat ?? null, lon ?? null, tipologia ?? null, note ?? null, numeroMissione, JSON.stringify({
        luogoEvento: { indirizzo: indirizzo.trim() },
        evento: { tipologia: tipologia ?? "", note: note ?? "" }
      })]
    );

    await registraStato(rows[0].id, "Attivazione", { origine: "centrale" });
    getIO().to("centrale").emit("nuovo_intervento", rows[0]);
    return reply.code(201).send(rows[0]);
  });

  app.post("/interventi/:id/assegna", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { mezzoId, operatoreId } = req.body as { mezzoId: string; operatoreId?: string };

    if (!mezzoId) return reply.code(400).send({ errore: "mezzoId obbligatorio" });

    const mezzo = await pool.query("SELECT * FROM mezzi WHERE id = $1", [mezzoId]);
    if (!mezzo.rows.length) return reply.code(404).send({ errore: "Mezzo non trovato" });

    let operatore = null;
    if (operatoreId) {
      const res = await pool.query("SELECT * FROM operatori WHERE id = $1", [operatoreId]);
      if (!res.rows.length) return reply.code(404).send({ errore: "Operatore non trovato" });
      operatore = res.rows[0];
    }

    const intervento = await pool.query(
      `UPDATE interventi
       SET mezzo_id=$1, stato='assegnato', ora_assegnazione=now(),
           numero_missione=COALESCE(numero_missione,$3),
           stato_missione='Attivazione',
           ultimo_aggiornamento_missione=now()
       WHERE id=$2 RETURNING *`,
      [mezzoId, id, await creaNumeroMissione()]
    );
    if (!intervento.rows.length) return reply.code(404).send({ errore: "Intervento non trovato" });

    await pool.query("UPDATE mezzi SET stato='impegnato' WHERE id=$1", [mezzoId]);

    const notifica = await pool.query(
      `INSERT INTO notifiche_attivazione (intervento_id, operatore_id, mezzo_id)
       VALUES ($1,$2,$3) RETURNING *`,
      [id, operatoreId ?? null, mezzoId]
    );

    getIO().to("centrale").emit("intervento_assegnato", intervento.rows[0]);
    getIO().to(`mezzo:${mezzoId}`).emit("attivazione", {
      notificaId: notifica.rows[0].id,
      interventoId: id,
      mezzoId,
      numeroMissione: intervento.rows[0].numero_missione,
      indirizzo: intervento.rows[0].indirizzo,
      lat: intervento.rows[0].lat,
      lon: intervento.rows[0].lon,
      tipologia: intervento.rows[0].tipologia,
      note: intervento.rows[0].note,
    });

    const pushToken = operatore?.push_token;
    if (pushToken) {
      try {
        await inviaNotificaAttivazione(pushToken, {
          interventoId: id,
          indirizzo: intervento.rows[0].indirizzo,
          tipologia: intervento.rows[0].tipologia,
        });
      } catch (err) {
        console.error("[attivazione] invio push fallito:", err);
        getIO().to("centrale").emit("attivazione_fallita", { interventoId: id, operatoreId });
      }
    }

    setTimeout(async () => {
      const check = await pool.query(
        "SELECT confermata_il FROM notifiche_attivazione WHERE id=$1",
        [notifica.rows[0].id]
      );
      if (check.rows.length && !check.rows[0].confermata_il) {
        await pool.query(
          "UPDATE notifiche_attivazione SET esito='timeout' WHERE id=$1",
          [notifica.rows[0].id]
        );
        getIO().to("centrale").emit("attivazione_senza_risposta", {
          interventoId: id,
          operatoreId,
          mezzoId,
          numeroMissione: intervento.rows[0].numero_missione,
        });
      }
    }, TIMEOUT_SECONDI * 1000);

    return intervento.rows[0];
  });

  app.post("/interventi/:id/conferma", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { operatoreId } = req.body as { operatoreId: string };

    await pool.query(
      `UPDATE notifiche_attivazione
       SET confermata_il=now(), esito='confermata'
       WHERE intervento_id=$1 AND operatore_id=$2`,
      [id, operatoreId]
    );

    const { rows } = await pool.query(
      "UPDATE interventi SET ora_presa_in_carico=now(), stato='in_corso', ultimo_aggiornamento_missione=now() WHERE id=$1 RETURNING *",
      [id]
    );
    if (!rows.length) return reply.code(404).send({ errore: "Intervento non trovato" });

    getIO().to("centrale").emit("intervento_confermato", rows[0]);
    return rows[0];
  });

  app.post("/interventi/:id/conferma-mezzo", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { mezzoId } = req.body as { mezzoId: string };
    if (!mezzoId) return reply.code(400).send({ errore: "mezzoId obbligatorio" });

    await pool.query(
      `UPDATE notifiche_attivazione
       SET confermata_il=now(), esito='confermata'
       WHERE intervento_id=$1 AND mezzo_id=$2`,
      [id, mezzoId]
    );

    const { rows } = await pool.query(
      "UPDATE interventi SET ora_presa_in_carico=now(), stato='in_corso', ultimo_aggiornamento_missione=now() WHERE id=$1 RETURNING *",
      [id]
    );
    if (!rows.length) return reply.code(404).send({ errore: "Intervento non trovato" });

    getIO().to("centrale").emit("intervento_confermato", rows[0]);
    return rows[0];
  });

  app.patch("/interventi/:id/scheda", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { scheda } = req.body as { scheda: Record<string, unknown> };
    if (!scheda || typeof scheda !== "object") {
      return reply.code(400).send({ errore: "scheda obbligatoria" });
    }

    const { rows } = await pool.query(
      `UPDATE interventi
       SET scheda_missione=$1::jsonb, ultimo_aggiornamento_missione=now()
       WHERE id=$2 RETURNING *`,
      [JSON.stringify(scheda), id]
    );
    if (!rows.length) return reply.code(404).send({ errore: "Intervento non trovato" });

    getIO().to("centrale").emit("scheda_missione_aggiornata", rows[0]);
    return rows[0];
  });

  app.post("/interventi/:id/stato-missione", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { stato, scheda, rifiutoTrasporto } = req.body as {
      stato: StatoMissione;
      scheda?: Record<string, unknown>;
      rifiutoTrasporto?: boolean;
    };

    if (!STATI.includes(stato)) {
      return reply.code(400).send({ errore: "Stato missione non valido" });
    }

    const current = await leggiIntervento(id);
    if (!current) return reply.code(404).send({ errore: "Intervento non trovato" });

    const precedente = (current.stato_missione || "Attivazione") as StatoMissione;
    if (stato !== precedente && !TRANSIZIONI[precedente]?.includes(stato)) {
      return reply.code(409).send({
        errore: `Transizione non consentita: ${precedente} → ${stato}`,
        statoCorrente: precedente,
        statiSuccessivi: TRANSIZIONI[precedente] ?? [],
      });
    }

    const merged = scheda
      ? JSON.stringify(scheda)
      : JSON.stringify(current.scheda_missione ?? {});

    const isRifiuto = rifiutoTrasporto === true || (stato === "Rientro" && precedente === "Paziente visto" && current.rifiuto_trasporto);

    const { rows } = await pool.query(
      `UPDATE interventi
       SET stato_missione=$1,
           scheda_missione=$2::jsonb,
           rifiuto_trasporto=CASE WHEN $3 THEN true ELSE rifiuto_trasporto END,
           ora_arrivo=CASE WHEN $1='Arrivo sul posto' THEN now() ELSE ora_arrivo END,
           ora_rientro=CASE WHEN $1='Rientro' THEN now() ELSE ora_rientro END,
           ultimo_aggiornamento_missione=now(),
           stato=CASE WHEN $1='Disponibile' THEN 'concluso' ELSE 'in_corso' END
       WHERE id=$4 RETURNING *`,
      [stato, merged, isRifiuto, id]
    );

    const dettagli = {
      rifiutoTrasporto: isRifiuto,
      scheda: scheda ?? null,
    };
    await registraStato(id, stato, dettagli);

    if (stato === "Disponibile" && rows[0].mezzo_id) {
      await pool.query("UPDATE mezzi SET stato='disponibile' WHERE id=$1", [rows[0].mezzo_id]);
    } else if (rows[0].mezzo_id && stato !== "Disponibile") {
      await pool.query("UPDATE mezzi SET stato='impegnato' WHERE id=$1", [rows[0].mezzo_id]);
    }

    const aggiornato = await leggiIntervento(id);
    getIO().to("centrale").emit("missione_aggiornata", aggiornato);
    return aggiornato;
  });

  app.get("/interventi/:id/registro", async (req, reply) => {
    const { id } = req.params as { id: string };
    const intervento = await leggiIntervento(id);
    if (!intervento) return reply.code(404).send({ errore: "Intervento non trovato" });
    const { rows } = await pool.query(
      "SELECT * FROM eventi_missione WHERE intervento_id=$1 ORDER BY creato_il",
      [id]
    );
    return rows;
  });

  app.post("/interventi/:id/chiudi", async (req, reply) => {
    const { id } = req.params as { id: string };
    const current = await leggiIntervento(id);
    if (!current) return reply.code(404).send({ errore: "Intervento non trovato" });

    if (current.stato_missione !== "Disponibile") {
      return reply.code(409).send({
        errore: "Chiudi la missione seguendo gli stati guidati fino a Disponibile.",
        statoCorrente: current.stato_missione,
      });
    }
    return current;
  });
}
