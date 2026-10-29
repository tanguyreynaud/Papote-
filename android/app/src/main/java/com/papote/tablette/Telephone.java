package com.papote.tablette;

import android.Manifest;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.telecom.TelecomManager;
import android.telephony.TelephonyManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Appels par la carte SIM (chantier téléphone, 29/10/2026, décision de Tanguy : depuis la tablette,
 * Mamie appelle TOUJOURS par téléphone ; la visio ne part plus que depuis l'app du proche).
 *
 * Papote est l'application Téléphone de la tablette (rôle DIALER, donné par installer-tablette.ps1 et
 * repris au démarrage par le propriétaire de l'appareil) : c'est elle qui montre l'écran d'appel
 * ({@link AppelGsm}), sinon l'écran d'Android passerait par-dessus le kiosque.
 *
 * Numéros de la famille : members/{uid}.telephone, relus avec les visages (Sync) et gardés ici
 * (prefs « numerosFamille » : [{uid, name, tel, responsable}]). Un appel entrant d'un autre numéro, ou
 * masqué, est refusé en silence ({@link BlockCalls}).
 */
final class Telephone {
    private static final String TAG = "Papote";
    private static final String PREF = "numerosFamille";

    private Telephone() { }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences("papote", Context.MODE_PRIVATE);
    }

    /** Chiffres significatifs d'un numéro : « 06 12 34 56 78 », « +33612345678 », « 0033… » → « 612345678 ». */
    static String normaliser(String numero) {
        if (numero == null) return "";
        String n = numero.replaceAll("[^0-9+]", "");
        if (n.startsWith("+")) n = n.substring(1);
        if (n.startsWith("00")) n = n.substring(2);
        if (n.startsWith("33") && n.length() == 11) n = n.substring(2);
        if (n.startsWith("0") && n.length() == 10) n = n.substring(1);
        return n;
    }

    static boolean memeNumero(String a, String b) {
        String na = normaliser(a), nb = normaliser(b);
        if (na.isEmpty() || nb.isEmpty()) return false;
        if (na.equals(nb)) return true;
        // Numéros étrangers ou formats inattendus : les 9 derniers chiffres suffisent.
        return na.length() >= 9 && nb.length() >= 9 && na.substring(na.length() - 9).equals(nb.substring(nb.length() - 9));
    }

    /** Numéro tel qu'on le compose : « 0612345678 » pour un numéro français, sinon « +… ». */
    static String composer(String numero) {
        String n = normaliser(numero);
        if (n.length() == 9 && !n.startsWith("0")) return "0" + n;
        String brut = numero == null ? "" : numero.replaceAll("[^0-9+]", "");
        return brut.startsWith("+") ? brut : brut.startsWith("00") ? "+" + brut.substring(2) : brut;
    }

    static void garderNumeros(Context c, JSONArray liste) {
        String avant = prefs(c).getString(PREF, "[]");
        String apres = liste == null ? "[]" : liste.toString();
        if (apres.equals(avant)) return;
        prefs(c).edit().putString(PREF, apres).apply();
        Journal.log(c, "Numéros de la famille : " + (liste == null ? 0 : liste.length()));
    }

    static JSONArray numeros(Context c) {
        try {
            return new JSONArray(prefs(c).getString(PREF, "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    /** Le proche qui a ce numéro ({uid, name, tel, responsable}), ou null. */
    static JSONObject proche(Context c, String numero) {
        JSONArray liste = numeros(c);
        for (int i = 0; i < liste.length(); i++) {
            JSONObject p = liste.optJSONObject(i);
            if (p != null && memeNumero(p.optString("tel"), numero)) return p;
        }
        return null;
    }

    static boolean saitTelephoner(Context c) {
        PackageManager pm = c.getPackageManager();
        if (!pm.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)) return false;
        TelephonyManager tm = (TelephonyManager) c.getSystemService(Context.TELEPHONY_SERVICE);
        return tm != null && tm.getSimState() == TelephonyManager.SIM_STATE_READY;
    }

    static boolean estAppliTelephone(Context c) {
        try {
            TelecomManager tel = (TelecomManager) c.getSystemService(Context.TELECOM_SERVICE);
            return tel != null && c.getPackageName().equals(tel.getDefaultDialerPackage());
        } catch (Exception e) {
            return false;
        }
    }

    /** La tablette peut téléphoner : carte SIM prête et Papote application Téléphone. */
    static boolean pret(Context c) {
        return saitTelephoner(c) && estAppliTelephone(c);
    }

    /**
     * Au démarrage, par le propriétaire de l'appareil : droits d'appel et rôle Téléphone (Android 14+ ;
     * avant, seulement par installer-tablette.ps1 : cmd role add-role-holder android.app.role.DIALER).
     */
    static void preparer(Context c) {
        try {
            DevicePolicyManager dpm = (DevicePolicyManager) c.getSystemService(Context.DEVICE_POLICY_SERVICE);
            if (dpm == null || !dpm.isDeviceOwnerApp(c.getPackageName())) return;
            ComponentName admin = new ComponentName(c, AdminReceiver.class);
            for (String p : new String[]{Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE,
                    Manifest.permission.READ_PHONE_NUMBERS, Manifest.permission.SEND_SMS}) {
                dpm.setPermissionGrantState(admin, c.getPackageName(), p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
            }
            if (Build.VERSION.SDK_INT >= 34 && saitTelephoner(c) && !estAppliTelephone(c)) {
                dpm.setDefaultDialerApplication(c.getPackageName());
                Journal.log(c, "Papote devient l'application Téléphone de la tablette");
            }
        } catch (Exception e) {
            Log.w(TAG, "Rôle Téléphone", e);
            Journal.log(c, "Rôle Téléphone impossible : " + e);
        }
    }

    /** Lance un appel par la carte SIM. false si l'appel ne peut pas partir (pas de SIM, pas le rôle). */
    static boolean appeler(Context c, String numero) {
        String n = composer(numero);
        if (n.isEmpty() || !pret(c)) return false;
        if (c.checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            Journal.log(c, "Appel téléphone impossible : droit d'appel absent");
            return false;
        }
        try {
            TelecomManager tel = (TelecomManager) c.getSystemService(Context.TELECOM_SERVICE);
            Bundle extras = new Bundle();
            extras.putBoolean(TelecomManager.EXTRA_START_CALL_WITH_SPEAKERPHONE, true);
            tel.placeCall(Uri.fromParts("tel", n, null), extras);
            Journal.log(c, "Appel téléphone vers " + masquer(n));
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Appel téléphone", e);
            Journal.log(c, "Appel téléphone impossible : " + e);
            return false;
        }
    }

    /** Dans le journal, seulement la fin du numéro. */
    static String masquer(String numero) {
        String n = numero == null ? "" : numero;
        return n.length() <= 4 ? "…" : "…" + n.substring(n.length() - 4);
    }

    /** Numéro de la carte SIM de la tablette (souvent vide : Android ne le lit pas sur toutes les cartes). */
    @SuppressWarnings("MissingPermission")
    static String numeroTablette(Context c) {
        try {
            TelephonyManager tm = (TelephonyManager) c.getSystemService(Context.TELEPHONY_SERVICE);
            if (tm == null || tm.getSimState() != TelephonyManager.SIM_STATE_READY) return "";
            String n = tm.getLine1Number();
            if (n == null || n.isEmpty()) {
                android.telephony.SubscriptionManager sm = (android.telephony.SubscriptionManager)
                        c.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE);
                java.util.List<android.telephony.SubscriptionInfo> subs = sm == null ? null : sm.getActiveSubscriptionInfoList();
                if (subs != null && !subs.isEmpty()) {
                    n = Build.VERSION.SDK_INT >= 33 ? sm.getPhoneNumber(subs.get(0).getSubscriptionId()) : subs.get(0).getNumber();
                }
            }
            return n == null ? "" : composer(n);
        } catch (Exception e) {
            return "";
        }
    }
}
