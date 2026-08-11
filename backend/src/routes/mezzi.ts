import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { getIO } from "../ws/socket.js";

const STATI = new Set(["disponibile", "impegnato", "fuori_servizio"]);

export async function mezziRoutes(app: FastifyInstance) {
  app.get("/mezzi", async () => {
    const { rows } = await pool.query(`
      SELECT m.*, i.missione_numero AS missione_numero, i.id AS intervento_id
      FROM mezzi m
      LEFT JOIN intervento_mezzi im ON im.mezzo_id = m.id
      LEFT JOIN interventi i ON i.id = im.intervento_id AND i.stato NOT IN ('concluso','annullato')
      ORDER BY m.nome
    `);
    return rows;
  });

  app.post("/mezzi", async (req, reply) => {
    const { nome, targa } = req.body as { nome: string; targa?: string };
    if (!nome?.trim()) return reply.code(400).send({ errore: "Nome obbligatorio" });
    const { rows } = await pool.query(
      "INSERT INTO mezzi (nome, targa) VALUES ($1, $2) RETURNING *",
      [nome.trim(), targa?.trim() || null]
    );
    getIO().to("centrale").emit("mezzo_creato", rows[0]);
    return reply.code(201).send(rows[0]);
  });

  app.patch("/mezzi/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { nome, targa } = req.body as { nome?: string; targa?: string };
    const { rows } = await pool.query(
      `UPDATE mezzi SET nome = COALESCE($1,nome), targa = $2 WHERE id=$3 RETURNING *`,
      [nome?.trim() || null, targa?.trim() || null, id]
    );
    if (!rows.length) return reply.code(404).send({ errore: "Mezzo non trovato" });
    getIO().to("centrale").emit("mezzo_aggiornato", rows[0]);
    return rows[0];
  });

  app.delete("/mezzi/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const active = await pool.query(`SELECT 1 FROM intervento_mezzi im JOIN interventi i ON i.id=im.intervento_id WHERE im.mezzo_id=$1 AND i.stato NOT IN ('concluso','annullato') LIMIT 1`, [id]);
    if (active.rows.length) return reply.code(409).send({ errore: "Il mezzo è associato a una missione attiva" });
    await pool.query("DELETE FROM notifiche_attivazione WHERE mezzo_id=$1", [id]);
    await pool.query("DELETE FROM stati_intervento WHERE mezzo_id=$1", [id]);
    await pool.query("DELETE FROM intervento_mezzi WHERE mezzo_id=$1", [id]);
    const { rows } = await pool.query("DELETE FROM mezzi WHERE id=$1 RETURNING *", [id]);
    if (!rows.length) return reply.code(404).send({ errore: "Mezzo non trovato" });
    getIO().to("centrale").emit("mezzo_eliminato", { id });
    return { ok: true };
  });

  app.post("/mezzi/:id/posizione", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { lat, lon } = req.body as { lat: number; lon: number };
    const { rows } = await pool.query(
      `UPDATE mezzi SET lat=$1, lon=$2, ultimo_aggiornamento_gps=now() WHERE id=$3 RETURNING *`,
      [lat, lon, id]
    );
    if (!rows.length) return reply.code(404).send({ errore: "Mezzo non trovato" });
    getIO().to("centrale").emit("posizione_mezzo", rows[0]);
    return rows[0];
  });

  app.patch("/mezzi/:id/stato", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { stato } = req.body as { stato: string };
    if (!STATI.has(stato)) return reply.code(400).send({ errore: "Stato non valido" });
    const { rows } = await pool.query("UPDATE mezzi SET stato=$1 WHERE id=$2 RETURNING *", [stato,id]);
    if (!rows.length) return reply.code(404).send({ errore: "Mezzo non trovato" });
    getIO().to("centrale").emit("stato_mezzo", rows[0]);
    return rows[0];
  });
}
