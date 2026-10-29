package fr.mapapote.famille;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.ComponentName;
import android.os.Bundle;

/**
 * « Voulez-vous quitter Papote ? » puis « Quitter » dans l'app famille (lien papote://quitter) :
 * ferme Papote comme le ferait le bouton retour d'Android. La page ne peut pas fermer Chrome
 * elle-même (window.close est refusé dès qu'elle a un historique).
 *
 * Toutes les tâches de l'app sont fermées (celle de Chrome plein écran comprise), sauf un appel
 * en cours ou qui sonne, qui vit dans sa propre tâche.
 */
public class Quitter extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        for (ActivityManager.AppTask tache : getSystemService(ActivityManager.class).getAppTasks()) {
            try {
                ComponentName base = tache.getTaskInfo().baseIntent.getComponent();
                String nom = base == null ? "" : base.getClassName();
                if (nom.equals(AppelEnCours.class.getName()) || nom.equals(EcranAppel.class.getName())) continue;
                tache.finishAndRemoveTask();
            } catch (IllegalArgumentException e) {
                // Tâche déjà fermée entre-temps.
            }
        }
        finishAndRemoveTask();
    }
}
