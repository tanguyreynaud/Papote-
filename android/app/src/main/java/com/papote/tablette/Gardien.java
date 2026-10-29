package com.papote.tablette;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

/**
 * Chien de garde : la tablette ne reste jamais figée chez Mamie (Tanguy, 29/10 : « imaginons
 * qu'elle freeze »). Un fil à part vérifie toutes les 10 s :
 *  - que le fil principal de l'appli avance : bloqué 45 s, Papote est relancée (alarme puis arrêt
 *    du processus ; Papote, propriétaire de la tablette et écran d'accueil, a le droit de se rouvrir) ;
 *  - que la page répond (pouls envoyé par tablette.js toutes les 20 s) : muette 3 min alors qu'elle
 *    est à l'écran, elle est rechargée ; muette encore après 2 rechargements, Papote est relancée.
 * Relancée 3 fois en 30 min : la tablette redémarre (au plus une fois toutes les 6 h).
 * Rien pendant la maintenance (kiosque en pause) ni écran éteint (la page peut alors dormir).
 * Chaque geste est noté « GARDE-FOU » dans le journal, envoyé tout de suite à la famille.
 */
final class Gardien {
    static final long VERIF_MS = 10_000;
    static final long FIL_MAX_MS = 45_000;
    static final long POULS_MAX_MS = 3 * 60_000;
    static final int RECHARGEMENTS_MAX = 2;
    static final int RELANCES_AVANT_REDEMARRAGE = 3;
    static final long RELANCES_FENETRE_MS = 30 * 60_000;
    static final long REDEMARRAGE_ECART_MS = 6 * 3600_000;
    /** Au-delà, la famille ne reçoit plus « en ligne » : l'alerte « ne répond plus » peut partir. */
    static final long PAGE_MORTE_MS = 5 * 60_000;

    enum Geste { RIEN, RECHARGER, RELANCER }

    interface Page {
        /** Recharge la page (sur le fil principal). */
        void recharger();
        /** Maintenance en cours (kiosque en pause, ADB) : on ne touche à rien. */
        boolean maintenance();
    }

    private static final Object LOCK = new Object();
    private static Thread fil;
    private static volatile Page page;
    private static volatile long dernierTic;
    private static volatile long dernierPouls;      // 0 : pas encore de pouls depuis le chargement
    private static volatile long premierPlanDepuis; // 0 : pas à l'écran
    private static volatile long dernierRechargement;
    private static volatile int rechargements;

    private Gardien() { }

    // ---------- Décisions (sans Android, testées dans GardienTest) ----------

    /**
     * Que faire maintenant ? Temps en millisecondes depuis le démarrage (uptime : le sommeil profond
     * de la tablette ne compte pas, il n'est pas un blocage).
     */
    static Geste decider(long maintenant, boolean maintenance, long tic, boolean aLEcran, long ecranDepuis,
                         long pouls, long rechargeA, int dejaRecharge, boolean appelGsm) {
        if (maintenance) return Geste.RIEN;
        if (maintenant - tic > FIL_MAX_MS) return Geste.RELANCER;
        // La page n'est jugée qu'à l'écran, et après un premier pouls (une vieille page sans pouls
        // n'est jamais rechargée en boucle).
        if (!aLEcran || pouls == 0) return Geste.RIEN;
        long depuis = Math.max(pouls, Math.max(ecranDepuis, rechargeA));
        if (maintenant - depuis <= POULS_MAX_MS) return Geste.RIEN;
        if (dejaRecharge < RECHARGEMENTS_MAX) return Geste.RECHARGER;
        // Pendant un appel téléphone, on ne coupe pas la ligne pour une page muette : l'appel finit
        // par Android (le proche raccroche), la page sera relancée ensuite.
        return appelGsm ? Geste.RIEN : Geste.RELANCER;
    }

    /** Relances récentes (heures murales, séparées par des virgules), la nouvelle comprise. */
    static String noterRelance(String avant, long maintenant) {
        StringBuilder sb = new StringBuilder();
        if (avant != null) {
            for (String s : avant.split(",")) {
                try {
                    long t = Long.parseLong(s.trim());
                    if (maintenant - t < RELANCES_FENETRE_MS && t <= maintenant) sb.append(t).append(',');
                } catch (NumberFormatException ignored) { }
            }
        }
        return sb.append(maintenant).toString();
    }

    static boolean fautRedemarrer(String relances, long maintenant, long dernierRedemarrage) {
        int n = relances == null || relances.isEmpty() ? 0 : relances.split(",").length;
        return n >= RELANCES_AVANT_REDEMARRAGE && maintenant - dernierRedemarrage > REDEMARRAGE_ECART_MS;
    }

    static boolean pageMorte(long maintenant, boolean aLEcran, long ecranDepuis, long pouls, long rechargeA) {
        if (!aLEcran || pouls == 0) return false;
        return maintenant - Math.max(pouls, Math.max(ecranDepuis, rechargeA)) > PAGE_MORTE_MS;
    }

    // ---------- Liens avec l'appli ----------

    /** La page a répondu (tablette.js, toutes les 20 s). */
    static void pouls() {
        dernierPouls = SystemClock.uptimeMillis();
        rechargements = 0;
    }

    /** L'écran Papote est au premier plan (onResume) ou ne l'est plus (onPause). */
    static void aLEcran(boolean oui) {
        premierPlanDepuis = oui ? SystemClock.uptimeMillis() : 0;
    }

    /** Une page neuve se charge : on attend son premier pouls avant de la juger. */
    static void nouvellePage() {
        dernierPouls = 0;
    }

    /** Faut-il envoyer « en ligne » à la famille ? Pas si la page à l'écran ne répond plus. */
    static boolean pageVivante() {
        return !pageMorte(SystemClock.uptimeMillis(), premierPlanDepuis != 0, premierPlanDepuis,
                dernierPouls, dernierRechargement);
    }

    static void demarrer(Context context, Page p) {
        page = p;
        final Context app = context.getApplicationContext();
        synchronized (LOCK) {
            if (fil != null) return;
            dernierTic = SystemClock.uptimeMillis();
            final Handler principal = new Handler(Looper.getMainLooper());
            final Runnable tic = () -> dernierTic = SystemClock.uptimeMillis();
            fil = new Thread(() -> {
                while (true) {
                    principal.post(tic);
                    SystemClock.sleep(VERIF_MS);
                    try {
                        verifier(app, principal);
                    } catch (Throwable t) {
                        Log.w("Papote", "Chien de garde", t);
                    }
                }
            }, "papote-gardien");
            fil.setDaemon(true);
            fil.start();
        }
    }

    private static void verifier(Context app, Handler principal) {
        Page p = page;
        long maintenant = SystemClock.uptimeMillis();
        Geste g = decider(maintenant, p == null || p.maintenance(), dernierTic, premierPlanDepuis != 0,
                premierPlanDepuis, dernierPouls, dernierRechargement, rechargements, AppelGsm.enCours());
        if (g == Geste.RECHARGER) {
            rechargements++;
            dernierRechargement = maintenant;
            Journal.urgent(app, "GARDE-FOU : la page ne répond plus depuis 3 min, rechargée (" + rechargements + "/" + RECHARGEMENTS_MAX + ")");
            principal.post(() -> {
                Page q = page;
                if (q != null) q.recharger();
            });
        } else if (g == Geste.RELANCER) {
            relancer(app, maintenant - dernierTic > FIL_MAX_MS
                    ? "l'appli est bloquée depuis " + ((maintenant - dernierTic) / 1000) + " s"
                    : "la page ne répond toujours pas");
        }
    }

    /** Papote se relance (ou la tablette redémarre après 3 relances en 30 min). */
    static void relancer(Context app, String pourquoi) {
        SharedPreferences prefs = app.getSharedPreferences("papote", Context.MODE_PRIVATE);
        long mur = System.currentTimeMillis();
        String relances = noterRelance(prefs.getString("gardienRelances", ""), mur);
        if (fautRedemarrer(relances, mur, prefs.getLong("gardienRedemarrage", 0))) {
            prefs.edit().putString("gardienRelances", "").putLong("gardienRedemarrage", mur).commit();
            Journal.urgent(app, "GARDE-FOU : " + pourquoi + ", 3 relances en 30 min : la tablette redémarre");
            try {
                DevicePolicyManager dpm = (DevicePolicyManager) app.getSystemService(Context.DEVICE_POLICY_SERVICE);
                dpm.reboot(new ComponentName(app, AdminReceiver.class));
                return;
            } catch (Exception e) {
                // Pas propriétaire de la tablette, ou appel téléphone en cours : on relance seulement Papote.
                Journal.urgent(app, "GARDE-FOU : redémarrage impossible (" + e + "), Papote relancée");
            }
        } else {
            prefs.edit().putString("gardienRelances", relances).commit();
            Journal.urgent(app, "GARDE-FOU : " + pourquoi + ", Papote relancée");
        }
        // Réouverture dans 2 s, puis arrêt du processus (Android rouvre aussi l'écran d'accueil, Papote).
        try {
            Intent launch = new Intent(app, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent pi = PendingIntent.getActivity(app, 7, launch,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            AlarmManager am = (AlarmManager) app.getSystemService(Context.ALARM_SERVICE);
            long a = SystemClock.elapsedRealtime() + 2_000;
            if (android.os.Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) {
                am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, a, pi);
            } else {
                am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, a, pi);
            }
        } catch (Exception e) {
            Log.w("Papote", "Relance", e);
        }
        android.os.Process.killProcess(android.os.Process.myPid());
        System.exit(10);
    }
}
