import "dotenv/config";
import fs from "fs";

let admin: typeof import("firebase-admin") | null = null;
let initialized = false;

async function ensureInit() {
  if (initialized) return;

  const credJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? "";
  const credPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ?? "";

  let credentials: object | null = null;

  if (credJson) {
    try {
      credentials = JSON.parse(credJson);
    } catch (e) {
      console.error("[push] FIREBASE_SERVICE_ACCOUNT_JSON non è un JSON valido:", e);
    }
  } else if (credPath && fs.existsSync(credPath)) {
    credentials = JSON.parse(fs.readFileSync(credPath, "utf-8"));
  }

  if (credentials) {
    admin = (await import("firebase-admin")).default;
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(credentials as any),
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
        channelId: "attivazioni-critiche",
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
