package fr.mapapote.famille;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

import org.json.JSONObject;

/**
 * Sonnerie des appels de la tablette, comme un vrai appel de téléphone : notification d'appel
 * (Répondre / Refuser) qui sonne en boucle avec la sonnerie du téléphone et s'ouvre en plein
 * écran quand le téléphone est en veille ou verrouillé (écran {@link EcranAppel}).
 *
 * Le serveur (functions/appels.js) renvoie « appel » toutes les 12 s tant que la tablette sonne,
 * puis « fin » quand elle arrête : la sonnerie s'arrête alors toute seule.
 */
final class Appels {
    private Appels() {}

    static final String URL_APP = "https://app.mapapote.fr/";
    static final String CANAL_APPELS = "appels";
    static final String CANAL_INFOS = "infos";
    /** Diffusé (dans l'app seulement) quand un appel ne sonne plus : l'écran d'appel se ferme. */
    static final String ACTION_FIN = "fr.mapapote.famille.FIN_APPEL";
    static final String EXTRA_CID = "cid";
    static final String EXTRA_NOM = "nom";

    private static final int ID_APPEL = 1;
    private static final int ID_MANQUE = 2;
    private static final int ID_ALERTE = 3;
    /** Au-delà, la tablette a raccroché depuis longtemps (elle abandonne au bout de 45 s). */
    private static final long DUREE_MAX_MS = 60_000;
    private static final String PREFS = "appels";
    private static final String TRAITES = "traites";
    private static final String REFUSES = "refuses";
    /** Fonction serveur refuserAppel (functions/appels.js). */
    private static final String URL_REFUS = "https://europe-west1-papote-famille.cloudfunctions.net/refuserAppel";

    static void creerCanaux(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        NotificationChannel appels = new NotificationChannel(CANAL_APPELS,
                ctx.getString(R.string.canal_appels), NotificationManager.IMPORTANCE_HIGH);
        appels.setDescription(ctx.getString(R.string.canal_appels_texte));
        appels.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
        appels.enableVibration(true);
        appels.setVibrationPattern(new long[] {0, 1000, 1000});
        appels.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(appels);
        nm.createNotificationChannel(new NotificationChannel(CANAL_INFOS,
                ctx.getString(R.string.canal_infos), NotificationManager.IMPORTANCE_DEFAULT));
    }

    /** La tablette appelle : le téléphone sonne (une seule fois par appel, malgré les renvois). */
    static void sonner(Context ctx, String cid, String nom, String fid, String jeton) {
        if (dejaTraite(ctx, cid)) return;
        // Gardés pour « Refuser » : le serveur arrête l'appel pour la tablette sur ce jeton.
        if (fid != null && jeton != null) prefs(ctx).edit().putString("refus." + cid, fid + "/" + jeton).apply();
        creerCanaux(ctx);
        Person appelant = new Person.Builder().setName(nom).setImportant(true).build();
        PendingIntent ecran = PendingIntent.getActivity(ctx, code(cid, 0),
                ecranAppel(ctx, cid, nom, null), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent repondre = PendingIntent.getActivity(ctx, code(cid, 1),
                ecranAppel(ctx, cid, nom, EcranAppel.REPONDRE), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent refuser = PendingIntent.getBroadcast(ctx, code(cid, 2),
                new Intent(ctx, Refus.class).putExtra(EXTRA_CID, cid),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification n = new NotificationCompat.Builder(ctx, CANAL_APPELS)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle(ctx.getString(R.string.vous_appelle, nom))
                .setContentText(ctx.getString(R.string.appel_video))
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setTimeoutAfter(DUREE_MAX_MS)
                .setContentIntent(ecran)
                .setFullScreenIntent(ecran, true)
                .addPerson(appelant)
                .setStyle(NotificationCompat.CallStyle.forIncomingCall(appelant, refuser, repondre))
                .build();
        // Sonne en boucle jusqu'à la réponse, au refus ou à la fin de l'appel.
        n.flags |= Notification.FLAG_INSISTENT;
        ctx.getSystemService(NotificationManager.class).notify(cid, ID_APPEL, n);
    }

    /** L'appel ne sonne plus (réponse, refus, la tablette a raccroché) : silence. */
    static void arreter(Context ctx, String cid) {
        if (cid == null) return;
        marquerTraite(ctx, cid);
        ctx.getSystemService(NotificationManager.class).cancel(cid, ID_APPEL);
        ctx.sendBroadcast(new Intent(ACTION_FIN).setPackage(ctx.getPackageName()).putExtra(EXTRA_CID, cid));
    }

    /**
     * « Refuser » : silence ici, et la tablette arrête de sonner tout de suite (« n'a pas pu
     * répondre »), comme le bouton Refuser de l'app famille. Appel réseau en arrière-plan.
     */
    static void refuser(Context ctx, String cid, Runnable fini) {
        arreter(ctx, cid);
        if (cid == null) {
            if (fini != null) fini.run();
            return;
        }
        marquer(ctx, REFUSES, cid);
        String cle = prefs(ctx).getString("refus." + cid, null);
        prefs(ctx).edit().remove("refus." + cid).apply();
        if (cle == null || cle.indexOf('/') < 0) {
            if (fini != null) fini.run();
            return;
        }
        String fid = cle.substring(0, cle.indexOf('/'));
        String jeton = cle.substring(cle.indexOf('/') + 1);
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(URL_REFUS).openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                byte[] corps = new JSONObject().put("fid", fid).put("cid", cid).put("jeton", jeton)
                        .toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream o = c.getOutputStream()) {
                    o.write(corps);
                }
                int code = c.getResponseCode();
                if (code >= 300) Log.w("Papote", "Refus de l'appel " + cid + " : réponse " + code);
                c.disconnect();
            } catch (Exception e) {
                Log.w("Papote", "Refus de l'appel " + cid + " impossible", e);
            } finally {
                if (fini != null) fini.run();
            }
        }).start();
    }

    /** Jeton de connexion de l'écran d'appel pour cet appel (functions/appels.js, envoyerConnexions). */
    static void memoriserConnexion(Context ctx, String cid, String connexion) {
        prefs(ctx).edit().putString("connexion." + cid, connexion).apply();
    }

    static String connexion(Context ctx, String cid) {
        String c = prefs(ctx).getString("connexion." + cid, null);
        prefs(ctx).edit().remove("connexion." + cid).apply();
        return c;
    }

    /** Personne n'a répondu : « Appel manqué », qui rappelle la tablette (pendant 24 h). */
    static void manque(Context ctx, String cid, String nom) {
        arreter(ctx, cid);
        // Refusé ici : pas d'« Appel manqué » pour soi-même.
        if (contient(ctx, REFUSES, cid)) return;
        creerCanaux(ctx);
        Notification n = new NotificationCompat.Builder(ctx, CANAL_INFOS)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle(ctx.getString(R.string.appel_manque, nom))
                .setContentText(ctx.getString(R.string.appel_manque_texte))
                .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
                .setAutoCancel(true)
                .setTimeoutAfter(24 * 3600_000L)
                .setContentIntent(ouvrir(ctx, URL_APP + "?rappeler=1", code(cid, 3)))
                .build();
        ctx.getSystemService(NotificationManager.class).notify(cid, ID_MANQUE, n);
    }

    /** Alerte sur la tablette (débranchée, silencieuse…). */
    static void alerte(Context ctx, String titre, String texte) {
        creerCanaux(ctx);
        Notification n = new NotificationCompat.Builder(ctx, CANAL_INFOS)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle(titre == null || titre.isEmpty() ? "Papote" : titre)
                .setContentText(texte == null ? "" : texte)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(texte == null ? "" : texte))
                .setAutoCancel(true)
                .setContentIntent(ouvrir(ctx, URL_APP, 0))
                .build();
        ctx.getSystemService(NotificationManager.class).notify("alerte", ID_ALERTE, n);
    }

    static Intent ecranAppel(Context ctx, String cid, String nom, String action) {
        Intent i = new Intent(ctx, EcranAppel.class)
                .putExtra(EXTRA_CID, cid)
                .putExtra(EXTRA_NOM, nom)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (action != null) i.setAction(action);
        return i;
    }

    /** Ouvre l'app famille à cette adresse (Chrome plein écran, voir {@link Ouverture}). */
    static Intent ouvrirApp(Context ctx, String url) {
        return new Intent(Intent.ACTION_VIEW, Uri.parse(url), ctx, Ouverture.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    private static PendingIntent ouvrir(Context ctx, String url, int code) {
        return PendingIntent.getActivity(ctx, code, ouvrirApp(ctx, url),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static int code(String cid, int bouton) {
        return cid.hashCode() * 4 + bouton;
    }

    // Appels déjà décrochés, refusés ou finis : les renvois du serveur ne doivent pas les refaire sonner.
    private static boolean dejaTraite(Context ctx, String cid) {
        return contient(ctx, TRAITES, cid);
    }

    private static void marquerTraite(Context ctx, String cid) {
        marquer(ctx, TRAITES, cid);
    }

    private static synchronized boolean contient(Context ctx, String liste, String cid) {
        return prefs(ctx).getStringSet(liste, new HashSet<>()).contains(cid);
    }

    private static synchronized void marquer(Context ctx, String liste, String cid) {
        Set<String> ids = new HashSet<>(prefs(ctx).getStringSet(liste, new HashSet<>()));
        if (ids.size() > 50) ids.clear();
        ids.add(cid);
        prefs(ctx).edit().putStringSet(liste, ids).apply();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
