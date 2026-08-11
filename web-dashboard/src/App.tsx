import { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import { io, Socket } from "socket.io-client";

const API_URL = "https://epcr-system.onrender.com";

interface Mezzo {
  id: string;
  nome: string;
  stato: "disponibile" | "impegnato" | "fuori_servizio";
  lat: number | null;
  lon: number | null;
}

interface Intervento {
  id: string;
  indirizzo: string;
  stato: string;
  tipologia?: string;
  creato_il: string;
}

const COLORE_STATO: Record<string, string> = {
  disponibile: "#2e7d32",
  impegnato: "#c62828",
  fuori_servizio: "#757575",
};

export default function App() {
  const [mezzi, setMezzi] = useState<Mezzo[]>([]);
  const [interventi, setInterventi] = useState<Intervento[]>([]);
  const [allarme, setAllarme] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/mezzi`).then((r) => r.json()).then(setMezzi);
    fetch(`${API_URL}/interventi`).then((r) => r.json()).then(setInterventi);

    const socket: Socket = io(API_URL);
    socket.emit("registra", { ruolo: "centrale" });

    socket.on("posizione_mezzo", (mezzo: Mezzo) => {
      setMezzi((prev) => prev.map((m) => (m.id === mezzo.id ? mezzo : m)));
    });

    socket.on("stato_mezzo", (mezzo: Mezzo) => {
      setMezzi((prev) => prev.map((m) => (m.id === mezzo.id ? mezzo : m)));
    });

    socket.on("nuovo_intervento", (intervento: Intervento) => {
      setInterventi((prev) => [intervento, ...prev]);
    });

    socket.on("intervento_assegnato", (intervento: Intervento) => {
      setInterventi((prev) => prev.map((i) => (i.id === intervento.id ? intervento : i)));
    });

    socket.on("attivazione_senza_risposta", (payload: { interventoId: string }) => {
      setAllarme(
        `Nessuna conferma dal soccorritore per l'intervento ${payload.interventoId}. Intervieni manualmente.`
      );
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ width: "60%", height: "100%" }}>
        <MapContainer center={[45.4642, 9.19]} zoom={12} style={{ height: "100%" }}>
          <TileLayer
            attribution='&copy; OpenStreetMap contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {mezzi
            .filter((m) => m.lat && m.lon)
            .map((m) => (
              <Marker key={m.id} position={[m.lat!, m.lon!]}>
                <Popup>
                  <strong>{m.nome}</strong>
                  <br />
                  Stato: <span style={{ color: COLORE_STATO[m.stato] }}>{m.stato}</span>
                </Popup>
              </Marker>
            ))}
        </MapContainer>
      </div>

      <div style={{ width: "40%", padding: 16, overflowY: "auto" }}>
        <h2>Centrale Operativa</h2>

        {allarme && (
          <div style={{ background: "#ffcdd2", padding: 12, borderRadius: 6, marginBottom: 16 }}>
            ⚠️ {allarme}
          </div>
        )}

        <h3>Mezzi</h3>
        <ul>
          {mezzi.map((m) => (
            <li key={m.id}>
              {m.nome} — <span style={{ color: COLORE_STATO[m.stato] }}>{m.stato}</span>
            </li>
          ))}
        </ul>

        <h3>Interventi</h3>
        <ul>
          {interventi.map((i) => (
            <li key={i.id}>
              <strong>{i.indirizzo}</strong> — {i.stato}
              <br />
              <small>{new Date(i.creato_il).toLocaleString("it-IT")}</small>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
