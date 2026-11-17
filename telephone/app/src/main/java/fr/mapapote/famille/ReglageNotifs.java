package fr.mapapote.famille;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;

/**
 * Carte rouge « Votre téléphone ne sonnera pas » de l'app famille (lien papote://notifications) :
 * ouvre la page Android des notifications de Papote (ou du seul canal « Appels de la tablette »
 * s'il est le seul coupé). Au retour, l'app famille est rouverte : Ouverture lui redit si le
 * téléphone peut sonner (?notifs=0 ou rien), la carte disparaît une fois réglé.
 */
public class ReglageNotifs extends Activity {
    private boolean dansReglages;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        boolean appliOk = NotificationManagerCompat.from(this).areNotificationsEnabled();
        Intent reglage = appliOk
                ? new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_CHANNEL_ID, Appels.CANAL_APPELS)
                : new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
        reglage.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
        try {
            startActivity(reglage);
            dansReglages = true;
        } catch (Exception e) {
            try {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + getPackageName())));
                dansReglages = true;
            } catch (Exception e2) {
                finish();
            }
        }
    }

    @Override
    protected void onRestart() {
        super.onRestart();
        if (!dansReglages) return;
        dansReglages = false;
        startActivity(new Intent(this, Ouverture.class).setData(Uri.parse(getString(R.string.url_app))));
        finish();
    }
}
