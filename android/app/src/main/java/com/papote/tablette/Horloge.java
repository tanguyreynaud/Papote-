package com.papote.tablette;

import android.os.SystemClock;

import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.TimeZone;

/**
 * L'heure de la tablette est-elle juste ? (Tanguy, 19/11.) Chaque réponse d'un serveur porte son heure
 * (en-tête « Date ») : elle est notée avec le chronomètre interne, qui ne saute jamais, et sert à
 * vérifier l'horloge murale sans une seule requête de plus. Inconnue après un redémarrage, jusqu'à la
 * première réponse d'un serveur.
 *  - écart de plus de 2 min : l'heure de la tablette est fausse (ni heure affichée, ni rappel, ni veille),
 *    le temps qu'Android la remette par le réseau ;
 *  - écart faible : l'heure est confirmée, même si la page avait retenu une heure fausse plus tardive.
 */
final class Horloge {
    static final long ECART_MAX_MS = 2 * 60_000L;
    /** Avant cette date, l'horloge n'est pas à l'heure (date d'usine, démarrage sans réseau). */
    static final long PLANCHER = 1790812800000L; // 1er octobre 2026, 0 h UTC

    private static volatile long serveurMs;
    private static volatile long chronoMs;

    private Horloge() { }

    /** En-tête « Date » d'une réponse HTTP (null ou illisible : ignoré). */
    static void noter(String date) {
        long t = lire(date);
        if (t > 0) noter(t, SystemClock.elapsedRealtime());
    }

    static void noter(long heureServeurMs, long chrono) {
        if (heureServeurMs < PLANCHER) return; // un serveur lui-même à une date impossible : pas une référence
        chronoMs = chrono;
        serveurMs = heureServeurMs;
    }

    static long lire(String date) {
        if (date == null || date.isEmpty()) return 0;
        try {
            SimpleDateFormat f = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US);
            f.setTimeZone(TimeZone.getTimeZone("GMT"));
            return f.parse(date).getTime();
        } catch (Exception e) {
            return 0;
        }
    }

    /** Écart « heure du serveur − heure de la tablette » en ms, ou null si aucun serveur n'a encore répondu. */
    static Long ecart() {
        return ecart(System.currentTimeMillis(), SystemClock.elapsedRealtime());
    }

    static Long ecart(long murMs, long chrono) {
        long s = serveurMs, c = chronoMs;
        if (s == 0) return null;
        return s + (chrono - c) - murMs;
    }

    /** Heure actuelle selon le dernier serveur entendu (ms), ou 0 si aucun serveur n'a répondu depuis le démarrage. */
    static long maintenantServeur() {
        return serveurMs == 0 ? 0 : maintenantServeur(SystemClock.elapsedRealtime());
    }

    static long maintenantServeur(long chrono) {
        long s = serveurMs, c = chronoMs;
        return s == 0 ? 0 : s + (chrono - c);
    }

    /** L'heure murale est utilisable : après la date d'usine, et pas contredite par un serveur. */
    static boolean sure() {
        return sure(System.currentTimeMillis(), SystemClock.elapsedRealtime());
    }

    static boolean sure(long murMs, long chrono) {
        Long e = ecart(murMs, chrono);
        if (e != null) return Math.abs(e) <= ECART_MAX_MS;
        return murMs >= PLANCHER;
    }

    /** Pour les essais. */
    static void oublier() {
        serveurMs = 0;
        chronoMs = 0;
    }
}
