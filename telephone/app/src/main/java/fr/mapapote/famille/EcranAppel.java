package fr.mapapote.famille;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Bundle;
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
            Appels.arreter(this, cid);
            finish();
        });
        montrer(getIntent());
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
        ((TextView) findViewById(R.id.nom)).setText(getString(R.string.vous_appelle, nom == null ? "Mamie" : nom));
        if (REPONDRE.equals(intent.getAction())) repondre();
    }

    // Déverrouille si besoin (code, empreinte), puis ouvre l'appel dans l'app famille.
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
        startActivity(Appels.ouvrirApp(this, Appels.URL_APP + "?appel=" + cid));
        finish();
    }

    @Override
    protected void onDestroy() {
        unregisterReceiver(fin);
        super.onDestroy();
    }
}
