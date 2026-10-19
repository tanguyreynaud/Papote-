package fr.mapapote.famille;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Messages du serveur (functions/push.js), reçus même téléphone en veille grâce à la priorité haute :
 *   { type: 'appel', cid, nom }   la tablette appelle : le téléphone sonne
 *   { type: 'fin', cid }          la tablette ne sonne plus : silence
 *   { type: 'manque', cid, nom }  personne n'a répondu : « Appel manqué »
 *   { type: 'alerte', titre, texte }
 */
public class Sonnerie extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> d = message.getData();
        String type = d.get("type");
        String cid = d.get("cid");
        String nom = d.get("nom");
        if (nom == null || nom.isEmpty()) nom = "Mamie";
        if ("appel".equals(type) && cid != null) {
            Appels.sonner(this, cid, nom);
        } else if ("fin".equals(type)) {
            Appels.arreter(this, cid);
        } else if ("manque".equals(type) && cid != null) {
            Appels.manque(this, cid, nom);
        } else if ("alerte".equals(type)) {
            Appels.alerte(this, d.get("titre"), d.get("texte"));
        }
    }

    @Override
    public void onNewToken(@NonNull String jeton) {
        // Transmis à l'app famille au prochain lancement (voir Ouverture), qui le range avec le compte.
        Ouverture.memoriserJeton(this, jeton);
    }
}
