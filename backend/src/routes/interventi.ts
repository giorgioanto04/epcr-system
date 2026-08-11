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

  // Assegnazione di un intervento a un mezzo: qui parte l'attivazione.
  // operatoreId è opzionale: se il mezzo non ha un operatore con account/app nativa,
  // l'attivazione arriva comunque in tempo reale alla pagina web del mezzo
  // (che si è registrata sulla stanza "mezzo:<mezzoId>").
  app.post("/interventi/:id/assegna", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { mezzoId, operatoreId } = req.body as { mezzoId: string; operatoreId?: string };

    if (!mezzoId) {
      return reply.code(400).send({ errore: "mezzoId obbligatorio" });
    }

    const mezzo = await pool.query("SELECT * FROM mezzi WHERE id = $1", [mezzoId]);
    if (mezzo.rows.length === 0) {
      return reply.code(404).send({ errore: "Mezzo non trovato" });
    }

    let operatore = null;
    if (operatoreId) {
      const res = await pool.query("SELECT * FROM operatori WHERE id = $1", [operatoreId]);
      if (res.rows.length === 0) {
        return reply.code(404).send({ errore: "Operatore non trovato" });
      }
      operatore = res.rows[0];
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
      `INSERT INTO notifiche_attivazione (intervento_id, operatore_id, mezzo_id)
       VALUES ($1, $2, $3) RETURNING *`,
      [id, operatoreId ?? null, mezzoId]
    );

    // 1. Notifica in tempo reale a tutte le dashboard aperte
    getIO().to("centrale").emit("intervento_assegnato", intervento.rows[0]);

    // 2. Notifica in tempo reale alla pagina web del mezzo selezionato (schermo di attivazione)
    getIO().to(`mezzo:${mezzoId}`).emit("attivazione", {
      notificaId: notifica.rows[0].id,
      interventoId: id,
      mezzoId,
      indirizzo: intervento.rows[0].indirizzo,
      lat: intervento.rows[0].lat,
      lon: intervento.rows[0].lon,
      tipologia: intervento.rows[0].tipologia,
      note: intervento.rows[0].note,
    });

    // 3. (Opzionale) push critica al telefono dell'operatore con app nativa/account
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

    // 4. Timer di fallback: se dopo TIMEOUT_SECONDI non c'è conferma, avvisa la centrale
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

  // Conferma di ricezione da parte dell'app mobile del soccorritore (account operatore)
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

  // Conferma di ricezione da parte della pagina web del mezzo (nessun account/login,
  // solo selezione del mezzo dalla lista)
  app.post("/interventi/:id/conferma-mezzo", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { mezzoId } = req.body as { mezzoId: string };

    if (!mezzoId) {
      return reply.code(400).send({ errore: "mezzoId obbligatorio" });
    }

    await pool.query(
      `UPDATE notifiche_attivazione SET confermata_il = now(), esito = 'confermata'
       WHERE intervento_id = $1 AND mezzo_id = $2`,
      [id, mezzoId]
    );

    const { rows } = await pool.query(
      "UPDATE interventi SET ora_presa_in_carico = now(), stato = 'in_corso' WHERE id = $1 RETURNING *",
      [id]
    );
    if (rows.length === 0) return reply.code(404).send({ errore: "Intervento non trovato" });

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
