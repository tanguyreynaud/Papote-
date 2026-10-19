package fr.mapapote.famille;

import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Toast;

import androidx.core.app.NotificationCompat;

/**
 * Touché depuis la carte « Ne manquez aucun appel » de l'app famille (lien papote://sans-pause) :
 * un tuto en 4 étapes, puis « OK, j'y vais » ouvre la page où se trouve l'interrupteur
 * « Suspendre l'activité si l'appli n'est pas utilisée » (depuis Android 12, « Infos sur l'appli »,
 * comme IntentCompat d'AndroidX).
 *
 * Android interdit d'afficher une fenêtre par-dessus ses réglages : les étapes y restent visibles
 * grâce à une notification qui s'affiche en haut de l'écran. Au retour, c'est réglé (« C'est bon »)
 * ou le tuto reste là pour réessayer.
 */
public class ReglagePause extends Activity {
    private static final String CANAL_AIDE = "aide";
    private static final int ID_AIDE = 10;
    private static final long DUREE_AIDE_MS = 3 * 60_000;

    private boolean dansReglages;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT < 30 || reglee()) {
            finish();
            return;
        }
        setContentView(R.layout.tuto_pause);
        findViewById(R.id.plus_tard).setOnClickListener(v -> finish());
        findViewById(R.id.ouvrir).setOnClickListener(v -> ouvrirReglage());
    }

    private void ouvrirReglage() {
        String action = Build.VERSION.SDK_INT >= 31
                ? Settings.ACTION_APPLICATION_DETAILS_SETTINGS
                : Intent.ACTION_AUTO_REVOKE_PERMISSIONS;
        try {
            startActivity(new Intent(action, Uri.parse("package:" + getPackageName())));
            dansReglages = true;
            montrerEtapes();
        } catch (Exception e) {
            finish(); // réglage absent sur ce téléphone
        }
    }

    // Bandeau en haut de l'écran, par-dessus la page des réglages, sans bruit.
    private void montrerEtapes() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel aide = new NotificationChannel(CANAL_AIDE,
                getString(R.string.canal_aide), NotificationManager.IMPORTANCE_HIGH);
        aide.setSound(null, null);
        aide.enableVibration(false);
        nm.createNotificationChannel(aide);
        nm.notify(ID_AIDE, new NotificationCompat.Builder(this, CANAL_AIDE)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle(getString(R.string.pause_bulle_titre))
                .setContentText(getString(R.string.pause_bulle_texte))
                .setStyle(new NotificationCompat.BigTextStyle().bigText(getString(R.string.pause_bulle_detail)))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setOnlyAlertOnce(true)
                .setAutoCancel(true)
                .setTimeoutAfter(DUREE_AIDE_MS)
                .build());
    }

    @Override
    protected void onRestart() {
        super.onRestart();
        if (!dansReglages) return;
        dansReglages = false;
        getSystemService(NotificationManager.class).cancel(ID_AIDE);
        if (reglee()) {
            Toast.makeText(this, R.string.pause_fait, Toast.LENGTH_LONG).show();
            finish();
        }
        // Sinon le tuto reste affiché : on peut réessayer ou choisir « Plus tard ».
    }

    private boolean reglee() {
        return getPackageManager().isAutoRevokeWhitelisted();
    }
}
