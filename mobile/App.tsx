import { useEffect, useState } from "react";
import {
  View, Text, Button, StyleSheet, Vibration, Platform, ScrollView,
  TextInput, Pressable, Alert
} from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";

const API_URL = "http://localhost:3000"; // sostituire con il dominio/IP del backend
const OPERATORE_ID = "INSERISCI-ID-OPERATORE";

const STATI = [
  "Attivazione","Partenza","Arrivo sul posto","Paziente visto",
  "Partenza per ospedale","Arrivo ospedale","Libero in Ospedale","Rientro","Disponibile"
] as const;

const NEXT: Record<string,string[]> = {
  "Attivazione":["Partenza"],
  "Partenza":["Arrivo sul posto"],
  "Arrivo sul posto":["Paziente visto"],
  "Paziente visto":["Partenza per ospedale","Rientro"],
  "Partenza per ospedale":["Arrivo ospedale"],
  "Arrivo ospedale":["Libero in Ospedale"],
  "Libero in Ospedale":["Rientro"],
  "Rientro":["Disponibile"],
  "Disponibile":[]
};

type Field = { key:string; label:string; multiline?:boolean; options?:string[] };
const FIELDS: { title:string; fields:Field[] }[] = [
 {title:"Identificazione",fields:[
  {key:"denominazioneOdV",label:"Denominazione OdV"},{key:"targaCodMezzo",label:"Targa / cod. mezzo"},
  {key:"kmIniziali",label:"Km iniziali"},{key:"kmFinali",label:"Km finali"},
  {key:"matrAutista",label:"Matr. autista"},{key:"matrSoccorritore1",label:"Matr. soccorritore 1"},
  {key:"matrSoccorritore2",label:"Matr. soccorritore 2"},{key:"convenzione",label:"Convenzione"},{key:"numeroInterno",label:"N° interno"}]},
 {title:"Luogo dell'evento",fields:[
  {key:"luogoVia",label:"Via / piazza"},{key:"luogoCivico",label:"N. civico"},{key:"luogoPianoScala",label:"Piano / scala"},
  {key:"luogoComune",label:"Comune"},{key:"dataEvento",label:"Data"},{key:"luogoEvento",label:"Casa / strada / uffici / sport / lavoro / altro"}]},
 {title:"Paziente",fields:[
  {key:"cognome",label:"Cognome"},{key:"nome",label:"Nome"},{key:"dataNascita",label:"Data di nascita"},
  {key:"eta",label:"Età"},{key:"cittadinanza",label:"Cittadinanza"},{key:"sesso",label:"Sesso (M/F)"},
  {key:"comuneResidenza",label:"Comune di residenza"},{key:"residenzaVia",label:"Via / piazza residenza"},
  {key:"residenzaCivico",label:"N. civico"},{key:"eventoRilevatoDa",label:"Evento rilevato da"},
  {key:"presenze",label:"Dati interni presenti: OdV, MSA1, MSA2, CNSAS, VVF, CC, Polizia, Medico"}]},
 {title:"Evento",fields:[
  {key:"evento",label:"Evento: perdita coscienza, lesioni, convulsioni, malessere, caduta, incidente, avvelenamento, violento, precipitato, pedone/ciclo, moto, malore, parto, infortunio, auto, altro",multiline:true},
  {key:"oraPerditaCoscienza",label:"Ora perdita coscienza"},{key:"precipitatoDa",label:"Precipitato da (m)"},{key:"proiettatoDa",label:"Proiettato da (m)"}]},
 {title:"Valutazione paziente - parametri",fields:[
  {key:"coscienza",label:"Coscienza: sveglio / reagisce chiamata / dolore / assente / incosciente"},
  {key:"respiro",label:"Respiro: normale / difficoltoso / assente"},
  {key:"circolo",label:"Circolo: periferico / centrale / ritmico / aritmico / assente"},
  {key:"cute",label:"Cute: calda / fredda / rosea / cianotica / pallida / sudata"},
  {key:"postura",label:"Postura: in piedi / seduta / prona / supina / laterale"},
  {key:"cpss",label:"CPSS: deviazione rima labiale / segni di lato / alterazioni linguaggio"},{key:"cpssVal1",label:"CPSS valutazione 1"},{key:"cpssVal2",label:"CPSS valutazione 2"},{key:"cpssVal3",label:"CPSS valutazione 3"},
  {key:"oraInsorgenzaSintomi",label:"Ora insorgenza sintomi"},{key:"fr",label:"FR"},{key:"satAria",label:"Sat. aria"},
  {key:"satO2",label:"Sat. O2"},{key:"fc",label:"FC"},{key:"pa",label:"PA"},{key:"temperatura",label:"Temp. °C"},
  {key:"glicemia",label:"Glicemia"},{key:"noteValutazione",label:"Note",multiline:true}]},
 {title:"RCP / ACC",fields:[
  {key:"inizioRcpOra",label:"Inizio RCP - ora"},{key:"numeroShock",label:"Nr. shock"},{key:"roscOra",label:"ROSC - ora"},
  {key:"esito",label:"Esito: trasporto con RCP / RCP già in corso / ACC durante trasporto / deceduto"},
  {key:"anamnesiAmpia",label:"Note / anamnesi AMPIA",multiline:true}]},
 {title:"Prestazioni / interventi e presidi",fields:[
  {key:"prestazioni",label:"Presidi/prestazioni: ossigeno, aspirazione, cannula, RCP, DAE, ECG, casco, collare, barella cucchiaio, tavola spinale, sedia, materasso, estricatore, steccobenda, telo, fascia/emostasi, medicazione, immobilizzazione, protezione termica",multiline:true},
  {key:"ossigenoLMin",label:"Ossigeno l/min"},{key:"dolore",label:"Dolore"},{key:"proiettatoDa",label:"Proiettato da (m)"},{key:"lesioniNote",label:"Lesioni / note",multiline:true}]},
 {title:"Destinazione e codici",fields:[
  {key:"aziendaIstituto",label:"Azienda / Istituto"},{key:"invioCodice",label:"Invio V / G / R"},
  {key:"trasportoCodice",label:"Trasporto V / G / R"},{key:"numeroMatricola",label:"N. matricola"},{key:"compilatore",label:"Compilatore"}]},
 {title:"Rifiuto trasporto / presidi",fields:[
  {key:"rifiutoNote",label:"Note / dichiarazione",multiline:true},{key:"rifiutoCoscienza",label:"Coscienza"},
  {key:"rifiutoRespiro",label:"Respiro"},{key:"rifiutoCircolo",label:"Circolo"},{key:"rifiutoCute",label:"Cute"},
  {key:"rifiutoData",label:"Data accettazione"},{key:"rifiutoOra",label:"Ora accettazione"}]},
 {title:"Relazione di soccorso",fields:[{key:"relazione",label:"Relazione",multiline:true}]}
];

Notifications.setNotificationHandler({
 handleNotification: async () => ({
  shouldShowAlert:true, shouldPlaySound:true, shouldSetBadge:false
 })
});

async function registraCanaleCritico(){
 if(Platform.OS==="android"){
  await Notifications.setNotificationChannelAsync("attivazioni-critiche",{
   name:"Attivazioni critiche",importance:Notifications.AndroidImportance.MAX,
   sound:"attivazione_alta_priorita.wav",vibrationPattern:[0,500,250,500,250,500],
   bypassDnd:true,lockscreenVisibility:Notifications.AndroidNotificationVisibility.PUBLIC
  });
 }
}
async function registraPushToken(){
 if(!Device.isDevice)return;
 const {status}=await Notifications.requestPermissionsAsync();
 if(status!=="granted")return;
 try{
  const token=(await Notifications.getDevicePushTokenAsync()).data;
  await fetch(`${API_URL}/operatori/${OPERATORE_ID}/push-token`,{
   method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({pushToken:token})
  });
 }catch(e){console.warn("Registrazione push non riuscita",e)}
}

export default function App(){
 const [missione,setMissione]=useState<any|null>(null);
 const [scheda,setScheda]=useState<Record<string,string>>({});
 const [registro,setRegistro]=useState<any[]>([]);

 async function load(id:string){
  const r=await fetch(`${API_URL}/interventi/${id}`);const d=await r.json();
  setMissione(d);setScheda(d.scheda_missione||{});setRegistro(d.registro||[]);
 }
 async function save(){
  if(!missione)return;
  const r=await fetch(`${API_URL}/interventi/${missione.id}/scheda`,{
   method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({scheda})
  });
  const d=await r.json();setMissione(d);
 }
 async function changeState(stato:string,rifiutoTrasporto=false){
  try{
   await save();
   const r=await fetch(`${API_URL}/interventi/${missione.id}/stato-missione`,{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({stato,scheda,rifiutoTrasporto})
   });
   const d=await r.json();if(!r.ok)throw new Error(d.errore);
   setMissione(d);setScheda(d.scheda_missione||{});
   const rr=await fetch(`${API_URL}/interventi/${missione.id}/registro`);setRegistro(await rr.json());
   if(stato==="Disponibile")setMissione(null);
  }catch(e:any){Alert.alert("Missione",e.message)}
 }

 useEffect(()=>{
  registraCanaleCritico();registraPushToken();
  const sub=Notifications.addNotificationReceivedListener(async notif=>{
   const data=notif.request.content.data as any;
   if(data.tipo==="attivazione"&&data.interventoId){
    Vibration.vibrate([0,500,250,500,250,500],true);
    await load(String(data.interventoId));
   }
  });
  return()=>sub.remove();
 },[]);

 if(!missione)return <View style={styles.container}><Text style={styles.title}>IRIS v2 Soccorritore</Text><Text>In attesa di attivazioni...</Text></View>;

 const current=missione.stato_missione||"Attivazione";
 const actions=NEXT[current]||[];
 return <ScrollView contentContainerStyle={styles.scroll}>
  <View style={styles.header}>
   <Text style={styles.title}>MISSIONE {missione.numero_missione}</Text>
   <Text>{missione.indirizzo}</Text><Text style={styles.state}>{current}</Text>
  </View>
  <View style={styles.timeline}>{STATI.map((s,i)=><View key={s} style={[styles.step,s===current&&styles.current,i<STATI.indexOf(current)&&styles.done]}><Text style={{fontWeight:"700"}}>{i+1}. {s}</Text></View>)}</View>
  {FIELDS.map(section=><View key={section.title} style={styles.card}><Text style={styles.section}>{section.title}</Text>{section.fields.map(f=><View key={f.key} style={styles.field}><Text style={styles.label}>{f.label}</Text><TextInput
   value={String(scheda[f.key]??"")} onChangeText={v=>setScheda(p=>({...p,[f.key]:v}))}
   multiline={f.multiline} style={[styles.input,f.multiline&&styles.multiline]} placeholder="Inserisci..." /></View>)}</View>)}
  <View style={styles.card}><Text style={styles.section}>Registro operativo</Text>{registro.map(r=><Text key={r.id} style={styles.log}>{new Date(r.creato_il).toLocaleTimeString("it-IT")}  ·  {r.stato}{r.dettagli?.rifiutoTrasporto?"  · RIFIUTO TRASPORTO":""}</Text>)}</View>
  <View style={styles.card}><Button title="SALVA SCHEDA" onPress={save}/></View>
  <View style={styles.card}><Text style={styles.section}>Prossimo passaggio</Text>{actions.map(s=><View key={s} style={{marginVertical:5}}><Button title={s.toUpperCase()} onPress={()=>changeState(s)} /></View>)}{current==="Paziente visto"&&<View style={{marginTop:10}}><Button color="#b91c1c" title="RIFIUTO TRASPORTO → RIENTRO" onPress={()=>Alert.alert("Conferma","Registrare il rifiuto del trasporto?",[{text:"Annulla"},{text:"Conferma",onPress:()=>changeState("Rientro",true)}])}/></View>}</View>
 </ScrollView>
}

const styles=StyleSheet.create({
 container:{flex:1,justifyContent:"center",alignItems:"center",padding:24,backgroundColor:"#f4f6f8"},
 scroll:{padding:12,backgroundColor:"#f4f6f8"},
 header:{backgroundColor:"#fff",padding:16,borderRadius:12,marginBottom:10},
 title:{fontSize:22,fontWeight:"900",marginBottom:5},state:{fontWeight:"900",marginTop:8},
 timeline:{backgroundColor:"#fff",padding:8,borderRadius:12,marginBottom:10},
 step:{padding:8,borderRadius:8,marginVertical:2},current:{borderWidth:2,borderColor:"#111827"},done:{backgroundColor:"#dcfce7"},
 card:{backgroundColor:"#fff",padding:14,borderRadius:12,marginBottom:10},
 section:{fontSize:17,fontWeight:"900",marginBottom:10},field:{marginBottom:9},
 label:{fontSize:12,fontWeight:"700",marginBottom:4},input:{borderWidth:1,borderColor:"#cbd5e1",borderRadius:8,padding:10,backgroundColor:"#fff"},
 multiline:{minHeight:85,textAlignVertical:"top"},log:{paddingVertical:5,borderBottomWidth:1,borderBottomColor:"#eee"}
});
