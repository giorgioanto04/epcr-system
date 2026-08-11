import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { setupSocket } from "./ws/socket.js";
import { mezziRoutes } from "./routes/mezzi.js";
import { interventiRoutes } from "./routes/interventi.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: "*" }); // in produzione: restringere

app.get("/health", async () => ({ ok: true }));

app.patch("/operatori/:id/push-token", async (req, reply) => {
  const { id } = req.params as { id: string };
  const { pushToken } = req.body as { pushToken?: string };
  if (!pushToken) return reply.code(400).send({ errore: "pushToken obbligatorio" });
  const { rows } = await (await import("./db/pool.js")).pool.query(
    "UPDATE operatori SET push_token=$1 WHERE id=$2 RETURNING id",
    [pushToken, id]
  );
  if (!rows.length) return reply.code(404).send({ errore: "Operatore non trovato" });
  return { ok: true };
});

await app.register(mezziRoutes);
await app.register(interventiRoutes);

setupSocket(app);

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).then(() => {
  console.log(`Backend IRIS v2 in ascolto su http://localhost:${port}`);
});
