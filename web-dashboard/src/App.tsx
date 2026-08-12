import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, CircleMarker, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { io, Socket } from "socket.io-client";
import "leaflet/dist/leaflet.css";

const API_URL = import.meta.env.VITE_API_URL;
if (!API_URL) throw new Error("VITE_API_URL non configurata.");

type Mezzo = {
  id:string; nome:string; targa?:string|null;
  stato:"disponibile"|"impegnato"|"fuori_servizio";
  lat:number|null; lon:number|null; missione_numero?:string; intervento_id?:string;
  ultimo_stato?:string|null; assegnabile?:boolean;
};
type Poi = { id:string; tipo:"squadra"|"intervento"|"posto_comando"|"punto_raccolta"|"altro"; etichetta:string; note?:string|null; lat:number; lon:number; creato_il:string };
const POI_COLORS:any = {squadra:"#2563eb",intervento:"#dc2626",posto_comando:"#7c3aed",punto_raccolta:"#0891b2",altro:"#64748b"};
const POI_LABELS:any = {squadra:"Squadra",intervento:"Intervento",posto_comando:"Posto di comando",punto_raccolta:"Punto di raccolta",altro:"Altro"};
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
function MapClicks({onClick}:{onClick:(lat:number,lon:number)=>void}) {
  useMapEvents({click:(e)=>onClick(e.latlng.lat,e.latlng.lng)});
  return null;
}
function Toggle({checked,onChange,label}:{checked:boolean;onChange:()=>void;label:string}) {
  return <button type="button" className={`check ${checked?"on":""}`} onClick={onChange}><span>✓</span>{label}</button>;
}
function Radio({value,onChange,options}:{value:string;onChange:(v:string)=>void;options:[string,string][]}) {
  return <div className="checks">{options.map(([k,label])=><button type="button" key={k} className={`check ${value===k?"on":""}`} onClick={()=>onChange(value===k?"":k)}><span>✓</span>{label}</button>)}</div>;
}
function inArr(arr:string[]|undefined,v:string){return !!arr&&arr.includes(v);}
function toggleArr(arr:string[]|undefined,v:string){const a=arr||[];return a.includes(v)?a.filter(x=>x!==v):[...a,v];}

const COSCIENZA_OPZ:[string,string][]=[["sveglio","Sveglio (A)"],["reag_chiamata","Reagisce a chiamata (V)"],["reag_dolore","Reagisce a dolore (P)"],["incosciente","Incosciente (U)"]];
const RESPIRO_OPZ:[string,string][]=[["normale","Normale"],["difficoltoso","Difficoltoso"],["assente","Assente"]];
const CIRCOLO_OPZ:[string,string][]=[["periferico","Periferico"],["centrale","Centrale"],["ritmico","Ritmico"],["aritmico","Aritmico"],["assente","Assente"]];
const CUTE_OPZ:[string,string][]=[["calda","Calda"],["fredda","Fredda"],["rosea","Rosea"],["cianotica","Cianotica"],["pallida","Pallida"],["sudata","Sudata"]];
const POSTURA_OPZ:[string,string][]=[["in_piedi","In piedi"],["seduta","Seduta"],["prona","Prona"],["supina","Supina"],["laterale","Laterale"]];
const LUOGO_EVENTO_OPZ:[string,string][]=[["casa","Casa"],["strada","Strada"],["uffici_esercizi_pubb","Uffici / esercizi pubb."],["imp_sportivo","Impianto sportivo"],["imp_lavorativo","Impianto lavorativo"],["altro","Altro"]];
const CODICE_OPZ:[string,string][]=[["verde","VERDE"],["giallo","GIALLO"],["rosso","ROSSO"]];
const EVENTI_OPZ:[string,string][]=[["perdita_coscienza","Perdita di coscienza"],["problem_respirat","Problematiche respiratorie"],["malore","Malore"],["convulsioni","Convulsioni"],["avvelenamenti","Avvelenamenti"],["travaglio_parto","Travaglio / parto"],["malessere","Malessere"],["caduta","Caduta"],["evento_violento","Evento violento"],["infortunio","Infortunio"]];
function downloadBlob(name:string,content:string,type="text/plain;charset=utf-8") {
  const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([content],{type})); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function escapeHtml(v:any){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]!));}

export default function App(){
  const [mezzi,setMezzi]=useState<Mezzo[]>([]);
  const [missioni,setMissioni]=useState<Missione[]>([]);
  const [poi,setPoi]=useState<Poi[]>([]);
  const [giorno,setGiorno]=useState(new Date().toISOString().slice(0,10));
  const [tab,setTab]=useState<"attive"|"chiuse">("attive");
  const [selectedMezzo,setSelectedMezzo]=useState<string|null>(null);
  const [selectedMissione,setSelectedMissione]=useState<Missione|null>(null);
  const [modal,setModal]=useState<"nuova"|"mezzo"|"poi"|null>(null);
  const [error,setError]=useState("");
  const [search,setSearch]=useState("");
  const [form,setForm]=useState({indirizzo:"",tipologia:"",note:"",priorita:"verde",ospedale:""});
  const [mezzoForm,setMezzoForm]=useState({id:"",nome:"",targa:""});
  const [poiForm,setPoiForm]=useState({id:"",tipo:"squadra",etichetta:"",note:"",lat:0,lon:0});
  const [placingPoi,setPlacingPoi]=useState(false);
  const [sheet,setSheet]=useState<any>({});
  const [evalIndex,setEvalIndex]=useState(0);
  const [newBorn,setNewBorn]=useState("");
  const audioRef=useRef<HTMLAudioElement|null>(null);

  const refresh=async()=>{
    try {
      const [a,b,c]=await Promise.all([fetch(`${API_URL}/mezzi`),fetch(`${API_URL}/interventi?data=${giorno}`),fetch(`${API_URL}/poi`)]);
      if(!a.ok||!b.ok) throw new Error("Backend non raggiungibile");
      setMezzi(await a.json()); setMissioni(await b.json()); if(c.ok) setPoi(await c.json());
    } catch(e:any){setError(e.message||"Errore di connessione");}
  };

  useEffect(()=>{
    refresh();
    const s:Socket=io(API_URL,{transports:["websocket","polling"]});
    s.emit("registra",{ruolo:"centrale"});
    const upd=()=>refresh();
    ["posizione_mezzo","stato_mezzo","mezzo_creato","mezzo_aggiornato","mezzo_eliminato","nuovo_intervento","intervento_assegnato","intervento_confermato","intervento_concluso","intervento_eliminato","missione_aggiornata","stato_missione","poi_creato","poi_aggiornato","poi_eliminato"].forEach(e=>s.on(e,upd));
    // Allarme CO quando una nuova attivazione arriva dal backend.
    s.on("intervento_assegnato",()=>{try{if(audioRef.current){audioRef.current.currentTime=0;audioRef.current.play().catch(()=>{});}}catch{}});
    return()=>s.disconnect();
  },[giorno]);

  const active=useMemo(()=>missioni.filter(m=>!["concluso","annullato"].includes(m.stato)),[missioni]);
  const closed=useMemo(()=>missioni.filter(m=>["concluso","annullato"].includes(m.stato)),[missioni]);
  const shown=(tab==="attive"?active:closed).filter(m=>{
    const q=search.toLowerCase(); return !q || `${m.missione_numero} ${m.indirizzo} ${m.tipologia||""} ${m.stato}`.toLowerCase().includes(q);
  });
  const mapPoints:[number,number][]=useMemo(()=>[
    ...mezzi.filter(m=>m.lat!=null&&m.lon!=null).map(m=>[m.lat!,m.lon!] as [number,number]),
    ...missioni.filter(m=>m.lat!=null&&m.lon!=null).map(m=>[m.lat!,m.lon!] as [number,number]),
    ...poi.map(p=>[p.lat,p.lon] as [number,number])
  ],[mezzi,missioni,poi]);

  const save=async(url:string,method:string,body:any)=>{
    const r=await fetch(`${API_URL}${url}`,{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d.errore||"Operazione non riuscita"); return d;
  };
  const createMission=async(e:any)=>{e.preventDefault();try{await save("/interventi","POST",form);setModal(null);setForm({indirizzo:"",tipologia:"",note:"",priorita:"verde",ospedale:""});refresh()}catch(e:any){setError(e.message)}};
  const assign=async(id:string,mezzoId:string)=>{try{await save(`/interventi/${id}/assegna`,"POST",{mezzoId});await openMission(id)}catch(e:any){setError(e.message)}};
  const setState=async(missioneId:string,mezzoId:string,stato:string)=>{try{await save(`/interventi/${missioneId}/stato`,"POST",{mezzoId,stato});await openMission(missioneId)}catch(e:any){setError(e.message)}};
  const deleteMission=async(id:string)=>{if(!confirm("Eliminare definitivamente questa missione?"))return;try{await save(`/interventi/${id}`,"DELETE",{});setSelectedMissione(null);refresh()}catch(e:any){setError(e.message)}};
  const closeMission=async(id:string)=>{if(!confirm("Chiudere questa missione? Dopo la chiusura comparirà nella scheda CHIUSE."))return;try{await save(`/interventi/${id}/chiudi`,"POST",{});await openMission(id);refresh();setTab("chiuse")}catch(e:any){setError(e.message)}};
  const removeAssignedMezzo=async(missioneId:string,mezzoId:string)=>{if(!confirm("Rimuovere questo mezzo dalla missione?"))return;try{await save(`/interventi/${missioneId}/mezzi/${mezzoId}`,"DELETE",{});await openMission(missioneId);refresh()}catch(e:any){setError(e.message)}};
  const setMezzoState=async(id:string,stato:string)=>{try{await save(`/mezzi/${id}/stato`,"PATCH",{stato});refresh()}catch(e:any){setError(e.message)}};
  const createOrEditMezzo=async(e:any)=>{e.preventDefault();try{if(mezzoForm.id)await save(`/mezzi/${mezzoForm.id}`,"PATCH",{nome:mezzoForm.nome,targa:mezzoForm.targa});else await save("/mezzi","POST",{nome:mezzoForm.nome,targa:mezzoForm.targa});setModal(null);setMezzoForm({id:"",nome:"",targa:""});refresh()}catch(e:any){setError(e.message)}};
  const deleteMezzo=async(id:string)=>{if(!confirm("Eliminare questo mezzo?"))return;try{await save(`/mezzi/${id}`,"DELETE",{});refresh()}catch(e:any){setError(e.message)}};
  const moveMezzo=async(lat:number,lon:number)=>{if(!selectedMezzo)return;try{await save(`/mezzi/${selectedMezzo}/posizione`,"POST",{lat,lon});refresh()}catch(e:any){setError(e.message)}};
  const mapClicked=(lat:number,lon:number)=>{
    if(placingPoi){setPoiForm({id:"",tipo:"squadra",etichetta:"",note:"",lat,lon});setModal("poi");setPlacingPoi(false);return;}
    if(selectedMezzo)moveMezzo(lat,lon);
  };
  const savePoi=async(e:any)=>{e.preventDefault();try{if(poiForm.id)await save(`/poi/${poiForm.id}`,"PATCH",{etichetta:poiForm.etichetta,note:poiForm.note});else await save("/poi","POST",poiForm);setModal(null);refresh()}catch(e:any){setError(e.message)}};
  const deletePoi=async(id:string)=>{if(!confirm("Rimuovere questo punto dalla mappa?"))return;try{await save(`/poi/${id}`,"DELETE",{});refresh()}catch(e:any){setError(e.message)}};
  const openMission=async(id:string)=>{try{const m=await fetch(`${API_URL}/interventi/${id}`).then(r=>r.json());if(m.errore)throw new Error(m.errore);setSelectedMissione(m);setSheet(m.scheda||{});setNewBorn(m.scheda?.dataNascita||"")}catch(e:any){setError(e.message)}};
  const updateSheet=(k:string,v:any)=>setSheet((s:any)=>({...s,[k]:v}));
  const saveSheet=async()=>{if(!selectedMissione)return;try{await save(`/interventi/${selectedMissione.id}/scheda`,"PATCH",{scheda:{...sheet,dataNascita:newBorn},ospedale:selectedMissione.ospedale||null,priorita:selectedMissione.priorita});await openMission(selectedMissione.id);refresh()}catch(e:any){setError(e.message)}};
  const age=newBorn?Math.max(0,new Date().getFullYear()-new Date(newBorn).getFullYear()-((new Date().getMonth()<new Date(newBorn).getMonth()||new Date().getMonth()===new Date(newBorn).getMonth()&&new Date().getDate()<new Date(newBorn).getDate())?1:0)):"";

  const downloadMission=()=>{
    if(!selectedMissione)return;
    const m=selectedMissione, s=m.scheda||{};
    const labels:Record<string,string>={cognome:"Cognome",nome:"Nome",dataNascita:"Data di nascita",sesso:"Sesso",cittadinanza:"Cittadinanza",anamnesi:"Anamnesi / relazione di soccorso",ospedale:"Azienda / istituto",matricola_compilatore:"N. matricola compilatore",ora_accettazione:"Ora accettazione",codice_invio:"Codice invio",codice_trasporto:"Codice trasporto"};
    const pretty=(k:string)=>labels[k]||k.replace(/^prest_/,'').replace(/^pres_/,'').replace(/^les_/,'').replace(/^ev_/,'').replace(/^is_/,'').replace(/^acc_/,'').replace(/^odv_/,'').replace(/_zona$/,' zona').replace(/_intensita$/,' intensità').replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
    const val=(v:any)=>v===true?'Sì':v===false?'No':Array.isArray(v)?v.join(', '):String(v??'').trim();
    const section=(title:string,body:string)=>body?`<h2>${escapeHtml(title)}</h2><table>${body}</table>`:'';
    const rowsFor=(keys:[string,any][])=>keys.map(([k,v])=>{const text=val(v);return text?`<tr><th>${escapeHtml(pretty(k))}</th><td>${escapeHtml(text)}</td></tr>`:''}).join('');

    const soccorso=rowsFor([["luogo_comune",s.luogo_comune],["luogo_via",s.luogo_via],["luogo_civico",s.luogo_civico],["luogo_piano_scala",s.luogo_piano_scala],["Domicilio paziente",s.luogo_domicilio],["note_soreu",s.note_soreu],
      ["Presenti",[["presenti_msa1","MSA1"],["presenti_msa2","MSA2"],["presenti_cnsas","CNSAS"],["presenti_vvf","VVF"],["presenti_cc","CC"],["presenti_polizia","Polizia"]].filter(([k])=>s[k]).map(([,l])=>l).concat(s.presenti_medico?[`Medico${s.presenti_medico_nome?` (${s.presenti_medico_nome})`:''}`]:[]).concat(s.presenti_altro?[`Altro${s.presenti_altro_testo?` (${s.presenti_altro_testo})`:''}`]:[]).join(', ')]]);

    const paziente=rowsFor([["Paziente sconosciuto",s.sconosciuto],["cognome",s.cognome],["nome",s.nome],["dataNascita",s.dataNascita],["Età",age],["sesso",s.sesso],["cittadinanza",s.cittadinanza],["residenza_comune",s.residenza_comune],["residenza_via",s.residenza_via],["residenza_civico",s.residenza_civico]]);

    const eventoSelezionati=EVENTI_OPZ.filter(([k])=>s[`ev_${k}`]).map(([,l])=>l);
    if(s.ev_precipitato) eventoSelezionati.push(`Precipitato da ${s.ev_precipitato_metri||'?'} m`);
    if(s.ev_incidente_stradale){const sub=[["is_pedone_ciclo","Pedone/ciclo"],["is_conducente","Conducente"],["is_moto","Moto"],["is_auto","Auto"],["is_passeggero","Passeggero"]].filter(([k])=>s[k]).map(([,l])=>l);eventoSelezionati.push(`Incidente stradale${sub.length?` (${sub.join(', ')})`:''}`);}
    const luogoEvLabel=LUOGO_EVENTO_OPZ.find(([k])=>k===s.luogo_evento)?.[1];
    const evento=rowsFor([["Tipologia evento",eventoSelezionati.join(', ')],["Luogo dell'evento",luogoEvLabel?`${luogoEvLabel}${s.luogo_evento_altro?` (${s.luogo_evento_altro})`:''}`:''],["Postura di rinvenimento",POSTURA_OPZ.find(([k])=>k===s.postura)?.[1]],["ora_insorgenza",s.ora_insorgenza]]);

    let valutazioni='';
    [0,1,2].forEach(i=>{const e=s[`eval${i}`];if(e&&(e.attiva||Object.keys(e).length>1)){
      valutazioni+=rowsFor([[`${i+1}ª valutazione`,e.ora?`ore ${e.ora}`:'effettuata'],["Coscienza",COSCIENZA_OPZ.find(([k])=>k===e.coscienza)?.[1]],["Respiro",RESPIRO_OPZ.find(([k])=>k===e.respiro)?.[1]],["Circolo",(e.circolo||[]).map((k:string)=>CIRCOLO_OPZ.find(o=>o[0]===k)?.[1]).join(', ')],["Cute",(e.cute||[]).map((k:string)=>CUTE_OPZ.find(o=>o[0]===k)?.[1]).join(', ')],["FR",e.fr],["FC",e.fc],["Sat. aria",e.satAria],["Sat. O₂",e.satO2],["PA",e.pa],["Temperatura",e.temp],["Glicemia",e.glicemia]]);
    }});
    const cpss=["deviazione_rima_labiale","segni_di_lato","alterazioni_linguaggio"].filter(k=>s[k]).map(k=>pretty(k)).join(', ');
    if(cpss) valutazioni+=`<tr><th>CPSS positiva</th><td>${escapeHtml(cpss)}</td></tr>`;

    const prestazioni=rowsFor([["Ossigeno l/min",s.prest_ossigeno_lmin],...Object.keys(s).filter(k=>k.startsWith('prest_')&&k!=='prest_ossigeno_lmin'&&k!=='prest_estricazione_rapida'&&s[k]).map(k=>[k,k==='prest_estricazione'&&s.prest_estricazione_rapida?'Sì (rapida)':true] as [string,any])]);
    const presidi=rowsFor(Object.keys(s).filter(k=>k.startsWith('pres_')&&s[k]).map(k=>[k,true] as [string,any]));
    const lesioni=rowsFor(Object.keys(s).filter(k=>k.startsWith('les_')&&!k.endsWith('_zona')&&!k.endsWith('_intensita')&&s[k]).map(k=>{const zona=s[`${k}_zona`];const intens=k==='les_dolore'&&s.les_dolore_intensita?` (${s.les_dolore_intensita}/10)`:'';return [k,zona?`Sì – ${zona}${intens}`:`Sì${intens}`] as [string,any];}));

    const acc=rowsFor([["acc_rilevato_da",s.acc_rilevato_da],["RCP già in corso",s.acc_rcp_gia_in_corso],["acc_inizio_rcp",s.acc_inizio_rcp],["ACC durante il trasporto",s.acc_durante_trasporto],["acc_nr_shock",s.acc_nr_shock],["Trasporto con RCP",s.acc_trasporto_con_rcp],["Deceduto",s.acc_deceduto],["acc_rosc",s.acc_rosc]]);
    const anamnesi=s.anamnesi?`<tr><th>Note / Anamnesi AMPIA</th><td>${escapeHtml(s.anamnesi)}</td></tr>`:'';

    const rifiuto=rowsFor([["Rifiuto trasporto",s.rifiuto_trasporto],["Rifiuto applicazione presidi",s.rifiuto_presidi],["rifiuto_data",s.rifiuto_data],["rifiuto_ora",s.rifiuto_ora],["rifiuto_firma",s.rifiuto_firma]]);

    const destinazione=rowsFor([["ospedale",s.ospedale||m.ospedale],["Pronto Soccorso",s.destinazione_ps],["ora_accettazione",s.ora_accettazione],["codice_invio",CODICE_OPZ.find(([k])=>k===s.codice_invio)?.[1]],["codice_trasporto",CODICE_OPZ.find(([k])=>k===s.codice_trasporto)?.[1]],["matricola_compilatore",s.matricola_compilatore]]);

    const datiOdv=rowsFor([["odv_denominazione",s.odv_denominazione],["odv_targa_mezzo",s.odv_targa_mezzo],["odv_km_iniziali",s.odv_km_iniziali],["odv_km_finali",s.odv_km_finali],["odv_matr_autista",s.odv_matr_autista],["odv_matr_soccorritore1",s.odv_matr_soccorritore1],["odv_matr_soccorritore2",s.odv_matr_soccorritore2],["odv_convenzione",s.odv_convenzione],["odv_n_interno",s.odv_n_interno]]);

    const html=`<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Relazione di soccorso ${escapeHtml(m.missione_numero)}</title><style>body{font-family:Arial,sans-serif;margin:30px;color:#111}h1{margin-bottom:2px;font-size:22px}h1 small{display:block;font-size:12px;font-weight:400;color:#888;margin-top:2px}h2{border-bottom:2px solid #0b1525;padding-bottom:5px;margin-top:26px;font-size:14px;text-transform:uppercase;letter-spacing:.4px}table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #ccc;padding:7px 9px;text-align:left;font-size:12.5px}th{width:34%;background:#f5f5f5}.muted{color:#666}.headerBox{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0b1525;padding-bottom:10px}</style></head><body>
      <div class="headerBox"><h1>Relazione di soccorso ${escapeHtml(m.missione_numero)}<small>Redatta da IRIS v2 · modulo conforme a Mod. 16 AREU (Rev. 8 del 28.04.2025)</small></h1></div>
      <p><b>${escapeHtml(m.indirizzo)}</b> · ${escapeHtml(m.tipologia||"Missione")} · priorità ${escapeHtml(m.priorita)} · attivazione ${new Date(m.creato_il).toLocaleString("it-IT")}</p>
      <p class="muted">${escapeHtml(m.note||"")}</p>
      <h2>Mezzi impiegati</h2><table><tr><th>Mezzo</th><th>Targa</th><th>Stato</th></tr>${(m.mezzi||[]).map((z:any)=>`<tr><td>${escapeHtml(z.nome)}</td><td>${escapeHtml(z.targa||"")}</td><td>${escapeHtml(STATUS_LABEL[z.stato]||z.stato)}</td></tr>`).join("")}</table>
      ${section("Informazioni relative al soccorso",soccorso)}
      ${section("Informazioni relative al paziente",paziente)}
      ${section("Evento",evento)}
      ${section("Valutazione del paziente",valutazioni)}
      ${section("Prestazioni / interventi",prestazioni)}
      ${section("Presidi utilizzati",presidi)}
      ${section("Lesioni e aggravanti",lesioni)}
      ${section("Arresto cardiocircolatorio (ACC)",acc+anamnesi)}
      ${section("Rifiuto trasporto / presidi",rifiuto)}
      ${section("Destinazione e codici di intervento",destinazione)}
      ${section("Dati interni OdV",datiOdv)}
      <h2>Cronologia missione</h2><table><tr><th>Ora</th><th>Mezzo</th><th>Stato</th></tr>${(m.cronologia||[]).map(c=>`<tr><td>${new Date(c.registrato_il).toLocaleString("it-IT")}</td><td>${escapeHtml((m.mezzi||[]).find((z:any)=>z.id===c.mezzo_id)?.nome||"Sistema")}</td><td>${escapeHtml(LABELS[c.stato]||c.stato)}</td></tr>`).join("")}</table>
    </body></html>`;
    downloadBlob(`relazione_soccorso_${m.missione_numero}.html`,html,"text/html;charset=utf-8");
  };
  const downloadBrogliaccio=()=>{
    const rows=[["Data/ora","Missione","Indirizzo","Mezzo","Stato","Evento"]];
    missioni.forEach(m=>(m.cronologia||[]).forEach(c=>rows.push([new Date(c.registrato_il).toLocaleString("it-IT"),m.missione_numero,m.indirizzo,(m.mezzi||[]).find(z=>z.id===c.mezzo_id)?.nome||"",LABELS[c.stato]||c.stato,"Cambio stato"])));
    // Le liste giornaliere non hanno cronologia: scarica anche un riepilogo missioni.
    missioni.forEach(m=>{if(!(m.cronologia||[]).length)rows.push([new Date(m.creato_il).toLocaleString("it-IT"),m.missione_numero,m.indirizzo,(m.mezzi||[]).map(z=>z.nome).join(" | "),STATUS_LABEL[m.stato]||m.stato,"Missione"]);});
    downloadBlob(`brogliaccio_${giorno}.csv`,"\ufeff"+rows.map(r=>r.map(x=>`"${String(x??"").replace(/"/g,'""')}"`).join(";")).join("\n"),"text/csv;charset=utf-8");
  };

  return <div className="app">
    <audio ref={audioRef} src="/glong.wav" preload="auto" />
    <header className="topbar"><div><div className="brand">IRIS <span>v2</span></div><div className="sub">Centrale Operativa · gestione missioni, mezzi e schede</div></div><div className="topActions"><span className="live">● REALTIME</span><label>Giornata <input type="date" value={giorno} onChange={e=>setGiorno(e.target.value)}/></label><button onClick={()=>audioRef.current?.play().catch(()=>setError("Il browser richiede un'interazione per attivare l'audio."))}>🔔 Test glong</button></div></header>
    {error&&<div className="error">{error}<button onClick={()=>setError("")}>×</button></div>}
    <div className="workspace">
      <aside className="left">
        <button className="newMission" onClick={()=>setModal("nuova")}>＋ Nuova missione</button>
        <div className="panelTitle">STATO MEZZI <span>{mezzi.length}</span></div>
        <div className="fleet">
          {mezzi.map(m=><div key={m.id} className={`fleetRow ${selectedMezzo===m.id?"selected":""}`} onClick={()=>setSelectedMezzo(m.id)}>
            <div className="fleetDot" style={{background:m.stato==="disponibile"?"#16a34a":m.stato==="impegnato"?"#f97316":"#64748b"}}/>
            <div className="fleetMain"><b>{m.nome}</b><small>{m.targa||"senza targa"}{m.missione_numero?` · ${m.missione_numero}`:""}</small></div><button className="miniAction" title="Modifica mezzo" onClick={e=>{e.stopPropagation();setMezzoForm({id:m.id,nome:m.nome,targa:m.targa||""});setModal("mezzo")}}>✎</button><button className="miniAction dangerMini" title="Elimina mezzo" onClick={e=>{e.stopPropagation();deleteMezzo(m.id)}}>×</button>
            <select value={m.stato} onChange={e=>setMezzoState(m.id,e.target.value)} onClick={e=>e.stopPropagation()}><option value="disponibile">Disponibile</option><option value="impegnato">Impegnato</option><option value="fuori_servizio">Fuori servizio</option></select>
          </div>)}
          {!mezzi.length&&<div className="empty">Nessun mezzo configurato.</div>}
          <button className="secondary full" onClick={()=>{setMezzoForm({id:"",nome:"",targa:""});setModal("mezzo")}}>＋ Aggiungi mezzo</button>
        </div>
        <div className="panelTitle">LEGENDA</div>
        <div className="legend"><span><i className="legendDot green"/> Disponibile</span><span><i className="legendDot orange"/> Impegnato</span><span><i className="legendDot gray"/> Fuori servizio</span></div>
        <div className="panelTitle">PUNTI DI INTERESSE <span>{poi.length}</span></div>
        <button className={`secondary full ${placingPoi?"placing":""}`} onClick={()=>setPlacingPoi(p=>!p)}>{placingPoi?"✕ Annulla · clicca sulla mappa":"＋ Aggiungi punto sulla mappa"}</button>
        <div className="poiList">
          {poi.map(p=><div key={p.id} className="poiRow"><i className="legendDot" style={{background:POI_COLORS[p.tipo]}}/><div className="poiMain"><b>{p.etichetta}</b><small>{POI_LABELS[p.tipo]}{p.note?` · ${p.note}`:""}</small></div><button className="miniAction dangerMini" title="Rimuovi punto" onClick={()=>deletePoi(p.id)}>×</button></div>)}
          {!poi.length&&<div className="empty">Nessun punto sulla mappa.</div>}
        </div>
      </aside>

      <main className="mapPanel">
        <MapContainer center={[45.4642,9.19]} zoom={12} style={{height:"100%",width:"100%"}}>
          <TileLayer attribution="© OpenStreetMap" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>
          <FitMap points={mapPoints}/>
          <MapClicks onClick={mapClicked}/>
          {missioni.filter(m=>m.lat!=null&&m.lon!=null).map(m=><CircleMarker key={`mission-${m.id}`} center={[m.lat!,m.lon!]} radius={10} pathOptions={{color:COLORS[m.priorita],fillColor:COLORS[m.priorita],fillOpacity:.55}} eventHandlers={{click:()=>openMission(m.id)}}><Popup><b>{m.missione_numero}</b><br/>{m.indirizzo}<br/><button onClick={()=>openMission(m.id)}>Apri missione</button></Popup><Tooltip permanent direction="top" offset={[0,-10]}>{m.missione_numero} · {m.indirizzo}</Tooltip></CircleMarker>)}
          {mezzi.filter(m=>m.lat!=null&&m.lon!=null).map(m=><Marker key={m.id} position={[m.lat!,m.lon!]} eventHandlers={{click:()=>setSelectedMezzo(m.id)}}><Popup><b>{m.nome}</b><br/>{STATUS_LABEL[m.stato]||m.stato}{m.missione_numero&&<><br/>{m.missione_numero}</>}</Popup><Tooltip permanent direction="top" offset={[0,-24]}>{m.nome}{m.missione_numero?` · ${m.missione_numero}`:""}</Tooltip></Marker>)}
          {poi.map(p=><CircleMarker key={`poi-${p.id}`} center={[p.lat,p.lon]} radius={8} pathOptions={{color:POI_COLORS[p.tipo],fillColor:POI_COLORS[p.tipo],fillOpacity:.85,weight:2,dashArray:"3 2"}}><Popup><b>{p.etichetta}</b><br/>{POI_LABELS[p.tipo]}{p.note?<><br/>{p.note}</>:null}<br/><button onClick={()=>deletePoi(p.id)}>Rimuovi punto</button></Popup><Tooltip permanent direction="top" offset={[0,-10]}>{p.etichetta}</Tooltip></CircleMarker>)}
        </MapContainer>
        <div className="mapOverlay"><b>MAPPA OPERATIVA</b><span>{mezzi.filter(m=>m.lat!=null&&m.lon!=null).length} mezzi · {active.length} missioni attive · {poi.length} punti</span></div>
        <div className="mapHint">{placingPoi?"Clicca sulla mappa per posizionare il nuovo punto.":"Seleziona un mezzo a sinistra e clicca sulla mappa per aggiornarne la posizione."}</div>
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
        <div className="drawerHead"><div><span className={`prio ${selectedMissione.priorita}`}>{selectedMissione.priorita.toUpperCase()}</span><b>{selectedMissione.missione_numero}</b><h2>{selectedMissione.indirizzo}</h2><small>{selectedMissione.tipologia||"Missione"} · {STATUS_LABEL[selectedMissione.stato]||selectedMissione.stato}</small></div><div className="drawerActions"><button onClick={downloadMission}>⇩ Scheda</button><button className="danger" style={{marginTop:0}} onClick={()=>deleteMission(selectedMissione.id)}>Elimina</button>{!["concluso","annullato"].includes(selectedMissione.stato)&&<button className="closeMission" onClick={()=>closeMission(selectedMissione.id)}>✓ Chiudi missione</button>}<button onClick={()=>setSelectedMissione(null)}>×</button></div></div>
        <div className="drawerBody">
          <section className="detailCard"><h3>Stati dei mezzi</h3>{(selectedMissione.mezzi||[]).length?(selectedMissione.mezzi||[]).map(m=><div className="unitBlock" key={m.id}><div className="unitHead"><b>{m.nome}</b><span>{STATUS_LABEL[m.stato]||m.stato} <button className="removeUnit" onClick={()=>removeAssignedMezzo(selectedMissione.id,m.id)}>Rimuovi</button></span></div><div className="stateGrid">{STATI.map(st=><button key={st} className={(selectedMissione.cronologia||[]).slice().reverse().find(c=>c.mezzo_id===m.id)?.stato===st?"on":""} onClick={()=>setState(selectedMissione.id,m.id,st)}>{LABELS[st]}</button>)}</div></div>):<div className="empty">Nessun mezzo associato.</div>}
          <h3>Assegna un altro mezzo</h3><div className="chips">{mezzi.filter(m=>!(selectedMissione.mezzi||[]).some(x=>x.id===m.id)).map(m=><button key={m.id} onClick={()=>assign(selectedMissione.id,m.id)} disabled={m.stato==="fuori_servizio"||m.assegnabile===false} title={m.assegnabile===false?"Mezzo impegnato su un'altra missione: assegnabile solo se in rientro, libero in ospedale o disponibile":""}>{m.nome} · {m.assegnabile===false?`Impegnato (${LABELS[m.ultimo_stato||""]||"in missione"})`:STATUS_LABEL[m.stato]}</button>)}</div></section>
          <section className="detailCard"><h3>Relazione di soccorso <small className="modLabel">Mod. 16</small></h3>

            <h4>Informazioni relative al soccorso</h4>
            <div className="grid grid4"><label>Comune<input value={sheet.luogo_comune||""} onChange={e=>updateSheet("luogo_comune",e.target.value)}/></label><label>Via / piazza<input value={sheet.luogo_via||""} onChange={e=>updateSheet("luogo_via",e.target.value)}/></label><label>N. civico<input value={sheet.luogo_civico||""} onChange={e=>updateSheet("luogo_civico",e.target.value)}/></label><label>Piano / scala<input value={sheet.luogo_piano_scala||""} onChange={e=>updateSheet("luogo_piano_scala",e.target.value)}/></label></div>
            <div className="checks"><Toggle label="Luogo = domicilio paziente" checked={!!sheet.luogo_domicilio} onChange={()=>updateSheet("luogo_domicilio",!sheet.luogo_domicilio)}/></div>
            <label className="fieldLabel">Note (da SOREU)<textarea value={sheet.note_soreu||""} onChange={e=>updateSheet("note_soreu",e.target.value)}/></label>
            <div className="fieldLabel">Presenti sul luogo</div>
            <div className="checks">{[["presenti_msa1","MSA1"],["presenti_msa2","MSA2"],["presenti_cnsas","CNSAS"],["presenti_vvf","VVF"],["presenti_cc","CC"],["presenti_polizia","Polizia"]].map(([k,l])=><Toggle key={k} label={l} checked={!!sheet[k]} onChange={()=>updateSheet(k,!sheet[k])}/>)}<Toggle label="Medico" checked={!!sheet.presenti_medico} onChange={()=>updateSheet("presenti_medico",!sheet.presenti_medico)}/>{sheet.presenti_medico&&<input className="inlineInput" placeholder="Qualifica / nominativo" value={sheet.presenti_medico_nome||""} onChange={e=>updateSheet("presenti_medico_nome",e.target.value)}/>}<Toggle label="Altro" checked={!!sheet.presenti_altro} onChange={()=>updateSheet("presenti_altro",!sheet.presenti_altro)}/>{sheet.presenti_altro&&<input className="inlineInput" placeholder="Specificare" value={sheet.presenti_altro_testo||""} onChange={e=>updateSheet("presenti_altro_testo",e.target.value)}/>}</div>

            <h4>Informazioni relative al paziente</h4>
            <div className="checks"><Toggle label="Paziente sconosciuto" checked={!!sheet.sconosciuto} onChange={()=>updateSheet("sconosciuto",!sheet.sconosciuto)}/></div>
            {!sheet.sconosciuto&&<div className="grid"><label>Cognome<input value={sheet.cognome||""} onChange={e=>updateSheet("cognome",e.target.value)}/></label><label>Nome<input value={sheet.nome||""} onChange={e=>updateSheet("nome",e.target.value)}/></label><label>Cittadinanza<input value={sheet.cittadinanza||""} onChange={e=>updateSheet("cittadinanza",e.target.value)}/></label></div>}
            <div className="grid"><label>Data di nascita<input type="date" value={newBorn} onChange={e=>{setNewBorn(e.target.value);updateSheet("dataNascita",e.target.value)}}/></label><label>Età<input value={age} readOnly/></label><label>Sesso<select value={sheet.sesso||""} onChange={e=>updateSheet("sesso",e.target.value)}><option value="">—</option><option>M</option><option>F</option></select></label></div>
            {!sheet.sconosciuto&&<div className="grid"><label>Comune di residenza<input value={sheet.residenza_comune||""} onChange={e=>updateSheet("residenza_comune",e.target.value)}/></label><label>Via / piazza<input value={sheet.residenza_via||""} onChange={e=>updateSheet("residenza_via",e.target.value)}/></label><label>N. civico<input value={sheet.residenza_civico||""} onChange={e=>updateSheet("residenza_civico",e.target.value)}/></label></div>}

            <h4>Evento</h4>
            <div className="checks">{EVENTI_OPZ.map(([k,l])=><Toggle key={k} label={l} checked={!!sheet[`ev_${k}`]} onChange={()=>updateSheet(`ev_${k}`,!sheet[`ev_${k}`])}/>)}<Toggle label="Precipitato da" checked={!!sheet.ev_precipitato} onChange={()=>updateSheet("ev_precipitato",!sheet.ev_precipitato)}/>{sheet.ev_precipitato&&<input className="inlineInput narrow" placeholder="metri" value={sheet.ev_precipitato_metri||""} onChange={e=>updateSheet("ev_precipitato_metri",e.target.value)}/>}<Toggle label="Incidente stradale" checked={!!sheet.ev_incidente_stradale} onChange={()=>updateSheet("ev_incidente_stradale",!sheet.ev_incidente_stradale)}/></div>
            {sheet.ev_incidente_stradale&&<div className="checks indent">{[["is_pedone_ciclo","Pedone / ciclo"],["is_conducente","Conducente"],["is_moto","Moto"],["is_auto","Auto"],["is_passeggero","Passeggero"]].map(([k,l])=><Toggle key={k} label={l} checked={!!sheet[k]} onChange={()=>updateSheet(k,!sheet[k])}/>)}<Toggle label="Altro" checked={!!sheet.is_altro} onChange={()=>updateSheet("is_altro",!sheet.is_altro)}/>{sheet.is_altro&&<input className="inlineInput" placeholder="Specificare" value={sheet.is_altro_testo||""} onChange={e=>updateSheet("is_altro_testo",e.target.value)}/>}</div>}
            <div className="fieldLabel">Luogo dell'evento</div>
            <Radio value={sheet.luogo_evento||""} onChange={v=>updateSheet("luogo_evento",v)} options={LUOGO_EVENTO_OPZ}/>
            {sheet.luogo_evento==="altro"&&<input className="inlineInput" placeholder="Specificare luogo" value={sheet.luogo_evento_altro||""} onChange={e=>updateSheet("luogo_evento_altro",e.target.value)}/>}

            <h4>Valutazione del paziente</h4>
            <div className="fieldLabel">Postura di rinvenimento</div>
            <Radio value={sheet.postura||""} onChange={v=>updateSheet("postura",v)} options={POSTURA_OPZ}/>
            <div className="grid"><label>Ora insorgenza sintomi<input type="time" value={sheet.ora_insorgenza||""} onChange={e=>updateSheet("ora_insorgenza",e.target.value)}/></label></div>
            <div className="evalSelector"><select value={evalIndex} onChange={e=>setEvalIndex(Number(e.target.value))}><option value={0}>1ª valutazione</option><option value={1}>2ª valutazione</option><option value={2}>3ª valutazione</option></select><Toggle label="Effettuata" checked={!!sheet[`eval${evalIndex}`]?.attiva} onChange={()=>updateSheet(`eval${evalIndex}`,{...(sheet[`eval${evalIndex}`]||{}),attiva:!sheet[`eval${evalIndex}`]?.attiva,ora:sheet[`eval${evalIndex}`]?.ora||new Date().toTimeString().slice(0,5)})}/><label>Ora<input type="time" value={sheet[`eval${evalIndex}`]?.ora||""} onChange={e=>updateSheet(`eval${evalIndex}`,{...(sheet[`eval${evalIndex}`]||{}),ora:e.target.value})}/></label></div>
            <div className="fieldLabel">Coscienza</div><Radio value={sheet[`eval${evalIndex}`]?.coscienza||""} onChange={v=>updateSheet(`eval${evalIndex}`,{...(sheet[`eval${evalIndex}`]||{}),coscienza:v})} options={COSCIENZA_OPZ}/>
            <div className="fieldLabel">Respiro</div><Radio value={sheet[`eval${evalIndex}`]?.respiro||""} onChange={v=>updateSheet(`eval${evalIndex}`,{...(sheet[`eval${evalIndex}`]||{}),respiro:v})} options={RESPIRO_OPZ}/>
            <div className="fieldLabel">Circolo</div><div className="checks">{CIRCOLO_OPZ.map(([k,l])=><Toggle key={k} label={l} checked={inArr(sheet[`eval${evalIndex}`]?.circolo,k)} onChange={()=>updateSheet(`eval${evalIndex}`,{...(sheet[`eval${evalIndex}`]||{}),circolo:toggleArr(sheet[`eval${evalIndex}`]?.circolo,k)})}/>)}</div>
            <div className="fieldLabel">Cute</div><div className="checks">{CUTE_OPZ.map(([k,l])=><Toggle key={k} label={l} checked={inArr(sheet[`eval${evalIndex}`]?.cute,k)} onChange={()=>updateSheet(`eval${evalIndex}`,{...(sheet[`eval${evalIndex}`]||{}),cute:toggleArr(sheet[`eval${evalIndex}`]?.cute,k)})}/>)}</div>
            <div className="grid">{["fr","fc","satAria","satO2","pa","temp","glicemia"].map(k=><label key={k}>{({fr:"FR",fc:"FC",satAria:"Sat. aria",satO2:"Sat. O₂",pa:"PA",temp:"Temperatura °C",glicemia:"Glicemia"} as any)[k]}<input value={sheet[`eval${evalIndex}`]?.[k]||""} onChange={e=>updateSheet(`eval${evalIndex}`,{...(sheet[`eval${evalIndex}`]||{}),[k]:e.target.value})}/></label>)}</div>
            <h4>CPSS <small>(Cincinnati Prehospital Stroke Scale)</small></h4><div className="checks">{["deviazione_rima_labiale","segni_di_lato","alterazioni_linguaggio"].map(k=><Toggle key={k} label={k.replaceAll("_"," ")} checked={!!sheet[k]} onChange={()=>updateSheet(k,!sheet[k])}/>)}</div>

            <h4>Prestazioni / interventi</h4>
            <div className="grid"><label>Ossigeno l/min<input type="number" min={0} value={sheet.prest_ossigeno_lmin||""} onChange={e=>updateSheet("prest_ossigeno_lmin",e.target.value)}/></label></div>
            <div className="checks">{["aspirazione_cavo_orale","cannula_of","ventilazione","rcp","applicazione_dae","trasmissione_ecg","rimozione_casco","emostasi","medicazione_ferite","immobilizzazione_arti","immobilizzazione_spinale","protezione_termica"].map(k=><Toggle key={k} label={k.replaceAll("_"," ")} checked={!!sheet[`prest_${k}`]} onChange={()=>updateSheet(`prest_${k}`,!sheet[`prest_${k}`])}/>)}<Toggle label="estricazione" checked={!!sheet.prest_estricazione} onChange={()=>updateSheet("prest_estricazione",!sheet.prest_estricazione)}/>{sheet.prest_estricazione&&<Toggle label="rapida" checked={!!sheet.prest_estricazione_rapida} onChange={()=>updateSheet("prest_estricazione_rapida",!sheet.prest_estricazione_rapida)}/>}</div>

            <h4>Presidi utilizzati</h4><div className="checks">{["collare_cervicale","barella_cucchiaio","tavola_spinale","sedia_portantina","materasso_depressione","estricatore","steccobenda","telo_porta_feriti","fascia_emostatica"].map(k=><Toggle key={k} label={k.replaceAll("_"," ")} checked={!!sheet[`pres_${k}`]} onChange={()=>updateSheet(`pres_${k}`,!sheet[`pres_${k}`])}/>)}</div>

            <h4>Lesioni e aggravanti</h4><div className="lesionList">{["amputazione","frattura_esposta","deformita","dolore","sanguinamento","emorragia_massiva","ferita","ferita_penetrante","lacerazione_schiacciamento","contusione","ustione","edema","lesioni_incompatibili_vita","proiettato","incastrato","accesso_difficile","presenza_deceduti","estricazione_20_min","motilita_assente","sensibilita_assente"].map(k=><div className="lesionRow" key={k}><Toggle label={k.replaceAll("_"," ")} checked={!!sheet[`les_${k}`]} onChange={()=>updateSheet(`les_${k}`,!sheet[`les_${k}`])}/>{sheet[`les_${k}`]&&<><input className="lesionZone" placeholder="Zona interessata" value={sheet[`les_${k}_zona`]||""} onChange={e=>updateSheet(`les_${k}_zona`,e.target.value)}/>{k==="dolore"&&<select className="painSelect" value={sheet.les_dolore_intensita||""} onChange={e=>updateSheet("les_dolore_intensita",e.target.value)}><option value="">Intensità</option>{Array.from({length:10},(_,i)=>i+1).map(n=><option key={n} value={n}>{n}/10</option>)}</select>}</>}</div>)}</div>

            <h4>Arresto cardiocircolatorio (ACC)</h4>
            <div className="grid"><label>Evento rilevato da<input value={sheet.acc_rilevato_da||""} onChange={e=>updateSheet("acc_rilevato_da",e.target.value)}/></label><label>Inizio RCP ore<input type="time" value={sheet.acc_inizio_rcp||""} onChange={e=>updateSheet("acc_inizio_rcp",e.target.value)}/></label><label>Nr. shock<input type="number" min={0} value={sheet.acc_nr_shock||""} onChange={e=>updateSheet("acc_nr_shock",e.target.value)}/></label><label>ROSC ore<input type="time" value={sheet.acc_rosc||""} onChange={e=>updateSheet("acc_rosc",e.target.value)}/></label></div>
            <div className="checks">{[["acc_rcp_gia_in_corso","RCP già in corso"],["acc_durante_trasporto","ACC durante il trasporto"],["acc_trasporto_con_rcp","Trasporto con RCP"],["acc_deceduto","Deceduto"]].map(([k,l])=><Toggle key={k} label={l} checked={!!sheet[k]} onChange={()=>updateSheet(k,!sheet[k])}/>)}</div>
            <label className="fieldLabel">Note / anamnesi AMPIA<textarea className="wide" value={sheet.anamnesi||""} onChange={e=>updateSheet("anamnesi",e.target.value)} placeholder="Allergie, Medicine, Patologie, Ingestione di alimenti, Altre informazioni…"/></label>

            <h4>Rifiuto trasporto / presidi</h4>
            <div className="checks">{[["rifiuto_trasporto","Rifiuto il trasporto in ospedale"],["rifiuto_presidi","Rifiuto l'applicazione dei presidi"]].map(([k,l])=><Toggle key={k} label={l} checked={!!sheet[k]} onChange={()=>updateSheet(k,!sheet[k])}/>)}</div>
            {(sheet.rifiuto_trasporto||sheet.rifiuto_presidi)&&<div className="grid"><label>Data<input type="date" value={sheet.rifiuto_data||""} onChange={e=>updateSheet("rifiuto_data",e.target.value)}/></label><label>Ora<input type="time" value={sheet.rifiuto_ora||""} onChange={e=>updateSheet("rifiuto_ora",e.target.value)}/></label><label>Firma (nome e cognome)<input value={sheet.rifiuto_firma||""} onChange={e=>updateSheet("rifiuto_firma",e.target.value)}/></label></div>}

            <h4>Destinazione e codici di intervento</h4>
            <div className="grid"><label>Azienda / istituto<input value={sheet.ospedale||selectedMissione.ospedale||""} onChange={e=>{updateSheet("ospedale",e.target.value);setSelectedMissione({...selectedMissione,ospedale:e.target.value})}}/></label><label>Ora accettazione<input type="time" value={sheet.ora_accettazione||""} onChange={e=>updateSheet("ora_accettazione",e.target.value)}/></label><label>N. matricola compilatore<input value={sheet.matricola_compilatore||""} onChange={e=>updateSheet("matricola_compilatore",e.target.value)}/></label></div>
            <div className="checks"><Toggle label="Pronto Soccorso" checked={!!sheet.destinazione_ps} onChange={()=>updateSheet("destinazione_ps",!sheet.destinazione_ps)}/></div>
            <div className="fieldLabel">Invio</div><Radio value={sheet.codice_invio||""} onChange={v=>updateSheet("codice_invio",v)} options={CODICE_OPZ}/>
            <div className="fieldLabel">Trasporto</div><Radio value={sheet.codice_trasporto||""} onChange={v=>updateSheet("codice_trasporto",v)} options={CODICE_OPZ}/>

            <h4>Dati interni OdV</h4>
            <div className="grid grid4"><label>Denomin. OdV<input value={sheet.odv_denominazione||""} onChange={e=>updateSheet("odv_denominazione",e.target.value)}/></label><label>Targa / cod. mezzo<input value={sheet.odv_targa_mezzo||""} onChange={e=>updateSheet("odv_targa_mezzo",e.target.value)}/></label><label>Km iniziali<input value={sheet.odv_km_iniziali||""} onChange={e=>updateSheet("odv_km_iniziali",e.target.value)}/></label><label>Km finali<input value={sheet.odv_km_finali||""} onChange={e=>updateSheet("odv_km_finali",e.target.value)}/></label></div>
            <div className="grid grid4"><label>Matr. autista<input value={sheet.odv_matr_autista||""} onChange={e=>updateSheet("odv_matr_autista",e.target.value)}/></label><label>Matr. soccorritore<input value={sheet.odv_matr_soccorritore1||""} onChange={e=>updateSheet("odv_matr_soccorritore1",e.target.value)}/></label><label>Matr. soccorritore<input value={sheet.odv_matr_soccorritore2||""} onChange={e=>updateSheet("odv_matr_soccorritore2",e.target.value)}/></label><label>Convenzione<input value={sheet.odv_convenzione||""} onChange={e=>updateSheet("odv_convenzione",e.target.value)}/></label></div>
            <div className="grid"><label>N° interno<input value={sheet.odv_n_interno||""} onChange={e=>updateSheet("odv_n_interno",e.target.value)}/></label></div>

            <button className="save full" onClick={saveSheet}>Salva scheda</button>
          </section>
          <section className="detailCard"><div className="historyHead"><h3>Brogliaccio missione</h3><button onClick={downloadMission}>⇩ Scarica</button></div>{(selectedMissione.cronologia||[]).length?<div className="timeline">{selectedMissione.cronologia!.slice().reverse().map(c=><div className="timelineRow" key={c.id}><time>{new Date(c.registrato_il).toLocaleString("it-IT")}</time><b>{LABELS[c.stato]||c.stato}</b><span>{(selectedMissione.mezzi||[]).find(z=>z.id===c.mezzo_id)?.nome||"Sistema"}</span></div>)}</div>:<div className="empty">Nessun evento registrato.</div>}</section>
        </div>
      </section>
    </div>}

    {modal&&<div className="modalBack" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null)}}><div className="modal"><button className="close" onClick={()=>setModal(null)}>×</button>{modal==="nuova"?<><h2>Nuova missione</h2><form onSubmit={createMission}><input placeholder="Luogo / indirizzo *" required value={form.indirizzo} onChange={e=>setForm({...form,indirizzo:e.target.value})}/><div className="grid"><select value={form.priorita} onChange={e=>setForm({...form,priorita:e.target.value})}><option value="verde">VERDE</option><option value="giallo">GIALLO</option><option value="rosso">ROSSO</option></select><input placeholder="Tipologia" value={form.tipologia} onChange={e=>setForm({...form,tipologia:e.target.value})}/></div><textarea placeholder="Note" value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/><button className="save full">Crea missione</button></form></>:modal==="mezzo"?<><h2>{mezzoForm.id?"Modifica mezzo":"Nuovo mezzo"}</h2><form onSubmit={createOrEditMezzo}><input placeholder="Nome mezzo" required value={mezzoForm.nome} onChange={e=>setMezzoForm({...mezzoForm,nome:e.target.value})}/><input placeholder="Targa" value={mezzoForm.targa} onChange={e=>setMezzoForm({...mezzoForm,targa:e.target.value})}/><button className="save full">Salva</button></form>{mezzoForm.id&&<button className="danger full" onClick={()=>{deleteMezzo(mezzoForm.id);setModal(null)}}>Elimina mezzo</button>}</>:<><h2>Nuovo punto di interesse</h2><form onSubmit={savePoi}><select value={poiForm.tipo} onChange={e=>setPoiForm({...poiForm,tipo:e.target.value})}>{Object.keys(POI_LABELS).map(k=><option key={k} value={k}>{POI_LABELS[k]}</option>)}</select><input placeholder="Etichetta (es. Squadra Alfa) *" required value={poiForm.etichetta} onChange={e=>setPoiForm({...poiForm,etichetta:e.target.value})}/><input placeholder="Note (opzionale)" value={poiForm.note} onChange={e=>setPoiForm({...poiForm,note:e.target.value})}/><button className="save full">Posiziona sulla mappa</button></form></>}</div></div>}
  </div>;
}
