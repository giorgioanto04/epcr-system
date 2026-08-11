import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import { io, Socket } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

type Mezzo = {
  id: string; nome: string; targa?: string;
  stato: "disponibile" | "impegnato" | "fuori_servizio";
  lat: number | null; lon: number | null;
};
type EventoMissione = { id: string; stato: string; creato_il: string; dettagli?: any };
type Intervento = {
  id: string; numero_missione?: string; indirizzo: string; lat?: number|null; lon?: number|null;
  tipologia?: string; note?: string; stato: string; stato_missione?: string; mezzo_id?: string|null;
  creato_il: string; ora_assegnazione?: string|null; ora_presa_in_carico?: string|null;
  ora_arrivo?: string|null; ora_rientro?: string|null; rifiuto_trasporto?: boolean;
  scheda_missione?: Record<string, any>; registro?: EventoMissione[];
};

const STATI = ["Attivazione","Partenza","Arrivo sul posto","Paziente visto","Partenza per ospedale","Arrivo ospedale","Libero in Ospedale","Rientro","Disponibile"];
const ETICHETTA: Record<string,string> = {
  in_attesa:"In attesa",assegnato:"Assegnato",in_corso:"In corso",concluso:"Concluso",annullato:"Annullato"
};
const COLORE: Record<string,string> = {disponibile:"#15803d",impegnato:"#b91c1c",fuori_servizio:"#64748b"};

const CAMPI: {section:string; fields:{key:string; label:string; type?:string; options?:string[]}[]}[] = [
 {section:"Identificazione",fields:[
  {key:"denominazioneOdV",label:"Denominazione OdV"},{key:"targaCodMezzo",label:"Targa / cod. mezzo"},
  {key:"kmIniziali",label:"Km iniziali",type:"number"},{key:"kmFinali",label:"Km finali",type:"number"},
  {key:"matrAutista",label:"Matr. autista"},{key:"matrSoccorritore1",label:"Matr. soccorritore 1"},
  {key:"matrSoccorritore2",label:"Matr. soccorritore 2"},{key:"convenzione",label:"Convenzione"},{key:"numeroInterno",label:"N° interno"}]},
 {section:"Luogo dell'evento",fields:[
  {key:"luogoVia",label:"Via / piazza"},{key:"luogoCivico",label:"N. civico"},{key:"luogoPianoScala",label:"Piano / scala"},
  {key:"luogoComune",label:"Comune"},{key:"dataEvento",label:"Data",type:"date"},
  {key:"luogoEvento",label:"Tipologia luogo",options:["Casa","Strada","Uffici/esercizi pubblici","Impianto sportivo","Impianto lavorativo","Altro"]}]},
 {section:"Paziente",fields:[
  {key:"cognome",label:"Cognome"},{key:"nome",label:"Nome"},{key:"dataNascita",label:"Data di nascita",type:"date"},
  {key:"eta",label:"Età",type:"number"},{key:"cittadinanza",label:"Cittadinanza"},{key:"sesso",label:"Sesso",options:["M","F"]},
  {key:"comuneResidenza",label:"Comune di residenza"},{key:"residenzaVia",label:"Via / piazza"},{key:"residenzaCivico",label:"N. civico"},
  {key:"eventoRilevatoDa",label:"Evento rilevato da"},{key:"presenze",label:"Dati interni presenti",type:"multi",options:["OdV","MSA1","MSA2","CNSAS","VVF","CC","Polizia","Medico"]}]},
 {section:"Evento",fields:[
  {key:"evento",label:"Evento",type:"multi",options:["Perdita di coscienza","Lesioni e aggravanti","Convulsioni","Malessere","Caduta","Incidente stradale","Avvelenamenti","Evento violento","Precipitato","Pedone/ciclo","Conducente moto","Malore","Travaglio/parto","Infortunio","Auto passeggero","Altro"]},
  {key:"oraPerditaCoscienza",label:"Ora perdita coscienza",type:"time"},{key:"precipitatoDa",label:"Precipitato da (m)",type:"number"}]},
 {section:"Valutazione e parametri",fields:[
  {key:"coscienza",label:"Stato coscienza",options:["Sveglio","Reagisce alla chiamata","Reagisce al dolore","Assente","Incosciente"]},
  {key:"respiro",label:"Respiro",options:["Normale","Difficoltoso","Assente"]},
  {key:"circolo",label:"Circolo",options:["Periferico","Centrale","Ritmico","Aritmico","Assente"]},
  {key:"cute",label:"Cute",options:["Calda","Fredda","Rosea","Cianotica","Pallida","Sudata"]},
  {key:"postura",label:"Postura",options:["In piedi","Seduta","Prona","Supina","Laterale"]},
  {key:"cpss",label:"CPSS",options:["Deviazione rima labiale","Segni di lato","Alterazioni del linguaggio"]},{key:"cpssVal1",label:"CPSS valutazione 1"},{key:"cpssVal2",label:"CPSS valutazione 2"},{key:"cpssVal3",label:"CPSS valutazione 3"},
  {key:"oraInsorgenzaSintomi",label:"Ora insorgenza sintomi",type:"time"},
  {key:"fr",label:"FR",type:"number"},{key:"satAria",label:"Sat. aria %",type:"number"},{key:"satO2",label:"Sat. O2 %",type:"number"},
  {key:"fc",label:"FC",type:"number"},{key:"pa",label:"PA"},{key:"temperatura",label:"Temp. °C",type:"number"},{key:"glicemia",label:"Glicemia",type:"number"},
  {key:"noteValutazione",label:"Note valutazione",type:"textarea"}]},
 {section:"RCP / ACC",fields:[
  {key:"inizioRcpOra",label:"Inizio RCP - ora",type:"time"},{key:"numeroShock",label:"Nr. shock",type:"number"},
  {key:"roscOra",label:"ROSC - ora",type:"time"},{key:"esito",label:"Esito",options:["Trasporto con RCP","RCP già in corso","ACC durante il trasporto","Deceduto"]},
  {key:"anamnesiAmpia",label:"Note / anamnesi AMPIA",type:"textarea"}]},
 {section:"Prestazioni / presidi",fields:[
  {key:"prestazioni",label:"Prestazioni / presidi",type:"multi",options:["Ossigeno","Aspirazione cavo orale","Cannula OF ventilazione","RCP","Applicazione DAE","Trasmissione ECG","Rimozione casco","Estricazione collare cervicale","Barella cucchiaio","Tavola spinale","Sedia portantina","Materasso depressione","Estricatore","Steccobenda","Telo porta feriti","Fascia emostatica","Emostasi rapida","Medicazione ferite","Immobilizzazione arti","Immobilizzazione spinale","Protezione termica","Frattura esposta","Deformità","Sanguinamento","Emorragia massiva","Ferita","Ferita penetrante","Lacerazione/schiacciamento","Contusione","Ustione","Proiettato","Edema","Lesioni incompatibili con la vita","Accesso difficile","Presenza deceduti","Incastrato","Estricazione >20 min","Motilità assente","Sensibilità assente"]},
  {key:"ossigenoLMin",label:"Ossigeno l/min",type:"number"},{key:"dolore",label:"Dolore",type:"number"},{key:"proiettatoDa",label:"Proiettato da (m)",type:"number"},{key:"lesioniNote",label:"Lesioni / note",type:"textarea"}]},
 {section:"Destinazione",fields:[
  {key:"aziendaIstituto",label:"Azienda / Istituto"},{key:"invioCodice",label:"Invio V / G / R",options:["V","G","R"]},
  {key:"trasportoCodice",label:"Trasporto V / G / R",options:["V","G","R"]},{key:"numeroMatricola",label:"N. matricola"},{key:"compilatore",label:"Compilatore"}]},
 {section:"Rifiuto trasporto / presidi",fields:[
  {key:"rifiutoNote",label:"Note / dichiarazione",type:"textarea"},{key:"rifiutoCoscienza",label:"Coscienza"},
  {key:"rifiutoRespiro",label:"Respiro"},{key:"rifiutoCircolo",label:"Circolo"},{key:"rifiutoCute",label:"Cute"},
  {key:"rifiutoData",label:"Data accettazione",type:"date"},{key:"rifiutoOra",label:"Ora accettazione",type:"time"}]},
 {section:"Relazione",fields:[{key:"relazione",label:"Relazione di soccorso",type:"textarea"}]}
];

function formatTime(v?:string|null){return v ? new Date(v).toLocaleTimeString("it-IT") : "—";}
function Field({f,value,onChange}:{f:any;value:any;onChange:(v:any)=>void}){
 if(f.type==="textarea") return <label className="field full"><span>{f.label}</span><textarea value={value??""} onChange={e=>onChange(e.target.value)}/></label>;
 if(f.type==="multi") return <div className="field full"><span>{f.label}</span><div className="checks">{f.options?.map((o:string)=><label key={o}><input type="checkbox" checked={Array.isArray(value)&&value.includes(o)} onChange={e=>{const a=Array.isArray(value)?[...value]:[];onChange(e.target.checked?[...a,o]:a.filter(x=>x!==o));}}/> {o}</label>)}</div></div>;
 if(f.options) return <label className="field"><span>{f.label}</span><select value={value??""} onChange={e=>onChange(e.target.value)}><option value="">—</option>{f.options.map((o:string)=><option key={o}>{o}</option>)}</select></label>;
 return <label className="field"><span>{f.label}</span><input type={f.type||"text"} value={value??""} onChange={e=>onChange(e.target.value)}/></label>;
}

export default function App(){
 const [mezzi,setMezzi]=useState<Mezzo[]>([]);
 const [interventi,setInterventi]=useState<Intervento[]>([]);
 const [allarme,setAllarme]=useState<string|null>(null);
 const [errore,setErrore]=useState<string|null>(null);
 const [selezionata,setSelezionata]=useState<Intervento|null>(null);
 const [scheda,setScheda]=useState<Record<string,any>>({});
 const [registro,setRegistro]=useState<EventoMissione[]>([]);
 const [salvando,setSalvando]=useState(false);
 const [indirizzo,setIndirizzo]=useState("");const [tipologia,setTipologia]=useState("");const [note,setNote]=useState("");
 const [nomeMezzo,setNomeMezzo]=useState("");const [targaMezzo,setTargaMezzo]=useState("");

 async function get(path:string,options?:RequestInit){const r=await fetch(API_URL+path,options);const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.errore||"Errore");return d}
 const refresh=async()=>{const [m,i]=await Promise.all([get("/mezzi"),get("/interventi")]);setMezzi(m);setInterventi(i);};
 useEffect(()=>{refresh().catch(e=>setErrore(e.message));const socket:Socket=io(API_URL);socket.emit("registra",{ruolo:"centrale"});
  const sync=(i:Intervento)=>{setInterventi(p=>p.some(x=>x.id===i.id)?p.map(x=>x.id===i.id?i:x):[i,...p]);if(selezionata?.id===i.id){setSelezionata(i);setScheda(i.scheda_missione||{});loadRegistro(i.id)}};
  socket.on("nuovo_intervento",sync);socket.on("intervento_assegnato",sync);socket.on("intervento_confermato",sync);socket.on("missione_aggiornata",sync);socket.on("scheda_missione_aggiornata",sync);
  socket.on("stato_mezzo",(m:Mezzo)=>setMezzi(p=>p.map(x=>x.id===m.id?m:x)));socket.on("posizione_mezzo",(m:Mezzo)=>setMezzi(p=>p.map(x=>x.id===m.id?m:x)));
  socket.on("attivazione_senza_risposta",(p:any)=>setAllarme(`Nessuna risposta dalla missione ${p.numeroMissione||p.interventoId}.`));
  return()=>socket.disconnect();
 },[selezionata?.id]);

 async function loadMissione(id:string){const d=await get(`/interventi/${id}`);setSelezionata(d);setScheda(d.scheda_missione||{});setRegistro(d.registro||[]);}
 async function loadRegistro(id:string){const d=await get(`/interventi/${id}/registro`);setRegistro(d);}
 async function salvaScheda(){if(!selezionata)return;setSalvando(true);try{const d=await get(`/interventi/${selezionata.id}/scheda`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({scheda})});setSelezionata(d);setInterventi(p=>p.map(i=>i.id===d.id?d:i));}finally{setSalvando(false)}}
 async function creaIntervento(e:React.FormEvent){e.preventDefault();try{await get("/interventi",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({indirizzo,tipologia,note})});setIndirizzo("");setTipologia("");setNote("");await refresh()}catch(e:any){setErrore(e.message)}}
 async function assegna(id:string,mezzoId:string){try{await get(`/interventi/${id}/assegna`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({mezzoId})});await refresh()}catch(e:any){setErrore(e.message)}}
 async function statoManuale(mezzoId:string,stato:string){try{await get(`/mezzi/${mezzoId}/stato`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({stato})});await refresh()}catch(e:any){setErrore(e.message)}}
 async function creaMezzo(e:React.FormEvent){e.preventDefault();try{await get("/mezzi",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({nome:nomeMezzo,targa:targaMezzo})});setNomeMezzo("");setTargaMezzo("");await refresh()}catch(e:any){setErrore(e.message)}}
 const attivi=useMemo(()=>interventi.filter(i=>i.stato!=="concluso"&&i.stato!=="annullato"),[interventi]);
 const mezzoNome=(id?:string|null)=>mezzi.find(m=>m.id===id)?.nome||"—";

 return <div className="app">
 <style>{`
 *{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;color:#172033;background:#f4f6f8}.app{display:flex;min-height:100vh}.map{width:45vw;position:sticky;top:0;height:100vh}.panel{width:55vw;padding:16px;overflow:auto}.card{background:#fff;border:1px solid #d9dee7;border-radius:12px;padding:14px;margin-bottom:12px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.field{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:700}.field.full{grid-column:1/-1}.field input,.field select,.field textarea{padding:8px;border:1px solid #cbd5e1;border-radius:7px;font:inherit;font-weight:400}.field textarea{min-height:80px}.checks{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;font-weight:500}.checks label{border:1px solid #e2e8f0;border-radius:6px;padding:6px}.mission{border:1px solid #d8dee8;border-radius:10px;padding:10px;margin:8px 0}.mission.active{border-left:5px solid #b91c1c}.timeline{list-style:none;padding:0;margin:0}.timeline li{padding:7px 0;border-bottom:1px solid #eee;display:flex;gap:10px}.time{font-weight:800;min-width:68px}.modal{position:fixed;inset:0;background:#0008;z-index:100;display:flex;justify-content:center;align-items:center;padding:14px}.modalbox{background:#f4f6f8;width:min(1100px,100%);height:94vh;overflow:auto;border-radius:14px;padding:16px}.bar{display:flex;justify-content:space-between;gap:8px;align-items:center;position:sticky;top:-16px;background:#f4f6f8;padding:5px 0 12px;z-index:2}.pill{padding:4px 8px;border-radius:999px;background:#e2e8f0;font-size:12px}.danger{background:#fee2e2;color:#991b1b}.ok{background:#dcfce7;color:#166534}button{padding:8px 10px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;cursor:pointer;font-weight:650}button.primary{background:#111827;color:#fff;border-color:#111827}button:hover{filter:brightness(.98)}@media(max-width:900px){.app{display:block}.map,.panel{width:100%}.map{height:38vh;position:relative}.grid{grid-template-columns:1fr}.checks{grid-template-columns:1fr 1fr}.field.full{grid-column:auto}}
 `}</style>
 <div className="map"><MapContainer center={[45.4642,9.19]} zoom={12} style={{height:"100%"}}><TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>{mezzi.filter(m=>m.lat!=null&&m.lon!=null).map(m=><Marker key={m.id} position={[m.lat!,m.lon!]}><Popup><b>{m.nome}</b><br/>Stato: {m.stato}</Popup></Marker>)}</MapContainer></div>
 <div className="panel"><h2 style={{marginTop:0}}>Centrale Operativa</h2>
 {errore&&<div className="card danger">{errore}</div>}{allarme&&<div className="card danger">⚠️ {allarme}<br/><button onClick={()=>setAllarme(null)}>Chiudi</button></div>}
 <section className="card"><h3>Nuova attivazione</h3><form onSubmit={creaIntervento} className="grid"><label className="field full">Luogo / indirizzo<input value={indirizzo} onChange={e=>setIndirizzo(e.target.value)} required/></label><label className="field">Tipologia<input value={tipologia} onChange={e=>setTipologia(e.target.value)}/></label><label className="field">Note<input value={note} onChange={e=>setNote(e.target.value)}/></label><div className="field full"><button className="primary">CREA ATTIVAZIONE</button></div></form></section>
 <section className="card"><h3>Registro attivazioni</h3>{attivi.length===0&&<p>Nessuna missione attiva.</p>}{attivi.map(i=><div key={i.id} className={`mission ${i.stato!=="concluso"?"active":""}`}><div style={{display:"flex",justifyContent:"space-between",gap:8}}><div><b>{i.numero_missione||"—"}</b> · {i.indirizzo}<br/><small>{i.tipologia||""} · {ETICHETTA[i.stato]||i.stato} · stato missione: <b>{i.stato_missione}</b></small></div><button onClick={()=>loadMissione(i.id)}>APRI SCHEDA</button></div>
 {i.stato==="in_attesa"&&<select defaultValue="" onChange={e=>e.target.value&&assegna(i.id,e.target.value)} style={{marginTop:8,width:"100%",padding:7}}><option value="" disabled>Assegna mezzo...</option>{mezzi.filter(m=>m.stato==="disponibile").map(m=><option key={m.id} value={m.id}>{m.nome} {m.targa||""}</option>)}</select>}
 {i.stato!=="in_attesa"&&<small>Mezzo: {mezzoNome(i.mezzo_id)}</small>}
 </div>)}</section>
 <section className="card"><h3>Mezzi</h3>{mezzi.map(m=><div key={m.id} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #eee"}}><span><b>{m.nome}</b> {m.targa&&<small>({m.targa})</small>}<br/><small style={{color:COLORE[m.stato]}}>{m.stato}</small></span><select value={m.stato} onChange={e=>statoManuale(m.id,e.target.value)}><option value="disponibile">disponibile</option><option value="impegnato">impegnato</option><option value="fuori_servizio">fuori servizio</option></select></div>)}<form onSubmit={creaMezzo} style={{display:"flex",gap:5,marginTop:10}}><input placeholder="Nome mezzo" value={nomeMezzo} onChange={e=>setNomeMezzo(e.target.value)} required/><input placeholder="Targa" value={targaMezzo} onChange={e=>setTargaMezzo(e.target.value)}/><button>Aggiungi</button></form></section>
 </div>

 {selezionata&&<div className="modal"><div className="modalbox"><div className="bar"><div><h2 style={{margin:0}}>{selezionata.numero_missione}</h2><small>{selezionata.indirizzo} · {selezionata.stato_missione}</small></div><button onClick={()=>setSelezionata(null)}>CHIUDI</button></div>
 <section className="card"><b>Registro operativo</b><ul className="timeline">{registro.map(r=><li key={r.id}><span className="time">{formatTime(r.creato_il)}</span><span>{r.stato}{r.dettagli?.rifiutoTrasporto&&<span className="pill danger"> RIFIUTO TRASPORTO</span>}</span></li>)}</ul></section>
 <section className="card"><h3>Dati della scheda missione — modificabili dalla Centrale</h3>{CAMPI.map(s=><div key={s.section} style={{marginBottom:16}}><h4>{s.section}</h4><div className="grid">{s.fields.map(f=><Field key={f.key} f={f} value={scheda[f.key]} onChange={v=>setScheda(p=>({...p,[f.key]:v}))}/>)}</div></div>)}<button className="primary" disabled={salvando} onClick={salvaScheda}>{salvando?"SALVATAGGIO...":"SALVA MODIFICHE SCHEDA"}</button></section>
 <section className="card"><h3>Orari registrati</h3><div className="grid"><div>Attivazione<br/><b>{formatTime(selezionata.creato_il)}</b></div><div>Presa in carico<br/><b>{formatTime(selezionata.ora_presa_in_carico)}</b></div><div>Arrivo sul posto<br/><b>{formatTime(selezionata.ora_arrivo)}</b></div><div>Rientro<br/><b>{formatTime(selezionata.ora_rientro)}</b></div></div></section>
 </div></div>}
 </div>
}
