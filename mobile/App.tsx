import { useEffect, useRef, useState } from "react";
import { View, Text, Button, StyleSheet, Vibration, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";

const API_URL = process.env.EXPO_PUBLIC_API_URL || "https://TUO-SERVIZIO.onrender.com";
const OPERATORE_ID = "INSERISCI-ID-OPERATORE"; // in produzione: da login
const MEZZO_ID = process.env.EXPO_PUBLIC_MEZZO_ID || "";

// Mostra la notifica anche con app in foreground, a volume massimo
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function registraCanaleCritico() {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("attivazioni-critiche", {
      name: "Attivazioni critiche",
      importance: Notifications.AndroidImportance.MAX,
      sound: "attivazione_alta_priorita.wav",
      vibrationPattern: [0, 500, 250, 500],
      bypassDnd: true, // ignora "Non disturbare"
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
}

async function registraPushToken() {
  if (!Device.isDevice) {
    console.warn("Le notifiche push richiedono un dispositivo fisico.");
    return;
  }
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== "granted") {
    console.warn("Permesso notifiche negato.");
    return;
  }
  const token = (await Notifications.getExpoPushTokenAsync()).data;

  // Invia il token al backend così può essere usato per l'attivazione
  await fetch(`${API_URL}/operatori/${OPERATORE_ID}/push-token`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pushToken: token }),
  }).catch((e) => console.error("Errore invio push token:", e));
}

export default function App() {
  const [interventoAttivo, setInterventoAttivo] = useState<{
    id: string;
    indirizzo: string;
  } | null>(null);
  const notificationListener = useRef<Notifications.Subscription>();

  useEffect(() => {
    registraCanaleCritico();
    registraPushToken();

    notificationListener.current = Notifications.addNotificationReceivedListener((notif) => {
      const data = notif.request.content.data as { tipo?: string; interventoId?: string; indirizzo?: string; mezzoId?: string };
      if (data.tipo === "attivazione" && data.interventoId) {
        Vibration.vibrate([0, 500, 250, 500], true);
        setInterventoAttivo({
          id: data.interventoId,
          indirizzo: data.indirizzo || (notif.request.content.body as string) || "",
        });
      }
    });

    return () => {
      notificationListener.current?.remove();
    };
  }, []);

  async function confermaAttivazione() {
    if (!interventoAttivo) return;
    Vibration.cancel();
    // La conferma della notifica deve indicare anche il mezzo assegnato.
    await fetch(`${API_URL}/interventi/${interventoAttivo.id}/conferma-mezzo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mezzoId: data.mezzoId || MEZZO_ID }),
    });
    setInterventoAttivo(null);
  }

  return (
    <View style={styles.container}>
      {interventoAttivo ? (
        <View style={styles.allarme}>
          <Text style={styles.titolo}>ATTIVAZIONE</Text>
          <Text style={styles.indirizzo}>{interventoAttivo.indirizzo}</Text>
          <Button title="Conferma presa in carico" onPress={confermaAttivazione} color="#c62828" />
        </View>
      ) : (
        <Text style={styles.inAttesa}>In attesa di attivazioni...</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  allarme: { alignItems: "center", gap: 16 },
  titolo: { fontSize: 32, fontWeight: "bold", color: "#c62828" },
  indirizzo: { fontSize: 20, textAlign: "center" },
  inAttesa: { fontSize: 16, color: "#666" },
});
