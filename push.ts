import "dotenv/config";
import fs from "fs";

let admin: typeof import("firebase-admin") | null = null;
let initialized = false;

/**
 * Inizializza Firebase Admin SDK solo se il file di credenziali esiste.
 * In fase di sviluppo iniziale, se manca, l'invio push viene semplicemente
 * loggato in console senza bloccare il resto del sistema.
 */
async function ensureInit() {
  if (initialized) return;
  const credPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? "";
  if (credPath && fs.existsSync(credPath)) {
    admin = (await import("firebase-admin")).default;
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(fs.readFileSync(credPath, "utf-8"))),
      });
    }
  } else {
    console.warn(
      "[push] Nessuna credenziale Firebase trovata: le notifiche push verranno solo loggate."
    );
  }
  initialized = true;
}

interface AttivazionePayload {
  interventoId: string;
  indirizzo: string;
  tipologia?: string;
}

/**
 * Invia una notifica push "critica": priorità massima, suono ad alto volume,
 * pensata per svegliare l'app anche a schermo spento o in background.
 */
export async function inviaNotificaAttivazione(pushToken: string, payload: AttivazionePayload) {
  await ensureInit();

  if (!admin) {
    console.log(`[push:SIMULATA] -> token=${pushToken}`, payload);
    return { simulata: true };
  }

  const message = {
    token: pushToken,
    notification: {
      title: "ATTIVAZIONE",
      body: payload.indirizzo,
    },
    data: {
      interventoId: payload.interventoId,
      tipologia: payload.tipologia ?? "",
      tipo: "attivazione",
    },
    android: {
      priority: "high" as const,
      notification: {
        channelId: "attivazioni-critiche", // canale ad alta priorità configurato lato app
        sound: "attivazione_alta_priorita",
        visibility: "public" as const,
      },
    },
    apns: {
      headers: { "apns-priority": "10" },
      payload: {
        aps: {
          sound: {
            critical: true,
            name: "attivazione_alta_priorita.caf",
            volume: 1.0,
          },
          "interruption-level": "critical",
        },
      },
    },
  };

  return admin.messaging().send(message);
}
