package com.papote.tablette;

import android.telecom.Call;
import android.telecom.CallScreeningService;

/**
 * Refuse en silence tous les appels de la carte SIM : Mamie ne reçoit que les appels Papote.
 * Actif quand Papote tient le rôle « filtrage des appels » (installation/installer-tablette.ps1).
 */
public class BlockCalls extends CallScreeningService {
    @Override
    public void onScreenCall(Call.Details details) {
        respondToCall(details, new CallResponse.Builder()
                .setDisallowCall(true)
                .setRejectCall(true)
                .setSkipCallLog(true)
                .setSkipNotification(true)
                .build());
    }
}
