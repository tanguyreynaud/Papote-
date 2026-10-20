package fr.mapapote.famille;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Bouton « Refuser » de la notification d'appel : silence ici, et la tablette arrête de sonner. */
public class Refus extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        PendingResult enCours = goAsync();
        Appels.refuser(context, intent.getStringExtra(Appels.EXTRA_CID), enCours::finish);
    }
}
