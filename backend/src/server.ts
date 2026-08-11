import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { setupSocket } from "./ws/socket.js";
import { mezziRoutes } from "./routes/mezzi.js";
import { interventiRoutes } from "./routes/interventi.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: "*" }); // in produzione: restringere

app.get("/health", async () => ({ ok: true }));

await app.register(mezziRoutes);
await app.register(interventiRoutes);

setupSocket(app);

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).then(() => {
  console.log(`Backend ePCR in ascolto su http://localhost:${port}`);
});
