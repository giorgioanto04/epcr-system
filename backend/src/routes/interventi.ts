import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { getIO } from "../ws/socket.js";
import { inviaNotificaAttivazione } from "../ws/push.js";

const TIMEOUT_SECONDI = Number(process.env.ACTIVATION_TIMEOUT_SECONDS ?? 60);
const STATI = ["Attivazione", "Partenza", "Arrivo sul posto", "Paziente visto", "Partenza per ospedale", "Arrivo ospedale", "Libero in Ospedale", "Rientro", "Disponibile"] as const;

async function generaNumeroMissione() {
  const { rows } = await pool.query(
    `INSERT INTO mission_progressivi (giorno, progressivo)
     VALUES ((now() AT TIME ZONE 'Europe/Rome')::date, 1)
     ON CONFLICT (giorno) DO UPDATE SET progressivo = mission_progressivi.progressivo + 1
     RETURNING progressivo`
  );
  const d = await pool.query("SELECT to_char((now() AT TIME ZONE 'Europe/Rome')::date, 'YYYYMMDD') AS giorno");
  return `${d.rows[0].giorno}-${String(rows[0].progressivo).padStart(4, "0")}`;
}

export async function interventiRoutes(app: FastifyInstance) {
  app.get("/interventi", async (req) => {
    const { data } = req.query as { data?: string };
    const params: unknown[] = [];
    let sql = "SELECT * FROM interventi";
    if (data) {
      params.push(data);
      sql += ` WHERE creato_il >= $1::date AND creato_il < ($1::date + INTERVAL '1 day')`;
    }
    sql += " ORDER BY creato_il DESC LIMIT 500";
    const { rows } = await pool.query(sql, params);
    return rows;
  });

  app.get("/interventi/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const missione = await pool.query("SELECT * FROM interventi WHERE id = $1", [id]);
    if (!missione.rows.length) return reply.code(404).send({ errore: "Missione non trovata" });
    const mezzi = await pool.query(`SELECT m.* FROM mezzi m JOIN missione_mezzi mm ON mm.mezzo_id=m.id WHERE mm.intervento_id=$1 ORDER BY m.nome`, [id]);
    const eventi = await pool.query("SELECT * FROM eventi_missione WHERE intervento_id=$1 ORDER BY creato_il ASC", [id]);
    return { ...missione.rows[0], mezzi: mezzi.rows, eventi: eventi.rows };
  });

  app.post("/interventi", async (req, reply) => {
    const body = req.body as { indirizzo: string; lat?: number; lon?: number; tipologia?: string; note?: string; priorita?: string };
    if (!body.indirizzo?.trim()) return reply.code(400).send({ errore: "Indirizzo obbligatorio" });
    const numero = await generaNumeroMissione();
    const priorita = ["verde", "giallo", "rosso"].includes(body.priorita ?? "") ? body.priorita : "verde";
    const { rows } = await pool.query(
      `INSERT INTO interventi (numero_missione, indirizzo, lat, lon, tipologia, note, priorita, stato_operativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Attivazione') RETURNING *`,
      [numero, body.indirizzo, body.lat ?? null, body.lon ?? null, body.tipologia ?? null, body.note ?? null, priorita]
    );
    const intervento = rows[0];
    await pool.query("INSERT INTO eventi_missione (intervento_id, stato) VALUES ($1,'Attivazione')", [intervento.id]);
    getIO().to("centrale").emit("nuovo_intervento", intervento);
    return reply.code(201).send(intervento);
  });

  app.post("/interventi/:id/assegna", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { mezzoId?: string; mezzoIds?: string[]; operatoreId?: string };
    const mezzoIds = [...new Set([...(body.mezzoIds ?? []), ...(body.mezzoId ? [body.mezzoId] : [])])];
    if (!mezzoIds.length) return reply.code(400).send({ errore: "Seleziona almeno un mezzo" });

    const missione = await pool.query("SELECT * FROM interventi WHERE id=$1", [id]);
    if (!missione.rows.length) return reply.code(404).send({ errore: "Missione non trovata" });
    const m = missione.rows[0];
    const mezzi = await pool.query("SELECT * FROM mezzi WHERE id = ANY($1::uuid[])", [mezzoIds]);
    if (mezzi.rows.length !== mezzoIds.length) return reply.code(404).send({ errore: "Uno o più mezzi non esistono" });

    await pool.query("UPDATE interventi SET mezzo_id=$1, stato='assegnato', stato_operativo='Attivazione', ora_assegnazione=COALESCE(ora_assegnazione,now()) WHERE id=$2", [mezzoIds[0], id]);
    for (const mezzoId of mezzoIds) {
      await pool.query("INSERT INTO missione_mezzi (intervento_id, mezzo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, mezzoId]);
      await pool.query("UPDATE mezzi SET stato='impegnato', flag_colore=$1 WHERE id=$2", [m.priorita, mezzoId]);
      const notifica = await pool.query(`INSERT INTO notifiche_attivazione (intervento_id, operatore_id, mezzo_id) VALUES ($1,$2,$3) RETURNING *`, [id, body.operatoreId ?? null, mezzoId]);
      getIO().to(`mezzo:${mezzoId}`).emit("attivazione", { notificaId:notifica.rows[0].id, interventoId:id, mezzoId, numeroMissione:m.numero_missione, priorita:m.priorita, indirizzo:m.indirizzo, lat:m.lat, lon:m.lon, tipologia:m.tipologia, note:m.note });
    }
    const updated = await pool.query("SELECT * FROM interventi WHERE id=$1", [id]);
    getIO().to("centrale").emit("intervento_assegnato", updated.rows[0]);
    return updated.rows[0];
  });

  app.post("/interventi/:id/conferma-mezzo", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { mezzoId } = req.body as { mezzoId: string };
    if (!mezzoId) return reply.code(400).send({ errore: "mezzoId obbligatorio" });
    await pool.query(`UPDATE notifiche_attivazione SET confermata_il=now(), esito='confermata' WHERE intervento_id=$1 AND mezzo_id=$2`, [id, mezzoId]);
    const { rows } = await pool.query("UPDATE interventi SET ora_presa_in_carico=COALESCE(ora_presa_in_carico,now()), stato='in_corso' WHERE id=$1 RETURNING *", [id]);
    if (!rows.length) return reply.code(404).send({ errore:"Missione non trovata" });
    getIO().to("centrale").emit("intervento_confermato", rows[0]);
    return rows[0];
  });

  app.post("/interventi/:id/stato", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { stato, mezzoId, nota } = req.body as { stato: string; mezzoId?: string; nota?: string };
    if (!STATI.includes(stato as any)) return reply.code(400).send({ errore:"Stato non valido" });
    const fields: string[] = ["stato_operativo=$1"];
    const values: unknown[] = [stato];
    let n = 2;
    if (stato === "Attivazione") { fields.push(`stato='assegnato'`); }
    if (stato !== "Attivazione" && stato !== "Disponibile") fields.push(`stato='in_corso'`);
    if (stato === "Disponibile" || stato === "Rientro") fields.push(`stato='concluso'`);
    if (stato === "Partenza") fields.push(`ora_presa_in_carico=COALESCE(ora_presa_in_carico,now())`);
    if (stato === "Arrivo sul posto") fields.push(`ora_arrivo=now()`);
    if (stato === "Rientro" || stato === "Disponibile") fields.push(`ora_rientro=COALESCE(ora_rientro,now())`);
    values.push(id);
    const { rows } = await pool.query(`UPDATE interventi SET ${fields.join(", ")} WHERE id=$${n} RETURNING *`, values);
    if (!rows.length) return reply.code(404).send({ errore:"Missione non trovata" });
    await pool.query("INSERT INTO eventi_missione (intervento_id, mezzo_id, stato, nota) VALUES ($1,$2,$3,$4)", [id, mezzoId ?? rows[0].mezzo_id, stato, nota ?? null]);
    if (mezzoId && (stato === "Rientro" || stato === "Disponibile")) await pool.query("UPDATE mezzi SET stato='disponibile' WHERE id=$1", [mezzoId]);
    getIO().to("centrale").emit("stato_missione", { ...rows[0], mezzoId, stato_operativo:stato });
    if (mezzoId) getIO().to(`mezzo:${mezzoId}`).emit("stato_missione", { ...rows[0], stato_operativo:stato });
    return rows[0];
  });

  app.patch("/interventi/:id/scheda", async (req, reply) => {
    const { id } = req.params as { id: string };
    const scheda = req.body;
    const { rows } = await pool.query("UPDATE interventi SET scheda_missione=$1 WHERE id=$2 RETURNING *", [scheda, id]);
    if (!rows.length) return reply.code(404).send({ errore:"Missione non trovata" });
    getIO().to("centrale").emit("scheda_aggiornata", rows[0]);
    return rows[0];
  });

  app.post("/interventi/:id/conferma", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { operatoreId } = req.body as { operatoreId: string };
    await pool.query(`UPDATE notifiche_attivazione SET confermata_il=now(), esito='confermata' WHERE intervento_id=$1 AND operatore_id=$2`, [id, operatoreId]);
    const { rows } = await pool.query("UPDATE interventi SET ora_presa_in_carico=now(), stato='in_corso' WHERE id=$1 RETURNING *", [id]);
    getIO().to("centrale").emit("intervento_confermato", rows[0]);
    return rows[0];
  });

  app.post("/interventi/:id/chiudi", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await pool.query("UPDATE interventi SET stato='concluso', stato_operativo='Disponibile', ora_rientro=now() WHERE id=$1 RETURNING *", [id]);
    if (!rows.length) return reply.code(404).send({ errore:"Intervento non trovato" });
    await pool.query("UPDATE mezzi SET stato='disponibile' WHERE id IN (SELECT mezzo_id FROM missione_mezzi WHERE intervento_id=$1)", [id]);
    await pool.query("INSERT INTO eventi_missione (intervento_id, stato) VALUES ($1,'Disponibile')", [id]);
    getIO().to("centrale").emit("intervento_concluso", rows[0]);
    return rows[0];
  });
}
