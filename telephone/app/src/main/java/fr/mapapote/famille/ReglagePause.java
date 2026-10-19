package fr.mapapote.famille;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;

/**
 * Touché depuis la carte « Ne manquez aucun appel » de l'app famille (lien papote://sans-pause) :
 * ouvre la page où se trouve l'interrupteur « Suspendre l'activité si l'appli n'est pas utilisée ».
 * Depuis Android 12, c'est la page « Infos sur l'appli » (comme IntentCompat d'AndroidX).
 */
public class ReglagePause extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 30) {
            String action = Build.VERSION.SDK_INT >= 31
                    ? Settings.ACTION_APPLICATION_DETAILS_SETTINGS
                    : Intent.ACTION_AUTO_REVOKE_PERMISSIONS;
            try {
                startActivity(new Intent(action, Uri.parse("package:" + getPackageName())));
            } catch (Exception e) {
                // Réglage absent sur ce téléphone : rien à faire.
            }
        }
        finish();
    }
}
