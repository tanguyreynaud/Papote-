package com.papote.tablette;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;

/**
 * Limite de charge Blackview à 80 % (Tanguy, 20/11) : une fois à 80 %, la tablette coupe la charge et ne la
 * rouvre que si on rebranche le câble, si on change son réglage ou si elle redémarre. Branchée en permanence,
 * elle se viderait donc jusqu'à s'éteindre. Papote le voit (branchée, ne charge pas, niveau bas) et relance :
 * d'abord en retouchant le réglage de la limite (qui reste à sa valeur), sinon en redémarrant la tablette.
 */
final class Charge {
    static final int SEUIL_REPRISE = 78;     // ESSAI du 22/11 : relance très tôt pour avoir la preuve vite ; valeur finale à décider
    static final int SEUIL_REDEMARRAGE = 50; // le réglage n'a rien donné : redémarrage sous ce niveau
    static final long ATTENTE_MS = 5 * 60_000L;       // temps laissé à la charge pour repartir après un essai
    static final long ENTRE_ESSAIS_MS = 30 * 60_000L; // pas plus d'un essai de réglage par demi-heure
    static final long ENTRE_REDEMARRAGES_MS = 3 * 60 * 60_000L;
    private static final String CLE_MAX = "bv_custom_charging_max";
    static final String MINI_APPLI = "com.papote.charge";

    enum Geste { RIEN, REGLAGE, REDEMARRER }

    private static long dernierEssai = -ENTRE_ESSAIS_MS;
    private static boolean essaiRate;

    private Charge() {}

    /**
     * Que faire, toutes durées en ms depuis le démarrage. « depuisEssai » : temps depuis le dernier essai de réglage
     * (très grand s'il n'y en a pas eu) ; « depuisRedemarrage » : temps depuis le dernier redémarrage pour la charge.
     */
    static Geste decider(boolean branchee, boolean charge, int niveau, long depuisEssai, boolean essaiRate,
                         long depuisRedemarrage, boolean appel) {
        if (!branchee || charge || niveau < 0 || niveau >= SEUIL_REPRISE) return Geste.RIEN;
        if (depuisEssai >= ENTRE_ESSAIS_MS && !essaiRate) return Geste.REGLAGE;
        boolean essaiSansEffet = essaiRate || depuisEssai >= ATTENTE_MS;
        if (essaiSansEffet && niveau < SEUIL_REDEMARRAGE && !appel && depuisRedemarrage >= ENTRE_REDEMARRAGES_MS) {
            return Geste.REDEMARRER;
        }
        return depuisEssai >= ENTRE_ESSAIS_MS ? Geste.REGLAGE : Geste.RIEN;
    }

    /** Appelé par le chien de garde (toutes les 30 s environ). */
    static void tic(Context app) {
        try {
            Intent b = app.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (b == null) return;
            boolean branchee = b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0;
            int etat = b.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN);
            boolean charge = etat == BatteryManager.BATTERY_STATUS_CHARGING || etat == BatteryManager.BATTERY_STATUS_FULL;
            int niveau = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int echelle = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
            if (niveau >= 0 && echelle > 0 && echelle != 100) niveau = niveau * 100 / echelle;
            if (charge) essaiRate = false;
            SharedPreferences prefs = app.getSharedPreferences("papote", Context.MODE_PRIVATE);
            long maintenant = SystemClock.elapsedRealtime();
            long mur = System.currentTimeMillis(), redem = prefs.getLong("chargeRedemarrage", 0);
            long depuisRedem = redem <= 0 || redem > mur ? Long.MAX_VALUE : mur - redem;
            // Juste après un redémarrage, on laisse à la tablette le temps de rouvrir la charge elle-même.
            if (maintenant < ATTENTE_MS) return;
            boolean appel = AppelGsm.enCours() || MainActivity.occupee();
            Geste g = decider(branchee, charge, niveau, maintenant - dernierEssai, essaiRate, depuisRedem, appel);
            if (g == Geste.REGLAGE && appel) return; // la fenêtre de relance couperait l'appel une seconde : plus tard
            if (g == Geste.REGLAGE) {
                dernierEssai = maintenant;
                essaiRate = !retoucherReglage(app, niveau);
            } else if (g == Geste.REDEMARRER) {
                prefs.edit().putLong("chargeRedemarrage", mur).commit();
                Journal.urgent(app, "CHARGE : branchée sans charger à " + niveau + " %, la tablette redémarre pour relancer la charge");
                DevicePolicyManager dpm = (DevicePolicyManager) app.getSystemService(Context.DEVICE_POLICY_SERVICE);
                dpm.reboot(new ComponentName(app, AdminReceiver.class));
            }
        } catch (Exception e) {
            Journal.log(app, "Charge : vérification impossible (" + e + ")");
        }
    }

    /**
     * Demande à la mini-appli « Papote Charge » de réécrire la limite (une valeur en dessous, puis la sienne) :
     * la tablette réexamine alors la charge. Papote n'a pas le droit de l'écrire elle-même (Android le refuse aux
     * applis récentes, vu le 21/11) ; la mini-appli, déclarée « ancienne », l'a. Sans elle : redémarrage.
     */
    private static boolean retoucherReglage(Context app, int niveau) {
        String debut = "CHARGE : branchée sans charger à " + niveau + " %, ";
        try {
            int max = Settings.System.getInt(app.getContentResolver(), CLE_MAX, -1);
            if (max < 0) {
                Journal.log(app, "Charge : branchée sans charger à " + niveau + " %, pas de limite Blackview sur cette tablette");
                return false;
            }
            // 1) La porte discrète (sans rien à l'écran). Blackview refuse de démarrer la mini-appli par ce chemin
            //    tant qu'elle ne tourne pas (vu le 22/11 : « Failed to find provider info ») : la porte ne répond
            //    donc que si la mini-appli tourne déjà.
            Bundle r = null;
            try {
                r = app.getContentResolver().call(Uri.parse("content://" + MINI_APPLI), "relancer", null, null);
            } catch (Exception e) { /* porte fermée : on passe par la fenêtre invisible */ }
            if (r != null && r.getBoolean("ok")) {
                Journal.urgent(app, debut + "limite de " + max + " % réécrite par la mini-appli pour relancer la charge");
                return true;
            }
            if (r != null) {
                Journal.urgent(app, debut + "la mini-appli n'a pas pu réécrire la limite (" + r.getString("erreur") + ")");
                return false;
            }
            // 2) Sa fenêtre invisible : ouverte par Papote (au premier plan), elle réécrit la limite et se referme
            //    aussitôt. On saura si ça a marché en voyant la charge repartir.
            Intent i = new Intent().setClassName(MINI_APPLI, MINI_APPLI + ".Fenetre")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION);
            app.startActivity(i);
            Journal.urgent(app, debut + "relance demandée à la mini-appli par sa fenêtre invisible (limite de " + max + " %)");
            return true;
        } catch (Exception e) {
            Journal.urgent(app, debut + "mini-appli de charge absente ou refusée (" + e + ")");
            return false;
        }
    }
}
