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
 * les 300 dernières lignes, gardées sur la tablette et envoyées à la famille
 * (families/{fid}/logs/{uid}) pour comprendre un problème à distance.
 */
final class Journal {
    private static final String FILE = "journal.txt";
    private static final int MAX_LINES = 300;
    private static final Object LOCK = new Object();

    private Journal() { }

    static void log(Context context, String message) {
        String line = new SimpleDateFormat("dd/MM HH:mm:ss", Locale.FRANCE).format(new Date()) + "  " + message;
        Log.i("PapoteJournal", message);
        synchronized (LOCK) {
            try {
                File f = new File(context.getFilesDir(), FILE);
                List<String> lines = f.exists()
                        ? new ArrayList<>(Arrays.asList(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8).split("\n")))
                        : new ArrayList<>();
                lines.add(line);
                if (lines.size() > MAX_LINES) lines = lines.subList(lines.size() - MAX_LINES, lines.size());
                FileOutputStream out = new FileOutputStream(f);
                try {
                    out.write(String.join("\n", lines).getBytes(StandardCharsets.UTF_8));
                } finally {
                    out.close();
                }
            } catch (Exception e) {
                Log.w("PapoteJournal", "Écriture du journal", e);
            }
        }
    }

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

    /** Une erreur qui ferait planter l'appli est notée avant qu'Android ne la relance. */
    static void catchCrashes(Context context) {
        final Context app = context.getApplicationContext();
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try {
                StringBuilder sb = new StringBuilder("PLANTAGE : ").append(error);
                StackTraceElement[] st = error.getStackTrace();
                for (int i = 0; i < Math.min(6, st.length); i++) sb.append(" | ").append(st[i]);
                log(app, sb.toString());
            } catch (Throwable ignored) { }
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }
}
