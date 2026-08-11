import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Pressable, ScrollView, StyleSheet, Text, TextInput, View, Vibration, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { io, Socket } from "socket.io-client";

const API_URL = process.env.EXPO_PUBLIC_API_URL || "https://TUO-SERVIZIO.onrender.com";
const OPERATORE_ID = process.env.EXPO_PUBLIC_OPERATORE_ID || "INSERISCI-ID-OPERATORE";
const MEZZO_ID = process.env.EXPO_PUBLIC_MEZZO_ID || "";

const STATI = ["attivazione","partenza","arrivo_sul_posto","paziente_visto","partenza_ospedale","arrivo_ospedale","libero_in_ospedale","rientro","disponibile"];
const LABELS: Record<string,string> = { attivazione:"Attivazione", partenza:"Partenza", arrivo_sul_posto:"Arrivo sul posto", paziente_visto:"Paziente visto", partenza_ospedale:"Partenza ospedale", arrivo_ospedale:"Arrivo ospedale", libero_in_ospedale:"Libero in ospedale", rientro:"Rientro", disponibile:"Disponibile" };

type Evento = { id:string; mezzo_id:string|null; stato:string; registrato_il:string };
type Missione = { id:string; missione_numero:string; indirizzo:string; tipologia?:string; note?:string; priorita:string; ospedale?:string|null; stato:string; creato_il:string; lat?:number|null; lon?:number|null; scheda:any; mezzi:any[]; cronologia:Evento[] };

Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowAlert:true, shouldPlaySound:true, shouldSetBadge:false }) });

async function registraCanaleCritico() {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("attivazioni-critiche", {
      name: "Attivazioni critiche",
      importance: Notifications.AndroidImportance.MAX,
      sound: "attivazione_alta_priorita.wav",
      vibrationPattern: [0,500,250,500],
      bypassDnd: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
}

async function registraPushToken() {
  if (!Device.isDevice || OPERATORE_ID.startsWith("INSERISCI")) return;
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== "granted") return;
  const token = (await Notifications.getExpoPushTokenAsync()).data;
  await fetch(`${API_URL}/operatori/${OPERATORE_ID}/push-token`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({pushToken:token}) }).catch(()=>{});
}

function Field({label,value,onChange,multiline=false,keyboardType="default"}:{label:string;value:string;onChange:(v:string)=>void;multiline?:boolean;keyboardType?:any}) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput value={value} onChangeText={onChange} multiline={multiline} keyboardType={keyboardType} style={[styles.input,multiline&&styles.multiline]} /></View>;
}
function Check({label,on,value}:{label:string;on:()=>void;value:boolean}) { return <Pressable onPress={on} style={[styles.check,value&&styles.checkOn]}><Text>{value?"✓ ":""}{label}</Text></Pressable>; }

export default function App() {
  const [missione,setMissione]=useState<Missione|null>(null);
  const [attivazione,setAttivazione]=useState(false);
  const [sheet,setSheet]=useState<any>({});
  const [evalIndex,setEvalIndex]=useState(0);
  const socketRef=useRef<Socket|null>(null);

  const api=useCallback(async(path:string,method="GET",body?:any)=>{
    const r=await fetch(`${API_URL}${path}`,{method,headers:{"Content-Type":"application/json"},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d.errore||"Errore di connessione");
    return d;
  },[]);

  const loadMission=useCallback(async()=>{
    if(!MEZZO_ID) return;
    try {
      const m=await api(`/interventi/mezzo/${MEZZO_ID}/attiva`);
      setMissione(m); setSheet(m?.scheda||{});
    } catch(e:any) { Alert.alert("Connessione",e.message); }
  },[api]);

  useEffect(()=>{
    registraCanaleCritico(); registraPushToken(); loadMission();
    const s=io(API_URL,{transports:["websocket","polling"]}); socketRef.current=s;
    s.emit("registra",{ruolo:"mezzo",id:MEZZO_ID});
    const refresh=()=>loadMission();
    s.on("attivazione",(data:any)=>{
      Vibration.vibrate([0,500,250,500],true);
      setAttivazione(true);
      if(data?.interventoId) loadMission();
    });
    s.on("intervento_confermato",refresh); s.on("stato_missione",refresh); s.on("missione_aggiornata",refresh);
    Notifications.getLastNotificationResponseAsync().then((response:any)=>{
      const data=response?.notification?.request?.content?.data;
      if(data?.tipo==="attivazione") { setAttivazione(true); loadMission(); }
    }).catch(()=>{});
    return()=>{s.disconnect();Vibration.cancel();};
  },[loadMission]);

  const cronologia=missione?.cronologia||[];
  const currentState=useMemo(()=>{const mine=cronologia.filter(e=>e.mezzo_id===MEZZO_ID);return mine[mine.length-1]?.stato||"attivazione"},[cronologia]);
  const setState=async(stato:string)=>{if(!missione)return;try{await api(`/interventi/${missione.id}/stato`,"POST",{mezzoId:MEZZO_ID,stato});await loadMission();if(stato!=="attivazione")setAttivazione(false);}catch(e:any){Alert.alert("Stato",e.message)}};
  const confirm=async()=>{if(!missione)return;try{Vibration.cancel();await api(`/interventi/${missione.id}/conferma-mezzo`,"POST",{mezzoId:MEZZO_ID});setAttivazione(false);await loadMission();}catch(e:any){Alert.alert("Attivazione",e.message)}};
  const saveSheet=async()=>{if(!missione)return;try{await api(`/interventi/${missione.id}/scheda`,"PATCH",{scheda:sheet,ospedale:missione.ospedale||null,priorita:missione.priorita});await loadMission();Alert.alert("Scheda","Salvata");}catch(e:any){Alert.alert("Scheda",e.message)}};
  const update=(k:string,v:any)=>setSheet((s:any)=>({...s,[k]:v}));
  const age=sheet.dataNascita?Math.max(0,new Date().getFullYear()-new Date(sheet.dataNascita).getFullYear()-((new Date().getMonth()<new Date(sheet.dataNascita).getMonth()||new Date().getMonth()===new Date(sheet.dataNascita).getMonth()&&new Date().getDate()<new Date(sheet.dataNascita).getDate())?1:0)):"";

  if(!MEZZO_ID) return <View style={styles.center}><Text style={styles.title}>Dispositivo mezzo non configurato</Text><Text style={styles.muted}>Impostare EXPO_PUBLIC_MEZZO_ID.</Text></View>;

  return <View style={styles.container}>
    <View style={styles.header}><View><Text style={styles.brand}>IRIS · MEZZO</Text><Text style={styles.muted}>Unità {MEZZO_ID}</Text></View><Pressable style={styles.refresh} onPress={loadMission}><Text>↻</Text></Pressable></View>
    {attivazione&&missione&&<View style={styles.alert}><Text style={styles.alertTitle}>ATTIVAZIONE</Text><Text style={styles.alertMission}>{missione.missione_numero}</Text><Text style={styles.alertAddress}>{missione.indirizzo}</Text><Button title="Conferma presa in carico" onPress={confirm} color="#b91c1c" /></View>}
    {!missione?<View style={styles.center}><Text style={styles.title}>Nessuna missione attiva</Text><Text style={styles.muted}>Il dispositivo è in attesa di nuove assegnazioni.</Text></View>:
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.card}><Text style={styles.missionNumber}>{missione.missione_numero}</Text><Text style={styles.address}>{missione.indirizzo}</Text><Text style={styles.meta}>{missione.tipologia||"Missione"} · priorità {missione.priorita.toUpperCase()}</Text></View>
      <View style={styles.card}><Text style={styles.sectionTitle}>Stato operativo del mezzo</Text><Text style={styles.current}>Stato attuale: <Text style={styles.bold}>{LABELS[currentState]||currentState}</Text></Text><View style={styles.stateWrap}>{STATI.map(st=><Pressable key={st} onPress={()=>setState(st)} style={[styles.stateBtn,currentState===st&&styles.stateBtnOn]}><Text style={currentState===st?styles.stateTextOn:undefined}>{LABELS[st]}</Text></Pressable>)}</View></View>
      <View style={styles.card}><Text style={styles.sectionTitle}>Orari / brogliaccio</Text>{[["Assegnazione",(missione as any).ora_assegnazione],["Presa in carico",(missione as any).ora_presa_in_carico],["Arrivo",(missione as any).ora_arrivo],["Rientro",(missione as any).ora_rientro]].filter((x:any)=>x[1]).map((x:any)=><View key={x[0]} style={styles.timeline}><Text style={styles.time}>{new Date(x[1]).toLocaleString("it-IT")}</Text><Text style={styles.event}>{x[0]}</Text></View>)}{cronologia.filter(e=>e.mezzo_id===MEZZO_ID).slice().reverse().map(e=><View key={e.id} style={styles.timeline}><Text style={styles.time}>{new Date(e.registrato_il).toLocaleString("it-IT")}</Text><Text style={styles.event}>{LABELS[e.stato]||e.stato}</Text></View>)}</View>
      <View style={styles.card}><Text style={styles.sectionTitle}>Scheda missione</Text><Field label="Cognome" value={sheet.cognome||""} onChange={v=>update("cognome",v)}/><Field label="Nome" value={sheet.nome||""} onChange={v=>update("nome",v)}/><Field label="Data di nascita (AAAA-MM-GG)" value={sheet.dataNascita||""} onChange={v=>update("dataNascita",v)} keyboardType="numbers-and-punctuation"/><Field label="Età" value={String(age)} onChange={()=>{}}/><Field label="Sesso" value={sheet.sesso||""} onChange={v=>update("sesso",v)}/>
        <Text style={styles.subTitle}>Evento</Text><View style={styles.checkWrap}>{["casa","strada","uffici_esercizi","impianto_sportivo","impianto_lavorativo","avvelenamento","evento_violento","precipitato","pedone_ciclo","conducente_moto","malore","travaglio_parto","infortunio","auto","passeggero"].map(k=><Check key={k} label={k.replaceAll("_"," ")} value={!!sheet[k]} on={()=>update(k,!sheet[k])}/>)}</View>
        <Text style={styles.subTitle}>Valutazione paziente</Text><View style={styles.stateWrap}>{[0,1,2].map(i=><Pressable key={i} onPress={()=>setEvalIndex(i)} style={[styles.stateBtn,evalIndex===i&&styles.stateBtnOn]}><Text style={evalIndex===i?styles.stateTextOn:undefined}>{i+1}ª valutazione</Text></Pressable>)}</View><View style={styles.checkWrap}>{["fr","fc","satAria","satO2","pa","temp","glicemia"].map(k=><View key={k} style={{width:"48%"}}><Field label={k} value={sheet[`eval${evalIndex}`]?.[k]||""} onChange={v=>update(`eval${evalIndex}`,{...(sheet[`eval${evalIndex}`]||{}),[k]:v})}/></View>)}</View>
        <Text style={styles.subTitle}>CPSS</Text><View style={styles.checkWrap}>{["deviazione_rima_labiale","segni_di_lato","alterazioni_linguaggio"].map(k=><Check key={k} label={k.replaceAll("_"," ")} value={!!sheet[k]} on={()=>update(k,!sheet[k])}/>)}</View>
        <Text style={styles.subTitle}>Prestazioni / interventi</Text><View style={styles.checkWrap}>{["ossigeno","aspirazione_cavo_orale","cannula","ventilazione","rcp","dae","trasmissione_ecg","rimozione_casco","collare_cervicale","estricazione"].map(k=><Check key={k} label={k.replaceAll("_"," ")} value={!!sheet[`prest_${k}`]} on={()=>update(`prest_${k}`,!sheet[`prest_${k}`])}/>)}</View>
        <Text style={styles.subTitle}>Presidi utilizzati</Text><View style={styles.checkWrap}>{["barella_cucchiaio","tavola_spinale","sedia_portantina","materasso_depressione","estricatore","steccobenda","telo_porta_feriti","fascia_emostatica","medicazione_ferite","immobilizzazione_arti","immobilizzazione_spinale","protezione_termica"].map(k=><Check key={k} label={k.replaceAll("_"," ")} value={!!sheet[`pres_${k}`]} on={()=>update(`pres_${k}`,!sheet[`pres_${k}`])}/>)}</View>
        <Text style={styles.subTitle}>Lesioni</Text><View>{["amputazione","frattura_esposta","deformita","dolore","sanguinamento","emorragia_massiva","ferita","ferita_penetrante","lacerazione_schiacciamento","contusione","ustione","proiettato","edema","lesioni_incompatibili_vita","accesso_difficile","presenza_deceduti","incastrato","estricazione_20_min","motilita_assente","sensibilita_assente"].map(k=><View key={k} style={styles.lesionRow}><Check label={k.replaceAll("_"," ")} value={!!sheet[`les_${k}`]} on={()=>update(`les_${k}`,!sheet[`les_${k}`])}/>{sheet[`les_${k}`]&&<><Field label="Zona interessata" value={sheet[`les_${k}_zona`]||""} onChange={v=>update(`les_${k}_zona`,v)}/>{k==="dolore"&&<Field label="Intensità dolore (1-10)" value={String(sheet.les_dolore_intensita||"")} onChange={v=>update("les_dolore_intensita",v)} keyboardType="numeric"/>}</>}</View>)}</View>
        <Text style={styles.subTitle}>Destinazione</Text><View style={styles.checkWrap}><Check label="Pronto Soccorso" value={sheet.destinazioneTipo==="ps"} on={()=>update("destinazioneTipo","ps")}/><Check label="Ospedale" value={sheet.destinazioneTipo==="ospedale"} on={()=>update("destinazioneTipo","ospedale")}/><Check label="Altro" value={sheet.destinazioneTipo==="altro"} on={()=>update("destinazioneTipo","altro")}/></View>{sheet.destinazioneTipo==="ospedale"&&<Field label="Ospedale" value={sheet.ospedale||missione.ospedale||""} onChange={v=>{update("ospedale",v);setMissione({...missione,ospedale:v})}}/>}{sheet.destinazioneTipo==="altro"&&<Field label="Specificare" value={sheet.destinazioneAltro||""} onChange={v=>update("destinazioneAltro",v)}/>}
        <Field label="Anamnesi / relazione di soccorso" value={sheet.anamnesi||""} onChange={v=>update("anamnesi",v)} multiline/><Pressable style={styles.save} onPress={saveSheet}><Text style={styles.saveText}>Salva scheda</Text></Pressable>
      </View>
    </ScrollView>}
  </View>;
}

const styles=StyleSheet.create({container:{flex:1,backgroundColor:"#f3f6fa"},header:{paddingTop:48,paddingHorizontal:18,paddingBottom:12,backgroundColor:"#0f172a",flexDirection:"row",justifyContent:"space-between",alignItems:"center"},brand:{fontSize:21,fontWeight:"900",color:"#fff"},muted:{color:"#94a3b8",marginTop:3},refresh:{backgroundColor:"#fff",borderRadius:10,paddingHorizontal:13,paddingVertical:8},scroll:{padding:14,paddingBottom:40},center:{flex:1,justifyContent:"center",alignItems:"center",padding:30},title:{fontSize:22,fontWeight:"800",textAlign:"center"},card:{backgroundColor:"#fff",borderRadius:14,padding:15,marginBottom:12,borderWidth:1,borderColor:"#e2e8f0"},missionNumber:{fontSize:13,fontWeight:"800",color:"#2563eb"},address:{fontSize:23,fontWeight:"800",marginTop:4},meta:{color:"#64748b",marginTop:4},alert:{backgroundColor:"#fee2e2",padding:16,borderBottomWidth:1,borderBottomColor:"#fecaca"},alertTitle:{fontSize:26,fontWeight:"900",color:"#b91c1c"},alertMission:{fontWeight:"800",marginTop:3},alertAddress:{fontSize:19,fontWeight:"700",marginVertical:8},sectionTitle:{fontSize:18,fontWeight:"800",marginBottom:10},subTitle:{fontSize:15,fontWeight:"800",marginTop:16,marginBottom:8},current:{marginBottom:10,color:"#475569"},bold:{fontWeight:"800",color:"#0f172a"},stateWrap:{flexDirection:"row",flexWrap:"wrap",gap:7},stateBtn:{borderWidth:1,borderColor:"#cbd5e1",borderRadius:9,paddingVertical:9,paddingHorizontal:10,backgroundColor:"#fff",marginBottom:6},stateBtnOn:{backgroundColor:"#2563eb",borderColor:"#2563eb"},stateTextOn:{color:"#fff",fontWeight:"800"},timeline:{borderLeftWidth:3,borderLeftColor:"#2563eb",paddingLeft:10,paddingVertical:6,marginBottom:6},time:{fontSize:12,color:"#64748b"},event:{fontWeight:"800",marginTop:2},field:{marginBottom:9},label:{fontSize:12,color:"#475569",marginBottom:4},input:{borderWidth:1,borderColor:"#cbd5e1",borderRadius:9,paddingHorizontal:10,paddingVertical:9,backgroundColor:"#fff"},multiline:{minHeight:110,textAlignVertical:"top"},checkWrap:{flexDirection:"row",flexWrap:"wrap",gap:6},check:{borderWidth:1,borderColor:"#cbd5e1",borderRadius:8,padding:8,backgroundColor:"#fff"},checkOn:{backgroundColor:"#dbeafe",borderColor:"#60a5fa"},lesionRow:{marginBottom:6,borderBottomWidth:1,borderBottomColor:"#eef2f7",paddingBottom:6},save:{marginTop:15,backgroundColor:"#2563eb",padding:13,borderRadius:10,alignItems:"center"},saveText:{color:"#fff",fontWeight:"900",fontSize:16}});
