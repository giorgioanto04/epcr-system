import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { getIO } from "../ws/socket.js";
import { inviaNotificaAttivazione } from "../ws/push.js";

const TIMEOUT_SECONDI = Number(process.env.ACTIVATION_TIMEOUT_SECONDS ?? 60);

export async function interventiRoutes(app: FastifyInstance) {
  // Elenco interventi (con filtro opzionale per stato)
  app.get("/interventi", async (req) => {
    const { stato } = req.query as { stato?: string };
    const { rows } = stato
      ? await pool.query("SELECT * FROM interventi WHERE stato = $1 ORDER BY creato_il DESC", [stato])
      : await pool.query("SELECT * FROM interventi ORDER BY creato_il DESC LIMIT 200");
    return rows;
  });

  // Creazione nuovo intervento (chiamata dalla centrale)
  app.post("/interventi", async (req, reply) => {
    const { indirizzo, lat, lon, tipologia, note } = req.body as {
      indirizzo: string;
      lat?: number;
      lon?: number;
      tipologia?: string;
      note?: string;
    };

    const { rows } = await pool.query(
      `INSERT INTO interventi (indirizzo, lat, lon, tipologia, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [indirizzo, lat ?? null, lon ?? null, tipologia ?? null, note ?? null]
    );

    const intervento = rows[0];
    getIO().to("centrale").emit("nuovo_intervento", intervento);
    return reply.code(201).send(intervento);
  });

  // Assegnazione di un intervento a un mezzo/operatore: qui parte l'attivazione
  app.post("/interventi/:id/assegna", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { mezzoId, operatoreId } = req.body as { mezzoId: string; operatoreId: string };

    const operatore = await pool.query("SELECT * FROM operatori WHERE id = $1", [operatoreId]);
    if (operatore.rows.length === 0) {
      return reply.code(404).send({ errore: "Operatore non trovato" });
    }

    const intervento = await pool.query(
      `UPDATE interventi SET mezzo_id = $1, stato = 'assegnato', ora_assegnazione = now()
       WHERE id = $2 RETURNING *`,
      [mezzoId, id]
    );
    if (intervento.rows.length === 0) {
      return reply.code(404).send({ errore: "Intervento non trovato" });
    }

    await pool.query("UPDATE mezzi SET stato = 'impegnato' WHERE id = $1", [mezzoId]);

    const notifica = await pool.query(
      `INSERT INTO notifiche_attivazione (intervento_id, operatore_id) VALUES ($1, $2) RETURNING *`,
      [id, operatoreId]
    );

    // 1. Notifica in tempo reale a tutte le dashboard aperte
    getIO().to("centrale").emit("intervento_assegnato", intervento.rows[0]);

    // 2. Push critica al telefono del soccorritore assegnato
    const pushToken = operatore.rows[0].push_token;
    if (pushToken) {
      try {
        await inviaNotificaAttivazione(pushToken, {
          interventoId: id,
          indirizzo: intervento.rows[0].indirizzo,
          tipologia: intervento.rows[0].tipologia,
        });
      } catch (err) {
        console.error("[attivazione] invio push fallito:", err);
        await pool.query(
          "UPDATE notifiche_attivazione SET esito = 'fallita' WHERE id = $1",
          [notifica.rows[0].id]
        );
        getIO().to("centrale").emit("attivazione_fallita", { interventoId: id, operatoreId });
      }
    } else {
      console.warn(`[attivazione] operatore ${operatoreId} senza push_token registrato`);
    }

    // 3. Timer di fallback: se dopo TIMEOUT_SECONDI non c'è conferma, avvisa la centrale
    setTimeout(async () => {
      const check = await pool.query(
        "SELECT confermata_il FROM notifiche_attivazione WHERE id = $1",
        [notifica.rows[0].id]
      );
      if (check.rows.length && !check.rows[0].confermata_il) {
        await pool.query(
          "UPDATE notifiche_attivazione SET esito = 'timeout' WHERE id = $1",
          [notifica.rows[0].id]
        );
        // Fallback: la centrale deve intervenire manualmente (richiamare, riassegnare)
        getIO().to("centrale").emit("attivazione_senza_risposta", {
          interventoId: id,
          operatoreId,
          mezzoId,
        });
      }
    }, TIMEOUT_SECONDI * 1000);

    return intervento.rows[0];
  });

  // Conferma di ricezione da parte dell'app mobile del soccorritore
  app.post("/interventi/:id/conferma", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { operatoreId } = req.body as { operatoreId: string };

    await pool.query(
      `UPDATE notifiche_attivazione SET confermata_il = now(), esito = 'confermata'
       WHERE intervento_id = $1 AND operatore_id = $2`,
      [id, operatoreId]
    );

    const { rows } = await pool.query(
      "UPDATE interventi SET ora_presa_in_carico = now(), stato = 'in_corso' WHERE id = $1 RETURNING *",
      [id]
    );

    getIO().to("centrale").emit("intervento_confermato", rows[0]);
    return rows[0];
  });

  // Chiusura intervento (arrivo/rientro)
  app.post("/interventi/:id/chiudi", async (req, reply) => {
    const { id } = req.params as { id: string };

    const { rows } = await pool.query(
      `UPDATE interventi SET stato = 'concluso', ora_rientro = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    if (rows.length === 0) return reply.code(404).send({ errore: "Intervento non trovato" });

    if (rows[0].mezzo_id) {
      await pool.query("UPDATE mezzi SET stato = 'disponibile' WHERE id = $1", [rows[0].mezzo_id]);
    }

    getIO().to("centrale").emit("intervento_concluso", rows[0]);
    return rows[0];
  });
}
