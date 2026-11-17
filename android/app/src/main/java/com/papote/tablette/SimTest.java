package com.papote.tablette;

import android.annotation.SuppressLint;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.telephony.ServiceState;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;
import android.util.Log;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * « Installer la carte SIM » (admin, préparation de l'envoi, 13/11) : la tablette, encore sur l'écran
 * Bienvenue, vérifie sa carte et le dit au serveur dans son pairings/{code}.simTest :
 * carte présente et sans code, française (MCC 208), inscrite au réseau sans itinérance, et des données
 * qui passent VRAIMENT par la carte (requête HTTPS sur le réseau mobile, même wifi allumé).
 */
final class SimTest {
    private static final String TAG = "Papote";
    static final long DONNEES_MS = 10_000;

    private SimTest() { }

    /** Résultat de la mesure. */
    static final class Resultat {
        String iccid, mcc, mnc, operateur, etat;
        boolean inscrite, itinerance, donneesOk;
        long donneesMs = -1;
    }

    // ---------- Décision (sans Android, testée dans SimTestTest) ----------

    /** État d'ensemble, dans l'ordre où un problème empêche les suivants. */
    static String etat(String carte, String mcc, boolean inscrite, boolean itinerance, boolean donneesOk) {
        if (carte != null && !carte.isEmpty()) return carte; // absente, pin, puk, verrouillee
        if (mcc != null && !mcc.isEmpty() && !"208".equals(mcc)) return "etrangere";
        if (!inscrite || itinerance) return "sans-reseau";
        if (!donneesOk) return "donnees-ko";
        return "ok";
    }

    /** État de la carte elle-même : "" si prête. */
    static String carte(int simState) {
        switch (simState) {
            case TelephonyManager.SIM_STATE_READY: return "";
            case TelephonyManager.SIM_STATE_PIN_REQUIRED: return "pin";
            case TelephonyManager.SIM_STATE_PUK_REQUIRED: return "puk";
            case TelephonyManager.SIM_STATE_NETWORK_LOCKED: return "verrouillee";
            default: return "absente";
        }
    }

    // ---------- Mesure sur la tablette ----------

    @SuppressLint("MissingPermission")
    static Resultat mesurer(Context c) {
        Resultat r = new Resultat();
        TelephonyManager tm = (TelephonyManager) c.getSystemService(Context.TELEPHONY_SERVICE);
        String carte = tm == null ? "absente" : carte(tm.getSimState());
        if (carte.isEmpty() && tm != null) {
            String op = tm.getSimOperator();
            if (op != null && op.length() >= 5) { r.mcc = op.substring(0, 3); r.mnc = op.substring(3); }
            r.operateur = tm.getSimOperatorName();
            try {
                SubscriptionManager sm = (SubscriptionManager) c.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE);
                List<SubscriptionInfo> subs = sm == null ? null : sm.getActiveSubscriptionInfoList();
                if (subs != null && !subs.isEmpty()) r.iccid = subs.get(0).getIccId();
            } catch (SecurityException e) {
                Log.w(TAG, "Essai SIM : ICCID", e);
            }
            try {
                ServiceState ss = tm.getServiceState();
                r.inscrite = ss != null && ss.getState() == ServiceState.STATE_IN_SERVICE;
                r.itinerance = ss != null && ss.getRoaming();
            } catch (SecurityException e) {
                Log.w(TAG, "Essai SIM : réseau", e);
            }
            if (r.inscrite) donnees(c, r);
        }
        r.etat = etat(carte, r.mcc, r.inscrite, r.itinerance, r.donneesOk);
        return r;
    }

    // ---------- SMS et appel d'essai (ordre.appel = {numero, secondes, texte}, Gestion 17/11) ----------

    static final long SMS_MAX_MS = 30_000;
    static final int SMS_DELAI = -999;          // pas de réponse d'Android en 30 s
    static final long APPEL_MIN_MS = 8_000;     // appel « ok » : en cours au moins 8 s sans coupure

    static final class Sms { boolean ok; int code = SMS_DELAI; long ms; }
    static final class Appel { boolean ok; long secondes; String raison; }

    /** Raison d'un appel fini avant 8 s, d'après la cause Android. */
    static String raison(int cause) {
        switch (cause) {
            case android.telecom.DisconnectCause.BUSY:
            case android.telecom.DisconnectCause.REJECTED: return "refuse";
            case android.telecom.DisconnectCause.ERROR:
            case android.telecom.DisconnectCause.RESTRICTED: return "erreur";
            default: return "coupe";
        }
    }

    static Sms envoyerSms(Context c, String numero, String texte) {
        Sms s = new Sms();
        String n = Telephone.composer(numero);
        if (n.isEmpty()) return s;
        final int[] code = {SMS_DELAI};
        final CountDownLatch fini = new CountDownLatch(1);
        String action = "com.papote.tablette.SIMTEST_SMS_" + System.nanoTime();
        android.content.BroadcastReceiver r = new android.content.BroadcastReceiver() {
            @Override public void onReceive(Context ctx, android.content.Intent i) { code[0] = getResultCode(); fini.countDown(); }
        };
        long debut = System.currentTimeMillis();
        try {
            android.content.IntentFilter f = new android.content.IntentFilter(action);
            if (android.os.Build.VERSION.SDK_INT >= 33) c.registerReceiver(r, f, Context.RECEIVER_NOT_EXPORTED);
            else c.registerReceiver(r, f);
            android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(c, 0,
                    new android.content.Intent(action).setPackage(c.getPackageName()), android.app.PendingIntent.FLAG_IMMUTABLE);
            android.telephony.SmsManager.getDefault().sendTextMessage(n, null, texte == null ? "Papote : test de la carte SIM" : texte, pi, null);
            fini.await(SMS_MAX_MS, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            Log.w(TAG, "Essai SIM : SMS", e);
        } finally {
            try { c.unregisterReceiver(r); } catch (Exception ignored) { }
        }
        s.code = code[0];
        s.ok = code[0] == android.app.Activity.RESULT_OK;
        s.ms = System.currentTimeMillis() - debut;
        return s;
    }

    /** Appelle le numéro, laisse sonner « secondes », raccroche. Bloquant (fil de la synchronisation). */
    static Appel appeler(Context c, String numero, long secondes) {
        Appel a = new Appel();
        if (Telephone.composer(numero).isEmpty()) { a.raison = "numero"; return a; }
        if (c.checkSelfPermission(android.Manifest.permission.CALL_PHONE) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            a.raison = "sans-permission";
            return a;
        }
        if (!Telephone.appeler(c, numero)) { a.raison = "erreur"; return a; }
        long fin = System.currentTimeMillis() + 10_000 + secondes * 1000;
        long debut = 0;
        android.telecom.Call call = null;
        while (System.currentTimeMillis() < fin) {
            android.telecom.Call ce = AppelGsm.appelEnCours();
            if (ce != null && call == null) { call = ce; debut = System.currentTimeMillis(); fin = debut + secondes * 1000; }
            if (call != null && !AppelGsm.encoreOuvert(call.getState())) break;
            android.os.SystemClock.sleep(250);
        }
        if (call == null) { a.raison = "erreur"; return a; }
        long duree = System.currentTimeMillis() - debut;
        if (AppelGsm.encoreOuvert(call.getState())) {
            AppelGsm.raccrocher();
            a.ok = duree >= APPEL_MIN_MS;
        } else {
            android.telecom.DisconnectCause dc = call.getDetails() == null ? null : call.getDetails().getDisconnectCause();
            a.ok = duree >= APPEL_MIN_MS;
            if (!a.ok) a.raison = raison(dc == null ? android.telecom.DisconnectCause.UNKNOWN : dc.getCode());
        }
        a.secondes = duree / 1000;
        return a;
    }

    /** Une requête HTTPS forcée sur le réseau mobile (requestNetwork), même si le wifi est là. */
    private static void donnees(Context c, Resultat r) {
        ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        final Network[] trouve = new Network[1];
        final CountDownLatch pret = new CountDownLatch(1);
        ConnectivityManager.NetworkCallback cb = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) { trouve[0] = n; pret.countDown(); }
        };
        long debut = System.currentTimeMillis();
        try {
            cm.requestNetwork(new NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), cb);
            if (!pret.await(DONNEES_MS, TimeUnit.MILLISECONDS) || trouve[0] == null) return;
            HttpURLConnection h = (HttpURLConnection) trouve[0].openConnection(new URL("https://firestore.googleapis.com/"));
            h.setConnectTimeout((int) DONNEES_MS);
            h.setReadTimeout((int) DONNEES_MS);
            h.setRequestMethod("HEAD");
            int code = h.getResponseCode(); // n'importe quelle réponse HTTP : les données passent
            h.disconnect();
            r.donneesOk = code > 0;
            r.donneesMs = System.currentTimeMillis() - debut;
        } catch (Exception e) {
            Log.w(TAG, "Essai SIM : données", e);
        } finally {
            try { cm.unregisterNetworkCallback(cb); } catch (Exception ignored) { }
        }
    }
}
