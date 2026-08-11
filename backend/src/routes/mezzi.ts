import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { getIO } from "../ws/socket.js";

export async function mezziRoutes(app: FastifyInstance) {
  app.get("/mezzi", async () => {
    const { rows } = await pool.query("SELECT * FROM mezzi ORDER BY nome");
    return rows;
  });
  app.post("/mezzi", async (req, reply) => {
    const { nome, targa } = req.body as { nome:string; targa?:string };
    const { rows } = await pool.query("INSERT INTO mezzi (nome,targa) VALUES ($1,$2) RETURNING *", [nome,targa??null]);
    return reply.code(201).send(rows[0]);
  });
  app.post("/mezzi/:id/posizione", async (req, reply) => {
    const { id } = req.params as { id:string };
    const { lat, lon } = req.body as { lat:number; lon:number };
    const { rows } = await pool.query("UPDATE mezzi SET lat=$1,lon=$2,ultimo_aggiornamento_gps=now() WHERE id=$3 RETURNING *", [lat,lon,id]);
    if (!rows.length) return reply.code(404).send({errore:"Mezzo non trovato"});
    getIO().to("centrale").emit("posizione_mezzo", rows[0]);
    return rows[0];
  });
  app.patch("/mezzi/:id/posizione", async (req, reply) => {
    const { id } = req.params as { id:string };
    const { lat, lon } = req.body as { lat:number; lon:number };
    const { rows } = await pool.query("UPDATE mezzi SET lat=$1,lon=$2,ultimo_aggiornamento_gps=now() WHERE id=$3 RETURNING *", [lat,lon,id]);
    if (!rows.length) return reply.code(404).send({errore:"Mezzo non trovato"});
    getIO().to("centrale").emit("posizione_mezzo", rows[0]);
    return rows[0];
  });
  app.patch("/mezzi/:id/flag", async (req, reply) => {
    const { id } = req.params as { id:string };
    const { colore } = req.body as { colore:string };
    if (!["verde","giallo","rosso"].includes(colore)) return reply.code(400).send({errore:"Colore non valido"});
    const { rows } = await pool.query("UPDATE mezzi SET flag_colore=$1 WHERE id=$2 RETURNING *", [colore,id]);
    if (!rows.length) return reply.code(404).send({errore:"Mezzo non trovato"});
    getIO().to("centrale").emit("stato_mezzo", rows[0]);
    return rows[0];
  });
  app.patch("/operatori/:id/push-token", async (req, reply) => {
    const { id } = req.params as { id:string };
    const { pushToken } = req.body as { pushToken:string };
    const { rows } = await pool.query("UPDATE operatori SET push_token=$1 WHERE id=$2 RETURNING id", [pushToken,id]);
    if (!rows.length) return reply.code(404).send({errore:"Operatore non trovato"});
    return { ok:true };
  });

  app.patch("/mezzi/:id/stato", async (req, reply) => {
    const { id } = req.params as { id:string };
    const { stato } = req.body as { stato:string };
    if (!["disponibile","impegnato","fuori_servizio"].includes(stato)) return reply.code(400).send({errore:"Stato non valido"});
    const { rows } = await pool.query("UPDATE mezzi SET stato=$1 WHERE id=$2 RETURNING *", [stato,id]);
    if (!rows.length) return reply.code(404).send({errore:"Mezzo non trovato"});
    getIO().to("centrale").emit("stato_mezzo", rows[0]);
    return rows[0];
  });
}
