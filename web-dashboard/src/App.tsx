import { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import { io, Socket } from "socket.io-client";
import "leaflet/dist/leaflet.css";

const API_URL = import.meta.env.VITE_API_URL;
if (!API_URL) console.warn("VITE_API_URL non impostata: configura l'URL pubblico Render del backend.");

const statiMezzo = ["disponibile", "impegnato", "fuori_servizio"] as const;
const statiMissione = ["Attivazione","Partenza","Arrivo sul posto","Paziente visto","Partenza per ospedale","Arrivo ospedale","Libero in Ospedale","Rientro","Disponibile"] as const;
const colori: Record<string,string> = { verde:"#16a34a", giallo:"#eab308", rosso:"#dc2626" };
const statoColor: Record<string,string> = { disponibile:"#16a34a", impegnato:"#f97316", fuori_servizio:"#64748b" };

type Mezzo = { id:string; nome:string; targa?:string; stato:string; lat:number|null; lon:number|null; flag_colore:string };
type Intervento = { id:string; numero_missione:string; indirizzo:string; lat:number|null; lon:number|null; tipologia?:string; note?:string; priorita:string; stato:string; stato_operativo:string; creato_il:string; mezzo_id?:string; scheda_missione?:Record<string,unknown>; eventi?: any[]; mezzi?: Mezzo[] };

type Scheda = Record<string, any>;

function oggi() { return new Date().toISOString().slice(0,10); }
function etichettaStato(s:string) { return s.replaceAll("_"," "); }
function calcolaEta(data:string) { if(!data) return ""; const d=new Date(data); if(Number.isNaN(d.getTime())) return ""; const now=new Date(); let e=now.getFullYear()-d.getFullYear(); const m=now.getMonth()-d.getMonth(); if(m<0 || (m===0 && now.getDate()<d.getDate())) e--; return String(Math.max(0,e)); }

export default function App() {
  const [mezzi,setMezzi]=useState<Mezzo[]>([]);
  const [missioni,setMissioni]=useState<Intervento[]>([]);
  const [data,setData]=useState(oggi());
  const [errore,setErrore]=useState("");
  const [priorita,setPriorita]=useState("verde");
  const [indirizzo,setIndirizzo]=useState("");
  const [tipologia,setTipologia]=useState("");
  const [note,setNote]=useState("");
  const [mezziSelezionati,setMezziSelezionati]=useState<string[]>([]);
  const [missioneAperta,setMissioneAperta]=useState<Intervento|null>(null);
  const [scheda,setScheda]=useState<Scheda>({});
  const [mezzoFocus,setMezzoFocus]=useState<Mezzo|null>(null);
  const [socket,setSocket]=useState<Socket|null>(null);

  async function carica() {
    if(!API_URL) return;
    try {
      const [m,i] = await Promise.all([fetch(`${API_URL}/mezzi`),fetch(`${API_URL}/interventi?data=${data}`)]);
      if(!m.ok || !i.ok) throw new Error("Backend non raggiungibile");
      setMezzi(await m.json()); setMissioni(await i.json()); setErrore("");
    } catch(e:any) { setErrore(e.message || "Backend non raggiungibile. Controlla VITE_API_URL su Vercel."); }
  }
  useEffect(()=>{ carica(); },[data]);
  useEffect(()=>{
    if(!API_URL) return;
    const s=io(API_URL,{transports:["websocket","polling"]}); setSocket(s); s.emit("registra",{ruolo:"centrale"});
    s.on("posizione_mezzo",(m:Mezzo)=>setMezzi(x=>x.map(v=>v.id===m.id?m:v)));
    s.on("stato_mezzo",(m:Mezzo)=>setMezzi(x=>x.map(v=>v.id===m.id?m:v)));
    s.on("nuovo_intervento",()=>carica()); s.on("intervento_assegnato",()=>carica()); s.on("intervento_confermato",()=>carica()); s.on("stato_missione",()=>carica()); s.on("intervento_concluso",()=>carica()); s.on("scheda_aggiornata",()=>carica());
    return ()=>{s.disconnect();};
  },[]);

  async function creaMissione(e:React.FormEvent){ e.preventDefault(); setErrore(""); if(!indirizzo.trim()) return; try { const r=await fetch(`${API_URL}/interventi`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({indirizzo,tipologia:tipologia||undefined,note:note||undefined,priorita})}); if(!r.ok) throw new Error("Creazione missione fallita"); const m=await r.json(); if(mezziSelezionati.length){ await assegna(m.id,mezziSelezionati); } setIndirizzo("");setTipologia("");setNote("");setMezziSelezionati([]);await carica();setMissioneAperta(m); }catch(e:any){setErrore(e.message||"Errore");} }
  async function assegna(id:string, ids=mezziSelezionati){ const r=await fetch(`${API_URL}/interventi/${id}/assegna`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mezzoIds:ids})}); if(!r.ok){const x=await r.json().catch(()=>({}));throw new Error(x.errore||"Assegnazione fallita");} }
  async function confermaStato(m:Mezzo, stato:string){ if(!confirm(`Confermi il cambio stato di ${m.nome} in ${etichettaStato(stato)}?`)) return; try{await fetch(`${API_URL}/mezzi/${m.id}/stato`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({stato})});await carica();}catch{setErrore("Impossibile cambiare stato");} }
  async function spostaMezzo(m:Mezzo, lat:number,lon:number){ await fetch(`${API_URL}/mezzi/${m.id}/posizione`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({lat,lon})}); }
  async function cambiaFlag(m:Mezzo,c:string){ await fetch(`${API_URL}/mezzi/${m.id}/flag`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({colore:c})}); await carica(); }
  async function cambiaStatoMissione(m:Intervento, stato:string){ const mezzoId=m.mezzo_id; if(!confirm(`Confermi “${stato}” per la missione ${m.numero_missione}?`)) return; await fetch(`${API_URL}/interventi/${m.id}/stato`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({stato,mezzoId})}); await carica(); if(m.id===missioneAperta?.id) apriMissione(m.id); }
  async function apriMissione(id:string){ const r=await fetch(`${API_URL}/interventi/${id}`); if(!r.ok)return; const m=await r.json();setMissioneAperta(m);setScheda(m.scheda_missione||{}); }
  async function salvaScheda(){ if(!missioneAperta)return; await fetch(`${API_URL}/interventi/${missioneAperta.id}/scheda`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(scheda)}); await apriMissione(missioneAperta.id); }

  const missioniAttive=missioni.filter(x=>x.stato!=="concluso"&&x.stato!=="annullato");
  const online=!!socket?.connected;

  return <div className="app">
    <header className="topbar"><div><div className="brand">IRIS <span>v2</span></div><div className="sub">Centrale Operativa · gestione missioni e mezzi</div></div><div className={`connection ${online?"on":"off"}`}><i/> {online?"Online":"Offline"}</div></header>
    {errore&&<div className="error">{errore}</div>}
    <div className="workspace">
      <section className="mapPanel"><MapContainer center={[45.4642,9.19]} zoom={12} style={{height:"100%"}}><TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>
        {mezzi.filter(m=>m.lat!==null&&m.lon!==null).map(m=><Marker key={m.id} position={[m.lat!,m.lon!]} icon={L.divIcon({html:`<div class="iris-marker" style="background:${colori[m.flag_colore]}">${m.nome.replace(/</g,"&lt;").slice(0,3)}</div>`,className:"iris-marker-wrap",iconSize:[36,36],iconAnchor:[18,18]})} draggable eventHandlers={{dragend:(e:any)=>{const p=e.target.getLatLng();spostaMezzo(m,p.lat,p.lng)}}}>
          <Popup><b>{m.nome}</b><br/>Stato: <strong style={{color:statoColor[m.stato]}}>{etichettaStato(m.stato)}</strong><br/>Flag: <strong style={{color:colori[m.flag_colore]}}>{m.flag_colore}</strong><div className="popupBtns"><button onClick={()=>setMezzoFocus(m)}>Gestisci</button></div></Popup>
        </Marker>)}
      </MapContainer><div className="mapLegend"><b>MEZZI</b><span><i className="dot green"/>Disponibile</span><span><i className="dot orange"/>Impegnato</span><span><i className="dot gray"/>Fuori servizio</span></div></section>

      <aside className="side">
        <div className="sectionHead"><div><h2>Missioni</h2><small>Registro del giorno</small></div><input type="date" value={data} onChange={e=>setData(e.target.value)}/></div>
        <form className="newMission" onSubmit={creaMissione}><div className="priorityRow">{["verde","giallo","rosso"].map(c=><button type="button" key={c} className={priorita===c?`priority active ${c}`:`priority ${c}`} onClick={()=>setPriorita(c)}>{c.toUpperCase()}</button>)}</div><input value={indirizzo} onChange={e=>setIndirizzo(e.target.value)} placeholder="Luogo / indirizzo evento *" required/><input value={tipologia} onChange={e=>setTipologia(e.target.value)} placeholder="Tipologia evento"/><textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="Note per l'equipaggio" rows={2}/><div className="assignTitle">Mezzi da attivare</div><div className="checks">{mezzi.filter(m=>m.stato==="disponibile").map(m=><label key={m.id}><input type="checkbox" checked={mezziSelezionati.includes(m.id)} onChange={e=>setMezziSelezionati(x=>e.target.checked?[...x,m.id]:x.filter(id=>id!==m.id))}/>{m.nome}</label>)}</div><button className="primary">CREA ATTIVAZIONE</button></form>

        <div className="missionList">{missioniAttive.length===0?<div className="empty">Nessuna missione per questa giornata.</div>:missioniAttive.map(m=><button className="missionCard" key={m.id} onClick={()=>apriMissione(m.id)}><div className="missionTop"><strong>{m.numero_missione}</strong><span className={`prio ${m.priorita}`}>{m.priorita}</span></div><div className="missionAddress">{m.indirizzo}</div><div className="missionBottom"><span>{m.stato_operativo}</span><time>{new Date(m.creato_il).toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"})}</time></div></button>)}</div>

        <div className="fleet"><div className="sectionHead"><div><h2>Mezzi</h2><small>Gestione rapida</small></div></div>{mezzi.map(m=><div className="fleetRow" key={m.id}><button className="fleetName" onClick={()=>setMezzoFocus(m)}><span className="flag" style={{background:colori[m.flag_colore]}}/><span><b>{m.nome}</b><small>{m.targa||""} · {etichettaStato(m.stato)}</small></span></button><select value={m.stato} onChange={e=>confermaStato(m,e.target.value)}>{statiMezzo.map(s=><option key={s} value={s}>{etichettaStato(s)}</option>)}</select></div>)}</div>
      </aside>
    </div>

    {mezzoFocus&&<div className="modalBack" onMouseDown={()=>setMezzoFocus(null)}><div className="modal small" onMouseDown={e=>e.stopPropagation()}><div className="modalHead"><div><b>{mezzoFocus.nome}</b><small>{mezzoFocus.targa}</small></div><button onClick={()=>setMezzoFocus(null)}>×</button></div><h4>Stato mezzo</h4><div className="stateGrid">{statiMezzo.map(s=><button key={s} className={mezzoFocus.stato===s?"selected":""} onClick={()=>confermaStato(mezzoFocus,s)}>{etichettaStato(s)}</button>)}</div><h4>Flag posizione / disponibilità</h4><div className="stateGrid flags">{["verde","giallo","rosso"].map(c=><button key={c} style={{borderColor:colori[c]}} className={mezzoFocus.flag_colore===c?"selected":""} onClick={()=>cambiaFlag(mezzoFocus,c)}>{c}</button>)}</div><p className="hint">Puoi anche trascinare il marker direttamente sulla mappa.</p></div></div>}

    {missioneAperta&&<div className="modalBack" onMouseDown={()=>setMissioneAperta(null)}><div className="modal missionModal" onMouseDown={e=>e.stopPropagation()}><div className="modalHead"><div><span className={`prio big ${missioneAperta.priorita}`}>{missioneAperta.priorita}</span><b>{missioneAperta.numero_missione}</b><small>{missioneAperta.indirizzo}</small></div><button onClick={()=>setMissioneAperta(null)}>×</button></div><div className="stateBar">{statiMissione.map(s=><button key={s} className={missioneAperta.stato_operativo===s?"current":""} onClick={()=>cambiaStatoMissione(missioneAperta,s)}>{s}</button>)}</div><div className="missionBody"><div className="timeline"><h3>Cronologia</h3>{(missioneAperta.eventi||[]).map((e:any)=><div className="event" key={e.id}><span>{new Date(e.creato_il).toLocaleTimeString("it-IT")}</span><b>{e.stato}</b></div>)}</div><div className="sheet"><h3>Scheda missione</h3><div className="grid2"><label>Data nascita<input type="date" value={scheda.dataNascita||""} onChange={e=>setScheda({...scheda,dataNascita:e.target.value,eta:calcolaEta(e.target.value)})}/></label><label>Età<input value={scheda.eta||""} readOnly/></label><label>Cognome<input value={scheda.cognome||""} onChange={e=>setScheda({...scheda,cognome:e.target.value})}/></label><label>Nome<input value={scheda.nome||""} onChange={e=>setScheda({...scheda,nome:e.target.value})}/></label></div><h4>Evento</h4><div className="checks multi">{["Casa","Strada","Uffici/esercizi pubblici","Impianto sportivo","Impianto lavorativo","Altro"].map(x=><label key={x}><input type="checkbox" checked={!!scheda.luogo?.includes(x)} onChange={e=>setScheda({...scheda,luogo:e.target.checked?[...(scheda.luogo||[]),x]:(scheda.luogo||[]).filter((v:string)=>v!==x)})}/>{x}</label>)}</div><h4>Parametri</h4><div className="checks multi">{["Polso periferico","Polso centrale","Polso assente","Ritmico","Aritmico","Cute calda","Cute fredda","Cute rosea","Cute pallida","Cute cianotica","Sudata","CPSS deviazione rima labiale","CPSS segni di lato","CPSS alterazioni linguaggio"].map(x=><label key={x}><input type="checkbox" checked={!!scheda.parametri?.includes(x)} onChange={e=>setScheda({...scheda,parametri:e.target.checked?[...(scheda.parametri||[]),x]:(scheda.parametri||[]).filter((v:string)=>v!==x)})}/>{x}</label>)}</div><h4>Prestazioni</h4><div className="checks multi">{["Ossigeno","Aspirazione cavo orale","Cannula OF","Ventilazione","RCP","Applicazione DAE","Trasmissione ECG","Rimozione casco","Collare cervicale","Barella cucchiaio","Tavola spinale","Sedia portantina","Materasso depressione","Estricatore","Steccobenda","Telo porta feriti","Fascia emostatica","Medicazione ferite","Immobilizzazione arti","Immobilizzazione spinale","Protezione termica"].map(x=><label key={x}><input type="checkbox" checked={!!scheda.prestazioni?.includes(x)} onChange={e=>setScheda({...scheda,prestazioni:e.target.checked?[...(scheda.prestazioni||[]),x]:(scheda.prestazioni||[]).filter((v:string)=>v!==x)})}/>{x}</label>)}</div><h4>Presidi</h4><textarea value={scheda.presidiNote||""} onChange={e=>setScheda({...scheda,presidiNote:e.target.value})} placeholder="Presidi / note aggiuntive" rows={3}/><h4>Lesioni e zone interessate</h4><textarea value={scheda.lesioni||""} onChange={e=>setScheda({...scheda,lesioni:e.target.value})} placeholder="Seleziona/descrivi le lesioni e indica la zona interessata" rows={3}/><h4>Destinazione</h4><div className="checks"><label><input type="radio" name="dest" checked={scheda.destinazione==="Pronto Soccorso"} onChange={()=>setScheda({...scheda,destinazione:"Pronto Soccorso"})}/>Pronto Soccorso</label><label><input type="radio" name="dest" checked={scheda.destinazione==="Altro"} onChange={()=>setScheda({...scheda,destinazione:"Altro"})}/>Altro</label></div>{scheda.destinazione==="Altro"&&<input value={scheda.destinazioneAltro||""} onChange={e=>setScheda({...scheda,destinazioneAltro:e.target.value})} placeholder="Specificare destinazione"/>}<h4>Anamnesi / relazione</h4><textarea value={scheda.anamnesi||""} onChange={e=>setScheda({...scheda,anamnesi:e.target.value})} rows={5}/><h4>Rifiuto</h4><div className="checks"><label><input type="checkbox" checked={!!scheda.rifiutoTrasporto} onChange={e=>setScheda({...scheda,rifiutoTrasporto:e.target.checked,rifiutoOra:e.target.checked?new Date().toISOString():""})}/>Rifiuto trasporto</label><label><input type="checkbox" checked={!!scheda.rifiutoPresidi} onChange={e=>setScheda({...scheda,rifiutoPresidi:e.target.checked,rifiutoOra:e.target.checked?new Date().toISOString():scheda.rifiutoOra})}/>Rifiuto presidi</label></div><label>Ora rifiuto<input type="time" value={scheda.rifiutoOra?new Date(scheda.rifiutoOra).toLocaleTimeString("it-IT",{hour:"2-digit",minute:"2-digit"}):""} readOnly/></label><button className="primary" onClick={salvaScheda}>SALVA SCHEDA</button></div></div></div></div>}
  </div>
}
