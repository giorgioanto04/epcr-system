import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, CircleMarker, useMap } from "react-leaflet";
import { io, Socket } from "socket.io-client";
import "leaflet/dist/leaflet.css";

const API_URL = import.meta.env.VITE_API_URL;
if (!API_URL) throw new Error("VITE_API_URL non configurata.");

type Mezzo = {
  id:string; nome:string; targa?:string|null;
  stato:"disponibile"|"impegnato"|"fuori_servizio";
  lat:number|null; lon:number|null; missione_numero?:string; intervento_id?:string;
};
type Cronologia = { id:string; intervento_id:string; mezzo_id:string|null; stato:string; registrato_il:string };
type Missione = {
  id:string; missione_numero:string; indirizzo:string; lat?:number|null; lon?:number|null;
  tipologia?:string; note?:string; priorita:"verde"|"giallo"|"rosso"; ospedale?:string|null;
  stato:string; creato_il:string; mezzi:Mezzo[]; scheda:any; cronologia?:Cronologia[];
};

const STATI = ["attivazione","partenza","arrivo_sul_posto","paziente_visto","partenza_ospedale","arrivo_ospedale","libero_in_ospedale","rientro","disponibile"];
const LABELS:any = {attivazione:"Attivazione",partenza:"Partenza",arrivo_sul_posto:"Arrivo sul posto",paziente_visto:"Paziente visto",partenza_ospedale:"Partenza ospedale",arrivo_ospedale:"Arrivo ospedale",libero_in_ospedale:"Libero in ospedale",rientro:"Rientro",disponibile:"Disponibile"};
const STATUS_LABEL:any = {disponibile:"Disponibile",impegnato:"Impegnato",fuori_servizio:"Fuori servizio",assegnato:"Assegnato",in_corso:"In corso",concluso:"Concluso",annullato:"Annullato"};
const COLORS:any = {verde:"#16a34a",giallo:"#ca8a04",rosso:"#dc2626"};

function FitMap({points}:{points:[number,number][]}) {
  const map=useMap();
  useEffect(()=>{ if(points.length) map.fitBounds(points,{padding:[35,35],maxZoom:13}); },[map,JSON.stringify(points)]);
  return null;
}
function Toggle({checked,onChange,label}:{checked:boolean;onChange:()=>void;label:string}) {
  return <button type="button" className={`check ${checked?"on":""}`} onClick={onChange}><span>✓</span>{label}</button>;
}
function downloadBlob(name:string,content:string,type="text/plain;charset=utf-8") {
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([content],{type})); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function escapeHtml(v:any){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]!));}

export default function App(){
  const [mezzi,setMezzi]=useState<Mezzo[]>([]);
  const [missioni,setMissioni]=useState<Missione[]>([]);
  const [giorno,setGiorno]=useState(new Date().toISOString().slice(0,10));
  const [tab,setTab]=useState<"attive"|"chiuse">("attive");
  const [selectedMezzo,setSelectedMezzo]=useState<string|null>(null);
  const [selectedMissione,setSelectedMissione]=useState<Missione|null>(null);
  const [modal,setModal]=useState<"nuova"|"mezzo"|null>(null);
  const [error,setError]=useState("");
  const [search,setSearch]=useState("");
  const [form,setForm]=useState({indirizzo:"",tipologia:"",note:"",priorita:"verde",ospedale:""});
  const [mezzoForm,setMezzoForm]=useState({id:"",nome:"",targa:""});
  const [sheet,setSheet]=useState<any>({});
  const [evalIndex,setEvalIndex]=useState(0);
  const [newBorn,setNewBorn]=useState("");
  const audioRef=useRef<HTMLAudioElement|null>(null);

  const refresh=async()=>{
    try {
      const [a,b]=await Promise.all([fetch(`${API_URL}/mezzi`),fetch(`${API_URL}/interventi?data=${giorno}`)]);
      if(!a.ok||!b.ok) throw new Error("Backend non raggiungibile");
      setMezzi(await a.json()); setMissioni(await b.json());
    } catch(e:any){setError(e.message||"Errore di connessione");}
  };

  useEffect(()=>{
    refresh();
    const s:Socket=io(API_URL,{transports:["websocket","polling"]});
    s.emit("registra",{ruolo:"centrale"});
    const upd=()=>refresh();
    ["posizione_mezzo","stato_mezzo","mezzo_creato","mezzo_aggiornato","mezzo_eliminato","nuovo_intervento","intervento_assegnato","intervento_confermato","intervento_concluso","intervento_eliminato","missione_aggiornata","stato_missione"].forEach(e=>s.on(e,upd));
    // Allarme CO quando una nuova attivazione arriva dal backend.
    s.on("intervento_assegnato",()=>{try{audioRef.current?.play().catch(()=>{});}catch{}});
    return()=>s.disconnect();
  },[giorno]);

  const active=useMemo(()=>missioni.filter(m=>!["concluso","annullato"].includes(m.stato)),[missioni]);
  const closed=useMemo(()=>missioni.filter(m=>["concluso","annullato"].includes(m.stato)),[missioni]);
  const shown=(tab==="attive"?active:closed).filter(m=>{
    const q=search.toLowerCase(); return !q || `${m.missione_numero} ${m.indirizzo} ${m.tipologia||""} ${m.stato}`.toLowerCase().includes(q);
  });
  const mapPoints:[number,number][]=useMemo(()=>[
    ...mezzi.filter(m=>m.lat!=null&&m.lon!=null).map(m=>[m.lat!,m.lon!] as [number,number]),
    ...missioni.filter(m=>m.lat!=null&&m.lon!=null).map(m=>[m.lat!,m.lon!] as [number,number])
  ],[mezzi,missioni]);

  const save=async(url:string,method:string,body:any)=>{
    const r=await fetch(`${API_URL}${url}`,{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d.errore||"Operazione non riuscita"); return d;
  };
  const createMission=async(e:any)=>{e.preventDefault();try{await save("/interventi","POST",form);setModal(null);setForm({indirizzo:"",tipologia:"",note:"",priorita:"verde",ospedale:""});refresh()}catch(e:any){setError(e.message)}};
  const assign=async(id:string,mezzoId:string)=>{try{await save(`/interventi/${id}/assegna`,"POST",{mezzoId});await openMission(id)}catch(e:any){setError(e.message)}};
  const setState=async(missioneId:string,mezzoId:string,stato:string)=>{try{await save(`/interventi/${missioneId}/stato`,"POST",{mezzoId,stato});await openMission(missioneId)}catch(e:any){setError(e.message)}};
  const deleteMission=async(id:string)=>{if(!confirm("Eliminare definitivamente questa missione?"))return;try{await save(`/interventi/${id}`,"DELETE",{});setSelectedMissione(null);refresh()}catch(e:any){setError(e.message)}};
  const setMezzoState=async(id:string,stato:string)=>{try{await save(`/mezzi/${id}/stato`,"PATCH",{stato});refresh()}catch(e:any){setError(e.message)}};
  const createOrEditMezzo=async(e:any)=>{e.preventDefault();try{if(mezzoForm.id)await save(`/mezzi/${mezzoForm.id}`,"PATCH",{nome:mezzoForm.nome,targa:mezzoForm.targa});else await save("/mezzi","POST",{nome:mezzoForm.nome,targa:mezzoForm.targa});setModal(null);setMezzoForm({id:"",nome:"",targa:""});refresh()}catch(e:any){setError(e.message)}};
  const deleteMezzo=async(id:string)=>{if(!confirm("Eliminare questo mezzo?"))return;try{await save(`/mezzi/${id}`,"DELETE",{});refresh()}catch(e:any){setError(e.message)}};
  const moveMezzo=async(lat:number,lon:number)=>{if(!selectedMezzo)return;try{await save(`/mezzi/${selectedMezzo}/posizione`,"POST",{lat,lon});refresh()}catch(e:any){setError(e.message)}};
  const openMission=async(id:string)=>{try{const m=await fetch(`${API_URL}/interventi/${id}`).then(r=>r.json());if(m.errore)throw new Error(m.errore);setSelectedMissione(m);setSheet(m.scheda||{});setNewBorn(m.scheda?.dataNascita||"")}catch(e:any){setError(e.message)}};
  const updateSheet=(k:string,v:any)=>setSheet((s:any)=>({...s,[k]:v}));
  const saveSheet=async()=>{if(!selectedMissione)return;try{await save(`/interventi/${selectedMissione.id}/scheda`,"PATCH",{scheda:{...sheet,dataNascita:newBorn},ospedale:selectedMissione.ospedale||null,priorita:selectedMissione.priorita});await openMission(selectedMissione.id);refresh()}catch(e:any){setError(e.message)}};
  const age=newBorn?Math.max(0,new Date().getFullYear()-new Date(newBorn).getFullYear()-((new Date().getMonth()<new Date(newBorn).getMonth()||new Date().getMonth()===new Date(newBorn).getMonth()&&new Date().getDate()<new Date(newBorn).getDate())?1:0)):"";

  const downloadMission=()=>{
    if(!selectedMissione)return;
    const m=selectedMissione, s=m.scheda||{};
    const html=`<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Scheda ${escapeHtml(m.missione_numero)}</title><style>body{font-family:Arial;margin:30px;color:#111}h1{margin-bottom:4px}h2{border-bottom:1px solid #ccc;padding-bottom:5px}table{border-collapse:collapse;width:100%;margin:10px 0}td,th{border:1px solid #ccc;padding:6px;text-align:left} .tag{display:inline-block;padding:4px 8px;border-radius:8px;background:#eee;margin:3px}</style></head><body><h1>Scheda missione ${escapeHtml(m.missione_numero)}</h1><p><b>${escapeHtml(m.indirizzo)}</b> · ${escapeHtml(m.tipologia)} · priorità ${escapeHtml(m.priorita)}</p><p>${escapeHtml(m.note)}</p><h2>Mezzi</h2><table><tr><th>Mezzo</th><th>Targa</th><th>Stato</th></tr>${(m.mezzi||[]).map((z:any)=>`<tr><td>${escapeHtml(z.nome)}</td><td>${escapeHtml(z.targa)}</td><td>${escapeHtml(STATUS_LABEL[z.stato]||z.stato)}</td></tr>`).join("")}</table><h2>Assistito</h2><p>${escapeHtml(s.nome||"")} ${escapeHtml(s.cognome||"")} · ${escapeHtml(s.dataNascita||"")} · ${escapeHtml(s.sesso||"")} · età ${escapeHtml(age)}</p><h2>Scheda completa</h2><pre>${escapeHtml(JSON.stringify(s,null,2))}</pre><h2>Cronologia</h2><table><tr><th>Ora</th><th>Mezzo</th><th>Stato</th></tr>${(m.cronologia||[]).map(c=>`<tr><td>${new Date(c.registrato_il).toLocaleString("it-IT")}</td><td>${escapeHtml((m.mezzi||[]).find((z:any)=>z.id===c.mezzo_id)?.nome||"")}</td><td>${escapeHtml(LABELS[c.stato]||c.stato)}</td></tr>`).join("")}</table></body></html>`;
    downloadBlob(`scheda_${m.missione_numero}.html`,html,"text/html;charset=utf-8");
  };
  const downloadBrogliaccio=()=>{
    const rows=[["Data/ora","Missione","Indirizzo","Mezzo","Stato","Evento"]];
    missioni.forEach(m=>(m.cronologia||[]).forEach(c=>rows.push([new Date(c.registrato_il).toLocaleString("it-IT"),m.missione_numero,m.indirizzo,(m.mezzi||[]).find(z=>z.id===c.mezzo_id)?.nome||"",LABELS[c.stato]||c.stato,"Cambio stato"])));
    // Le liste giornaliere non hanno cronologia: scarica anche un riepilogo missioni.
    missioni.forEach(m=>{if(!(m.cronologia||[]).length)rows.push([new Date(m.creato_il).toLocaleString("it-IT"),m.missione_numero,m.indirizzo,(m.mezzi||[]).map(z=>z.nome).join(" | "),STATUS_LABEL[m.stato]||m.stato,"Missione"]);});
    downloadBlob(`brogliaccio_${giorno}.csv`,"\ufeff"+rows.map(r=>r.map(x=>`"${String(x??"").replace(/"/g,'""')}"`).join(";")).join("\n"),"text/csv;charset=utf-8");
  };

  return <div className="app">
    <audio ref={audioRef} src="/attivazione_alta_priorita.wav" preload="auto" />
    <header className="topbar"><div><div className="brand">IRIS <span>v2</span></div><div className="sub">Centrale Operativa · gestione missioni, mezzi e schede</div></div><div className="topActions"><span className="live">● REALTIME</span><label>Giornata <input type="date" value={giorno} onChange={e=>setGiorno(e.target.value)}/></label><button onClick={()=>audioRef.current?.play().catch(()=>setError("Il browser richiede un'interazione per attivare l'audio."))}>🔊 Test suoneria</button></div></header>
    {error&&<div className="error">{error}<button onClick={()=>setError("")}>×</button></div>}
    <div className="workspace">
      <aside className="left">
        <button className="newMission" onClick={()=>setModal("nuova")}>＋ Nuova missione</button>
        <div className="panelTitle">STATO MEZZI <span>{mezzi.length}</span></div>
        <div className="fleet">
          {mezzi.map(m=><div key={m.id} className={`fleetRow ${selectedMezzo===m.id?"selected":""}`} onClick={()=>setSelectedMezzo(m.id)}>
            <div className="fleetDot" style={{background:m.stato==="disponibile"?"#16a34a":m.stato==="impegnato"?"#f97316":"#64748b"}}/>
            <div className="fleetMain"><b>{m.nome}</b><small>{m.targa||"senza targa"}{m.missione_numero?` · ${m.missione_numero}`:""}</small></div>
            <select value={m.stato} onChange={e=>setMezzoState(m.id,e.target.value)} onClick={e=>e.stopPropagation()}><option value="disponibile">Disponibile</option><option value="impegnato">Impegnato</option><option value="fuori_servizio">Fuori servizio</option></select>
          </div>)}
          {!mezzi.length&&<div className="empty">Nessun mezzo configurato.</div>}
          <button className="secondary full" onClick={()=>{setMezzoForm({id:"",nome:"",targa:""});setModal("mezzo")}}>＋ Aggiungi mezzo</button>
        </div>
        <div className="panelTitle">LEGENDA</div>
        <div className="legend"><span><i className="legendDot green"/> Disponibile</span><span><i className="legendDot orange"/> Impegnato</span><span><i className="legendDot gray"/> Fuori servizio</span></div>
      </aside>

      <main className="mapPanel">
        <MapContainer center={[45.4642,9.19]} zoom={12} style={{height:"100%",width:"100%"}}>
          <TileLayer attribution="© OpenStreetMap" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>
          <FitMap points={mapPoints}/>
          {missioni.filter(m=>m.lat!=null&&m.lon!=null).map(m=><CircleMarker key={`mission-${m.id}`} center={[m.lat!,m.lon!]} radius={10} pathOptions={{color:COLORS[m.priorita],fillColor:COLORS[m.priorita],fillOpacity:.55}} eventHandlers={{click:()=>openMission(m.id)}}><Popup><b>{m.missione_numero}</b><br/>{m.indirizzo}<br/><button onClick={()=>openMission(m.id)}>Apri missione</button></Popup></CircleMarker>)}
          {mezzi.filter(m=>m.lat!=null&&m.lon!=null).map(m=><Marker key={m.id} position={[m.lat!,m.lon!]} eventHandlers={{click:()=>setSelectedMezzo(m.id)}}><Popup><b>{m.nome}</b><br/>{STATUS_LABEL[m.stato]||m.stato}{m.missione_numero&&<><br/>{m.missione_numero}</>}</Popup></Marker>)}
        </MapContainer>
        <div className="mapOverlay"><b>MAPPA OPERATIVA</b><span>{mezzi.filter(m=>m.lat!=null&&m.lon!=null).length} mezzi · {active.length} missioni attive</span></div>
        <div className="mapHint">Seleziona un mezzo a sinistra e clicca sulla mappa per aggiornarne la posizione.</div>
      </main>

      <aside className="right">
        <div className="rightHead"><div><h2>Missioni</h2><small>{new Date(giorno+"T12:00:00").toLocaleDateString("it-IT")}</small></div><button onClick={downloadBrogliaccio} title="Scarica brogliaccio evento">⇩ Brogliaccio</button></div>
        <div className="tabs"><button className={tab==="attive"?"active":""} onClick={()=>setTab("attive")}>Aperte <b>{active.length}</b></button><button className={tab==="chiuse"?"active":""} onClick={()=>setTab("chiuse")}>Chiuse <b>{closed.length}</b></button></div>
        <input className="search" placeholder="Cerca missione, indirizzo, stato..." value={search} onChange={e=>setSearch(e.target.value)}/>
        <div className="missionList">{shown.map(m=><article key={m.id} className="missionCard" onClick={()=>openMission(m.id)}>
          <div className="missionTop"><b>{m.missione_numero}</b><span className={`prio ${m.priorita}`}>{m.priorita.toUpperCase()}</span></div>
          <strong>{m.indirizzo}</strong><small>{m.tipologia||"Missione"} · {STATUS_LABEL[m.stato]||m.stato}</small>
          <div className="missionMeta"><span>{(m.mezzi||[]).map(z=>z.nome).join(", ")||"Nessun mezzo"}</span><button onClick={e=>{e.stopPropagation();openMission(m.id)}}>Scheda →</button></div>
        </article>)}{!shown.length&&<div className="empty">Nessuna missione {tab==="attive"?"aperta":"chiusa"} per la giornata.</div>}</div>
      </aside>
    </div>

    {selectedMissione&&<div className="drawerBack" onMouseDown={e=>{if(e.target===e.currentTarget)setSelectedMissione(null)}}>
      <section className="drawer">
        <div className="drawerHead"><div><span className={`prio ${selectedMissione.priorita}`}>{selectedMissione.priorita.toUpperCase()}</span><b>{selectedMissione.missione_numero}</b><h2>{selectedMissione.indirizzo}</h2><small>{selectedMissione.tipologia||"Missione"} · {STATUS_LABEL[selectedMissione.stato]||selectedMissione.stato}</small></div><div className="drawerActions"><button onClick={downloadMission}>⇩ Scheda</button><button onClick={()=>setSelectedMissione(null)}>×</button></div></div>
        <div className="drawerBody">
          <section className="detailCard"><h3>Stati dei mezzi</h3>{(selectedMissione.mezzi||[]).length?(selectedMissione.mezzi||[]).map(m=><div className="unitBlock" key={m.id}><div className="unitHead"><b>{m.nome}</b><span>{STATUS_LABEL[m.stato]||m.stato}</span></div><div className="stateGrid">{STATI.map(st=><button key={st} className={(selectedMissione.cronologia||[]).slice().reverse().find(c=>c.mezzo_id===m.id)?.stato===st?"on":""} onClick={()=>setState(selectedMissione.id,m.id,st)}>{LABELS[st]}</button>)}</div></div>):<div className="empty">Nessun mezzo associato.</div>}
          <h3>Assegna un altro mezzo</h3><div className="chips">{mezzi.filter(m=>!(selectedMissione.mezzi||[]).some(x=>x.id===m.id)).map(m=><button key={m.id} onClick={()=>assign(selectedMissione.id,m.id)} disabled={m.stato==="fuori_servizio"}>{m.nome} · {STATUS_LABEL[m.stato]}</button>)}</div></section>
          <section className="detailCard"><h3>Scheda missione</h3>
            <div className="grid"><label>Data di nascita<input type="date" value={newBorn} onChange={e=>{setNewBorn(e.target.value);updateSheet("dataNascita",e.target.value)}}/></label><label>Età<input value={age} readOnly/></label><label>Cognome<input value={sheet.cognome||""} onChange={e=>updateSheet("cognome",e.target.value)}/></label><label>Nome<input value={sheet.nome||""} onChange={e=>updateSheet("nome",e.target.value)}/></label><label>Sesso<select value={sheet.sesso||""} onChange={e=>updateSheet("sesso",e.target.value)}><option value="">—</option><option>M</option><option>F</option></select></label><label>Ospedale<input value={selectedMissione.ospedale||""} onChange={e=>setSelectedMissione({...selectedMissione,ospedale:e.target.value})}/></label></div>
            <h4>Evento</h4><div className="checks">{["casa","strada","uffici_esercizi","impianto_sportivo","impianto_lavorativo","avvelenamento","evento_violento","precipitato","pedone_ciclo","conducente_moto","malore","travaglio_parto","infortunio","auto","passeggero"].map(k=><Toggle key={k} label={k.replaceAll("_"," ")} checked={!!sheet[k]} onChange={()=>updateSheet(k,!sheet[k])}/>)}</div>
            <h4>Valutazione paziente</h4><div className="evalSelector"><select value={evalIndex} onChange={e=>setEvalIndex(Number(e.target.value))}><option value={0}>1ª valutazione</option><option value={1}>2ª valutazione</option><option value={2}>3ª valutazione</option></select><Toggle label="Effettuata" checked={!!sheet[`eval${evalIndex}`]?.attiva} onChange={()=>updateSheet(`eval${evalIndex}`,{...(sheet[`eval${evalIndex}`]||{}),attiva:!sheet[`eval${evalIndex}`]?.attiva,ora:sheet[`eval${evalIndex}`]?.ora||new Date().toTimeString().slice(0,5)})}/><label>Ora<input type="time" value={sheet[`eval${evalIndex}`]?.ora||""} onChange={e=>updateSheet(`eval${evalIndex}`,{...(sheet[`eval${evalIndex}`]||{}),ora:e.target.value})}/></label></div>
            <div className="grid">{["fr","fc","satAria","satO2","pa","temp","glicemia"].map(k=><label key={k}>{({fr:"FR",fc:"FC",satAria:"Sat. aria",satO2:"Sat. O₂",pa:"PA",temp:"Temperatura °C",glicemia:"Glicemia"} as any)[k]}<input value={sheet[`eval${evalIndex}`]?.[k]||""} onChange={e=>updateSheet(`eval${evalIndex}`,{...(sheet[`eval${evalIndex}`]||{}),[k]:e.target.value})}/></label>)}</div>
            <h4>CPSS</h4><div className="checks">{["deviazione_rima_labiale","segni_di_lato","alterazioni_linguaggio"].map(k=><Toggle key={k} label={k.replaceAll("_"," ")} checked={!!sheet[k]} onChange={()=>updateSheet(k,!sheet[k])}/>)}</div>
            <h4>Prestazioni / interventi</h4><div className="checks">{["ossigeno","aspirazione_cavo_orale","cannula","ventilazione","rcp","dae","trasmissione_ecg","rimozione_casco","collare_cervicale","estricazione"].map(k=><Toggle key={k} label={k.replaceAll("_"," ")} checked={!!sheet[`prest_${k}`]} onChange={()=>updateSheet(`prest_${k}`,!sheet[`prest_${k}`])}/>)}</div>
            <h4>Presidi utilizzati</h4><div className="checks">{["barella_cucchiaio","tavola_spinale","sedia_portantina","materasso_depressione","estricatore","steccobenda","telo_porta_feriti","fascia_emostatica","medicazione_ferite","immobilizzazione_arti","immobilizzazione_spinale","protezione_termica"].map(k=><Toggle key={k} label={k.replaceAll("_"," ")} checked={!!sheet[`pres_${k}`]} onChange={()=>updateSheet(`pres_${k}`,!sheet[`pres_${k}`])}/>)}</div>
            <h4>Lesioni</h4><div className="checks">{["amputazione","frattura_esposta","deformita","dolore","sanguinamento","emorragia_massiva","ferita","ferita_penetrante","lacerazione_schiacciamento","contusione","ustione","proiettato","edema","lesioni_incompatibili_vita","accesso_difficile","presenza_deceduti","incastrato","estricazione_20_min","motilita_assente","sensibilita_assente"].map(k=><Toggle key={k} label={k.replaceAll("_"," ")} checked={!!sheet[`les_${k}`]} onChange={()=>updateSheet(`les_${k}`,!sheet[`les_${k}`])}/>)}</div>
            <h4>Destinazione / note</h4><div className="grid"><label>Destinazione<select value={sheet.destinazioneTipo||""} onChange={e=>updateSheet("destinazioneTipo",e.target.value)}><option value="">—</option><option value="ps">Pronto Soccorso</option><option value="altro">Altro</option></select></label></div><textarea className="wide" value={sheet.anamnesi||""} onChange={e=>updateSheet("anamnesi",e.target.value)} placeholder="Anamnesi / relazione di soccorso"/><button className="save full" onClick={saveSheet}>Salva scheda</button>
          </section>
          <section className="detailCard"><div className="historyHead"><h3>Brogliaccio missione</h3><button onClick={downloadMission}>⇩ Scarica</button></div>{(selectedMissione.cronologia||[]).length?<div className="timeline">{selectedMissione.cronologia!.slice().reverse().map(c=><div className="timelineRow" key={c.id}><time>{new Date(c.registrato_il).toLocaleString("it-IT")}</time><b>{LABELS[c.stato]||c.stato}</b><span>{(selectedMissione.mezzi||[]).find(z=>z.id===c.mezzo_id)?.nome||"Sistema"}</span></div>)}</div>:<div className="empty">Nessun evento registrato.</div>}</section>
        </div>
      </section>
    </div>}

    {modal&&<div className="modalBack" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null)}}><div className="modal"><button className="close" onClick={()=>setModal(null)}>×</button>{modal==="nuova"?<><h2>Nuova missione</h2><form onSubmit={createMission}><input placeholder="Luogo / indirizzo *" required value={form.indirizzo} onChange={e=>setForm({...form,indirizzo:e.target.value})}/><div className="grid"><select value={form.priorita} onChange={e=>setForm({...form,priorita:e.target.value})}><option value="verde">VERDE</option><option value="giallo">GIALLO</option><option value="rosso">ROSSO</option></select><input placeholder="Tipologia" value={form.tipologia} onChange={e=>setForm({...form,tipologia:e.target.value})}/></div><input placeholder="Ospedale (se noto)" value={form.ospedale} onChange={e=>setForm({...form,ospedale:e.target.value})}/><textarea placeholder="Note" value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/><button className="save full">Crea missione</button></form></>:<><h2>{mezzoForm.id?"Modifica mezzo":"Nuovo mezzo"}</h2><form onSubmit={createOrEditMezzo}><input placeholder="Nome mezzo" required value={mezzoForm.nome} onChange={e=>setMezzoForm({...mezzoForm,nome:e.target.value})}/><input placeholder="Targa" value={mezzoForm.targa} onChange={e=>setMezzoForm({...mezzoForm,targa:e.target.value})}/><button className="save full">Salva</button></form>{mezzoForm.id&&<button className="danger full" onClick={()=>{deleteMezzo(mezzoForm.id);setModal(null)}}>Elimina mezzo</button>}</>}</div></div>}
  </div>;
}
