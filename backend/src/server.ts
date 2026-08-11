import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { setupSocket } from "./ws/socket.js";
import { mezziRoutes } from "./routes/mezzi.js";
import { interventiRoutes } from "./routes/interventi.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
app.get("/health", async () => ({ ok:true, service:"IRIS v2" }));
await app.register(mezziRoutes);
await app.register(interventiRoutes);
setupSocket(app);
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host:"0.0.0.0" });
console.log(`IRIS v2 backend avviato sulla porta ${port}`);
