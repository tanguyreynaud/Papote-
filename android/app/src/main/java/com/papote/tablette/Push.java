package com.papote.tablette;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.annotation.NonNull;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * Réveil de la tablette par le serveur (functions/reveil.js), à la place d'une écoute Firestore
 * ouverte en permanence dans la page (≈ 100 Mo par mois sur la carte SIM, mesuré le 28/10).
 *
 * Messages « data » en priorité haute : { type: 'appel' | 'ordre' | 'famille' | 'version', id? }.
 *   appel    un proche appelle : la page relit les appels qui sonnent (papoteReveil) ;
 *   ordre    test du son demandé par le téléphone : la page relit les ordres ;
 *   famille  la fiche de la famille a changé (envoi, rappel, réglage) : tour de synchronisation ;
 *   version  nouvelle version publiée : vérification de la mise à jour.
 *
 * Jeton de la tablette : families/{fid}/members/{uid}/private/push = { tablette: [jeton] } (écrit par
 * Sync avec le compte de la tablette). Sans google-services.json à la construction, Firebase n'est pas
 * configuré : pas de jeton, la page garde son écoute en direct (pushReady() faux).
 *
 * Auto-contrôle : avec le jeton, Sync écrit pingDemande ; le serveur (reveilPing) renvoie { type: 'ping' }.
 * Tant qu'aucun ping n'est reçu (ou si un contrôle quotidien échoue : économiseur de données, services
 * Google en panne), pret() reste faux et la page garde son écoute en direct. Un appel manqué parce que
 * les réveils n'arrivent pas serait bien pire que les Mo de l'écoute.
 */
public class Push extends FirebaseMessagingService {
    private static final String TAG = "Papote";
    static final String TOPIC = "tablettes";

    @Override
    public void onNewToken(@NonNull String jeton) {
        memoriser(this, jeton);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        String type = message.getData().get("type");
        if (type == null) return;
        SharedPreferences p = prefs(this);
        p.edit().putLong("pushDernier", System.currentTimeMillis()).apply();
        if ("ping".equals(type)) {
            boolean premier = p.getLong("pushPingRecu", 0) == 0;
            p.edit().putLong("pushPingRecu", System.currentTimeMillis()).putBoolean("pushEchecNote", false).apply();
            if (premier) Journal.log(this, "Push : réveil par le serveur vérifié (ping reçu)");
            MainActivity.surPush("jeton", null); // la page peut fermer ses écoutes dès ce tour
            return;
        }
        MainActivity.surPush(type, message.getData().get("id"));
    }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences("papote", Context.MODE_PRIVATE);
    }

    /** Firebase configuré (google-services.json présent à la construction). */
    static boolean disponible(Context c) {
        try {
            return !FirebaseApp.getApps(c.getApplicationContext()).isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    /** Au démarrage : jeton demandé (écrit par Sync au prochain tour) et abonnement aux nouvelles versions. */
    static void demarrer(Context c) {
        if (!disponible(c)) {
            Log.i(TAG, "Push : Firebase non configuré, la page garde son écoute en direct");
            return;
        }
        try {
            FirebaseMessaging fm = FirebaseMessaging.getInstance();
            fm.getToken().addOnSuccessListener((jeton) -> memoriser(c, jeton))
                    .addOnFailureListener((e) -> Log.w(TAG, "Push : jeton", e));
            fm.subscribeToTopic(TOPIC);
        } catch (Exception e) {
            Log.w(TAG, "Push", e);
        }
    }

    static void memoriser(Context c, String jeton) {
        if (jeton == null || jeton.isEmpty()) return;
        SharedPreferences p = prefs(c);
        if (jeton.equals(p.getString("pushJeton", null))) return;
        p.edit().putString("pushJeton", jeton).remove("pushJetonEcrit").remove("pushPingRecu").remove("pushPingDemande").apply();
        Journal.log(c, "Push : nouveau jeton, à écrire dans la famille");
        MainActivity.surPush("jeton", null);
    }

    /** Jeton à écrire (null si déjà écrit ou inconnu). */
    static String jetonAEcrire(Context c) {
        SharedPreferences p = prefs(c);
        String jeton = p.getString("pushJeton", null);
        if (jeton == null || jeton.equals(p.getString("pushJetonEcrit", null))) return null;
        return jeton;
    }

    static final long PING_ATTENTE_MS = 2 * 60_000;
    static final long PING_CHAQUE_MS = 24 * 3600_000;
    static final long PING_RELANCE_MS = 30 * 60_000;

    static void jetonEcrit(Context c, String jeton) {
        prefs(c).edit().putString("pushJetonEcrit", jeton).putLong("pushPingDemande", System.currentTimeMillis()).apply();
    }

    /** Le contrôle quotidien est dû : Sync réécrit pingDemande (le serveur renvoie un ping). */
    static boolean controleDu(Context c) {
        SharedPreferences p = prefs(c);
        if (p.getString("pushJetonEcrit", null) == null) return false;
        long depuis = System.currentTimeMillis() - p.getLong("pushPingDemande", 0);
        // Pas de ping reçu pour la dernière demande (serveur pas encore à jour, coupure) : on redemande
        // toutes les 30 min, au lieu d'attendre le lendemain en gardant l'écoute en direct (28/10).
        boolean sansReponse = p.getLong("pushPingRecu", 0) < p.getLong("pushPingDemande", 0);
        return depuis >= (sansReponse ? PING_RELANCE_MS : PING_CHAQUE_MS);
    }

    static void controleDemande(Context c) {
        prefs(c).edit().putLong("pushPingDemande", System.currentTimeMillis()).putBoolean("pushEchecNote", false).apply();
    }

    /**
     * Le serveur peut réveiller la tablette : jeton connu, écrit dans la famille, ET un ping reçu après
     * la dernière demande (ou la demande date de moins de 2 min : le ping est en route).
     */
    static boolean pret(Context c) {
        SharedPreferences p = prefs(c);
        String jeton = p.getString("pushJeton", null);
        if (!disponible(c) || jeton == null || !jeton.equals(p.getString("pushJetonEcrit", null))) return false;
        long demande = p.getLong("pushPingDemande", 0);
        long recu = p.getLong("pushPingRecu", 0);
        if (recu >= demande) return recu > 0;
        boolean enRoute = System.currentTimeMillis() - demande < PING_ATTENTE_MS;
        if (!enRoute && !p.getBoolean("pushEchecNote", false)) {
            p.edit().putBoolean("pushEchecNote", true).apply();
            Journal.log(c, "Push : aucun ping reçu en 2 min, la page garde son écoute en direct");
        }
        // Avant le premier ping, on ne ferme rien : le ping « en route » ne suffit pas.
        return false;
    }
}
