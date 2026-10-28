package com.papote.tablette;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Heures de veille de la tablette, réglées depuis l'app famille (families/{fid}.veille :
 * {active, de, deMin, a, aMin}, minutes 0 ou 30). Sans réglage : de 21h à 6h30, comme le
 * serveur (functions/alertes.js). Gardées sur la tablette pour tenir sans internet.
 * Les heures sont gardées en minutes depuis minuit.
 */
final class Veille {
    static final int DEFAULT_FROM = 21 * 60;
    static final int DEFAULT_TO = 6 * 60 + 30;

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
            e.putBoolean("veille_active", active).putInt("veille_debut", clamp(from)).putInt("veille_fin", clamp(to));
        }
        e.apply();
    }

    /** Heure et minutes (0 ou 30, sinon 0) du réglage, en minutes depuis minuit. */
    static int minutes(long hour, long min) {
        return (int) Math.max(0, Math.min(23, hour)) * 60 + (min == 30 ? 30 : 0);
    }

    private static int clamp(int m) { return Math.max(0, Math.min(24 * 60 - 1, m)); }

    /** Vrai pendant les heures de veille (jamais si la veille est désactivée). */
    static boolean isNight(Context c) {
        if (!active(c)) return false;
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
