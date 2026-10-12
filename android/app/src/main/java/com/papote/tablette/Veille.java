package com.papote.tablette;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Heures de veille de la tablette, réglées depuis l'app famille (families/{fid}.veille).
 * Sans réglage : de 23h à 7h. Gardées sur la tablette pour tenir sans internet.
 */
final class Veille {
    static final int DEFAULT_FROM = 23;
    static final int DEFAULT_TO = 7;

    private Veille() { }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences("papote", Context.MODE_PRIVATE);
    }

    static boolean active(Context c) { return prefs(c).getBoolean("veille_active", true); }
    static int from(Context c) { return prefs(c).getInt("veille_de", DEFAULT_FROM); }
    static int to(Context c) { return prefs(c).getInt("veille_a", DEFAULT_TO); }

    /** Enregistre le réglage lu sur la famille ; null = pas de réglage (horaires par défaut). */
    static void save(Context c, Boolean active, int from, int to) {
        SharedPreferences.Editor e = prefs(c).edit();
        if (active == null) {
            e.remove("veille_active").remove("veille_de").remove("veille_a");
        } else {
            e.putBoolean("veille_active", active).putInt("veille_de", clamp(from)).putInt("veille_a", clamp(to));
        }
        e.apply();
    }

    private static int clamp(int h) { return Math.max(0, Math.min(23, h)); }

    /** Vrai pendant les heures de veille (jamais si la veille est désactivée). */
    static boolean isNight(Context c) {
        if (!active(c)) return false;
        int hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY);
        return inRange(hour, from(c), to(c));
    }

    /** Heure dans [de, a[, en passant minuit si besoin ; de == a : jamais. */
    static boolean inRange(int hour, int from, int to) {
        if (from < to) return hour >= from && hour < to;
        if (from > to) return hour >= from || hour < to;
        return false;
    }
}
