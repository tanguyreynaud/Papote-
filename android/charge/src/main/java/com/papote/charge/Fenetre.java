package com.papote.charge;

import android.app.Activity;
import android.os.Bundle;

/**
 * Fenêtre invisible : Papote l'ouvre, elle réécrit la limite de charge et se referme aussitôt, sans rien afficher.
 * Elle existe parce que Blackview refuse de démarrer la mini-appli en arrière-plan (22/11) ; une fenêtre ouverte
 * par l'appli à l'écran, elle, démarre.
 */
public final class Fenetre extends Activity {
    @Override
    protected void onCreate(Bundle etat) {
        super.onCreate(etat);
        Relance.ecrire(getApplicationContext(), new Bundle());
        finish();
        overridePendingTransition(0, 0);
    }
}
