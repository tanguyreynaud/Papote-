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

    private Updater() { }

    /** À appeler hors du fil principal, seulement en mode kiosque. */
    static void check(Context context) {
        try {
            JSONObject feed = new JSONObject(new String(download(FEED), "UTF-8"));
            int latest = feed.getInt("versionCode");
            long current = currentVersion(context);
            if (latest <= current) return;
            Log.i(TAG, "Mise à jour " + current + " -> " + latest);
            Journal.log(context, "Mise à jour " + current + " -> " + latest);
            // L'APK est rangé sur GitHub (Firebase gratuit refuse les APK), la version sur Firebase.
            byte[] apk = download(feed.getString("url"));
            if (!sha256(apk).equalsIgnoreCase(feed.getString("sha256"))) {
                Log.w(TAG, "Mise à jour ignorée : empreinte incorrecte");
                return;
            }
            install(context, apk);
        } catch (Exception e) {
            Log.w(TAG, "Vérification des mises à jour", e);
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
            Intent done = new Intent("com.papote.tablette.MISE_A_JOUR").setPackage(context.getPackageName());
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
