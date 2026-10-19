package com.papote.tablette;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.util.Log;

/**
 * Résultat d'une mise à jour (PackageInstaller) : noté dans le journal pour qu'un échec se voie,
 * au lieu de passer inaperçu et de laisser la tablette sur une vieille version.
 */
public class UpdateResult extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999);
        String msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // Ne devrait pas arriver en propriétaire de l'appareil : on affiche la confirmation plutôt que rester bloqué.
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            Journal.log(context, "Mise à jour : confirmation demandée par Android");
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try { context.startActivity(confirm); } catch (Exception e) { Log.w("Papote", "Confirmation", e); }
            }
            return;
        }
        if (status == PackageInstaller.STATUS_SUCCESS) return; // Papote est relancée par BootReceiver
        Log.w("Papote", "Mise à jour refusée : " + status + " " + msg);
        Journal.log(context, "Mise à jour refusée (" + status + ") : " + msg);
    }
}
