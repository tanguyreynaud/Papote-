package fr.mapapote.famille;

import android.animation.AnimatorSet;
import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
import android.view.View;
import android.widget.TextView;

import androidx.core.content.ContextCompat;

/**
 * « Mamie vous appelle » en plein écran, par-dessus l'écran verrouillé. La sonnerie vient de la
 * notification (voir {@link Appels#sonner}) ; cet écran se ferme quand l'appel ne sonne plus.
 */
public class EcranAppel extends Activity {
    static final String REPONDRE = "fr.mapapote.famille.REPONDRE";

    private String cid;
    /** Pendant la réponse, la fin de la sonnerie ne doit pas fermer l'écran avant le déverrouillage. */
    private boolean enReponse;
    private AnimatorSet respiration;

    private final BroadcastReceiver fin = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String fini = intent.getStringExtra(Appels.EXTRA_CID);
            if (!enReponse && (fini == null || fini.equals(cid))) finish();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.ecran_appel);
        ContextCompat.registerReceiver(this, fin, new IntentFilter(Appels.ACTION_FIN),
                ContextCompat.RECEIVER_NOT_EXPORTED);
        findViewById(R.id.repondre).setOnClickListener(v -> repondre());
        findViewById(R.id.refuser).setOnClickListener(v -> {
            Appels.refuser(getApplicationContext(), cid, null);
            finish();
        });
        montrer(getIntent());
        respirer();
    }

    // Deux halos qui s'élargissent et s'effacent l'un après l'autre autour du visage.
    private void respirer() {
        respiration = new AnimatorSet();
        respiration.playTogether(halo(findViewById(R.id.halo1), 0), halo(findViewById(R.id.halo2), 900));
        respiration.start();
    }

    private AnimatorSet halo(View v, long decalage) {
        AnimatorSet set = new AnimatorSet();
        ObjectAnimator x = ObjectAnimator.ofFloat(v, View.SCALE_X, 0.62f, 1f);
        ObjectAnimator y = ObjectAnimator.ofFloat(v, View.SCALE_Y, 0.62f, 1f);
        ObjectAnimator a = ObjectAnimator.ofFloat(v, View.ALPHA, 1f, 0f);
        for (ObjectAnimator o : new ObjectAnimator[] {x, y, a}) {
            o.setDuration(1800);
            o.setRepeatCount(ValueAnimator.INFINITE);
        }
        set.playTogether(x, y, a);
        set.setStartDelay(decalage);
        v.setAlpha(0f);
        return set;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        montrer(intent);
    }

    private void montrer(Intent intent) {
        cid = intent.getStringExtra(Appels.EXTRA_CID);
        String nom = intent.getStringExtra(Appels.EXTRA_NOM);
        if (nom == null || nom.trim().isEmpty()) nom = "Mamie";
        ((TextView) findViewById(R.id.nom)).setText(nom);
        ((TextView) findViewById(R.id.initiale)).setText(nom.trim().substring(0, 1).toUpperCase());
        if (REPONDRE.equals(intent.getAction())) repondre();
    }

    // Déverrouille si besoin (code, empreinte), puis ouvre l'appel (AppelEnCours).
    private void repondre() {
        if (cid == null) {
            finish();
            return;
        }
        enReponse = true;
        Appels.arreter(this, cid);
        KeyguardManager km = getSystemService(KeyguardManager.class);
        if (km != null && km.isKeyguardLocked()) {
            km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override
                public void onDismissSucceeded() {
                    ouvrirAppel();
                }

                @Override
                public void onDismissCancelled() {
                    finish();
                }

                @Override
                public void onDismissError() {
                    finish();
                }
            });
        } else {
            ouvrirAppel();
        }
    }

    private void ouvrirAppel() {
        // Dans l'écran d'appel de l'app (et non dans Chrome) : le micro tient en arrière-plan.
        startActivity(AppelEnCours.pourRepondre(this, cid));
        finish();
    }

    @Override
    protected void onDestroy() {
        if (respiration != null) respiration.cancel();
        unregisterReceiver(fin);
        super.onDestroy();
    }
}
