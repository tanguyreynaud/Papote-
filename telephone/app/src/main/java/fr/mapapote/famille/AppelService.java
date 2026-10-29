package fr.mapapote.famille;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.ServiceCompat;

/**
 * Appel en cours : notification permanente « Appel avec Mamie » dans la barre, avec la durée et
 * « Raccrocher », comme WhatsApp. C'est ce service au premier plan qui autorise Android à garder
 * le micro (et la caméra en vidéo) quand l'appel passe en arrière-plan.
 */
public class AppelService extends Service {
    private static final String CANAL = "appel_en_cours";
    private static final int ID = 20;
    private static final String EXTRA_ETAT = "etat";
    private static final String EXTRA_NOM = "nom";
    private static final String EXTRA_VIDEO = "video";

    private long debut;

    static void montrer(Context ctx, String etat, String nom, boolean video) {
        Intent i = new Intent(ctx, AppelService.class)
                .putExtra(EXTRA_ETAT, etat).putExtra(EXTRA_NOM, nom).putExtra(EXTRA_VIDEO, video);
        try {
            ctx.startForegroundService(i);
        } catch (Exception e) {
            // Démarrage refusé (app déjà en arrière-plan) : l'appel continue, sans notification.
        }
    }

    static void arreter(Context ctx) {
        ctx.stopService(new Intent(ctx, AppelService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        String etat = intent.getStringExtra(EXTRA_ETAT);
        String nom = intent.getStringExtra(EXTRA_NOM);
        if (nom == null || nom.trim().isEmpty()) nom = "Mamie";
        boolean video = intent.getBooleanExtra(EXTRA_VIDEO, false);
        if ("en_cours".equals(etat) && debut == 0) debut = System.currentTimeMillis();

        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel canal = new NotificationChannel(CANAL, getString(R.string.canal_appel_en_cours),
                NotificationManager.IMPORTANCE_DEFAULT);
        canal.setSound(null, null);
        canal.enableVibration(false);
        nm.createNotificationChannel(canal);

        PendingIntent revenir = PendingIntent.getActivity(this, ID,
                new Intent(this, AppelEnCours.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent raccrocher = PendingIntent.getBroadcast(this, ID,
                new Intent(AppelEnCours.ACTION_RACCROCHER).setPackage(getPackageName()),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Person enFace = new Person.Builder().setName(nom).setImportant(true).build();
        NotificationCompat.Builder n = new NotificationCompat.Builder(this, CANAL)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle(getString(R.string.appel_avec, nom))
                .setContentText(getString(debut == 0 ? R.string.appel_connexion : video ? R.string.appel_video_en_cours : R.string.appel_audio_en_cours))
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setOngoing(true)
                .setSilent(true)
                .setContentIntent(revenir)
                .setStyle(NotificationCompat.CallStyle.forOngoingCall(enFace, raccrocher));
        if (debut > 0) n.setWhen(debut).setUsesChronometer(true).setShowWhen(true);
        Notification notif = n.build();

        int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                | (video ? ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA : 0);
        try {
            ServiceCompat.startForeground(this, ID, notif, types);
        } catch (Exception e) {
            // Micro pas encore autorisé : la notification attend le prochain état.
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
