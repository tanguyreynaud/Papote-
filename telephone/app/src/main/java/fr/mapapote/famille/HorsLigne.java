package fr.mapapote.famille;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;

/**
 * Papote lancé sans réseau : au lieu de la page d'erreur de Chrome, un écran calme qui explique,
 * et l'app s'ouvre toute seule dès que le Wi-Fi ou les données mobiles reviennent.
 */
public class HorsLigne extends Activity {
    private ConnectivityManager reseau;
    private boolean relance;

    private final ConnectivityManager.NetworkCallback retour = new ConnectivityManager.NetworkCallback() {
        @Override
        public void onAvailable(Network n) {
            runOnUiThread(HorsLigne.this::relancer);
        }
    };

    static boolean connecte(Context ctx) {
        ConnectivityManager cm = ctx.getSystemService(ConnectivityManager.class);
        NetworkCapabilities c = cm.getNetworkCapabilities(cm.getActiveNetwork());
        return c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.hors_ligne);
        findViewById(R.id.reessayer).setOnClickListener(v -> {
            if (connecte(this)) relancer();
        });
        reseau = getSystemService(ConnectivityManager.class);
        reseau.registerDefaultNetworkCallback(retour);
    }

    private void relancer() {
        if (relance || isFinishing()) return;
        relance = true;
        startActivity(new Intent(this, Ouverture.class).setData(getIntent().getData()));
        finish();
    }

    @Override
    protected void onDestroy() {
        if (reseau != null) reseau.unregisterNetworkCallback(retour);
        super.onDestroy();
    }
}
