package com.papote.tablette;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.telephony.CellInfo;
import android.telephony.ServiceState;
import android.telephony.TelephonyManager;
import android.util.Log;

import java.util.List;

/**
 * Garde du réseau mobile : une carte SIM qui reste « hors service » alors qu'une antenne est là, la
 * tablette redémarre pour la réinscrire (Tanguy, T-003, 12-13/11 : la SIM Lyca est restée toute la
 * nuit sans réseau, ni données, ni appels, ni SMS ; retirée puis remise, elle a marché tout de suite).
 * Papote n'a pas le droit de relancer seulement la partie radio (réservé au système) ; redémarrer la
 * tablette, comme sortir et remettre la carte, la réinscrit au réseau.
 *  - hors service depuis 20 min, une antenne entendue (sinon c'est une vraie zone blanche : redémarrer
 *    n'y changerait rien), pas d'appel en cours, pas de maintenance ;
 *  - 1er redémarrage tout de suite, 2e au moins 6 h après, puis au plus un par jour, tant que la panne dure ;
 *  - tout est noté « GARDE-FOU » dans le journal (envoyé à Papote dès qu'internet est là).
 */
final class GardeReseau {
    static final long HORS_MAX_MS = 20 * 60_000;
    static final long ECART_2E_MS = 6 * 3600_000;
    static final long ECART_ENSUITE_MS = 24 * 3600_000;
    static final long VERIF_MS = 60_000;

    private GardeReseau() { }

    // ---------- Décision (sans Android, testée dans GardeReseauTest) ----------

    /**
     * horsDepuis : heure murale du début de la panne (0 : en service) ; faits : redémarrages déjà tentés
     * pendant cette panne ; dernier : heure du dernier.
     */
    static boolean fautRedemarrer(long maintenant, long horsDepuis, boolean antenne, boolean appel,
                                  boolean maintenance, long dernier, int faits) {
        if (horsDepuis == 0 || !antenne || appel || maintenance) return false;
        if (maintenant - horsDepuis < HORS_MAX_MS) return false;
        long ecart = faits == 0 ? 0 : faits == 1 ? ECART_2E_MS : ECART_ENSUITE_MS;
        return maintenant - dernier >= ecart;
    }

    /** « hors service » au sens de la garde : ni inscrite, ni éteinte exprès (mode avion). */
    static boolean hors(int etat) {
        return etat == ServiceState.STATE_OUT_OF_SERVICE || etat == ServiceState.STATE_EMERGENCY_ONLY;
    }

    /** Une antenne du réseau qui porte la carte est-elle à portée ? Réseau jamais vu : n'importe laquelle. */
    static boolean antenneDuReseau(List<CellInfo> cellules, String hote) {
        if (cellules == null || cellules.isEmpty()) return false;
        for (CellInfo c : cellules) {
            if (memeReseau(plmn(c), hote)) return true;
        }
        return false;
    }

    /** La carte se présente sous une autre identité que celle qu'elle avait en service. */
    static boolean identiteChangee(String connue, String actuelle) {
        return connue != null && !connue.isEmpty() && actuelle != null && !actuelle.isEmpty() && !connue.equals(actuelle);
    }

    static boolean memeReseau(String plmnAntenne, String hote) {
        return hote == null || hote.isEmpty() || hote.equals(plmnAntenne);
    }

    private static String plmn(CellInfo c) {
        try {
            String mcc = null, mnc = null;
            if (c instanceof android.telephony.CellInfoLte) {
                android.telephony.CellIdentityLte i = ((android.telephony.CellInfoLte) c).getCellIdentity();
                mcc = i.getMccString(); mnc = i.getMncString();
            } else if (c instanceof android.telephony.CellInfoNr) {
                android.telephony.CellIdentityNr i = (android.telephony.CellIdentityNr) ((android.telephony.CellInfoNr) c).getCellIdentity();
                mcc = i.getMccString(); mnc = i.getMncString();
            } else if (c instanceof android.telephony.CellInfoWcdma) {
                android.telephony.CellIdentityWcdma i = ((android.telephony.CellInfoWcdma) c).getCellIdentity();
                mcc = i.getMccString(); mnc = i.getMncString();
            } else if (c instanceof android.telephony.CellInfoGsm) {
                android.telephony.CellIdentityGsm i = ((android.telephony.CellInfoGsm) c).getCellIdentity();
                mcc = i.getMccString(); mnc = i.getMncString();
            }
            return mcc == null || mnc == null ? "" : mcc + mnc;
        } catch (Exception e) {
            return "";
        }
    }

    // ---------- Lien avec Android (appelé par le chien de garde) ----------

    private static long derniereVerif;

    @SuppressWarnings("MissingPermission")
    static void verifier(Context app, boolean maintenance) {
        long uptime = android.os.SystemClock.uptimeMillis();
        if (uptime - derniereVerif < VERIF_MS) return;
        derniereVerif = uptime;
        SharedPreferences prefs = app.getSharedPreferences("papote", Context.MODE_PRIVATE);
        long mur = System.currentTimeMillis();
        try {
            TelephonyManager tm = (TelephonyManager) app.getSystemService(Context.TELEPHONY_SERVICE);
            boolean simPrete = tm != null && tm.getSimState() == TelephonyManager.SIM_STATE_READY;
            ServiceState ss = simPrete ? tm.getServiceState() : null;
            if (ss != null && ss.getState() == ServiceState.STATE_IN_SERVICE && ss.getOperatorNumeric() != null
                    && !ss.getOperatorNumeric().isEmpty()) {
                // Réseau qui porte vraiment la carte (Bouygues 20820 pour Lyca 20825) : seule une de ses
                // antennes à portée justifie un redémarrage (Tanguy, 13/11 : à Poissy, rien que de l'Orange).
                prefs.edit().putString("reseauHote", ss.getOperatorNumeric())
                        .putString("simIdentite", tm.getSimOperator() == null ? "" : tm.getSimOperator()).apply();
            }
            if (ss == null || !hors(ss.getState())) {
                if (prefs.getLong("reseauHorsDepuis", 0) != 0) {
                    if (ss != null) Journal.urgent(app, "GARDE-FOU : réseau mobile revenu");
                    prefs.edit().remove("reseauHorsDepuis").remove("reseauRedemarrages").apply();
                }
                return;
            }
            long depuis = prefs.getLong("reseauHorsDepuis", 0);
            if (depuis == 0) {
                prefs.edit().putLong("reseauHorsDepuis", mur).apply();
                Journal.log(app, "Réseau mobile hors service");
                return;
            }
            List<CellInfo> cellules = null;
            try { cellules = tm.getAllCellInfo(); } catch (SecurityException ignored) { }
            // Carte passée sur une autre identité (Lyca 20825 → 26001, T-003 le 12/11) : coincée sur ce
            // profil, elle ne voit plus les antennes de son réseau (seulement Orange dans les relevés, alors
            // que Bouygues était là le lendemain matin au même endroit). Ce signe suffit.
            boolean autreIdentite = identiteChangee(prefs.getString("simIdentite", ""), tm.getSimOperator());
            boolean antenne = autreIdentite || antenneDuReseau(cellules, prefs.getString("reseauHote", ""));
            int faits = prefs.getInt("reseauRedemarrages", 0);
            if (!fautRedemarrer(mur, depuis, antenne, AppelGsm.enCours(), maintenance,
                    prefs.getLong("reseauDernierRedemarrage", 0), faits)) return;
            prefs.edit().putInt("reseauRedemarrages", faits + 1).putLong("reseauDernierRedemarrage", mur).commit();
            Journal.urgent(app, "GARDE-FOU : carte SIM hors service depuis " + ((mur - depuis) / 60_000)
                    + " min avec une antenne à portée : la tablette redémarre pour retrouver le réseau ("
                    + (faits + 1) + "e fois)");
            DevicePolicyManager dpm = (DevicePolicyManager) app.getSystemService(Context.DEVICE_POLICY_SERVICE);
            dpm.reboot(new ComponentName(app, AdminReceiver.class));
        } catch (Exception e) {
            Log.w("Papote", "Garde du réseau mobile", e);
        }
    }
}
