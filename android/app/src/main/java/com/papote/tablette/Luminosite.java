package com.papote.tablette;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Luminosité de l'écran en journée, réglée par un responsable de la famille (families/{fid}.luminosite,
 * de 40 à 100 %, Tanguy 20/11). Sans réglage : celle de la tablette, comme avant. Le soir l'écran reste
 * plus doux (55 % au plus) ; la nuit, écran noir (voir MainActivity.setSleep).
 */
final class Luminosite {
    static final int MIN = 40, MAX = 100;
    /** Le soir : jamais plus fort que ça, et jamais plus fort que le jour. */
    static final float SOIR = 0.55f;
    /** Valeur d'Android pour « pas de réglage de l'appli : luminosité de la tablette ». */
    static final float TABLETTE = -1f;

    private Luminosite() { }

    /** Réglage lu sur la famille : entre 40 et 100, sinon 0 (pas de réglage). */
    static int borner(long v) {
        return v >= MIN && v <= MAX ? (int) v : 0;
    }

    /** Luminosité de la fenêtre le jour : 0,40 à 1, ou celle de la tablette sans réglage. */
    static float jour(int reglage) {
        return reglage >= MIN && reglage <= MAX ? reglage / 100f : TABLETTE;
    }

    /** Luminosité de la fenêtre le soir : 55 %, ou celle du jour si elle est déjà plus douce. */
    static float soir(int reglage) {
        float j = jour(reglage);
        return j > 0 && j < SOIR ? j : SOIR;
    }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences("papote", Context.MODE_PRIVATE);
    }

    static int reglage(Context c) { return prefs(c).getInt("luminosite_jour", 0); }

    /** Enregistre le réglage ; renvoie vrai s'il a changé. */
    static boolean save(Context c, int reglage) {
        if (reglage == reglage(c)) return false;
        if (reglage == 0) prefs(c).edit().remove("luminosite_jour").apply();
        else prefs(c).edit().putInt("luminosite_jour", reglage).apply();
        return true;
    }
}
