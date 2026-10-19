package fr.mapapote.famille;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Toast;

/**
 * Touché depuis la carte « Ne manquez aucun appel » de l'app famille (lien papote://sans-pause) :
 * un petit tuto en 3 étapes, puis « Ouvrir le réglage » ouvre la page où se trouve l'interrupteur
 * « Suspendre l'activité si l'appli n'est pas utilisée ». Android interdit d'afficher quoi que ce
 * soit par-dessus ses réglages : le tuto vient donc avant, et un rappel court s'affiche après.
 * Depuis Android 12, c'est la page « Infos sur l'appli » (comme IntentCompat d'AndroidX).
 */
public class ReglagePause extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT < 30) {
            finish();
            return;
        }
        setContentView(R.layout.tuto_pause);
        findViewById(R.id.plus_tard).setOnClickListener(v -> finish());
        findViewById(R.id.ouvrir).setOnClickListener(v -> {
            String action = Build.VERSION.SDK_INT >= 31
                    ? Settings.ACTION_APPLICATION_DETAILS_SETTINGS
                    : Intent.ACTION_AUTO_REVOKE_PERMISSIONS;
            try {
                startActivity(new Intent(action, Uri.parse("package:" + getPackageName())));
                Toast.makeText(this, R.string.pause_rappel, Toast.LENGTH_LONG).show();
            } catch (Exception e) {
                // Réglage absent sur ce téléphone : rien à faire.
            }
            finish();
        });
    }
}
