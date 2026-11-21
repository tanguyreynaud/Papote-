package com.papote.tablette;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * Journal de la tablette (démarrages, écran allumé/éteint, veille, réseau, erreurs) :
 * les 300 dernières lignes au moins (le fichier est raccourci quand il dépasse 96 Ko), gardées sur la tablette et envoyées à la famille
 * (families/{fid}/logs/{uid}) pour comprendre un problème à distance.
 */
final class Journal {
    private static final String FILE = "journal.txt";
    private static final int MAX_LINES = 300;
    /** Au-delà, le fichier est raccourci aux MAX_LINES dernières lignes. */
    private static final int TAILLE_MAX = 96 * 1024;
    private static final Object LOCK = new Object();

    private Journal() { }

    static void log(Context context, String message) {
        String line = new SimpleDateFormat("dd/MM HH:mm:ss", Locale.FRANCE).format(new Date()) + "  " + message;
        Log.i("PapoteJournal", message);
        synchronized (LOCK) {
            try {
                File f = new File(context.getFilesDir(), FILE);
                // La ligne est ajoutée au bout du fichier ; il n'est relu et raccourci aux 300 dernières
                // lignes que lorsqu'il a trop grossi (avant : fichier entier relu et réécrit à chaque ligne).
                byte[] octets = ((f.length() > 0 ? "\n" : "") + line).getBytes(StandardCharsets.UTF_8);
                FileOutputStream out = new FileOutputStream(f, true);
                try {
                    out.write(octets);
                } finally {
                    out.close();
                }
                if (f.length() > TAILLE_MAX) {
                    List<String> lines = new ArrayList<>(Arrays.asList(
                            new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8).split("\n")));
                    if (lines.size() > MAX_LINES) lines = lines.subList(lines.size() - MAX_LINES, lines.size());
                    byte[] garde = String.join("\n", lines).getBytes(StandardCharsets.UTF_8);
                    // Lignes très longues : même 300 lignes dépassent, on garde la fin seulement.
                    if (garde.length > TAILLE_MAX) garde = Arrays.copyOfRange(garde, garde.length - TAILLE_MAX / 2, garde.length);
                    FileOutputStream tout = new FileOutputStream(f);
                    try {
                        tout.write(garde);
                    } finally {
                        tout.close();
                    }
                }
            } catch (Exception e) {
                Log.w("PapoteJournal", "Écriture du journal", e);
            }
        }
    }

    /**
     * Incident (plantage, page rechargée, Papote relancée) : noté, et le journal part à la famille au
     * prochain tour de synchronisation au lieu d'attendre 6 h (Sync.journalUrgent).
     */
    static void urgent(Context context, String message) {
        log(context, message);
        try {
            context.getSharedPreferences("papote", Context.MODE_PRIVATE).edit().putBoolean(URGENT, true).commit();
            MainActivity.incident();
        } catch (Exception e) {
            Log.w("PapoteJournal", "Journal urgent", e);
        }
    }

    static final String URGENT = "journalUrgent";

    /** Les dernières lignes, les plus récentes en bas. */
    static String tail(Context context, int max) {
        synchronized (LOCK) {
            try {
                File f = new File(context.getFilesDir(), FILE);
                if (!f.exists()) return "";
                String[] lines = new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8).split("\n");
                int from = Math.max(0, lines.length - max);
                return String.join("\n", Arrays.copyOfRange(lines, from, lines.length));
            } catch (Exception e) {
                return "";
            }
        }
    }

    /**
     * Lignes de « tail » venues après « dernier » (dernière ligne déjà envoyée), les plus récentes en bas ; "" si rien
     * de neuf. « dernier » absent ou plus dans les lignes (journal raccourci, première fois) : toutes les lignes.
     */
    static String nouvelles(String tail, String dernier) {
        if (tail == null || tail.isEmpty()) return "";
        if (dernier == null || dernier.isEmpty()) return tail;
        String[] lines = tail.split("\n");
        for (int i = lines.length - 1; i >= 0; i--) {
            if (lines[i].equals(dernier)) {
                return i == lines.length - 1 ? "" : String.join("\n", Arrays.copyOfRange(lines, i + 1, lines.length));
            }
        }
        return tail;
    }

    /** La dernière ligne (la plus récente), "" si aucune. */
    static String derniere(String tail) {
        if (tail == null || tail.isEmpty()) return "";
        int i = tail.lastIndexOf('\n');
        return i < 0 ? tail : tail.substring(i + 1);
    }

    /** Une erreur qui ferait planter l'appli est notée avant qu'Android ne la relance. */
    private static boolean crashesCaught;

    static void catchCrashes(Context context) {
        // Une seule fois par démarrage de l'appli : l'écran peut être refait (page arrêtée, langue),
        // et chaque nouvelle prise notait le plantage une fois de plus.
        synchronized (LOCK) {
            if (crashesCaught) return;
            crashesCaught = true;
        }
        final Context app = context.getApplicationContext();
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                StringBuilder sb = new StringBuilder("PLANTAGE : ").append(error);
                StackTraceElement[] st = error.getStackTrace();
                for (int i = 0; i < Math.min(6, st.length); i++) sb.append(" | ").append(st[i]);
                urgent(app, sb.toString());
            } catch (Throwable ignored) { }
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }
}
