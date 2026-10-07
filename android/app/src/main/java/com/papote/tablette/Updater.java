package com.papote.tablette;

import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Calendar;

import javax.net.ssl.HttpsURLConnection;

/**
 * Mise à jour à distance : la tablette regarde régulièrement si une nouvelle version de Papote
 * est publiée (installation/publier-mise-a-jour.ps1), la télécharge et l'installe.
 * Seuls les APK signés avec la même clé que Papote peuvent la remplacer (vérifié par Android).
 * Android 5 et plus en mode kiosque : sans rien demander. Android 4.4 : l'écran d'installation
 * d'Android s'ouvre, il suffit de toucher « Installer ».
 */
final class Updater {
    private static final String TAG = "Papote";
    private static final String FEED = "https://papote-maj.web.app/version.json";
    private static final String FILE = "mise-a-jour.apk";

    /** Pendant l'écran d'installation d'Android, Papote ne repasse pas devant. */
    static volatile long promptUntil = 0;

    private Updater() { }

    static boolean prompting() {
        return System.currentTimeMillis() < promptUntil;
    }

    /** À appeler hors du fil principal. */
    static void check(Context context, boolean deviceOwner) {
        try {
            JSONObject feed = new JSONObject(new String(download(context, FEED), "UTF-8"));
            int latest = feed.getInt("versionCode");
            int current = currentVersion(context);
            if (latest <= current) return;
            boolean silent = deviceOwner && Build.VERSION.SDK_INT >= 21;
            // Sans installation silencieuse, on ne la propose qu'en journée (Android 4.4 à 6).
            if (!silent) {
                int hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
                if (Build.VERSION.SDK_INT >= 24 || hour < 9 || hour >= 20) return;
            }
            Log.i(TAG, "Mise à jour " + current + " -> " + latest);
            // L'APK est rangé sur GitHub (Firebase gratuit refuse les APK), la version sur Firebase.
            byte[] apk = download(context, feed.getString("url"));
            if (!sha256(apk).equalsIgnoreCase(feed.getString("sha256"))) {
                Log.w(TAG, "Mise à jour ignorée : empreinte incorrecte");
                return;
            }
            if (silent) installSilently(context, apk);
            else promptInstall(context, apk);
        } catch (Exception e) {
            Log.w(TAG, "Vérification des mises à jour", e);
        }
    }

    @SuppressWarnings("deprecation")
    private static int currentVersion(Context context) throws PackageManager.NameNotFoundException {
        return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionCode;
    }

    @SuppressLint("NewApi")
    private static void installSilently(Context context, byte[] apk) throws IOException {
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

    @SuppressWarnings("deprecation")
    @SuppressLint("WorldReadableFiles")
    private static void promptInstall(Context context, byte[] apk) throws IOException {
        // L'installeur d'Android 4.4 lit le fichier lui-même : il doit être lisible par tous.
        FileOutputStream out = context.openFileOutput(FILE, Context.MODE_WORLD_READABLE);
        try {
            out.write(apk);
        } finally {
            out.close();
        }
        File file = new File(context.getFilesDir(), FILE);
        promptUntil = System.currentTimeMillis() + 10 * 60_000;
        Intent install = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(Uri.fromFile(file), "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(install);
    }

    private static byte[] download(Context context, String url) throws Exception {
        HttpsURLConnection c = (HttpsURLConnection) new URL(url).openConnection();
        c.setSSLSocketFactory(Tls.socketFactory(context));
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

    /** Supprime le fichier téléchargé une fois la mise à jour faite. */
    static void cleanup(Context context) {
        if (!prompting()) new File(context.getFilesDir(), FILE).delete();
    }
}
