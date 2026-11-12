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
        // Refus qui ne changera pas (signature, fichier invalide) : cet APK n'est plus retéléchargé (forfait SIM).
        android.content.SharedPreferences prefs = context.getSharedPreferences("papote", Context.MODE_PRIVATE);
        String enCours = prefs.getString("majEnCours", null);
        if (enCours == null) return;
        // Refus passager qui se répète (place manquante, vérification d'Android) : au bout de 3 fois pour le
        // même APK, il n'est plus retéléchargé non plus (audit réseau du 11/11).
        int rates = MajGarde.essaisPour(prefs.getString("majInstallRatees", null), enCours) + 1;
        if (MajGarde.refusDefinitif(status) || MajGarde.abandonner(rates)) {
            if (!MajGarde.refusDefinitif(status)) {
                Journal.urgent(context, "Mise à jour abandonnée : " + rates + " installations ratées du même fichier (" + status + ")");
            }
            prefs.edit().putString("majRefusee", enCours).remove("majEnCours").remove("majInstallRatees").apply();
        } else {
            prefs.edit().putString("majInstallRatees", enCours + ":" + rates).apply();
        }
    }
}
