import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { getIO } from "../ws/socket.js";

const TIPI = new Set(["squadra", "intervento", "posto_comando", "punto_raccolta", "altro"]);

export async function poiRoutes(app: FastifyInstance) {
  app.get("/poi", async () => {
    const { rows } = await pool.query("SELECT * FROM punti_interesse ORDER BY creato_il DESC");
    return rows;
  });

  app.post("/poi", async (req, reply) => {
    const b = req.body as { tipo?: string; etichetta: string; note?: string; lat: number; lon: number };
    if (!b.etichetta?.trim()) return reply.code(400).send({ errore: "Etichetta obbligatoria" });
    if (b.lat == null || b.lon == null) return reply.code(400).send({ errore: "Posizione obbligatoria" });
    const tipo = TIPI.has(b.tipo || "") ? b.tipo : "altro";
    const { rows } = await pool.query(
      `INSERT INTO punti_interesse(tipo,etichetta,note,lat,lon) VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [tipo, b.etichetta.trim(), b.note?.trim() || null, b.lat, b.lon]
    );
    getIO().to("centrale").emit("poi_creato", rows[0]);
    return reply.code(201).send(rows[0]);
  });

  app.patch("/poi/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { etichetta?: string; note?: string; lat?: number; lon?: number };
    const { rows } = await pool.query(
      `UPDATE punti_interesse SET etichetta=COALESCE($1,etichetta), note=$2, lat=COALESCE($3,lat), lon=COALESCE($4,lon) WHERE id=$5 RETURNING *`,
      [b.etichetta?.trim() || null, b.note?.trim() ?? null, b.lat ?? null, b.lon ?? null, id]
    );
    if (!rows.length) return reply.code(404).send({ errore: "Punto non trovato" });
    getIO().to("centrale").emit("poi_aggiornato", rows[0]);
    return rows[0];
  });

  app.delete("/poi/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { rows } = await pool.query("DELETE FROM punti_interesse WHERE id=$1 RETURNING id", [id]);
    if (!rows.length) return reply.code(404).send({ errore: "Punto non trovato" });
    getIO().to("centrale").emit("poi_eliminato", { id });
    return { ok: true };
  });
}
