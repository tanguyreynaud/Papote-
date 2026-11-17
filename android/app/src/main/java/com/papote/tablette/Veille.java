package com.papote.tablette;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Heures de veille de la tablette, réglées depuis l'app famille (families/{fid}.veille :
 * {active, de, deMin, a, aMin}, minutes 0 ou 30). Sans réglage : de 23 h à 5 h (17/11 ; avant 21 h - 6 h 30), comme le
 * serveur (functions/alertes.js). Gardées sur la tablette pour tenir sans internet.
 * Les heures sont gardées en minutes depuis minuit.
 */
final class Veille {
    static final int DEFAULT_FROM = 23 * 60; // Tanguy, 17/11 : 23 h - 5 h par défaut
    static final int DEFAULT_TO = 5 * 60;

    private Veille() { }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences("papote", Context.MODE_PRIVATE);
    }

    static boolean active(Context c) { return prefs(c).getBoolean("veille_active", true); }
    /** Début de la veille, en minutes depuis minuit. */
    static int from(Context c) { return prefs(c).getInt("veille_debut", DEFAULT_FROM); }
    /** Fin de la veille, en minutes depuis minuit. */
    static int to(Context c) { return prefs(c).getInt("veille_fin", DEFAULT_TO); }

    /** Enregistre le réglage lu sur la famille ; null = pas de réglage (horaires par défaut). */
    static void save(Context c, Boolean active, int from, int to) {
        // veille_de / veille_a : anciennes clés en heures (avant 2.99.88).
        SharedPreferences.Editor e = prefs(c).edit().remove("veille_de").remove("veille_a");
        if (active == null) {
            e.remove("veille_active").remove("veille_debut").remove("veille_fin");
        } else {
            e.putBoolean("veille_active", active).putInt("veille_debut", bornerDebut(clamp(from))).putInt("veille_fin", bornerFin(clamp(to)));
        }
        e.apply();
    }

    /** Heure et minutes (0 ou 30, sinon 0) du réglage, en minutes depuis minuit. */
    static int minutes(long hour, long min) {
        return (int) Math.max(0, Math.min(23, hour)) * 60 + (min == 30 ? 30 : 0);
    }

    private static int clamp(int m) { return Math.max(0, Math.min(24 * 60 - 1, m)); }

    // Garde-fou (17/11 : réveil enregistré à 20 h 30, la tablette est restée en nuit 23 h 30 sur 24) :
    // début ramené entre 19 h et 23 h 30, réveil entre 5 h et 10 h, au plus proche.
    static final int DEBUT_MIN = 19 * 60, DEBUT_MAX = 23 * 60 + 30;
    static final int FIN_MIN = 5 * 60, FIN_MAX = 10 * 60;

    // Même règle exactement que le serveur (functions/veille.js veilleSure, 17/11) : simple borne.
    static int bornerDebut(int m) { return Math.min(DEBUT_MAX, Math.max(DEBUT_MIN, m)); }

    static int bornerFin(int m) { return Math.min(FIN_MAX, Math.max(FIN_MIN, m)); }

    /** Heure lue de la base (0-23, minutes 0 ou 30) en minutes, ou -1 si mal formée (alors : valeur par défaut). */
    static int lire(long heure, long min) {
        if (heure < 0 || heure > 23) return -1;
        return (int) heure * 60 + (min == 30 ? 30 : 0);
    }

    /** Vrai pendant les heures de veille (jamais si la veille est désactivée). */
    /** Avant cette date, l'horloge n'est pas à l'heure (date d'usine, démarrage sans réseau) : pas de veille. */
    static final long HEURE_PLANCHER = 1790812800000L; // 1er octobre 2026, 0 h UTC

    static boolean isNight(Context c) {
        if (!active(c) || System.currentTimeMillis() < HEURE_PLANCHER) return false;
        java.util.Calendar now = java.util.Calendar.getInstance();
        int m = now.get(java.util.Calendar.HOUR_OF_DAY) * 60 + now.get(java.util.Calendar.MINUTE);
        return inRange(m, from(c), to(c));
    }

    /** Minute dans [de, a[, en passant minuit si besoin ; de == a : jamais. */
    static boolean inRange(int m, int from, int to) {
        if (from < to) return m >= from && m < to;
        if (from > to) return m >= from || m < to;
        return false;
    }
}
