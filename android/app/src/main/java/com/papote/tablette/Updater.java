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
    /**
     * Fichiers de version de secours, sur le domaine de Papote (DNS chez OVH, hors de Google) : si le projet Firebase
     * disparaît (compte Google perdu, projet supprimé), papote-maj.web.app disparaît avec lui et aucune tablette
     * ne pourrait plus recevoir la version qui pointe vers le nouveau projet : il faudrait passer chez chaque Mamie.
     * Tanguy fait alors pointer maj.mapapote.fr vers un autre hébergement (GitHub Pages, Cloudflare Pages…) et y
     * dépose version.json. Tant que l'adresse ne répond pas, rien ne change. Sûr : l'APK reste limité au dépôt
     * Papote (MajGarde) et Android exige la signature de Papote ; on prend la version la plus récente des deux.
     */
    private static final String FEED_SECOURS = "https://maj.mapapote.fr/version.json";
    private static final String FEED_SECOURS_TEST = "https://maj.mapapote.fr/version-test.json";

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
            JSONObject feed = lireVersion(test);
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
            JSONObject feed = lireVersion(test);
            int latest = feed.getInt("versionCode");
            long current = currentVersion(context);
            echecs = 0;
            if (latest <= current) return true;
            Log.i(TAG, "Mise à jour " + current + " -> " + latest);
            Journal.log(context, "Mise à jour " + current + " -> " + latest);
            // L'APK est rangé sur GitHub (Firebase gratuit refuse les APK), la version sur Firebase.
            // Garde-fous (MajGarde) : seulement le dépôt Papote à un commit précis, taille plafonnée, et une
            // empreinte déjà refusée n'est plus retéléchargée (forfait SIM), même si version.json a été modifié.
            android.content.SharedPreferences prefs = context.getSharedPreferences("papote", Context.MODE_PRIVATE);
            String refus = MajGarde.refus(feed.optString("url", null), feed.optString("sha256", null),
                    prefs.getString("majRefusee", null));
            if (refus != null) {
                Log.w(TAG, "Mise à jour ignorée : " + refus);
                Journal.log(context, "Mise à jour ignorée : " + refus);
                return true;
            }
            byte[] apk;
            try {
                apk = download(feed.getString("url"), MajGarde.TAILLE_MAX);
            } catch (TropGros e) {
                // Pas de nouvel essai dans 10 min pour un fichier trop gros : il serait retéléchargé sans fin.
                prefs.edit().putString("majRefusee", feed.getString("sha256")).apply();
                Journal.log(context, "Mise à jour ignorée : " + e.getMessage());
                return true;
            }
            if (!sha256(apk).equalsIgnoreCase(feed.getString("sha256"))) {
                prefs.edit().putString("majRefusee", feed.getString("sha256")).apply();
                Log.w(TAG, "Mise à jour ignorée : empreinte incorrecte");
                Journal.log(context, "Mise à jour ignorée : empreinte incorrecte");
                // Pas de nouvel essai : ce serait l'APK entier retéléchargé sans fin (forfait SIM). Une nouvelle
                // publication (autre empreinte) sera prise à la prochaine vérification ou annonce.
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

    /** Le fichier de version le plus récent entre l'adresse habituelle et celle de secours ; erreur si aucune ne répond. */
    private static JSONObject lireVersion(boolean test) throws Exception {
        JSONObject meilleur = null;
        Exception derniere = null;
        for (String url : test ? new String[]{FEED_TEST, FEED_SECOURS_TEST} : new String[]{FEED, FEED_SECOURS}) {
            try {
                JSONObject f = new JSONObject(new String(download(url), "UTF-8"));
                if (meilleur == null || f.getInt("versionCode") > meilleur.getInt("versionCode")) meilleur = f;
            } catch (Exception e) {
                derniere = e;
            }
        }
        if (meilleur == null) throw derniere != null ? derniere : new IOException("aucun fichier de version");
        return meilleur;
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

    /** Fichier plus gros que permis (MajGarde.TAILLE_MAX) : refusé pour de bon, pas réessayé. */
    static final class TropGros extends IOException {
        TropGros(String message) { super(message); }
    }

    private static byte[] download(String url) throws IOException {
        return download(url, 1024 * 1024);
    }

    /** Téléchargement plafonné : refusé si le serveur annonce plus, interrompu s'il envoie plus. */
    private static byte[] download(String url, long max) throws IOException {
        HttpsURLConnection c = (HttpsURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20_000);
        c.setReadTimeout(60_000);
        c.setUseCaches(false);
        try {
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode() + " " + url);
            if (c.getContentLengthLong() > max) throw new TropGros("Fichier trop gros (" + c.getContentLengthLong() + " octets) " + url);
            InputStream in = c.getInputStream();
            try {
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[32 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (out.size() > max) throw new TropGros("Fichier trop gros (plus de " + max + " octets) " + url);
                }
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
