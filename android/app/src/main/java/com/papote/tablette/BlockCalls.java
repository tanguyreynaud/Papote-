package com.papote.tablette;

import android.net.Uri;
import android.os.Build;
import android.telecom.Call;
import android.telecom.CallScreeningService;

import org.json.JSONObject;

/**
 * Filtre les appels de la carte SIM : Mamie ne reçoit que les appels des numéros de sa famille
 * (members/{uid}.telephone, gardés par {@link Telephone}) ; tout autre numéro, ou un numéro masqué,
 * est refusé en silence. Les appels qu'elle passe elle-même passent toujours.
 * Actif quand Papote tient le rôle « filtrage des appels » ou « Téléphone » (installer-tablette.ps1).
 * Avant le 29/10/2026 : tous les appels refusés.
 */
public class BlockCalls extends CallScreeningService {
    @Override
    public void onScreenCall(Call.Details details) {
        if (Build.VERSION.SDK_INT >= 29 && details.getCallDirection() == Call.Details.DIRECTION_OUTGOING) {
            respondToCall(details, new CallResponse.Builder().build());
            return;
        }
        Uri handle = details.getHandle();
        String numero = handle == null ? "" : handle.getSchemeSpecificPart();
        JSONObject proche = Telephone.proche(this, numero);
        if (proche != null) {
            respondToCall(details, new CallResponse.Builder().build());
            return;
        }
        Journal.log(this, "Appel téléphone refusé : numéro " + (numero.isEmpty() ? "masqué" : "inconnu " + Telephone.masquer(numero)));
        respondToCall(details, new CallResponse.Builder()
                .setDisallowCall(true)
                .setRejectCall(true)
                .setSkipCallLog(true)
                .setSkipNotification(true)
                .build());
    }
}
