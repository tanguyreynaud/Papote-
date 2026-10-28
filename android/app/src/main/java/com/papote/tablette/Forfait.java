package com.papote.tablette;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.util.Log;

import org.json.JSONObject;

import java.util.Calendar;
import java.util.TimeZone;

/**
 * Garde-fou du forfait de la carte SIM (28/10, demande de Tanguy : un forfait d'1 Go avec de la marge).
 * La tablette compte les Mo RÉELLEMENT passés par la carte SIM depuis le début du cycle de recharge
 * (compteur Android, le même que la page « Forfaits SIM » de l'admin) et se retient par paliers :
 *   niveau 0 : rien ne change ;
 *   niveau 1 (70 %) : la visio sur SIM passe en qualité réduite (≈ 1,6 Mo la minute au lieu de 5) ;
 *   niveau 2 (88 %) : plus d'image dans les appels sur SIM, le son seul (≈ 0,5 Mo la minute) ;
 *   niveau 3 (95 %) : plus de vidéos reçues, de météo ni de mise à jour sur SIM (textes et photos passent).
 * Sur le Wi-Fi, aucune limite, jamais. Les appels SOS passent toujours (en audio au pire).
 *
 * Réglage par la famille (families/{fid}.forfaitSim, écrit par l'admin) : { mo, jour | debut }.
 *   mo    : Mo du forfait (1000 par défaut ; 0 = pas de limite, carte illimitée ou formule Wi-Fi) ;
 *   jour  : jour du mois où le forfait repart (1 par défaut) ;
 *   debut : date « aaaa-mm-jj » d'une recharge, pour les pass de 30 jours (Lyca) : cycles de 30 jours.
 *   visio : { reception, envoi } en kbit/s, réglage d'essai de la visio sur SIM (outils/admin/visio-sim.bat) ;
 *           absent = réglage de la page (appels.js : 500 reçus, 120 envoyés). Jamais appliqué sur le Wi-Fi.
 */
final class Forfait {
    static final long DEFAUT_MO = 1000;
    static final int ECO = 70, AUDIO = 88, TEXTE = 95; // pour cent du forfait (1 Go : 1 h 45 de visio normale, puis réduite)
    static final long CYCLE_MS = 30L * 24 * 3600_000;
    private static final String TAG = "Papote";

    private Forfait() { }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences("papote", Context.MODE_PRIVATE);
    }

    /** Réglage lu avec la fiche de la famille (mo ≤ 0 : pas de limite ; debut vide : jour du mois). */
    static void regler(Context c, long mo, int jour, String debut) {
        SharedPreferences p = prefs(c);
        long moAvant = p.getLong("forfaitMo", DEFAUT_MO);
        int jourAvant = p.getInt("forfaitJour", 1);
        String debutAvant = p.getString("forfaitDebut", "");
        if (debut == null) debut = "";
        if (jour < 1 || jour > 28) jour = 1;
        if (moAvant == mo && jourAvant == jour && debutAvant.equals(debut)) return;
        p.edit().putLong("forfaitMo", mo).putInt("forfaitJour", jour).putString("forfaitDebut", debut).apply();
        Journal.log(c, "Forfait SIM réglé : " + (mo <= 0 ? "sans limite" : mo + " Mo")
                + (debut.isEmpty() ? ", repart le " + jour + " du mois" : ", recharge du " + debut + " (30 jours)"));
    }

    /** Réglage d'essai de la visio sur SIM (0 = réglage normal de la page). */
    static void reglerVisio(Context c, int reception, int envoi) {
        SharedPreferences p = prefs(c);
        if (reception < 0) reception = 0;
        if (envoi < 0) envoi = 0;
        if (p.getInt("visioReception", 0) == reception && p.getInt("visioEnvoi", 0) == envoi) return;
        p.edit().putInt("visioReception", reception).putInt("visioEnvoi", envoi).apply();
        Journal.log(c, "Visio sur SIM : " + (reception <= 0 && envoi <= 0 ? "réglage normal"
                : "essai, reçu " + reception + " kbit/s, envoyé " + envoi + " kbit/s"));
    }

    static long plafondMo(Context c) {
        return prefs(c).getLong("forfaitMo", DEFAUT_MO);
    }

    /** Début du cycle en cours, en millisecondes. */
    static long debutCycleMs(Context c) {
        SharedPreferences p = prefs(c);
        return debutCycle(p.getInt("forfaitJour", 1), p.getString("forfaitDebut", ""), System.currentTimeMillis());
    }

    /** Dernier « jour » du mois à minuit (heure de Paris), ou dernier multiple de 30 jours depuis « debut ». */
    static long debutCycle(int jour, String debut, long now) {
        Calendar c = Calendar.getInstance(TimeZone.getTimeZone("Europe/Paris"));
        c.setTimeInMillis(now);
        c.set(Calendar.HOUR_OF_DAY, 0);
        c.set(Calendar.MINUTE, 0);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        if (debut != null && debut.matches("\\d{4}-\\d{2}-\\d{2}")) {
            c.set(Integer.parseInt(debut.substring(0, 4)), Integer.parseInt(debut.substring(5, 7)) - 1, Integer.parseInt(debut.substring(8, 10)));
            long d = c.getTimeInMillis();
            if (d > now) return d - CYCLE_MS; // date dans le futur (horloge, faute de frappe) : cycle précédent
            return d + ((now - d) / CYCLE_MS) * CYCLE_MS;
        }
        if (jour < 1 || jour > 28) jour = 1;
        c.set(Calendar.DAY_OF_MONTH, jour);
        if (c.getTimeInMillis() > now) c.add(Calendar.MONTH, -1);
        return c.getTimeInMillis();
    }

    /** Mo passés par la carte SIM depuis le début du cycle (-1 si inconnu). */
    static long consoMo(Context c) {
        return SimInfo.dataDepuisMb(c, debutCycleMs(c));
    }

    /** Palier atteint : 0 (rien), 1 (économie), 2 (audio seul), 3 (textes et photos seulement). */
    static int niveau(long plafondMo, long consoMo) {
        if (plafondMo <= 0 || consoMo < 0) return 0;
        long pourCent = consoMo * 100 / plafondMo;
        if (pourCent >= TEXTE) return 3;
        if (pourCent >= AUDIO) return 2;
        if (pourCent >= ECO) return 1;
        return 0;
    }

    static int niveau(Context c) {
        return niveau(plafondMo(c), consoMo(c));
    }

    /** La tablette passe en ce moment par la carte SIM (et non le Wi-Fi). */
    static boolean surSim(Context c) {
        try {
            ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkCapabilities active = cm == null ? null : cm.getNetworkCapabilities(cm.getActiveNetwork());
            return active != null && active.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR);
        } catch (Exception e) {
            return false;
        }
    }

    /** Vrai si la tablette est sur la SIM ET a atteint ce palier : ce qui coûte doit attendre. */
    static boolean economie(Context c, int palier) {
        return surSim(c) && niveau(c) >= palier;
    }

    /** État pour la page (pont simBudget) et la famille : {plafondMo, consoMo, niveau, sim, cycleDebut}. */
    static JSONObject etat(Context c) {
        JSONObject j = new JSONObject();
        try {
            long plafond = plafondMo(c);
            long conso = consoMo(c);
            int niveau = niveau(plafond, conso);
            Calendar d = Calendar.getInstance(TimeZone.getTimeZone("Europe/Paris"));
            d.setTimeInMillis(debutCycleMs(c));
            j.put("plafondMo", plafond).put("consoMo", conso).put("niveau", niveau).put("sim", surSim(c))
                    .put("cycleDebut", String.format(java.util.Locale.US, "%04d-%02d-%02d",
                            d.get(Calendar.YEAR), d.get(Calendar.MONTH) + 1, d.get(Calendar.DAY_OF_MONTH)));
            SharedPreferences pv = prefs(c);
            int reception = pv.getInt("visioReception", 0), envoi = pv.getInt("visioEnvoi", 0);
            if (reception > 0 || envoi > 0) j.put("visio", new JSONObject().put("reception", reception).put("envoi", envoi));
            // Changement de palier noté une fois dans le journal (visible dans l'admin).
            SharedPreferences p = prefs(c);
            if (p.getInt("forfaitNiveau", 0) != niveau) {
                p.edit().putInt("forfaitNiveau", niveau).apply();
                Journal.log(c, "Forfait SIM : " + conso + " Mo sur " + plafond + ", palier " + niveau
                        + (niveau == 0 ? " (normal)" : niveau == 1 ? " (visio réduite)" : niveau == 2 ? " (appels sans image)" : " (ni vidéo, ni météo, ni mise à jour)"));
            }
        } catch (Exception e) {
            Log.w(TAG, "Forfait", e);
        }
        return j;
    }
}
