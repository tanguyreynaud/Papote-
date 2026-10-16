package com.papote.tablette;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Relance Papote au démarrage et après une mise à jour de l'app. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Intent launch = new Intent(context, MainActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(launch);
        } catch (Exception ignored) {
            // Android peut refuser un lancement en arrière-plan ; l'écran d'accueil HOME prend le relais.
        }
    }
}
