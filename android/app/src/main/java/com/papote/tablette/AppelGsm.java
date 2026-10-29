package com.papote.tablette;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.telecom.Call;
import android.telecom.CallAudioState;
import android.telecom.DisconnectCause;
import android.telecom.InCallService;
import android.telecom.VideoProfile;
import android.util.Log;

import org.json.JSONObject;

/**
 * L'appel téléphonique en cours (Papote = application Téléphone de la tablette, voir {@link Telephone}).
 * Android nous confie chaque appel de la carte SIM : on le dit à l'écran Papote (MainActivity → page :
 * Papote.onGsm({etat, sortant, numero, uid, name, cause})), qui sonne, montre la photo du proche et
 * laisse Mamie décrocher ou raccrocher avec un gros bouton. Jamais de décroché automatique.
 * Pendant l'appel, le son sort toujours par le haut-parleur.
 *
 * Un seul appel à la fois : un deuxième appel entrant pendant une conversation est refusé.
 */
public class AppelGsm extends InCallService {
    private static final String TAG = "Papote";

    interface Ecouteur { void onGsm(JSONObject etat); }

    private static Call courant;
    private static Ecouteur ecouteur;
    private static Object proprietaire;
    private static JSONObject dernierEtat;
    private static boolean sortant;

    /**
     * La page de cette activité reçoit les états GSM. Après une mise à jour ou une relance du
     * kiosque, Android garde un moment deux MainActivity : la plus récente écoute, et la
     * destruction de l'ancienne (oublier) ne doit pas lui retirer l'écoute.
     */
    static void ecouter(Object qui, Ecouteur e) {
        proprietaire = qui;
        ecouteur = e;
        if (e != null && dernierEtat != null) e.onGsm(dernierEtat);
    }

    /** Retire l'écoute, seulement si c'est encore celle de cette activité. */
    static void oublier(Object qui) {
        if (proprietaire != qui) return;
        proprietaire = null;
        ecouteur = null;
    }

    /** Pour les tests : un état reçu du téléphone. */
    static void simuler(JSONObject etat) {
        dernierEtat = etat;
        Ecouteur e = ecouteur;
        if (e != null) e.onGsm(etat);
    }

    static boolean enCours() {
        return courant != null;
    }

    static JSONObject etat() {
        return dernierEtat == null ? new JSONObject() : dernierEtat;
    }

    static boolean decrocher() {
        Call c = courant;
        if (c == null || c.getState() != Call.STATE_RINGING) return false;
        c.answer(VideoProfile.STATE_AUDIO_ONLY);
        return true;
    }

    static boolean raccrocher() {
        Call c = courant;
        if (c == null) return false;
        if (c.getState() == Call.STATE_RINGING) c.reject(false, null);
        else c.disconnect();
        return true;
    }

    private final Call.Callback callback = new Call.Callback() {
        @Override
        public void onStateChanged(Call call, int state) {
            if (state == Call.STATE_ACTIVE) hautParleur();
            publier(call);
        }
    };

    @Override
    public void onCallAdded(Call call) {
        super.onCallAdded(call);
        if (courant != null && courant != call) {
            // Déjà en ligne : le deuxième appel est refusé (l'appelant entend « occupé »).
            Journal.log(this, "Appel téléphone pendant un appel : refusé");
            try { if (call.getState() == Call.STATE_RINGING) call.reject(false, null); else call.disconnect(); } catch (Exception ignored) { }
            return;
        }
        courant = call;
        sortant = call.getState() != Call.STATE_RINGING;
        call.registerCallback(callback);
        hautParleur();
        // L'écran Papote revient devant (il y est déjà en kiosque, mais pas après « unlock »).
        try {
            Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(i);
        } catch (Exception e) {
            Log.w(TAG, "Écran d'appel", e);
        }
        publier(call);
    }

    @Override
    public void onCallRemoved(Call call) {
        super.onCallRemoved(call);
        if (call != courant) return;
        call.unregisterCallback(callback);
        courant = null;
        publier(call);
        dernierEtat = null;
    }

    @Override
    public void onCallAudioStateChanged(CallAudioState audioState) {
        super.onCallAudioStateChanged(audioState);
        if (courant != null && audioState.getRoute() != CallAudioState.ROUTE_SPEAKER
                && (audioState.getSupportedRouteMask() & CallAudioState.ROUTE_SPEAKER) != 0) {
            hautParleur();
        }
    }

    private void hautParleur() {
        try { setAudioRoute(CallAudioState.ROUTE_SPEAKER); } catch (Exception e) { Log.w(TAG, "Haut-parleur", e); }
    }

    private void publier(Call call) {
        JSONObject etat = new JSONObject();
        try {
            Call.Details d = call.getDetails();
            Uri handle = d == null ? null : d.getHandle();
            String numero = handle == null ? "" : handle.getSchemeSpecificPart();
            int state = call.getState();
            String nom;
            switch (state) {
                case Call.STATE_RINGING: nom = "sonne"; break;         // un proche appelle
                case Call.STATE_DIALING:
                case Call.STATE_CONNECTING:
                case Call.STATE_NEW:
                case Call.STATE_SELECT_PHONE_ACCOUNT: nom = "appel"; break; // Mamie appelle, ça sonne chez le proche
                case Call.STATE_ACTIVE: nom = "enLigne"; break;
                case Call.STATE_HOLDING: nom = "enLigne"; break;
                case Call.STATE_DISCONNECTED:
                case Call.STATE_DISCONNECTING: nom = "fin"; break;
                default: nom = "appel";
            }
            etat.put("etat", nom).put("sortant", sortant).put("numero", numero);
            JSONObject proche = Telephone.proche(getApplicationContext(), numero);
            if (proche != null) etat.put("uid", proche.optString("uid")).put("name", proche.optString("name"));
            if (nom.equals("fin")) {
                DisconnectCause dc = d == null ? null : d.getDisconnectCause();
                int code = dc == null ? DisconnectCause.UNKNOWN : dc.getCode();
                String cause;
                switch (code) {
                    case DisconnectCause.BUSY: cause = "occupe"; break;
                    case DisconnectCause.MISSED: cause = "manque"; break;
                    case DisconnectCause.REJECTED: cause = "refuse"; break;
                    case DisconnectCause.ERROR:
                    case DisconnectCause.RESTRICTED:
                    case DisconnectCause.CANCELED: cause = "erreur"; break;
                    case DisconnectCause.REMOTE: cause = "raccroche"; break;
                    case DisconnectCause.LOCAL: cause = "raccroche"; break;
                    default: cause = "fin";
                }
                etat.put("cause", cause);
                Journal.log(this, "Appel téléphone " + (sortant ? "vers " : "de ") + Telephone.masquer(numero) + " : " + cause
                        + (dc != null && dc.getReason() != null ? " (" + dc.getReason() + ")" : ""));
            } else if (state == Call.STATE_RINGING) {
                Journal.log(this, "Appel téléphone de " + (proche != null ? proche.optString("name") : Telephone.masquer(numero)));
            }
        } catch (Exception e) {
            Log.w(TAG, "État de l'appel", e);
        }
        dernierEtat = etat;
        Ecouteur e = ecouteur;
        if (e != null) e.onGsm(etat);
    }

    /** Pour les tests : l'appel en cours, s'il y en a un. */
    static Call appelEnCours() {
        return courant;
    }

    static Context contexte(InCallService s) {
        return s.getApplicationContext();
    }
}
