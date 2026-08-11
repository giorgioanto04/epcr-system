import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { getIO } from "../ws/socket.js";

export async function mezziRoutes(app: FastifyInstance) {
  // Elenco mezzi con stato e posizione corrente
  app.get("/mezzi", async () => {
    const { rows } = await pool.query("SELECT * FROM mezzi ORDER BY nome");
    return rows;
  });

  // Creazione nuovo mezzo
  app.post("/mezzi", async (req, reply) => {
    const { nome, targa } = req.body as { nome: string; targa?: string };
    const { rows } = await pool.query(
      "INSERT INTO mezzi (nome, targa) VALUES ($1, $2) RETURNING *",
      [nome, targa ?? null]
    );
    return reply.code(201).send(rows[0]);
  });

  // Aggiornamento posizione GPS (chiamato periodicamente dall'app mobile)
  app.post("/mezzi/:id/posizione", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { lat, lon } = req.body as { lat: number; lon: number };

    const { rows } = await pool.query(
      `UPDATE mezzi SET lat = $1, lon = $2, ultimo_aggiornamento_gps = now()
       WHERE id = $3 RETURNING *`,
      [lat, lon, id]
    );

    if (rows.length === 0) return reply.code(404).send({ errore: "Mezzo non trovato" });

    // Notifica la centrale in tempo reale del nuovo punto GPS
    getIO().to("centrale").emit("posizione_mezzo", rows[0]);

    return rows[0];
  });

  // Cambio stato manuale (es. fuori servizio)
  app.patch("/mezzi/:id/stato", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { stato } = req.body as { stato: string };

    const { rows } = await pool.query(
      "UPDATE mezzi SET stato = $1 WHERE id = $2 RETURNING *",
      [stato, id]
    );

    if (rows.length === 0) return reply.code(404).send({ errore: "Mezzo non trovato" });

    getIO().to("centrale").emit("stato_mezzo", rows[0]);
    return rows[0];
  });
}
