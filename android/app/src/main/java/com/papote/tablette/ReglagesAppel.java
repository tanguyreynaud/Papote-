package com.papote.tablette;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Délais des appels de Mamie réglables à distance : families/{fid}.reglagesAppel = { sansReponse, messagerie },
 * en secondes (Tanguy, 19/11). Absents ou hors bornes : la page garde ses valeurs (18 s et 4,5 s, tablette.js).
 *  - sansReponse : on raccroche si le proche n'a pas décroché (10 à 45 s) ;
 *  - messagerie  : « en ligne » plus vite que ça = messagerie d'un téléphone éteint, on raccroche
 *                  (0 à 8 s ; 0 coupe la règle).
 */
final class ReglagesAppel {
    static final double SANS_REPONSE_MIN_S = 10, SANS_REPONSE_MAX_S = 45;
    static final double MESSAGERIE_MIN_S = 0, MESSAGERIE_MAX_S = 8;

    private ReglagesAppel() { }

    /** Les champs Firestore de la famille → { sansReponseMs, messagerieMs } ; null si rien d'utilisable. */
    static JSONObject lire(JSONObject champsFamille) {
        JSONObject v = champsFamille == null ? null : champsFamille.optJSONObject("reglagesAppel");
        JSONObject f = v == null || v.optJSONObject("mapValue") == null ? null
                : v.optJSONObject("mapValue").optJSONObject("fields");
        if (f == null) return null;
        JSONObject out = new JSONObject();
        try {
            long sr = sansReponseMs(nombre(f.optJSONObject("sansReponse")));
            if (sr >= 0) out.put("sansReponseMs", sr);
            long me = messagerieMs(nombre(f.optJSONObject("messagerie")));
            if (me >= 0) out.put("messagerieMs", me);
        } catch (JSONException e) {
            return null;
        }
        return out.length() == 0 ? null : out;
    }

    /** Délai sans réponse en millisecondes ; -1 si absent ou hors bornes (la page garde sa valeur). */
    static long sansReponseMs(Double secondes) {
        return dansLesBornes(secondes, SANS_REPONSE_MIN_S, SANS_REPONSE_MAX_S);
    }

    /** Délai « messagerie directe » en millisecondes (0 : règle coupée) ; -1 si absent ou hors bornes. */
    static long messagerieMs(Double secondes) {
        return dansLesBornes(secondes, MESSAGERIE_MIN_S, MESSAGERIE_MAX_S);
    }

    private static long dansLesBornes(Double secondes, double min, double max) {
        if (secondes == null || Double.isNaN(secondes) || secondes < min || secondes > max) return -1;
        return Math.round(secondes * 1000);
    }

    /** Un nombre Firestore (entier ou décimal) ; null si ce n'en est pas un. */
    static Double nombre(JSONObject valeur) {
        if (valeur == null) return null;
        try {
            if (valeur.has("integerValue")) return Double.valueOf(String.valueOf(valeur.get("integerValue")));
            if (valeur.has("doubleValue")) {
                double d = valeur.getDouble("doubleValue");
                return Double.isNaN(d) || Double.isInfinite(d) ? null : d;
            }
        } catch (Exception e) {
            return null;
        }
        return null;
    }
}
