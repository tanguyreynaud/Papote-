package com.papote.tablette;

import android.app.Activity;
import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.TextView;

/**
 * Mode secours (audit du 11/11, T-A) : une version de Papote qui plante dès l'ouverture ne doit pas
 * laisser la tablette de Mamie tourner en boucle sans plus jamais chercher la version corrigée.
 *
 * Chaque ouverture de l'écran compte un « démarrage raté » ; le compteur revient à zéro quand Papote
 * a tenu une minute. Après {@link #SEUIL} démarrages ratés d'affilée, l'écran habituel n'est plus
 * chargé : un écran tout simple (rien de ce qui peut planter) cherche une mise à jour tout de suite,
 * puis Papote est réessayée, 2 min après la première fois, toutes les 10 min ensuite.
 * Si une mise à jour s'installe, Android relance Papote et le compteur repart de zéro (BootReceiver).
 */
final class Secours {
    static final int SEUIL = 3;
    static final long TENU_MS = 60_000;
    private static final String RATES = "demarragesRates";
    private static final String PASSAGES = "secoursPassages";

    private Secours() { }

    /** Faut-il passer par l'écran de secours, après ce nombre de démarrages ratés d'affilée ? */
    static boolean fautSecourir(int rates) {
        return rates >= SEUIL;
    }

    /** Attente avant de réessayer Papote : 2 min au premier passage par le secours, 10 min ensuite. */
    static long attenteMs(int passages) {
        return passages <= 1 ? 2 * 60_000L : 10 * 60_000L;
    }

    /**
     * À l'ouverture de l'écran principal, avant tout le reste. true : ne rien charger, ouvrir le secours.
     * Écrit tout de suite (commit) : un plantage juste après ne doit pas perdre le compte.
     */
    static boolean auDemarrage(SharedPreferences prefs) {
        int rates = prefs.getInt(RATES, 0);
        if (fautSecourir(rates)) return true;
        prefs.edit().putInt(RATES, rates + 1).commit();
        return false;
    }

    /** Papote a tenu une minute : tout va bien. */
    static void demarrageReussi(SharedPreferences prefs) {
        if (prefs.getInt(RATES, 0) == 0 && prefs.getInt(PASSAGES, 0) == 0) return;
        prefs.edit().remove(RATES).remove(PASSAGES).apply();
    }

    /** Nouvelle version installée : on repart de zéro. */
    static void nouvelleVersion(Context c) {
        c.getSharedPreferences("papote", Context.MODE_PRIVATE).edit().remove(RATES).remove(PASSAGES).commit();
    }

    /** Papote a-t-elle des démarrages ratés en cours (écran principal pas encore confirmé) ? */
    static boolean enDifficulte(Context c) {
        return c.getSharedPreferences("papote", Context.MODE_PRIVATE).getInt(RATES, 0) > 0;
    }

    /** L'écran de secours : un texte calme, une recherche de mise à jour, puis un nouvel essai de Papote. */
    public static final class Ecran extends Activity {
        private final Handler handler = new Handler(Looper.getMainLooper());

        @Override
        protected void onCreate(Bundle savedInstanceState) {
            super.onCreate(savedInstanceState);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_FULLSCREEN
                    | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
            TextView t = new TextView(this);
            t.setText("Papote revient dans un instant.");
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 34);
            t.setTextColor(Color.parseColor("#312E81"));
            t.setBackgroundColor(Color.parseColor("#FDFAF5"));
            t.setGravity(Gravity.CENTER);
            setContentView(t);

            final Context app = getApplicationContext();
            final SharedPreferences prefs = getSharedPreferences("papote", MODE_PRIVATE);
            final int passages = prefs.getInt(PASSAGES, 0) + 1;
            prefs.edit().putInt(PASSAGES, passages).commit();
            Journal.urgent(app, "SECOURS : " + SEUIL + " démarrages ratés d'affilée, recherche d'une mise à jour (passage " + passages + ")");
            new Thread(() -> {
                try {
                    DevicePolicyManager dpm = (DevicePolicyManager) app.getSystemService(Context.DEVICE_POLICY_SERVICE);
                    if (dpm != null && dpm.isDeviceOwnerApp(app.getPackageName())) Updater.check(app);
                } catch (Throwable e) {
                    Journal.log(app, "SECOURS : mise à jour impossible : " + e);
                }
            }, "papote-secours").start();
            // Nouvel essai de Papote : un seul démarrage raté de plus ramènera ici.
            handler.postDelayed(() -> {
                prefs.edit().putInt(RATES, SEUIL - 1).commit();
                try {
                    startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception ignored) { }
                finish();
            }, attenteMs(passages));
        }

        @Override
        protected void onDestroy() {
            handler.removeCallbacksAndMessages(null);
            super.onDestroy();
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onBackPressed() { }
    }
}
