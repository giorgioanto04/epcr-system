import { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import { io, Socket } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

interface Mezzo {
  id: string;
  nome: string;
  targa?: string;
  stato: "disponibile" | "impegnato" | "fuori_servizio";
  lat: number | null;
  lon: number | null;
}

interface Intervento {
  id: string;
  indirizzo: string;
  lat?: number | null;
  lon?: number | null;
  tipologia?: string;
  note?: string;
  stato: string;
  mezzo_id?: string | null;
  creato_il: string;
}

const COLORE_STATO: Record<string, string> = {
  disponibile: "#2e7d32",
  impegnato: "#c62828",
  fuori_servizio: "#757575",
};

const ETICHETTA_STATO_INTERVENTO: Record<string, string> = {
  in_attesa: "In attesa di assegnazione",
  assegnato: "Assegnato (in attesa di conferma)",
  in_corso: "In corso",
  concluso: "Concluso",
  annullato: "Annullato",
};

export default function App() {
  const [mezzi, setMezzi] = useState<Mezzo[]>([]);
  const [interventi, setInterventi] = useState<Intervento[]>([]);
  const [allarme, setAllarme] = useState<string | null>(null);
  const [errore, setErrore] = useState<string | null>(null);

  // form nuovo intervento
  const [indirizzo, setIndirizzo] = useState("");
  const [tipologia, setTipologia] = useState("");
  const [note, setNote] = useState("");

  // form nuovo mezzo
  const [nomeMezzo, setNomeMezzo] = useState("");
  const [targaMezzo, setTargaMezzo] = useState("");

  function ricaricaMezzi() {
    fetch(`${API_URL}/mezzi`).then((r) => r.json()).then(setMezzi);
  }
  function ricaricaInterventi() {
    fetch(`${API_URL}/interventi`).then((r) => r.json()).then(setInterventi);
  }

  useEffect(() => {
    ricaricaMezzi();
    ricaricaInterventi();

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
      ricaricaMezzi(); // il mezzo assegnato passa a "impegnato"
    });

    socket.on("intervento_confermato", (intervento: Intervento) => {
      setInterventi((prev) => prev.map((i) => (i.id === intervento.id ? intervento : i)));
    });

    socket.on("intervento_concluso", (intervento: Intervento) => {
      setInterventi((prev) => prev.map((i) => (i.id === intervento.id ? intervento : i)));
      ricaricaMezzi();
    });

    socket.on("attivazione_senza_risposta", (payload: { interventoId: string }) => {
      setAllarme(
        `Nessuna conferma dal mezzo per l'intervento ${payload.interventoId}. Intervieni manualmente (richiama o riassegna).`
      );
    });

    socket.on("attivazione_fallita", (payload: { interventoId: string }) => {
      setAllarme(`Invio della notifica push fallito per l'intervento ${payload.interventoId}.`);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  async function creaIntervento(e: React.FormEvent) {
    e.preventDefault();
    setErrore(null);
    if (!indirizzo.trim()) return;

    try {
      const res = await fetch(`${API_URL}/interventi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ indirizzo, tipologia: tipologia || undefined, note: note || undefined }),
      });
      if (!res.ok) throw new Error("Creazione intervento fallita");
      setIndirizzo("");
      setTipologia("");
      setNote("");
      ricaricaInterventi();
    } catch (err) {
      setErrore("Impossibile creare l'intervento. Controlla la connessione al backend.");
    }
  }

  async function assegnaIntervento(interventoId: string, mezzoId: string) {
    setErrore(null);
    if (!mezzoId) return;
    try {
      const res = await fetch(`${API_URL}/interventi/${interventoId}/assegna`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mezzoId }),
      });
      if (!res.ok) {
        const dati = await res.json().catch(() => ({}));
        throw new Error(dati.errore || "Assegnazione fallita");
      }
      ricaricaInterventi();
      ricaricaMezzi();
    } catch (err: any) {
      setErrore(err.message || "Errore durante l'assegnazione.");
    }
  }

  async function chiudiIntervento(interventoId: string) {
    setErrore(null);
    try {
      await fetch(`${API_URL}/interventi/${interventoId}/chiudi`, { method: "POST" });
      ricaricaInterventi();
      ricaricaMezzi();
    } catch {
      setErrore("Errore durante la chiusura dell'intervento.");
    }
  }

  async function creaMezzo(e: React.FormEvent) {
    e.preventDefault();
    setErrore(null);
    if (!nomeMezzo.trim()) return;
    try {
      const res = await fetch(`${API_URL}/mezzi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: nomeMezzo, targa: targaMezzo || undefined }),
      });
      if (!res.ok) throw new Error();
      setNomeMezzo("");
      setTargaMezzo("");
      ricaricaMezzi();
    } catch {
      setErrore("Impossibile creare il mezzo.");
    }
  }

  async function cambiaStatoMezzo(mezzoId: string, stato: string) {
    setErrore(null);
    try {
      await fetch(`${API_URL}/mezzi/${mezzoId}/stato`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stato }),
      });
      ricaricaMezzi();
    } catch {
      setErrore("Impossibile cambiare lo stato del mezzo.");
    }
  }

  const mezziDisponibili = mezzi.filter((m) => m.stato === "disponibile");
  const interventiAttivi = interventi.filter((i) => i.stato !== "concluso" && i.stato !== "annullato");

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
        <h2 style={{ marginTop: 0 }}>Centrale Operativa</h2>

        {errore && (
          <div style={{ background: "#fff3cd", padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 14 }}>
            {errore}
          </div>
        )}

        {allarme && (
          <div style={{ background: "#ffcdd2", padding: 12, borderRadius: 6, marginBottom: 16 }}>
            ⚠️ {allarme}
            <div>
              <button onClick={() => setAllarme(null)} style={{ marginTop: 8 }}>
                Chiudi avviso
              </button>
            </div>
          </div>
        )}

        {/* --- Nuovo intervento --- */}
        <section style={{ marginBottom: 24, border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>Nuovo intervento</h3>
          <form onSubmit={creaIntervento} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              placeholder="Indirizzo *"
              value={indirizzo}
              onChange={(e) => setIndirizzo(e.target.value)}
              required
              style={{ padding: 8 }}
            />
            <input
              placeholder="Tipologia (es. codice rosso)"
              value={tipologia}
              onChange={(e) => setTipologia(e.target.value)}
              style={{ padding: 8 }}
            />
            <textarea
              placeholder="Note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              style={{ padding: 8 }}
            />
            <button type="submit" style={{ padding: 10, fontWeight: 600 }}>
              Crea intervento
            </button>
          </form>
        </section>

        {/* --- Interventi --- */}
        <section style={{ marginBottom: 24 }}>
          <h3>Interventi attivi</h3>
          {interventiAttivi.length === 0 && <p style={{ color: "#777" }}>Nessun intervento attivo.</p>}
          <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {interventiAttivi.map((i) => (
              <li key={i.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 10 }}>
                <strong>{i.indirizzo}</strong>
                {i.tipologia && <> — {i.tipologia}</>}
                <br />
                <small>
                  {ETICHETTA_STATO_INTERVENTO[i.stato] ?? i.stato} · {new Date(i.creato_il).toLocaleString("it-IT")}
                </small>

                {i.stato === "in_attesa" && (
                  <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                    <select
                      defaultValue=""
                      onChange={(e) => e.target.value && assegnaIntervento(i.id, e.target.value)}
                      style={{ flex: 1, padding: 6 }}
                    >
                      <option value="" disabled>
                        Assegna a un mezzo...
                      </option>
                      {mezziDisponibili.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.nome}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {(i.stato === "assegnato" || i.stato === "in_corso") && (
                  <div style={{ marginTop: 8 }}>
                    <button onClick={() => chiudiIntervento(i.id)}>Chiudi intervento (rientro)</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>

        {/* --- Mezzi --- */}
        <section>
          <h3>Mezzi</h3>
          <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {mezzi.map((m) => (
              <li
                key={m.id}
                style={{
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  padding: 8,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>
                  {m.nome} {m.targa && <small style={{ color: "#888" }}>({m.targa})</small>}
                  <br />
                  <span style={{ color: COLORE_STATO[m.stato], fontSize: 13 }}>{m.stato}</span>
                </span>
                <select
                  value={m.stato}
                  onChange={(e) => cambiaStatoMezzo(m.id, e.target.value)}
                  style={{ padding: 4 }}
                >
                  <option value="disponibile">disponibile</option>
                  <option value="impegnato">impegnato</option>
                  <option value="fuori_servizio">fuori servizio</option>
                </select>
              </li>
            ))}
          </ul>

          <form onSubmit={creaMezzo} style={{ display: "flex", gap: 6, marginTop: 12 }}>
            <input
              placeholder="Nome mezzo (es. Ambulanza 2)"
              value={nomeMezzo}
              onChange={(e) => setNomeMezzo(e.target.value)}
              required
              style={{ flex: 2, padding: 8 }}
            />
            <input
              placeholder="Targa"
              value={targaMezzo}
              onChange={(e) => setTargaMezzo(e.target.value)}
              style={{ flex: 1, padding: 8 }}
            />
            <button type="submit">Aggiungi</button>
          </form>
        </section>
      </div>
    </div>
  );
}
