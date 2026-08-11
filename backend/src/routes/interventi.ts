import type { FastifyInstance } from "fastify";
import { pool } from "../db/pool.js";
import { getIO } from "../ws/socket.js";
import { inviaNotificaAttivazione } from "../ws/push.js";

const TIMEOUT_SECONDI = Number(process.env.ACTIVATION_TIMEOUT_SECONDS ?? 60);
const STATI_MISSIONE = ["attivazione","partenza","arrivo_sul_posto","paziente_visto","partenza_ospedale","arrivo_ospedale","libero_in_ospedale","rientro","disponibile"] as const;

async function missioneCompleta(id: string) {
  const { rows } = await pool.query(`
    SELECT i.*, COALESCE(json_agg(json_build_object('id',m.id,'nome',m.nome,'targa',m.targa,'stato',m.stato)) FILTER (WHERE m.id IS NOT NULL),'[]') AS mezzi
    FROM interventi i
    LEFT JOIN intervento_mezzi im ON im.intervento_id=i.id
    LEFT JOIN mezzi m ON m.id=im.mezzo_id
    WHERE i.id=$1 GROUP BY i.id`, [id]);
  return rows[0];
}

export async function interventiRoutes(app: FastifyInstance) {
  app.get("/interventi", async (req) => {
    const { data } = req.query as { data?: string };
    const { rows } = data
      ? await pool.query(`SELECT * FROM interventi WHERE creato_il::date=$1 ORDER BY creato_il DESC`, [data])
      : await pool.query(`SELECT * FROM interventi ORDER BY creato_il DESC LIMIT 200`);
    const out=[]; for (const r of rows) out.push(await missioneCompleta(r.id)); return out;
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

  app.delete("/interventi/:id", async (req, reply) => {
    const { id }=req.params as {id:string}; const { rows }=await pool.query("DELETE FROM interventi WHERE id=$1 RETURNING id",[id]);
    if(!rows.length)return reply.code(404).send({errore:"Missione non trovata"}); getIO().to("centrale").emit("intervento_eliminato",{id}); return {ok:true};
  });

  app.post("/interventi/:id/assegna", async (req, reply) => {
    const {id}=req.params as {id:string}; const {mezzoId,operatoreId}=req.body as {mezzoId:string;operatoreId?:string};
    if(!mezzoId)return reply.code(400).send({errore:"mezzoId obbligatorio"});
    const mezzo=await pool.query("SELECT * FROM mezzi WHERE id=$1",[mezzoId]); if(!mezzo.rows.length)return reply.code(404).send({errore:"Mezzo non trovato"});
    const intervento=await pool.query("SELECT * FROM interventi WHERE id=$1",[id]); if(!intervento.rows.length)return reply.code(404).send({errore:"Missione non trovata"});
    await pool.query(`INSERT INTO intervento_mezzi(intervento_id,mezzo_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[id,mezzoId]);
    await pool.query(`UPDATE interventi SET stato='assegnato',ora_assegnazione=COALESCE(ora_assegnazione,now()),mezzo_id=COALESCE(mezzo_id,$2) WHERE id=$1`,[id,mezzoId]);
    await pool.query("UPDATE mezzi SET stato='impegnato' WHERE id=$1",[mezzoId]);
    const notifica=await pool.query(`INSERT INTO notifiche_attivazione(intervento_id,operatore_id,mezzo_id) VALUES($1,$2,$3) RETURNING *`,[id,operatoreId??null,mezzoId]);
    const m=await missioneCompleta(id);
    await pool.query("UPDATE intervento_mezzi SET attivato_il=now() WHERE intervento_id=$1 AND mezzo_id=$2",[id,mezzoId]);
    await pool.query(`INSERT INTO stati_intervento(intervento_id,mezzo_id,stato) VALUES($1,$2,'attivazione')`,[id,mezzoId]);
    getIO().to("centrale").emit("intervento_assegnato",m);
    getIO().to(`mezzo:${mezzoId}`).emit("attivazione",{notificaId:notifica.rows[0].id,interventoId:id,mezzoId,missioneNumero:m.missione_numero,priorita:m.priorita,indirizzo:m.indirizzo,lat:m.lat,lon:m.lon,tipologia:m.tipologia,note:m.note});
    if(operatoreId){const op=await pool.query("SELECT push_token FROM operatori WHERE id=$1",[operatoreId]); if(op.rows[0]?.push_token){try{await inviaNotificaAttivazione(op.rows[0].push_token,{interventoId:id,indirizzo:m.indirizzo,tipologia:m.tipologia});}catch(e){console.error(e)}}}
    setTimeout(async()=>{const c=await pool.query("SELECT confermata_il FROM notifiche_attivazione WHERE id=$1",[notifica.rows[0].id]); if(c.rows.length&&!c.rows[0].confermata_il)getIO().to("centrale").emit("attivazione_senza_risposta",{interventoId:id,mezzoId});},TIMEOUT_SECONDI*1000);
    return m;
  });

  app.post("/interventi/:id/conferma-mezzo", async (req, reply)=>{const{id}=req.params as{id:string};const{mezzoId}=req.body as{mezzoId:string}; await pool.query(`UPDATE notifiche_attivazione SET confermata_il=now(),esito='confermata' WHERE intervento_id=$1 AND mezzo_id=$2 AND confermata_il IS NULL`,[id,mezzoId]); const r=await pool.query("UPDATE interventi SET ora_presa_in_carico=COALESCE(ora_presa_in_carico,now()),stato='in_corso' WHERE id=$1 RETURNING *",[id]); if(!r.rows.length)return reply.code(404).send({errore:"Missione non trovata"}); const m=await missioneCompleta(id); getIO().to("centrale").emit("intervento_confermato",m); return m;});

  app.post("/interventi/:id/stato", async(req,reply)=>{const{id}=req.params as{id:string};const{stato,mezzoId}=req.body as{stato:string;mezzoId:string}; if(!STATI_MISSIONE.includes(stato as any))return reply.code(400).send({errore:"Stato non valido"}); if(!mezzoId)return reply.code(400).send({errore:"mezzoId obbligatorio"}); const exists=await pool.query("SELECT 1 FROM intervento_mezzi WHERE intervento_id=$1 AND mezzo_id=$2",[id,mezzoId]); if(!exists.rows.length)return reply.code(409).send({errore:"Mezzo non associato alla missione"}); await pool.query("INSERT INTO stati_intervento(intervento_id,mezzo_id,stato) VALUES($1,$2,$3)",[id,mezzoId,stato]); const map:any={attivazione:'assegnato',partenza:'in_corso',arrivo_sul_posto:'in_corso',paziente_visto:'in_corso',partenza_ospedale:'in_corso',arrivo_ospedale:'in_corso',libero_in_ospedale:'in_corso',rientro:'in_corso',disponibile:'concluso'}; await pool.query("UPDATE interventi SET stato=$1,ora_arrivo=CASE WHEN $2='arrivo_sul_posto' THEN now() ELSE ora_arrivo END,ora_rientro=CASE WHEN $2='rientro' THEN now() ELSE ora_rientro END WHERE id=$3",[map[stato],stato,id]); if(stato==='disponibile')await pool.query("UPDATE mezzi SET stato='disponibile' WHERE id=$1",[mezzoId]); const m=await missioneCompleta(id); getIO().to("centrale").emit("stato_missione",{missione:m,mezzoId,stato}); return m;});

  app.post("/interventi/:id/chiudi", async(req,reply)=>{const{id}=req.params as{id:string}; const{rows}=await pool.query("UPDATE interventi SET stato='concluso',ora_rientro=now() WHERE id=$1 RETURNING *",[id]); if(!rows.length)return reply.code(404).send({errore:"Missione non trovata"}); await pool.query("UPDATE mezzi SET stato='disponibile' WHERE id IN (SELECT mezzo_id FROM intervento_mezzi WHERE intervento_id=$1)",[id]); const m=await missioneCompleta(id); getIO().to("centrale").emit("intervento_concluso",m); return m;});
}
