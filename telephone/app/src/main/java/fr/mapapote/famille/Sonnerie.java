package fr.mapapote.famille;

import android.content.Context;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Messages du serveur (functions/push.js), reçus même téléphone en veille grâce à la priorité haute :
 *   { type: 'appel', cid, fid, jeton, nom }  la tablette appelle : le téléphone sonne
 *                                 (fid + jeton : pour « Refuser », voir Appels.refuser)
 *   { type: 'connexion', cid, connexion }  juste après : de quoi ouvrir l'appel dans l'app
 *   { type: 'fin', cid }          la tablette ne sonne plus : silence
 *   { type: 'manque', cid, nom }  personne n'a répondu : « Appel manqué »
 *   { type: 'alerte', titre, texte }
 * SOS (A47) : « urgence: 'sos' » sur l'appel et l'alerte (sinon « SOS : » devant le nom ou le titre),
 * affichés en urgence (voir Appels.CANAL_SOS).
 */
public class Sonnerie extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        recevoir(this, message.getData());
    }

    /** Traite un message du serveur (séparé pour les tests). */
    static void recevoir(Context ctx, Map<String, String> d) {
        String type = d.get("type");
        String cid = d.get("cid");
        String nom = d.get("nom");
        if (nom == null || nom.isEmpty()) nom = "Mamie";
        if ("appel".equals(type) && cid != null) {
            Appels.sonner(ctx, cid, nom, d.get("fid"), d.get("jeton"), Appels.estSos(d.get("urgence"), nom, null));
            Raccourci.nommer(ctx, nom);
        } else if ("connexion".equals(type) && cid != null && d.get("connexion") != null) {
            Appels.memoriserConnexion(ctx, cid, d.get("connexion"));
        } else if ("fin".equals(type)) {
            Appels.arreter(ctx, cid);
        } else if ("manque".equals(type) && cid != null) {
            Appels.manque(ctx, cid, nom);
        } else if ("alerte".equals(type)) {
            Appels.alerte(ctx, d.get("titre"), d.get("texte"), Appels.estSos(d.get("urgence"), null, d.get("titre")));
        }
    }

    @Override
    public void onNewToken(@NonNull String jeton) {
        // Transmis à l'app famille au prochain lancement (voir Ouverture), qui le range avec le compte.
        Ouverture.memoriserJeton(this, jeton);
    }
}
