package fr.mapapote.famille;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Bouton « Refuser » de la notification d'appel : le téléphone arrête de sonner. */
public class Refus extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        Appels.arreter(context, intent.getStringExtra(Appels.EXTRA_CID));
    }
}
