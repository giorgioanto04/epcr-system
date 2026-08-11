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
  mezzo_id?: string | null;
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

  const [nomeMezzo, setNomeMezzo] = useState("");

  const [indirizzo, setIndirizzo] = useState("");
  const [tipologia, setTipologia] = useState("");

  const [mezzoScelto, setMezzoScelto] = useState<Record<string, string>>({});

  function ricarica() {
    fetch(`${API_URL}/mezzi`).then((r) => r.json()).then(setMezzi);
    fetch(`${API_URL}/interventi`).then((r) => r.json()).then(setInterventi);
  }

  useEffect(() => {
    ricarica();

    const socket: Socket = io(API_URL);
    socket.emit("registra", { ruolo: "centrale" });

    socket.on("posizione_mezzo", (mezzo: Mezzo) =>
      setMezzi((prev) => prev.map((m) => (m.id === mezzo.id ? mezzo : m)))
    );
    socket.on("stato_mezzo", (mezzo: Mezzo) =>
      setMezzi((prev) => prev.map((m) => (m.id === mezzo.id ? mezzo : m)))
    );
    socket.on("nuovo_intervento", (i: Intervento) =>
      setInterventi((prev) => [i, ...prev])
    );
    socket.on("intervento_assegnato", (i: Intervento) =>
      setInterventi((prev) => prev.map((x) => (x.id === i.id ? i : x)))
    );
    socket.on("intervento_confermato", (i: Intervento) =>
      setInterventi((prev) => prev.map((x) => (x.id === i.id ? i : x)))
    );
    socket.on("intervento_concluso", (i: Intervento) =>
      setInterventi((prev) => prev.map((x) => (x.id === i.id ? i : x)))
    );
    socket.on("attivazione_senza_risposta", (payload: { interventoId: string }) => {
      setAllarme(
        `Nessuna conferma dal soccorritore per l'intervento ${payload.interventoId}. Intervieni manualmente.`
      );
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  async function creaMezzo(e: React.FormEvent) {
    e.preventDefault();
    if (!nomeMezzo.trim()) return;
    await fetch(`${API_URL}/mezzi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: nomeMezzo }),
    });
    setNomeMezzo("");
    ricarica();
  }

  async function creaIntervento(e: React.FormEvent) {
    e.preventDefault();
    if (!indirizzo.trim()) return;
    await fetch(`${API_URL}/interventi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ indirizzo, tipologia }),
    });
    setIndirizzo("");
    setTipologia("");
    ricarica();
  }

  async function assegna(interventoId: string) {
    const mezzoId = mezzoScelto[interventoId];
    if (!mezzoId) {
      alert("Scegli prima un mezzo dal menu a tendina");
      return;
    }
    const operatoreId = prompt(
      "ID operatore da attivare (in un secondo momento sarà scelto automaticamente in base al turno):"
    );
    if (!operatoreId) return;

    await fetch(`${API_URL}/interventi/${interventoId}/assegna`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mezzoId, operatoreId }),
    });
    ricarica();
  }

  async function chiudi(interventoId: string) {
    await fetch(`${API_URL}/interventi/${interventoId}/chiudi`, { method: "POST" });
    ricarica();
  }

  const mezziDisponibili = mezzi.filter((m) => m.stato === "disponibile");

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ width: "55%", height: "100%" }}>
        <MapContainer center={[45.4642, 9.19]} zoom={12} style={{ height: "100%" }}>
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
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

      <div style={{ width: "45%", padding: 16, overflowY: "auto" }}>
        <h2>Centrale Operativa</h2>

        {allarme && (
          <div style={{ background: "#ffcdd2", padding: 12, borderRadius: 6, marginBottom: 16 }}>
            ⚠️ {allarme}
          </div>
        )}

        <section style={{ marginBottom: 24, padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
          <h3>Nuovo mezzo</h3>
          <form onSubmit={creaMezzo} style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="Nome mezzo (es. Ambulanza 1)"
              value={nomeMezzo}
              onChange={(e) => setNomeMezzo(e.target.value)}
              style={{ flex: 1, padding: 6 }}
            />
            <button type="submit">Aggiungi</button>
          </form>
        </section>

        <section style={{ marginBottom: 24, padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
          <h3>Nuovo intervento</h3>
          <form onSubmit={creaIntervento} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              placeholder="Indirizzo"
              value={indirizzo}
              onChange={(e) => setIndirizzo(e.target.value)}
              style={{ padding: 6 }}
            />
            <input
              placeholder="Tipologia (es. codice rosso)"
              value={tipologia}
              onChange={(e) => setTipologia(e.target.value)}
              style={{ padding: 6 }}
            />
            <button type="submit" style={{ background: "#c62828", color: "white", padding: 8, border: "none", borderRadius: 4 }}>
              Crea attivazione
            </button>
          </form>
        </section>

        <h3>Mezzi ({mezzi.length})</h3>
        <ul>
          {mezzi.map((m) => (
            <li key={m.id}>
              {m.nome} — <span style={{ color: COLORE_STATO[m.stato] }}>{m.stato}</span>
            </li>
          ))}
        </ul>

        <h3>Interventi</h3>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {interventi.map((i) => (
            <li key={i.id} style={{ marginBottom: 12, padding: 8, border: "1px solid #eee", borderRadius: 6 }}>
              <strong>{i.indirizzo}</strong> — {i.stato}
              <br />
              <small>{new Date(i.creato_il).toLocaleString("it-IT")}</small>

              {i.stato === "in_attesa" && (
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <select
                    value={mezzoScelto[i.id] ?? ""}
                    onChange={(e) => setMezzoScelto((prev) => ({ ...prev, [i.id]: e.target.value }))}
                  >
                    <option value="">Scegli mezzo...</option>
                    {mezziDisponibili.map((m) => (
                      <option key={m.id} value={m.id}>{m.nome}</option>
                    ))}
                  </select>
                  <button onClick={() => assegna(i.id)}>Assegna e attiva</button>
                </div>
              )}

              {(i.stato === "assegnato" || i.stato === "in_corso") && (
                <div style={{ marginTop: 8 }}>
                  <button onClick={() => chiudi(i.id)}>Chiudi intervento</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
