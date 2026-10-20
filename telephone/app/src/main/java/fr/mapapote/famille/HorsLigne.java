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

    // On attend un réseau « validé » (qui atteint vraiment internet), pas seulement un Wi-Fi
    // connecté : sinon l'app repartirait aussitôt vers une page qui ne se charge pas.
    private final ConnectivityManager.NetworkCallback retour = new ConnectivityManager.NetworkCallback() {
        @Override
        public void onCapabilitiesChanged(Network n, NetworkCapabilities c) {
            if (internet(c)) runOnUiThread(HorsLigne.this::relancer);
        }
    };

    static boolean connecte(Context ctx) {
        ConnectivityManager cm = ctx.getSystemService(ConnectivityManager.class);
        return internet(cm.getNetworkCapabilities(cm.getActiveNetwork()));
    }

    private static boolean internet(NetworkCapabilities c) {
        return c != null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
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
