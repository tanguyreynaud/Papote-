package com.papote.tablette;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.HttpsURLConnection;

/**
 * Mise à jour à distance : la tablette regarde régulièrement si une nouvelle version de Papote
 * est publiée (installation/publier-mise-a-jour.ps1), la télécharge et l'installe sans rien
 * demander (mode kiosque, propriétaire de l'appareil).
 * Seuls les APK signés avec la même clé que Papote peuvent la remplacer (vérifié par Android).
 */
final class Updater {
    private static final String TAG = "Papote";
    private static final String FEED = "https://papote-maj.web.app/version.json";
    /** Tablettes de test (installées avec -Canal test) : elles reçoivent les nouvelles versions en premier. */
    private static final String FEED_TEST = "https://papote-maj.web.app/version-test.json";

    private static int echecs;
    /** Une seule vérification à la fois (une annonce peut arriver pendant un téléchargement). */
    private static final AtomicBoolean enCours = new AtomicBoolean(false);

    private Updater() { }

    /** À appeler hors du fil principal, seulement en mode kiosque. false : échec, à réessayer bientôt. */
    static boolean check(Context context) {
        if (!enCours.compareAndSet(false, true)) return true;
        try {
            return verifier(context);
        } finally {
            enCours.set(false);
        }
    }

    /**
     * Ordre « maj » du tableau de bord : vérification tout de suite, avec une phrase pour l'administrateur.
     * Hors du fil principal. Une installation lancée suit son cours (Android relance Papote à la fin).
     */
    static String maintenant(Context context) {
        try {
            boolean test = "test".equals(context.getSharedPreferences("papote", Context.MODE_PRIVATE).getString("canal", ""));
            JSONObject feed = new JSONObject(new String(download(test ? FEED_TEST : FEED), "UTF-8"));
            int latest = feed.getInt("versionCode");
            long current = currentVersion(context);
            String nom = feed.optString("versionName", String.valueOf(latest));
            if (latest <= current) return "Déjà à jour (version " + nom + (test ? ", canal test" : "") + ").";
            if (!check(context)) return "Impossible de mettre à jour pour l'instant (téléchargement raté), nouvel essai dans 10 min.";
            return "Mise à jour vers la version " + nom + " lancée : Papote se relance toute seule dans une minute.";
        } catch (Exception e) {
            return "Impossible de vérifier la version : " + e.getMessage();
        }
    }

    private static boolean verifier(Context context) {
        try {
            boolean test = "test".equals(context.getSharedPreferences("papote", Context.MODE_PRIVATE).getString("canal", ""));
            JSONObject feed = new JSONObject(new String(download(test ? FEED_TEST : FEED), "UTF-8"));
            int latest = feed.getInt("versionCode");
            long current = currentVersion(context);
            echecs = 0;
            if (latest <= current) return true;
            Log.i(TAG, "Mise à jour " + current + " -> " + latest);
            Journal.log(context, "Mise à jour " + current + " -> " + latest);
            // L'APK est rangé sur GitHub (Firebase gratuit refuse les APK), la version sur Firebase.
            byte[] apk = download(feed.getString("url"));
            if (!sha256(apk).equalsIgnoreCase(feed.getString("sha256"))) {
                Log.w(TAG, "Mise à jour ignorée : empreinte incorrecte");
                Journal.log(context, "Mise à jour ignorée : empreinte incorrecte");
                // Pas de nouvel essai dans 10 min : ce serait l'APK entier retéléchargé sans fin (forfait SIM).
                // Réessai à la prochaine vérification normale ou à la prochaine annonce de version.
                return true;
            }
            install(context, apk);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "Vérification des mises à jour", e);
            // Coupure passagère (wifi, DNS) : nouvel essai 10 min après, sans rien noter.
            // Le journal ne le signale qu'au bout de 3 échecs d'affilée (30 min).
            echecs++;
            if (echecs == 3) Journal.log(context, "Mise à jour impossible depuis 30 min : " + e);
            return false;
        }
    }

    private static long currentVersion(Context context) throws PackageManager.NameNotFoundException {
        return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).getLongVersionCode();
    }

    private static void install(Context context, byte[] apk) throws IOException {
        PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params =
                new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(context.getPackageName());
        int id = installer.createSession(params);
        PackageInstaller.Session session = installer.openSession(id);
        try {
            OutputStream out = session.openWrite("papote", 0, apk.length);
            try {
                out.write(apk);
                session.fsync(out);
            } finally {
                out.close();
            }
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
            Intent done = new Intent("com.papote.tablette.MISE_A_JOUR").setClass(context, UpdateResult.class);
            PendingIntent pi = PendingIntent.getBroadcast(context, id, done, flags);
            session.commit(pi.getIntentSender());
        } finally {
            session.close();
        }
        // Une fois installée, Android relance Papote (BootReceiver, MY_PACKAGE_REPLACED).
    }

    private static byte[] download(String url) throws IOException {
        HttpsURLConnection c = (HttpsURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20_000);
        c.setReadTimeout(60_000);
        c.setUseCaches(false);
        try {
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode() + " " + url);
            InputStream in = c.getInputStream();
            try {
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[32 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return out.toByteArray();
            } finally {
                in.close();
            }
        } finally {
            c.disconnect();
        }
    }

    private static String sha256(byte[] data) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(data);
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    /** Supprime le fichier laissé par l'ancienne méthode d'installation (Android 4.4). */
    static void cleanup(Context context) {
        new File(context.getFilesDir(), "mise-a-jour.apk").delete();
    }
}
