import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { getIO } from "../ws/socket.js";

const STATI = new Set(["disponibile", "impegnato", "fuori_servizio"]);

export async function mezziRoutes(app: FastifyInstance) {
  app.get("/mezzi", async () => {
    const { rows } = await pool.query(`
      SELECT m.*, i.missione_numero AS missione_numero, i.id AS intervento_id,
        (SELECT s.stato FROM stati_intervento s
          WHERE s.intervento_id = i.id AND s.mezzo_id = m.id
          ORDER BY s.registrato_il DESC LIMIT 1) AS ultimo_stato
      FROM mezzi m
      LEFT JOIN LATERAL (
        SELECT im.intervento_id
        FROM intervento_mezzi im
        JOIN interventi ia ON ia.id=im.intervento_id
        WHERE im.mezzo_id=m.id AND ia.stato NOT IN ('concluso','annullato')
        ORDER BY ia.creato_il DESC LIMIT 1
      ) im ON true
      LEFT JOIN interventi i ON i.id = im.intervento_id
      ORDER BY m.nome, m.id
    `);
    // Un mezzo è riassegnabile a una nuova missione solo se libero, oppure se
    // sulla missione attiva corrente è già in rientro / libero in ospedale / disponibile.
    return rows.map(r => ({
      ...r,
      assegnabile: !r.intervento_id || ["rientro", "libero_in_ospedale", "disponibile"].includes(r.ultimo_stato),
    }));
  });

  app.post("/mezzi", async (req, reply) => {
    const { nome, targa } = req.body as { nome: string; targa?: string };
    if (!nome?.trim()) return reply.code(400).send({ errore: "Nome obbligatorio" });
    const duplicato = await pool.query(
      `SELECT id FROM mezzi WHERE lower(trim(nome))=lower(trim($1)) AND COALESCE(lower(trim(targa)), '')=COALESCE(lower(trim($2)), '') LIMIT 1`,
      [nome.trim(), targa?.trim() || null]
    );
    if (duplicato.rows.length) return reply.code(409).send({ errore: "Esiste già un mezzo con lo stesso nome e la stessa targa" });
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
