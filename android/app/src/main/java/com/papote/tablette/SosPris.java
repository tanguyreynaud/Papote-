package com.papote.tablette;

import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;

/**
 * « Je m'en occupe » touché par un proche dans l'app pendant un SOS : families/{fid}.sosPris =
 * { uid, nom, le } (écrit par le serveur ; le = heure du serveur, horodatage Firestore ou millisecondes).
 * Sync le lit avec la fiche de la famille (réveil « famille ») et le passe à la page, qui prévient les
 * autres proches par SMS et n'appelle plus personne (tablette.js, sosPrisEnCharge). La page ignore un
 * « Je m'en occupe » plus ancien que le SOS en cours : rien à effacer ici.
 */
final class SosPris {
    private SosPris() { }

    /** Les champs Firestore de la famille → { uid, nom, le (ms) } ; null si absent ou inutilisable. */
    static JSONObject lire(JSONObject champsFamille) {
        JSONObject v = champsFamille == null ? null : champsFamille.optJSONObject("sosPris");
        JSONObject f = v == null || v.optJSONObject("mapValue") == null ? null
                : v.optJSONObject("mapValue").optJSONObject("fields");
        if (f == null) return null;
        JSONObject le = f.optJSONObject("le");
        long ms = le == null ? -1 : instant(le.optString("timestampValue", null), le.optString("integerValue", null));
        if (ms <= 0) return null;
        try {
            return new JSONObject()
                    .put("uid", texte(f.optJSONObject("uid")))
                    .put("nom", texte(f.optJSONObject("nom")))
                    .put("le", ms);
        } catch (JSONException e) {
            return null;
        }
    }

    private static String texte(JSONObject valeur) {
        return valeur == null ? "" : valeur.optString("stringValue", "");
    }

    /** Millisecondes d'un horodatage Firestore (« 2026-11-20T12:30:00.123Z ») ou d'un entier ; -1 sinon. */
    static long instant(String horodatage, String entier) {
        try {
            if (horodatage != null && !horodatage.isEmpty()) return Instant.parse(horodatage).toEpochMilli();
            if (entier != null && !entier.isEmpty()) return Long.parseLong(entier);
        } catch (RuntimeException e) {
            return -1;
        }
        return -1;
    }
}
