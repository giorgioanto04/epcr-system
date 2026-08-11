import { Server } from "socket.io";
import type { FastifyInstance } from "fastify";

let io: Server;

export function setupSocket(app: FastifyInstance) {
  io = new Server(app.server, {
    cors: { origin: "*" }, // in produzione: restringere all'origine della dashboard
  });

  io.on("connection", (socket) => {
    console.log(`[socket] client connesso: ${socket.id}`);

    // Il client (dashboard o app) dichiara che ruolo ha, per poterlo
    // eventualmente filtrare/targetizzare in futuro
    socket.on("registra", (info: { ruolo: "centrale" | "mezzo"; id?: string }) => {
      socket.join(info.ruolo);
      if (info.id) socket.join(`operatore:${info.id}`);
    });

    socket.on("disconnect", () => {
      console.log(`[socket] client disconnesso: ${socket.id}`);
    });
  });

  return io;
}

export function getIO() {
  if (!io) throw new Error("Socket.IO non ancora inizializzato");
  return io;
}
