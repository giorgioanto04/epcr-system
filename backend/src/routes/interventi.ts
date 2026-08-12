import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { getIO } from "../ws/socket.js";
import { inviaNotificaAttivazione } from "../ws/push.js";

const TIMEOUT_SECONDI = Number(process.env.ACTIVATION_TIMEOUT_SECONDS ?? 60);
const STATI_MISSIONE = ["attivazione","partenza","arrivo_sul_posto","paziente_visto","partenza_ospedale","arrivo_ospedale","libero_in_ospedale","rientro","disponibile"] as const;

async function ensurePazienti(interventoId: string) {
  const { rows } = await pool.query(`SELECT * FROM pazienti_intervento WHERE intervento_id=$1 ORDER BY numero`, [interventoId]);
  if (!rows.length) {
    const missione = await pool.query(`SELECT scheda FROM interventi WHERE id=$1`, [interventoId]);
    const legacy = missione.rows[0]?.scheda || {};
    await pool.query(`INSERT INTO pazienti_intervento(intervento_id,numero,scheda) VALUES($1,1,$2) ON CONFLICT DO NOTHING`, [interventoId, JSON.stringify(legacy)]);
    return (await pool.query(`SELECT * FROM pazienti_intervento WHERE intervento_id=$1 ORDER BY numero`, [interventoId])).rows;
  }
  return rows;
}

async function missioneCompleta(id: string) {
  const { rows } = await pool.query(`
    SELECT i.*, COALESCE(json_agg(json_build_object(
      'id',m.id,
      'nome',m.nome,
      'targa',m.targa,
      'stato',m.stato,
      'ultimo_stato',(SELECT s.stato FROM stati_intervento s WHERE s.intervento_id=i.id AND s.mezzo_id=m.id ORDER BY s.registrato_il DESC LIMIT 1)
    )) FILTER (WHERE m.id IS NOT NULL),'[]') AS mezzi
    FROM interventi i
    LEFT JOIN intervento_mezzi im ON im.intervento_id=i.id
    LEFT JOIN mezzi m ON m.id=im.mezzo_id
    WHERE i.id=$1 GROUP BY i.id`, [id]);
  if (!rows[0]) return rows[0];
  rows[0].pazienti = await ensurePazienti(id);
  return rows[0];
}

async function aggiornaStatoMissioneDaCronologia(interventoId: string) {
  const { rows: links } = await pool.query(
    `SELECT im.mezzo_id, (SELECT s.stato FROM stati_intervento s WHERE s.intervento_id=$1 AND s.mezzo_id=im.mezzo_id ORDER BY s.registrato_il DESC LIMIT 1) AS ultimo_stato
     FROM intervento_mezzi im WHERE im.intervento_id=$1`, [interventoId]
  );
  if (!links.length) {
    await pool.query(`UPDATE interventi SET stato='in_attesa' WHERE id=$1 AND stato NOT IN ('concluso','annullato')`, [interventoId]);
    return;
  }
  for (const link of links) {
    const stato = link.ultimo_stato || null;
    const mezzoStato = !stato || stato === 'disponibile' ? 'disponibile' : 'impegnato';
    await pool.query(`UPDATE mezzi SET stato=$1 WHERE id=$2`, [mezzoStato, link.mezzo_id]);
  }
  const nessunEvento = links.every((x:any) => !x.ultimo_stato);
  const tuttiDisponibili = links.every((x:any) => x.ultimo_stato === 'disponibile');
  const qualcunoInCorso = links.some((x:any) => ['partenza','arrivo_sul_posto','paziente_visto','partenza_ospedale','arrivo_ospedale','libero_in_ospedale','rientro'].includes(x.ultimo_stato));
  const nuovoStato = nessunEvento ? 'assegnato' : tuttiDisponibili ? 'concluso' : qualcunoInCorso ? 'in_corso' : 'assegnato';
  await pool.query(`UPDATE interventi SET stato=$1 WHERE id=$2 AND stato NOT IN ('annullato')`, [nuovoStato, interventoId]);
}

export async function interventiRoutes(app: FastifyInstance) {
  // Missione attiva del singolo mezzo: usata dal dispositivo di bordo all'avvio.
  app.get("/interventi/mezzo/:mezzoId/attiva", async (req) => {
    const { mezzoId } = req.params as { mezzoId: string };
    const { rows } = await pool.query(`
      SELECT i.id
      FROM interventi i
      JOIN intervento_mezzi im ON im.intervento_id=i.id
      WHERE im.mezzo_id=$1 AND i.stato NOT IN ('concluso','annullato')
      ORDER BY i.creato_il DESC LIMIT 1`, [mezzoId]);
    if (!rows.length) return null;
    const m = await missioneCompleta(rows[0].id);
    const { rows: stati } = await pool.query("SELECT * FROM stati_intervento WHERE intervento_id=$1 ORDER BY registrato_il", [rows[0].id]);
    return { ...m, cronologia: stati };
  });
  app.get("/interventi", async (req) => {
    const { data } = req.query as { data?: string };
    const { rows } = data
      ? await pool.query(`SELECT * FROM interventi WHERE creato_il::date=$1 ORDER BY creato_il DESC`, [data])
      : await pool.query(`SELECT * FROM interventi ORDER BY creato_il DESC LIMIT 200`);
    const out=[]; for (const r of rows) {
      const m=await missioneCompleta(r.id);
      const { rows: stati }=await pool.query("SELECT * FROM stati_intervento WHERE intervento_id=$1 ORDER BY registrato_il",[r.id]);
      out.push({...m,cronologia:stati});
    } return out;
  });

  app.get("/interventi/:id", async (req, reply) => {
    const { id } = req.params as { id:string };
    const missione = await missioneCompleta(id);
    if (!missione) return reply.code(404).send({ errore:"Missione non trovata" });
    const { rows: stati } = await pool.query("SELECT * FROM stati_intervento WHERE intervento_id=$1 ORDER BY registrato_il", [id]);
    return { ...missione, cronologia: stati };
  });

  app.post("/interventi", async (req, reply) => {
    const b = req.body as { indirizzo:string; lat?:number; lon?:number; tipologia?:string; note?:string; priorita?:string; ospedale?:string };
    if (!b.indirizzo?.trim()) return reply.code(400).send({ errore:"Indirizzo obbligatorio" });
    const priorita = ["verde","giallo","rosso"].includes(b.priorita || "") ? b.priorita : "verde";
    const { rows } = await pool.query(`INSERT INTO interventi(indirizzo,lat,lon,tipologia,note,priorita,ospedale) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [b.indirizzo.trim(),b.lat??null,b.lon??null,b.tipologia??null,b.note??null,priorita,b.ospedale??null]);
    const missione=await missioneCompleta(rows[0].id);
    getIO().to("centrale").emit("nuovo_intervento",missione); return reply.code(201).send(missione);
  });

  app.patch("/interventi/:id/scheda", async (req, reply) => {
    const { id }=req.params as {id:string}; const { scheda, ospedale, priorita }=req.body as {scheda:Record<string,unknown>;ospedale?:string;priorita?:string};
    const { rows }=await pool.query(`UPDATE interventi SET scheda=$1, ospedale=COALESCE($2,ospedale), priorita=COALESCE($3,priorita) WHERE id=$4 RETURNING *`,[JSON.stringify(scheda||{}),ospedale??null,priorita??null,id]);
    if(!rows.length)return reply.code(404).send({errore:"Missione non trovata"}); const m=await missioneCompleta(id); getIO().to("centrale").emit("missione_aggiornata",m); return m;
  });

  // Pazienti multipli per missione: ogni paziente ha una scheda indipendente.
  app.get("/interventi/:id/pazienti", async (req, reply) => {
    const { id } = req.params as { id:string };
    const exists = await pool.query(`SELECT 1 FROM interventi WHERE id=$1`, [id]);
    if (!exists.rows.length) return reply.code(404).send({ errore:"Missione non trovata" });
    return ensurePazienti(id);
  });

  app.post("/interventi/:id/pazienti", async (req, reply) => {
    const { id } = req.params as { id:string };
    const { mezzoId, etichetta, scheda } = req.body as { mezzoId?:string; etichetta?:string; scheda?:Record<string,unknown> };
    const exists = await pool.query(`SELECT 1 FROM interventi WHERE id=$1`, [id]);
    if (!exists.rows.length) return reply.code(404).send({ errore:"Missione non trovata" });
    const max = await pool.query(`SELECT COALESCE(MAX(numero),0)+1 AS numero FROM pazienti_intervento WHERE intervento_id=$1`, [id]);
    const numero = Number(max.rows[0].numero);
    if (mezzoId) {
      const linked = await pool.query(`SELECT 1 FROM intervento_mezzi WHERE intervento_id=$1 AND mezzo_id=$2`, [id, mezzoId]);
      if (!linked.rows.length) return reply.code(409).send({ errore:"Il mezzo indicato non è assegnato alla missione" });
    }
    const { rows } = await pool.query(`INSERT INTO pazienti_intervento(intervento_id,numero,mezzo_id,etichetta,scheda) VALUES($1,$2,$3,$4,$5) RETURNING *`, [id,numero,mezzoId||null,etichetta||`Paziente ${numero}`,JSON.stringify(scheda||{})]);
    const m=await missioneCompleta(id); getIO().to("centrale").emit("paziente_creato",m);
    if (mezzoId) getIO().to(`mezzo:${mezzoId}`).emit("paziente_creato",m);
    return reply.code(201).send(rows[0]);
  });

  app.patch("/interventi/:id/pazienti/:pazienteId", async (req, reply) => {
    const { id,pazienteId } = req.params as {id:string;pazienteId:string};
    const { mezzoId, etichetta, scheda } = req.body as { mezzoId?:string|null; etichetta?:string; scheda?:Record<string,unknown> };
    if (mezzoId) {
      const linked = await pool.query(`SELECT 1 FROM intervento_mezzi WHERE intervento_id=$1 AND mezzo_id=$2`, [id,mezzoId]);
      if (!linked.rows.length) return reply.code(409).send({ errore:"Il mezzo indicato non è assegnato alla missione" });
    }
    const { rows } = await pool.query(`UPDATE pazienti_intervento SET mezzo_id=$1, etichetta=COALESCE($2,etichetta), scheda=COALESCE($3,scheda), aggiornato_il=now() WHERE id=$4 AND intervento_id=$5 RETURNING *`, [mezzoId||null,etichetta??null,scheda?JSON.stringify(scheda):null,pazienteId,id]);
    if (!rows.length) return reply.code(404).send({ errore:"Paziente non trovato" });
    const m=await missioneCompleta(id); getIO().to("centrale").emit("paziente_aggiornato",m);
    if (rows[0].mezzo_id) getIO().to(`mezzo:${rows[0].mezzo_id}`).emit("paziente_aggiornato",m);
    return rows[0];
  });

  app.delete("/interventi/:id/pazienti/:pazienteId", async (req, reply) => {
    const { id,pazienteId } = req.params as {id:string;pazienteId:string};
    const { rows } = await pool.query(`DELETE FROM pazienti_intervento WHERE id=$1 AND intervento_id=$2 RETURNING *`, [pazienteId,id]);
    if (!rows.length) return reply.code(404).send({ errore:"Paziente non trovato" });
    await pool.query(`UPDATE pazienti_intervento SET numero=numero-1 WHERE intervento_id=$1 AND numero > $2`, [id,rows[0].numero]);
    const m=await missioneCompleta(id); getIO().to("centrale").emit("paziente_eliminato",m);
    return m;
  });

  app.delete("/interventi/:id", async (req, reply) => {
    const { id }=req.params as {id:string};
    const linked=await pool.query("SELECT mezzo_id FROM intervento_mezzi WHERE intervento_id=$1",[id]);
    const { rows }=await pool.query("DELETE FROM interventi WHERE id=$1 RETURNING id",[id]);
    if(!rows.length)return reply.code(404).send({errore:"Missione non trovata"});
    for(const row of linked.rows) getIO().to(`mezzo:${row.mezzo_id}`).emit("missione_chiusa",{interventoId:id,mezzoId:row.mezzo_id,eliminata:true});
    getIO().to("centrale").emit("intervento_eliminato",{id}); return {ok:true};
  });

  // Un mezzo può essere impegnato su una sola missione attiva per volta: è
  // riassegnabile solo se libero (mai assegnato / fuori servizio non incluso),
  // oppure se sulla missione attiva in cui si trova ha già raggiunto uno stato
  // di "rientro", "libero in ospedale" o "disponibile".
  async function mezzoAssegnabile(mezzoId: string) {
    const attive = await pool.query(
      `SELECT im.intervento_id
       FROM intervento_mezzi im
       JOIN interventi i ON i.id = im.intervento_id
       WHERE im.mezzo_id=$1 AND i.stato NOT IN ('concluso','annullato')`,
      [mezzoId]
    );
    for (const row of attive.rows) {
      const ultimo = await pool.query(
        `SELECT stato FROM stati_intervento WHERE intervento_id=$1 AND mezzo_id=$2 ORDER BY registrato_il DESC LIMIT 1`,
        [row.intervento_id, mezzoId]
      );
      const statoAttuale = ultimo.rows[0]?.stato;
      if (!["rientro", "libero_in_ospedale", "disponibile"].includes(statoAttuale)) {
        return false;
      }
    }
    return true;
  }

  app.post("/interventi/:id/assegna", async (req, reply) => {
    const {id}=req.params as {id:string}; const {mezzoId,operatoreId}=req.body as {mezzoId:string;operatoreId?:string};
    if(!mezzoId)return reply.code(400).send({errore:"mezzoId obbligatorio"});
    const mezzo=await pool.query("SELECT * FROM mezzi WHERE id=$1",[mezzoId]); if(!mezzo.rows.length)return reply.code(404).send({errore:"Mezzo non trovato"});
    if(mezzo.rows[0].stato==='fuori_servizio')return reply.code(409).send({errore:"Il mezzo è fuori servizio e non può essere assegnato"});
    const intervento=await pool.query("SELECT * FROM interventi WHERE id=$1",[id]); if(!intervento.rows.length)return reply.code(404).send({errore:"Missione non trovata"});
    const giaAssegnato=await pool.query("SELECT 1 FROM intervento_mezzi WHERE intervento_id=$1 AND mezzo_id=$2",[id,mezzoId]);
    if(giaAssegnato.rows.length) return reply.code(409).send({errore:"Il mezzo è già associato a questa missione"});
    if(!(await mezzoAssegnabile(mezzoId))) {
      return reply.code(409).send({errore:"Il mezzo è già impegnato su un'altra missione: può essere riassegnato solo se in rientro, libero in ospedale o disponibile"});
    }
    await pool.query(`INSERT INTO intervento_mezzi(intervento_id,mezzo_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[id,mezzoId]);
    await pool.query(`UPDATE interventi SET stato='assegnato',ora_assegnazione=COALESCE(ora_assegnazione,now()),mezzo_id=COALESCE(mezzo_id,$2) WHERE id=$1`,[id,mezzoId]);
    await pool.query("UPDATE mezzi SET stato='impegnato' WHERE id=$1",[mezzoId]);
    const notifica=await pool.query(`INSERT INTO notifiche_attivazione(intervento_id,operatore_id,mezzo_id) VALUES($1,$2,$3) RETURNING *`,[id,operatoreId??null,mezzoId]);
    const m=await missioneCompleta(id);
    await pool.query("UPDATE intervento_mezzi SET attivato_il=now() WHERE intervento_id=$1 AND mezzo_id=$2",[id,mezzoId]);
    await pool.query(`INSERT INTO stati_intervento(intervento_id,mezzo_id,stato) VALUES($1,$2,'attivazione')`,[id,mezzoId]);
    getIO().to("centrale").emit("intervento_assegnato",m);
    getIO().to(`mezzo:${mezzoId}`).emit("attivazione",{notificaId:notifica.rows[0].id,interventoId:id,mezzoId,missioneNumero:m.missione_numero,priorita:m.priorita,indirizzo:m.indirizzo,lat:m.lat,lon:m.lon,tipologia:m.tipologia,note:m.note});
    if(operatoreId){const op=await pool.query("SELECT push_token FROM operatori WHERE id=$1",[operatoreId]); if(op.rows[0]?.push_token){try{await inviaNotificaAttivazione(op.rows[0].push_token,{interventoId:id,indirizzo:m.indirizzo,tipologia:m.tipologia,mezzoId:mezzoId});}catch(e){console.error(e)}}}
    setTimeout(async()=>{const c=await pool.query("SELECT confermata_il FROM notifiche_attivazione WHERE id=$1",[notifica.rows[0].id]); if(c.rows.length&&!c.rows[0].confermata_il)getIO().to("centrale").emit("attivazione_senza_risposta",{interventoId:id,mezzoId});},TIMEOUT_SECONDI*1000);
    return m;
  });

  app.delete("/interventi/:id/mezzi/:mezzoId", async (req, reply)=>{
    const { id, mezzoId } = req.params as { id:string; mezzoId:string };
    const linked = await pool.query("SELECT 1 FROM intervento_mezzi WHERE intervento_id=$1 AND mezzo_id=$2", [id, mezzoId]);
    if (!linked.rows.length) return reply.code(404).send({ errore:"Mezzo non associato alla missione" });
    await pool.query("DELETE FROM notifiche_attivazione WHERE intervento_id=$1 AND mezzo_id=$2", [id, mezzoId]);
    await pool.query("DELETE FROM stati_intervento WHERE intervento_id=$1 AND mezzo_id=$2", [id, mezzoId]);
    await pool.query("DELETE FROM intervento_mezzi WHERE intervento_id=$1 AND mezzo_id=$2", [id, mezzoId]);
    await pool.query("UPDATE mezzi SET stato='disponibile' WHERE id=$1", [mezzoId]);
    await pool.query("UPDATE interventi SET mezzo_id=CASE WHEN mezzo_id=$2 THEN (SELECT mezzo_id FROM intervento_mezzi WHERE intervento_id=$1 LIMIT 1) ELSE mezzo_id END, stato=CASE WHEN NOT EXISTS (SELECT 1 FROM intervento_mezzi WHERE intervento_id=$1) THEN 'in_attesa' ELSE stato END WHERE id=$1", [id, mezzoId]);
    const m = await missioneCompleta(id);
    getIO().to("centrale").emit("mezzo_rimosso_missione", { missione:m, mezzoId });
    getIO().to(`mezzo:${mezzoId}`).emit("missione_rimossa", { interventoId:id, mezzoId });
    return m;
  });

  app.post("/interventi/:id/conferma-mezzo", async (req, reply)=>{
    const{id}=req.params as{id:string};
    const{mezzoId}=req.body as{mezzoId:string};
    if(!mezzoId)return reply.code(400).send({errore:"mezzoId obbligatorio"});
    const linked=await pool.query("SELECT 1 FROM intervento_mezzi WHERE intervento_id=$1 AND mezzo_id=$2",[id,mezzoId]);
    if(!linked.rows.length)return reply.code(409).send({errore:"Mezzo non associato alla missione"});
    await pool.query(`UPDATE notifiche_attivazione SET confermata_il=now(),esito='confermata' WHERE intervento_id=$1 AND mezzo_id=$2 AND confermata_il IS NULL`,[id,mezzoId]);
    await pool.query("UPDATE interventi SET ora_presa_in_carico=COALESCE(ora_presa_in_carico,now()),stato='in_corso' WHERE id=$1",[id]);
    await pool.query("UPDATE mezzi SET stato='impegnato' WHERE id=$1",[mezzoId]);
    const m=await missioneCompleta(id);
    getIO().to("centrale").emit("intervento_confermato",m);
    getIO().to(`mezzo:${mezzoId}`).emit("intervento_confermato",m);
    return m;
  });

  app.post("/interventi/:id/stato", async(req,reply)=>{
    const{id}=req.params as{id:string};
    const{stato,mezzoId}=req.body as{stato:string;mezzoId:string};
    if(!STATI_MISSIONE.includes(stato as any))return reply.code(400).send({errore:"Stato non valido"});
    if(!mezzoId)return reply.code(400).send({errore:"mezzoId obbligatorio"});
    const exists=await pool.query("SELECT 1 FROM intervento_mezzi WHERE intervento_id=$1 AND mezzo_id=$2",[id,mezzoId]);
    if(!exists.rows.length)return reply.code(409).send({errore:"Mezzo non associato alla missione"});
    const ultimo = await pool.query("SELECT stato FROM stati_intervento WHERE intervento_id=$1 AND mezzo_id=$2 ORDER BY registrato_il DESC LIMIT 1",[id,mezzoId]);
    const precedente = ultimo.rows[0]?.stato || "attivazione";
    const transizioni:any = {
      attivazione:["partenza"],
      partenza:["arrivo_sul_posto","rientro"],
      arrivo_sul_posto:["paziente_visto","rientro"],
      paziente_visto:["partenza_ospedale","rientro"],
      partenza_ospedale:["arrivo_ospedale","rientro"],
      arrivo_ospedale:["libero_in_ospedale"],
      libero_in_ospedale:["rientro"],
      rientro:["disponibile"],
      disponibile:[]
    };
    if (!transizioni[precedente]?.includes(stato)) return reply.code(409).send({errore:`Da "${precedente}" è possibile passare solo a: ${(transizioni[precedente]||[]).join(", ") || "nessuno"}`});
    await pool.query("INSERT INTO stati_intervento(intervento_id,mezzo_id,stato) VALUES($1,$2,$3)",[id,mezzoId,stato]);
    const map:any={attivazione:'assegnato',partenza:'in_corso',arrivo_sul_posto:'in_corso',paziente_visto:'in_corso',partenza_ospedale:'in_corso',arrivo_ospedale:'in_corso',libero_in_ospedale:'in_corso',rientro:'in_corso',disponibile:'in_corso'};
    await pool.query("UPDATE interventi SET stato=$1,ora_arrivo=CASE WHEN $2='arrivo_sul_posto' THEN now() ELSE ora_arrivo END,ora_rientro=CASE WHEN $2='rientro' THEN now() ELSE ora_rientro END WHERE id=$3",[map[stato],stato,id]);
    await pool.query("UPDATE mezzi SET stato=$1 WHERE id=$2",[stato==='disponibile'?'disponibile':'impegnato',mezzoId]);
    if(stato==='disponibile'){
      const pending=await pool.query(`SELECT 1 FROM intervento_mezzi im JOIN mezzi m ON m.id=im.mezzo_id WHERE im.intervento_id=$1 AND m.stato='impegnato'`,[id]);
      if(!pending.rows.length) await pool.query("UPDATE interventi SET stato='concluso' WHERE id=$1",[id]);
    }
    const m=await missioneCompleta(id);
    getIO().to("centrale").emit("stato_missione",{missione:m,mezzoId,stato});
    getIO().to(`mezzo:${mezzoId}`).emit("stato_missione",{missione:m,mezzoId,stato});
    return m;
  });

  app.patch("/interventi/:id/orari", async(req,reply)=>{
    const {id}=req.params as {id:string};
    const b=req.body as {creato_il?:string|null;ora_assegnazione?:string|null;ora_presa_in_carico?:string|null;ora_arrivo?:string|null;ora_rientro?:string|null};
    const {rows}=await pool.query(`UPDATE interventi SET
      creato_il=COALESCE($1,creato_il),
      ora_assegnazione=$2,
      ora_presa_in_carico=$3,
      ora_arrivo=$4,
      ora_rientro=$5
      WHERE id=$6 RETURNING *`,[b.creato_il||null,b.ora_assegnazione||null,b.ora_presa_in_carico||null,b.ora_arrivo||null,b.ora_rientro||null,id]);
    if(!rows.length)return reply.code(404).send({errore:"Missione non trovata"});
    const m=await missioneCompleta(id); getIO().to("centrale").emit("missione_aggiornata",m);
    return m;
  });

  app.patch("/interventi/:id/cronologia/:eventId", async(req,reply)=>{
    const {id,eventId}=req.params as {id:string;eventId:string};
    const {registrato_il}=req.body as {registrato_il:string};
    if(!registrato_il || Number.isNaN(Date.parse(registrato_il))) return reply.code(400).send({errore:"Data/ora non valida"});
    const {rows}=await pool.query(`UPDATE stati_intervento SET registrato_il=$1 WHERE id=$2 AND intervento_id=$3 RETURNING *`,[registrato_il,eventId,id]);
    if(!rows.length)return reply.code(404).send({errore:"Evento di cronologia non trovato"});
    await aggiornaStatoMissioneDaCronologia(id);
    const m=await missioneCompleta(id); getIO().to("centrale").emit("cronologia_modificata",{missione:m,eventId});
    if(rows[0].mezzo_id)getIO().to(`mezzo:${rows[0].mezzo_id}`).emit("cronologia_modificata",{missione:m,eventId});
    return m;
  });

  app.delete("/interventi/:id/cronologia/:eventId", async(req,reply)=>{
    const {id,eventId}=req.params as {id:string;eventId:string};
    const existing=await pool.query(`SELECT * FROM stati_intervento WHERE id=$1 AND intervento_id=$2`,[eventId,id]);
    if(!existing.rows.length)return reply.code(404).send({errore:"Evento di cronologia non trovato"});
    await pool.query(`DELETE FROM stati_intervento WHERE id=$1 AND intervento_id=$2`,[eventId,id]);
    await aggiornaStatoMissioneDaCronologia(id);
    const m=await missioneCompleta(id); getIO().to("centrale").emit("cronologia_modificata",{missione:m,eventId,eliminato:true});
    if(existing.rows[0].mezzo_id)getIO().to(`mezzo:${existing.rows[0].mezzo_id}`).emit("cronologia_modificata",{missione:m,eventId,eliminato:true});
    return m;
  });

  app.post("/interventi/:id/chiudi", async(req,reply)=>{
    const{id}=req.params as{id:string};
    const {rows}=await pool.query("UPDATE interventi SET stato='concluso',ora_rientro=COALESCE(ora_rientro,now()) WHERE id=$1 RETURNING *",[id]);
    if(!rows.length)return reply.code(404).send({errore:"Missione non trovata"});
    const linked=await pool.query("SELECT mezzo_id FROM intervento_mezzi WHERE intervento_id=$1",[id]);
    await pool.query("UPDATE mezzi SET stato='disponibile' WHERE id IN (SELECT mezzo_id FROM intervento_mezzi WHERE intervento_id=$1)",[id]);
    const m=await missioneCompleta(id);
    for(const row of linked.rows) getIO().to(`mezzo:${row.mezzo_id}`).emit("missione_chiusa",{interventoId:id,mezzoId:row.mezzo_id,missione:m});
    getIO().to("centrale").emit("intervento_concluso",m);
    return m;
  });
}
