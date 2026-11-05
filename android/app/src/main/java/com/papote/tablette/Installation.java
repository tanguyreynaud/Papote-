package com.papote.tablette;

import android.Manifest;
import android.app.Activity;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.PersistableBundle;
import android.provider.Settings;
import android.telephony.TelephonyManager;
import android.util.DisplayMetrics;
import android.util.Log;

import org.json.JSONObject;

/**
 * Installation d'une tablette par QR code (Tanguy, 05/11) : sur une tablette neuve, 6 touchers sur l'écran
 * d'accueil, on scanne le QR de l'admin, Android télécharge Papote et en fait le propriétaire de l'appareil.
 * Remplace adb (installer-tablette.ps1) pour la préparation.
 *   GET_PROVISIONING_MODE   → appareil entièrement géré (ModeInstallation) ;
 *   ADMIN_POLICY_COMPLIANCE → ce que faisait le script : droits, réglages, applis inutiles (Conformite) ;
 *   puis, dès qu'internet est là, la tablette s'inscrit (callable inscrireTablette, jeton du QR à usage unique).
 * Le QR (admin) : PROVISIONING_ADMIN_EXTRAS_BUNDLE { papote_jeton, papote_canal }.
 */
final class Installation {
    private static final String TAG = "Papote";
    private static final String URL_INSCRIPTION = "https://europe-west1-papote-famille.cloudfunctions.net/inscrireTablette";

    // Mêmes applis que installation/economie-donnees.ps1 (absentes sur une autre tablette : ignorées).
    private static final String[] INUTILES = {
            "com.android.vending", "com.google.android.youtube", "com.google.android.apps.youtube.music",
            "com.google.android.keep", "com.google.android.apps.translate", "com.google.android.apps.fitness",
            "com.google.android.apps.adm", "com.google.android.apps.restore", "com.google.android.apps.safetyhub",
            "com.google.android.apps.turbo", "com.google.android.feedback", "com.google.android.gms.location.history",
            "com.google.ambient.streaming", "com.google.android.as", "com.google.android.as.oss",
            "com.google.android.federatedcompute", "com.google.android.ondevicepersonalization.services",
            "com.google.android.odad", "com.google.android.partnersetup",
            "com.google.android.printservice.recommendation", "com.google.android.apps.setupwizard.searchselector",
            "com.google.android.dialer", "com.google.android.apps.carrier.carrierwifi",
            "com.google.android.healthconnect.controller", "com.blackview.weather", "com.blackview.filetrans",
            "com.blackview.easytrans", "com.blackview.appsedge", "com.blackview.userfeedback",
            "com.blackview.apkupgrade", "com.blackview.call.recorder", "com.android.soundrecorder",
    };

    private Installation() { }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences("papote", Context.MODE_PRIVATE);
    }

    /** ADMIN_POLICY_COMPLIANCE : réglages de la tablette neuve, comme installer-tablette.ps1. */
    static void conformite(Context c, Intent intent) {
        SharedPreferences.Editor e = prefs(c).edit();
        PersistableBundle extras = intent == null ? null
                : intent.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE);
        if (extras != null) {
            String jeton = extras.getString("papote_jeton");
            if (jeton != null && !jeton.isEmpty()) e.putString("installJeton", jeton);
            e.putString("canal", "test".equals(extras.getString("papote_canal")) ? "test" : "");
        }
        e.apply();
        DevicePolicyManager dpm = (DevicePolicyManager) c.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null || !dpm.isDeviceOwnerApp(c.getPackageName())) {
            Journal.log(c, "Installation par QR : Papote n'est pas propriétaire de l'appareil");
            return;
        }
        ComponentName admin = new ComponentName(c, AdminReceiver.class);
        // Droits accordés d'office (comme « adb install -g ») : caméra et micro pour les appels, etc.
        for (String p : new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO,
                Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_BACKGROUND_LOCATION,
                Manifest.permission.READ_PHONE_STATE, Manifest.permission.CALL_PHONE,
                Manifest.permission.READ_PHONE_NUMBERS, Manifest.permission.SEND_SMS}) {
            try {
                dpm.setPermissionGrantState(admin, c.getPackageName(), p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
            } catch (Exception ex) {
                Log.w(TAG, "Droit " + p, ex);
            }
        }
        // Heure automatique (connexions sécurisées) et écran allumé tant que la tablette est branchée.
        try {
            dpm.setGlobalSetting(admin, Settings.Global.AUTO_TIME, "1");
            dpm.setGlobalSetting(admin, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, "7");
        } catch (Exception ex) {
            Log.w(TAG, "Réglages de l'installation", ex);
        }
        // Applis inutiles (et enregistreurs) cachées : elles ne se lancent plus et ne consomment rien.
        int cachees = 0;
        for (String p : INUTILES) {
            try {
                if (dpm.setApplicationHidden(admin, p, true)) cachees++;
            } catch (Exception ignored) { }
        }
        Telephone.preparer(c);
        JSONObject crit = criteres(c);
        prefs(c).edit().putString("installCriteres", crit.toString()).apply();
        Journal.log(c, "Installation par QR : réglages faits, " + cachees + " applis cachées, critères "
                + (crit.optBoolean("ok") ? "ok" : "NON : " + crit.optString("manque")));
    }

    /** Critères des tablettes vendues (installer-tablette.ps1) : 10", Android 13+, caméra, SIM sans code PIN. */
    static JSONObject criteres(Context c) {
        JSONObject j = new JSONObject();
        StringBuilder manque = new StringBuilder();
        try {
            DisplayMetrics m = c.getResources().getDisplayMetrics();
            double pouces = Math.hypot(m.widthPixels / (double) m.xdpi, m.heightPixels / (double) m.ydpi);
            boolean android13 = Build.VERSION.SDK_INT >= 33;
            boolean camera = c.getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_FRONT);
            TelephonyManager tm = (TelephonyManager) c.getSystemService(Context.TELEPHONY_SERVICE);
            int sim = tm == null ? TelephonyManager.SIM_STATE_UNKNOWN : tm.getSimState();
            boolean pin = sim == TelephonyManager.SIM_STATE_PIN_REQUIRED || sim == TelephonyManager.SIM_STATE_PUK_REQUIRED;
            if (pouces < 9.5) manque.append("écran ").append(Math.round(pouces * 10) / 10.0).append("\" ; ");
            if (!android13) manque.append("Android ").append(Build.VERSION.RELEASE).append(" ; ");
            if (!camera) manque.append("pas de caméra avant ; ");
            if (pin) manque.append("carte SIM avec code PIN ; ");
            j.put("pouces", Math.round(pouces * 10) / 10.0).put("android13", android13).put("camera", camera)
                    .put("simPin", pin).put("ok", manque.length() == 0).put("manque", manque.toString());
        } catch (Exception e) {
            Log.w(TAG, "Critères", e);
        }
        return j;
    }

    /**
     * Inscription auprès du serveur avec le jeton du QR (à chaque tour de synchronisation tant qu'elle n'a
     * pas réussi : sans réseau, elle réessaie). Le jeton n'est effacé qu'après un succès.
     * Renvoie le code tablette donné par le serveur s'il y en a un (sinon null).
     */
    static String inscrire(Context c, Http http) {
        SharedPreferences p = prefs(c);
        String jeton = p.getString("installJeton", null);
        if (jeton == null || jeton.isEmpty()) return null;
        try {
            JSONObject crit = new JSONObject(p.getString("installCriteres", "{}"));
            JSONObject sim = SimInfo.read(c);
            JSONObject data = new JSONObject()
                    .put("jeton", jeton)
                    .put("serie", Sync.serialNumber() == null ? "" : Sync.serialNumber())
                    .put("iccid", sim == null ? "" : sim.optString("iccid"))
                    .put("modele", Build.MODEL)
                    .put("android", Build.VERSION.RELEASE)
                    .put("criteresOk", crit.optBoolean("ok", false))
                    .put("criteres", crit);
            Http.Response r = http.request("POST", URL_INSCRIPTION, "application/json",
                    new JSONObject().put("data", data).toString(), null);
            JSONObject body = r.body == null || r.body.isEmpty() ? new JSONObject() : new JSONObject(r.body);
            if (r.code != 200 || body.has("error")) {
                JSONObject err = body.optJSONObject("error");
                String msg = err == null ? "HTTP " + r.code : err.optString("message", "HTTP " + r.code);
                Journal.log(c, "Inscription de la tablette refusée : " + msg);
                // Jeton refusé (expiré, déjà utilisé) : inutile d'insister à chaque tour.
                if (r.code == 400 || r.code == 403 || r.code == 404) p.edit().remove("installJeton").apply();
                return null;
            }
            p.edit().remove("installJeton").apply();
            JSONObject res = body.optJSONObject("result");
            String code = res == null ? "" : res.optString("code", "");
            Journal.log(c, "Tablette inscrite (installation par QR)" + (code.isEmpty() ? "" : ", code reçu"));
            return code.isEmpty() ? null : code;
        } catch (Exception e) {
            Log.w(TAG, "Inscription de la tablette", e);
            return null;
        }
    }

    /** android.app.action.GET_PROVISIONING_MODE : Papote gère toute la tablette. */
    public static final class ModeInstallation extends Activity {
        @Override
        protected void onCreate(Bundle savedInstanceState) {
            super.onCreate(savedInstanceState);
            Intent r = new Intent();
            r.putExtra(DevicePolicyManager.EXTRA_PROVISIONING_MODE, DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE);
            setResult(RESULT_OK, r);
            finish();
        }
    }

    /** android.app.action.ADMIN_POLICY_COMPLIANCE : réglages, puis on rend la main à l'installation d'Android. */
    public static final class Conformite extends Activity {
        @Override
        protected void onCreate(Bundle savedInstanceState) {
            super.onCreate(savedInstanceState);
            try {
                conformite(this, getIntent());
            } catch (Exception e) {
                Log.w(TAG, "Installation par QR", e);
            }
            setResult(RESULT_OK);
            finish();
        }
    }
}
