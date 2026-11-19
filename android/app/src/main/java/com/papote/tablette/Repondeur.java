package com.papote.tablette;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import android.telephony.ServiceState;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;
import android.util.Log;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Pas de répondeur sur la ligne de la tablette (Tanguy, 19/11) : un proche qui appelle Mamie ne tombe jamais
 * sur une messagerie que personne n'écoutera. Le répondeur des opérateurs français (Orange/Sosh, SFR, Free,
 * Bouygues) est un renvoi d'appel « si pas de réponse / injoignable / occupé » vers la messagerie : le code
 * réseau standard ##002# (GSM 02.30, effacement de tous les renvois conditionnels) le coupe chez tous.
 *
 * Envoyé sans écran par TelephonyManager.sendUssdRequest : Android le traite comme un code de service
 * (GsmMmiCode) et rend la réponse du réseau (accepté / refusé). Aucun coût, aucun appel passé.
 *  - pendant « Installer la carte SIM » (SimTest, ordre de l'admin) : résultat dans pairings/{code}.simTest.repondeur ;
 *  - ensuite, sur toute tablette dont la carte n'a pas encore un « ok » (tablettes déjà chez les clients, nouvelle
 *    carte, refus passager du réseau) : nouvel essai au plus une fois par jour, jamais pendant un appel.
 * Ce n'est pas le répondeur des proches : le SOS, qui appelle leurs portables, n'est pas touché.
 */
final class Repondeur {
    private static final String TAG = "Papote";
    static final String CODE = "##002#";
    /** Réponse du réseau attendue au plus ce temps par essai. */
    static final long ATTENTE_MS = 15_000;
    static final int ESSAIS = 2;
    static final long ENTRE_ESSAIS_MS = 5_000;
    /** Pas encore « ok » : nouvel essai au plus une fois par jour. */
    static final long REESSAI_MS = 24 * 3600_000L;
    /** Code interne : pas de réponse d'Android dans le délai. */
    static final int DELAI = -999;

    static final String PREF_ETAT = "repondeurEtat";   // "ok" ou la raison du dernier échec
    static final String PREF_ESSAI = "repondeurEssai"; // heure murale du dernier essai
    static final String PREF_CARTE = "repondeurCarte"; // ICCID de la carte coupée (nouvelle carte : à refaire)

    private static final AtomicBoolean enCours = new AtomicBoolean(false);
    private static volatile long derniereVerif;

    private Repondeur() { }

    static final class Resultat {
        boolean ok;
        int essais;
        String raison; // null si ok : refuse, indisponible, delai, sans-permission, sans-reseau, occupe, erreur
    }

    // ---------- Décisions (sans Android, testées dans RepondeurTest) ----------

    /** Raison d'un échec d'après le code rendu par Android (onReceiveUssdResponseFailed). */
    static String raison(int code) {
        if (code == DELAI) return "delai";
        if (code == TelephonyManager.USSD_ERROR_SERVICE_UNAVAIL) return "indisponible";
        if (code == TelephonyManager.USSD_RETURN_FAILURE) return "refuse";
        return "erreur";
    }

    /** Un échec qui ne changera pas en réessayant tout de suite (le réseau a répondu non, ou pas de droit). */
    static boolean definitif(String raison) {
        return "refuse".equals(raison) || "sans-permission".equals(raison);
    }

    /** Faut-il (re)couper le répondeur maintenant ? Carte coupée = celle d'aujourd'hui avec « ok ». */
    static boolean aFaire(String etat, String carteCoupee, String carte, long dernierEssai, long maintenant) {
        if ("ok".equals(etat)) {
            // Déjà coupé : seulement si une autre carte est dans la tablette (tout de suite).
            return carte != null && !carte.isEmpty() && !carte.equals(carteCoupee);
        }
        return dernierEssai <= 0 || dernierEssai > maintenant || maintenant - dernierEssai >= REESSAI_MS;
    }

    // ---------- Sur la tablette ----------

    /**
     * Coupe le répondeur : jusqu'à 2 essais, la réponse du réseau à chacun. Bloquant (jamais sur le fil
     * principal) ; garde le résultat pour les essais suivants et le note au journal.
     */
    static Resultat couper(Context c) {
        Resultat r = new Resultat();
        if (!enCours.compareAndSet(false, true)) {
            r.raison = "occupe";
            return r;
        }
        try {
            r = essayer(c);
            garder(c, r);
            Journal.log(c, r.ok ? "Répondeur de la carte SIM coupé (" + CODE + ", " + r.essais + " essai(s))"
                    : "Répondeur de la carte SIM pas coupé (" + r.raison + ", " + r.essais + " essai(s))");
            return r;
        } finally {
            enCours.set(false);
        }
    }

    @SuppressLint("MissingPermission")
    private static Resultat essayer(Context c) {
        Resultat r = new Resultat();
        if (c.checkSelfPermission(android.Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            r.raison = "sans-permission";
            return r;
        }
        TelephonyManager tm = (TelephonyManager) c.getSystemService(Context.TELEPHONY_SERVICE);
        if (tm == null || tm.getSimState() != TelephonyManager.SIM_STATE_READY) {
            r.raison = "sans-reseau";
            return r;
        }
        Handler principal = new Handler(Looper.getMainLooper());
        for (int i = 0; i < ESSAIS; i++) {
            if (i > 0) android.os.SystemClock.sleep(ENTRE_ESSAIS_MS);
            if (AppelGsm.enCours()) { r.raison = "occupe"; break; }
            r.essais++;
            final int[] code = {DELAI};
            final boolean[] ok = {false};
            final CountDownLatch fini = new CountDownLatch(1);
            try {
                tm.sendUssdRequest(CODE, new TelephonyManager.UssdResponseCallback() {
                    @Override
                    public void onReceiveUssdResponse(TelephonyManager t, String requete, CharSequence reponse) {
                        ok[0] = true;
                        Log.i(TAG, "Répondeur : réponse du réseau « " + reponse + " »");
                        fini.countDown();
                    }

                    @Override
                    public void onReceiveUssdResponseFailed(TelephonyManager t, String requete, int echec) {
                        code[0] = echec;
                        fini.countDown();
                    }
                }, principal);
                fini.await(ATTENTE_MS, TimeUnit.MILLISECONDS);
            } catch (Exception e) {
                Log.w(TAG, "Répondeur", e);
                code[0] = Integer.MIN_VALUE;
            }
            if (ok[0]) {
                r.ok = true;
                r.raison = null;
                return r;
            }
            r.raison = raison(code[0]);
            if (definitif(r.raison)) break;
        }
        return r;
    }

    private static void garder(Context c, Resultat r) {
        SharedPreferences p = c.getSharedPreferences("papote", Context.MODE_PRIVATE);
        SharedPreferences.Editor e = p.edit()
                .putString(PREF_ETAT, r.ok ? "ok" : r.raison == null ? "erreur" : r.raison)
                .putLong(PREF_ESSAI, System.currentTimeMillis());
        if (r.ok) e.putString(PREF_CARTE, carte(c));
        e.apply();
    }

    /**
     * Toutes les minutes (Gardien, chien de garde) : une tablette dont le répondeur n'est pas encore coupé
     * essaie, sur un fil à part, au plus une fois par jour, carte inscrite au réseau et sans appel en cours.
     */
    @SuppressLint("MissingPermission")
    static void peutEtre(Context c, boolean maintenance) {
        long maintenant = android.os.SystemClock.uptimeMillis();
        if (maintenant - derniereVerif < 60_000 && derniereVerif != 0) return; // une fois par minute suffit
        derniereVerif = maintenant;
        if (maintenance || enCours.get() || AppelGsm.enCours()) return;
        SharedPreferences p = c.getSharedPreferences("papote", Context.MODE_PRIVATE);
        try {
            TelephonyManager tm = (TelephonyManager) c.getSystemService(Context.TELEPHONY_SERVICE);
            if (tm == null || tm.getSimState() != TelephonyManager.SIM_STATE_READY) return;
            ServiceState ss = tm.getServiceState();
            if (ss == null || ss.getState() != ServiceState.STATE_IN_SERVICE) return;
        } catch (Exception e) {
            return;
        }
        if (!aFaire(p.getString(PREF_ETAT, ""), p.getString(PREF_CARTE, ""), carte(c),
                p.getLong(PREF_ESSAI, 0), System.currentTimeMillis())) return;
        // Noté avant le fil : pas deux départs si la vérification suivante arrive avant la fin.
        p.edit().putLong(PREF_ESSAI, System.currentTimeMillis()).apply();
        Thread t = new Thread(() -> couper(c), "papote-repondeur");
        t.setDaemon(true);
        t.start();
    }

    /** ICCID de la carte (vide si illisible). */
    @SuppressLint("MissingPermission")
    static String carte(Context c) {
        try {
            SubscriptionManager sm = (SubscriptionManager) c.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE);
            List<SubscriptionInfo> subs = sm == null ? null : sm.getActiveSubscriptionInfoList();
            String id = subs == null || subs.isEmpty() ? null : subs.get(0).getIccId();
            return id == null ? "" : id;
        } catch (Exception e) {
            return "";
        }
    }
}
