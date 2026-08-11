import { Server } from "socket.io";
import type { FastifyInstance } from "fastify";

let io: Server;

export function setupSocket(app: FastifyInstance) {
  io = new Server(app.server, {
    cors: { origin: "*" }, // in produzione: restringere all'origine della dashboard
  });

  io.on("connection", (socket) => {
    console.log(`[socket] client connesso: ${socket.id}`);

    // Il client (dashboard, app operatore o pagina web del mezzo) dichiara
    // che ruolo ha, per poterlo targetizzare in modo specifico.
    // - centrale: riceve tutti gli eventi generali (nuovo intervento, stato mezzi, ecc.)
    // - mezzo: si registra nella stanza "mezzo:<id>" e riceve SOLO le attivazioni
    //   destinate al mezzo che ha selezionato dalla lista
    // - operatore (uso legacy/app nativa): stanza "operatore:<id>"
    socket.on("registra", (info: { ruolo: "centrale" | "mezzo" | "operatore"; id?: string }) => {
      socket.join(info.ruolo);
      if (info.id) socket.join(`${info.ruolo}:${info.id}`);
      console.log(`[socket] ${socket.id} registrato come ${info.ruolo}${info.id ? " " + info.id : ""}`);
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
