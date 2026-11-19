package com.papote.tablette;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.SystemClock;

/**
 * Secours quand le réveil par le serveur (push) ne marche pas, sous verrou (Tanguy, 19/11 : « on n'a
 * qu'1 Go, un dépassement qu'on n'a pas vu serait catastrophique »).
 *
 *   push    le serveur réveille la tablette : aucune écoute ouverte (le cas normal) ;
 *   direct  push en panne : la page rouvre ses écoutes en direct pour ne manquer aucun appel
 *           (≈ 3 Mo par jour), 24 h AU PLUS ;
 *   bride   les 24 h sont dépensées : écoutes fermées, la tablette relit toutes les 5 min (≈ 2 Mo par
 *           jour ; les envois arrivent avec 5 min de retard au plus, un appel vidéo peut être manqué ;
 *           les appels par la carte SIM et le SOS ne passent pas par le push et marchent toujours).
 *
 * Les verrous :
 *  - le temps d'écoute directe est ADDITIONNÉ et enregistré sur la tablette : il survit au redémarrage,
 *    au rechargement de la page et à la mise à jour ; c'est Android qui décide, pas la page ;
 *  - il ne revient à zéro qu'après 7 jours de push sain d'affilée : un push qui revient une minute puis
 *    retombe ne redonne pas 24 h ;
 *  - sans réseau du tout, rien n'est compté (ce n'est pas une panne du push, et rien n'est consommé) ;
 *  - le temps est compté au chronomètre interne (jamais à l'horloge murale, qui peut sauter), par pas
 *    de 2 min au plus : un trou (tablette endormie, redémarrage) ne compte pas ;
 *  - le mode part dans le signal « en ligne » (sim.push, sim.pushDirectMin) pour l'admin.
 */
final class SecoursPush {
    static final String PUSH = "push", DIRECT = "direct", BRIDE = "bride";
    static final long DIRECT_MAX_MS = 24 * 3600_000L;
    static final long SAIN_REMISE_MS = 7 * 24 * 3600_000L;
    /** Push absent moins longtemps que ça (contrôle quotidien, nouveau jeton) : pas une panne. */
    static final long PANNE_MS = 10 * 60_000L;
    static final long PAS_MAX_MS = 2 * 60_000L;
    /** Tour de synchronisation en mode bridé. */
    static final long TOUR_BRIDE_MS = 5 * 60_000L;
    /** Push en panne depuis ce temps : un nouveau jeton est demandé à Google, puis toutes les 6 h. */
    static final long NOUVEAU_JETON_MS = 6 * 3600_000L;
    private static final long VERIF_MS = 30_000;
    private static final long SAIN_NOTE_MS = 3600_000L;

    private SecoursPush() { }

    // ---------- Règle (sans Android, essayée dans SecoursPushTest) ----------

    /** Les trois compteurs, en millisecondes : écoute directe dépensée, push sain d'affilée, push absent d'affilée. */
    static final class Compteurs {
        long direct, sain, hors;

        Compteurs(long direct, long sain, long hors) {
            this.direct = direct;
            this.sain = sain;
            this.hors = hors;
        }
    }

    static String mode(boolean pushPret, long directMs) {
        if (pushPret) return PUSH;
        return directMs < DIRECT_MAX_MS ? DIRECT : BRIDE;
    }

    /** Un pas de temps (chronomètre interne) vient de passer dans cet état. */
    static void avancer(Compteurs c, boolean pushPret, boolean enLigne, long pasMs) {
        if (!enLigne || pasMs <= 0) return; // sans réseau : ni panne, ni consommation
        long pas = Math.min(pasMs, PAS_MAX_MS);
        if (pushPret) {
            c.hors = 0;
            c.sain += pas;
            if (c.sain >= SAIN_REMISE_MS) c.direct = 0;
            return;
        }
        c.hors += pas;
        if (c.hors >= PANNE_MS) c.sain = 0;
        if (c.direct < DIRECT_MAX_MS) c.direct = Math.min(DIRECT_MAX_MS, c.direct + pas);
    }

    /** Vrai quand le temps de panne vient de franchir 6 h, 12 h, 18 h… : un nouveau jeton est demandé. */
    static boolean nouveauJetonDu(long horsAvant, long horsApres) {
        return horsApres / NOUVEAU_JETON_MS > horsAvant / NOUVEAU_JETON_MS;
    }

    // ---------- Lien avec Android ----------

    private static final Object VERROU = new Object();
    private static Compteurs compteurs;
    private static long dernierTic;
    private static long sainNote;
    private static String dernierMode;

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences("papote", Context.MODE_PRIVATE);
    }

    private static Compteurs lus(Context c) {
        if (compteurs == null) {
            SharedPreferences p = prefs(c);
            compteurs = new Compteurs(p.getLong("secoursDirectMs", 0), p.getLong("secoursSainMs", 0), 0);
            sainNote = compteurs.sain;
        }
        return compteurs;
    }

    /** Appelé par le chien de garde (toutes les 10 s) : compte au plus une fois toutes les 30 s. */
    static void tic(Context app) {
        long maintenant = SystemClock.elapsedRealtime();
        boolean jeton = false;
        String change = null;
        synchronized (VERROU) {
            Compteurs c = lus(app);
            if (dernierTic == 0) {
                dernierTic = maintenant;
                return;
            }
            long pas = maintenant - dernierTic;
            if (pas < VERIF_MS) return;
            dernierTic = maintenant;
            boolean pret = Push.pret(app);
            long directAvant = c.direct, horsAvant = c.hors, sainAvant = c.sain;
            avancer(c, pret, enLigne(app), pas);
            SharedPreferences.Editor e = null;
            if (c.direct != directAvant) e = prefs(app).edit().putLong("secoursDirectMs", c.direct);
            // Le temps « sain » avance sans arrêt : enregistré une fois par heure seulement, et à sa remise à zéro.
            if ((c.sain == 0 && sainAvant != 0) || c.sain - sainNote >= SAIN_NOTE_MS || c.sain < sainNote) {
                e = (e == null ? prefs(app).edit() : e).putLong("secoursSainMs", c.sain);
                sainNote = c.sain;
            }
            if (e != null) e.apply();
            jeton = !pret && nouveauJetonDu(horsAvant, c.hors);
            String m = mode(pret, c.direct);
            if (!m.equals(dernierMode)) {
                if (dernierMode != null || !PUSH.equals(m)) change = m;
                dernierMode = m;
            }
        }
        if (change != null) {
            Journal.log(app, PUSH.equals(change) ? "Push : réveil par le serveur revenu, écoutes fermées"
                    : DIRECT.equals(change) ? "Push en panne : écoute en direct (secours, 24 h au plus, "
                            + (directMs(app) / 60_000) + " min déjà dépensées)"
                    : "Push en panne depuis trop longtemps : secours bridé, relecture toutes les 5 min, écoutes fermées");
            MainActivity.surPush("jeton", null); // la page relit son mode tout de suite
        }
        if (jeton) Push.renouvelerJeton(app);
    }

    /** Mode demandé par la page (pont modeReseau) et par Sync. */
    static String mode(Context c) {
        synchronized (VERROU) {
            return mode(Push.pret(c), lus(c).direct);
        }
    }

    static boolean bride(Context c) {
        return BRIDE.equals(mode(c));
    }

    static long directMs(Context c) {
        synchronized (VERROU) {
            return lus(c).direct;
        }
    }

    /** Internet vraiment joignable (wifi ou carte SIM validés par Android). */
    static boolean enLigne(Context c) {
        try {
            ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network n = cm == null ? null : cm.getActiveNetwork();
            NetworkCapabilities caps = n == null ? null : cm.getNetworkCapabilities(n);
            return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        } catch (Exception e) {
            return true; // dans le doute, on compte : le verrou ne doit jamais s'ouvrir par erreur
        }
    }
}
