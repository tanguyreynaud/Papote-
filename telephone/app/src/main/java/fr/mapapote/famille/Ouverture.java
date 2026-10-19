package fr.mapapote.famille;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.google.androidbrowserhelper.trusted.LauncherActivity;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * Ouvre l'app famille (app.mapapote.fr) dans Chrome, en plein écran : connexion Google, caméra,
 * micro et mises à jour du site marchent comme dans le navigateur.
 *
 * Avant, au premier lancement : autorisation des notifications (Android 13+) et de l'écran d'appel
 * plein écran (Android 14+). Puis l'adresse reçoit ?natif=<jeton> : l'app famille range ce jeton
 * avec le compte (web/js/push.js), et le serveur fait sonner ce téléphone par lui.
 */
public class Ouverture extends LauncherActivity {
    private static final String PREFS = "ouverture";
    private static final String JETON = "jeton";
    private static final String NOTIFS_DEMANDEES = "notifsDemandees";
    private static final String PLEIN_ECRAN_DEMANDE = "pleinEcranDemande";
    private static final String SANS_PAUSE_DEMANDE = "sansPauseDemande";
    /** Sans réseau, le jeton peut ne jamais arriver : on ouvre quand même l'app. */
    private static final long ATTENTE_JETON_MS = 4000;

    private boolean lance;
    /** Étape suivante, au retour d'un écran de réglages ouvert par l'app. */
    private Runnable auRetour;

    @Override
    protected boolean shouldLaunchImmediately() {
        return false;
    }

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (isFinishing()) return;
        Appels.creerCanaux(this);
        // Ouverte depuis « Répondre » : la sonnerie a fait son travail.
        Uri data = getIntent().getData();
        if (data != null && data.getQueryParameter("appel") != null) {
            Appels.arreter(this, data.getQueryParameter("appel"));
            // Pas de réglages par-dessus un appel : ils seront proposés au prochain lancement.
            recupererJeton();
            return;
        }
        demanderNotifications();
    }

    private void demanderNotifications() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && !prefs(this).getBoolean(NOTIFS_DEMANDEES, false)) {
            prefs(this).edit().putBoolean(NOTIFS_DEMANDEES, true).apply();
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
            return;
        }
        demanderPleinEcran();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        demanderPleinEcran();
    }

    // Android 14+ : sans cette autorisation, l'appel n'apparaît qu'en bandeau, sans écran plein.
    private void demanderPleinEcran() {
        if (Build.VERSION.SDK_INT >= 34
                && !getSystemService(NotificationManager.class).canUseFullScreenIntent()
                && !prefs(this).getBoolean(PLEIN_ECRAN_DEMANDE, false)) {
            prefs(this).edit().putBoolean(PLEIN_ECRAN_DEMANDE, true).apply();
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                        Uri.parse("package:" + getPackageName())));
                auRetour = this::demanderSansPause;
                return;
            } catch (Exception e) {
                // Réglage absent sur ce téléphone : tant pis, le bandeau sonnera quand même.
            }
        }
        demanderSansPause();
    }

    // Android 11+ met en pause une app pas ouverte depuis quelques mois : elle ne recevrait plus
    // les appels. Un proche qui ne décroche jamais serait concerné ; on propose de l'éviter.
    private void demanderSansPause() {
        if (Build.VERSION.SDK_INT >= 30
                && !getPackageManager().isAutoRevokeWhitelisted()
                && !prefs(this).getBoolean(SANS_PAUSE_DEMANDE, false)) {
            prefs(this).edit().putBoolean(SANS_PAUSE_DEMANDE, true).apply();
            try {
                startActivity(new Intent(Intent.ACTION_AUTO_REVOKE_PERMISSIONS,
                        Uri.parse("package:" + getPackageName())));
                Toast.makeText(this, R.string.sans_pause, Toast.LENGTH_LONG).show();
                auRetour = this::recupererJeton;
                return;
            } catch (Exception e) {
                // Réglage absent sur ce téléphone.
            }
        }
        recupererJeton();
    }

    // onRestart et non onResume : la fermeture de la demande d'autorisation relance aussi onResume,
    // alors que l'écran de réglages tout juste ouvert n'a pas encore été vu.
    @Override
    protected void onRestart() {
        super.onRestart();
        if (auRetour != null && !isFinishing()) {
            Runnable suite = auRetour;
            auRetour = null;
            suite.run();
        }
    }

    private void recupererJeton() {
        Handler principal = new Handler(Looper.getMainLooper());
        principal.postDelayed(this::lancer, ATTENTE_JETON_MS);
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(t -> {
            if (t.isSuccessful() && t.getResult() != null) memoriserJeton(this, t.getResult());
            principal.post(this::lancer);
        });
    }

    private void lancer() {
        if (lance) return;
        lance = true;
        // L'écran de démarrage attend la fin de l'animation d'ouverture avant de passer la main à
        // Chrome. Quand la demande d'autorisation s'ouvre par-dessus, Android ne la signale jamais :
        // l'app restait bloquée sur le logo. On la signale nous-mêmes (sans effet si déjà reçue).
        onEnterAnimationComplete();
        launchTwa();
    }

    @Override
    protected Uri getLaunchingUrl() {
        Uri url = super.getLaunchingUrl();
        String jeton = prefs(this).getString(JETON, null);
        if (jeton == null) return url;
        return url.buildUpon().appendQueryParameter("natif", jeton).build();
    }

    static void memoriserJeton(Context ctx, String jeton) {
        prefs(ctx).edit().putString(JETON, jeton).apply();
    }

    private static android.content.SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
