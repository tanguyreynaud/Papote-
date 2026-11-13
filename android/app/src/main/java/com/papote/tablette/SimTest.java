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
