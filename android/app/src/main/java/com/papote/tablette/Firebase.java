package com.papote.tablette;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;

/**
 * Accès à Firebase par ses API REST : compte de la tablette (e-mail et mot de passe) et Firestore.
 * Pas de SDK Firebase : l'appli reste petite et sans dépendance.
 */
final class Firebase {
    static final String PROJECT = "papote-famille";
    private static final String API_KEY = "AIzaSyAvoivJR8p-u2VxUWzlyHzTgP20-5ZG_-E";
    static final String DOCS = "projects/" + PROJECT + "/databases/(default)/documents";
    private static final String FIRESTORE = "https://firestore.googleapis.com/v1/";

    /** Erreur HTTP renvoyée par Firebase. */
    static final class ApiException extends IOException {
        final int code;

        ApiException(int code, String body) {
            super("HTTP " + code + " " + body);
            this.code = code;
        }
    }

    private final Http http;
    private final SharedPreferences prefs;
    private String idToken;
    private long idTokenExpiry;

    Firebase(Context context, SharedPreferences prefs) {
        this.http = new Http(context);
        this.prefs = prefs;
    }

    String uid() {
        return prefs.getString("uid", null);
    }

    // ---------- Compte de la tablette (e-mail et mot de passe, plus de compte anonyme) ----------

    private static final String ACCOUNT_DOMAIN = "@tablettes.papote-famille.web.app";
    private static final String AUTH = "https://identitytoolkit.googleapis.com/v1/accounts:";

    synchronized String token() throws IOException, JSONException {
        if (idToken != null && System.currentTimeMillis() < idTokenExpiry) return idToken;
        String refresh = prefs.getString("refreshToken", null);
        if (refresh != null) {
            Http.Response r = http.request("POST",
                    "https://securetoken.googleapis.com/v1/token?key=" + API_KEY,
                    "application/x-www-form-urlencoded",
                    "grant_type=refresh_token&refresh_token=" + Uri.encode(refresh), null);
            if (r.ok()) {
                JSONObject j = new JSONObject(r.body);
                remember(j.getString("id_token"), j.getString("refresh_token"),
                        j.getString("user_id"), j.optLong("expires_in", 3600));
                return idToken;
            }
            if (r.code != 400) throw new ApiException(r.code, r.body);
            // Jeton refusé : on se reconnecte avec l'e-mail et le mot de passe de la tablette.
        }
        String email = prefs.getString("email", null);
        String password = prefs.getString("password", null);
        if (email != null && password != null) {
            Http.Response r = authCall("signInWithPassword", email, password, null);
            if (r.ok()) {
                rememberAuth(new JSONObject(r.body));
                prefs.edit().putBoolean("accountConverted", true).apply();
                return idToken;
            }
            if (r.code != 400) throw new ApiException(r.code, r.body);
        }
        // Première installation : le compte est créé directement avec e-mail et mot de passe.
        email = "tablette-" + randomString(20).toLowerCase() + ACCOUNT_DOMAIN;
        password = randomString(32);
        prefs.edit().putString("email", email).putString("password", password).apply();
        Http.Response r = authCall("signUp", email, password, null);
        if (!r.ok()) throw new ApiException(r.code, r.body);
        rememberAuth(new JSONObject(r.body));
        prefs.edit().putBoolean("accountConverted", true).apply();
        return idToken;
    }

    /**
     * Ancien compte anonyme : Firebase n'accepte pas d'y ajouter une adresse non vérifiée.
     * Quand on donne un nouveau code tablette, on l'abandonne : la tablette crée son compte
     * e-mail et mot de passe et rejoint la famille avec ce code.
     */
    synchronized void forgetAnonymous() {
        if (prefs.getBoolean("accountConverted", false)) return;
        idToken = null;
        idTokenExpiry = 0;
        prefs.edit().remove("refreshToken").remove("uid").remove("email").remove("password").apply();
    }

    boolean isAnonymous() {
        return !prefs.getBoolean("accountConverted", false);
    }

    private Http.Response authCall(String action, String email, String password, String idTokenOrNull)
            throws IOException, JSONException {
        JSONObject body = new JSONObject().put("email", email).put("password", password)
                .put("returnSecureToken", true);
        if (idTokenOrNull != null) body.put("idToken", idTokenOrNull);
        return http.request("POST", AUTH + action + "?key=" + API_KEY, "application/json", body.toString(), null);
    }

    private void rememberAuth(JSONObject j) throws JSONException {
        remember(j.getString("idToken"), j.getString("refreshToken"),
                j.getString("localId"), j.optLong("expiresIn", 3600));
    }

    /**
     * Second compte, pour les appels vidéo (appels.js a sa propre connexion Firebase) :
     * créé une fois sur Firebase, puis toujours le même. {"email": "...", "password": "..."}
     */
    synchronized String callsAccount() {
        String email = prefs.getString("callEmail", null);
        String password = prefs.getString("callPassword", null);
        if (email == null || password == null) {
            email = "tablette-appels-" + randomString(20).toLowerCase() + ACCOUNT_DOMAIN;
            password = randomString(32);
            prefs.edit().putString("callEmail", email).putString("callPassword", password).apply();
        }
        try {
            return new JSONObject().put("email", email).put("password", password).toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    /** Crée le compte des appels sur Firebase s'il n'existe pas encore (hors du fil principal). */
    synchronized void ensureCallsAccount() {
        if (prefs.getBoolean("callAccountCreated", false)) return;
        try {
            JSONObject creds = new JSONObject(callsAccount());
            Http.Response r = authCall("signUp", creds.getString("email"), creds.getString("password"), null);
            if (r.ok() || r.body.contains("EMAIL_EXISTS")) {
                prefs.edit().putBoolean("callAccountCreated", true).apply();
            } else {
                android.util.Log.w("Papote", "Compte des appels : HTTP " + r.code + " " + r.body);
            }
        } catch (Exception e) {
            android.util.Log.w("Papote", "Compte des appels", e);
        }
    }

    private static String randomString(int length) {
        String alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
        java.security.SecureRandom rnd = new java.security.SecureRandom();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < length; i++) sb.append(alphabet.charAt(rnd.nextInt(alphabet.length())));
        return sb.toString();
    }

    private void remember(String id, String refresh, String uid, long expiresIn) {
        idToken = id;
        idTokenExpiry = System.currentTimeMillis() + (expiresIn - 300) * 1000;
        prefs.edit().putString("refreshToken", refresh).putString("uid", uid).apply();
    }

    // ---------- Firestore ----------

    /** Lit un document ; renvoie null s'il n'existe pas. */
    JSONObject get(String path, String... fieldMask) throws IOException, JSONException {
        StringBuilder url = new StringBuilder(FIRESTORE).append(DOCS).append('/').append(path);
        char sep = '?';
        for (String f : fieldMask) {
            url.append(sep).append("mask.fieldPaths=").append(Uri.encode(f));
            sep = '&';
        }
        Http.Response r = http.request("GET", url.toString(), null, null, token());
        if (r.code == 404) return null;
        if (!r.ok()) throw new ApiException(r.code, r.body);
        return new JSONObject(r.body);
    }

    /** Liste les documents d'une collection (jusqu'à 300). */
    JSONArray list(String path) throws IOException, JSONException {
        String url = FIRESTORE + DOCS + "/" + path + "?pageSize=300";
        Http.Response r = http.request("GET", url, null, null, token());
        if (!r.ok()) throw new ApiException(r.code, r.body);
        JSONArray docs = new JSONObject(r.body).optJSONArray("documents");
        return docs == null ? new JSONArray() : docs;
    }

    JSONArray runQuery(String parent, JSONObject structuredQuery) throws IOException, JSONException {
        String url = FIRESTORE + DOCS + (parent.isEmpty() ? "" : "/" + parent) + ":runQuery";
        JSONObject body = new JSONObject().put("structuredQuery", structuredQuery);
        Http.Response r = http.request("POST", url, "application/json", body.toString(), token());
        if (!r.ok()) throw new ApiException(r.code, r.body);
        return new JSONArray(r.body);
    }

    void commit(JSONArray writes) throws IOException, JSONException {
        String url = FIRESTORE + DOCS + ":commit";
        JSONObject body = new JSONObject().put("writes", writes);
        Http.Response r = http.request("POST", url, "application/json", body.toString(), token());
        if (!r.ok()) throw new ApiException(r.code, r.body);
    }

    static String docName(String path) {
        return DOCS + "/" + path;
    }

    // ---------- Valeurs Firestore ----------

    static JSONObject string(String s) throws JSONException {
        return new JSONObject().put("stringValue", s);
    }

    static String str(JSONObject fields, String name) {
        JSONObject v = fields.optJSONObject(name);
        return v == null ? null : v.optString("stringValue", null);
    }

    static long integer(JSONObject fields, String name) {
        JSONObject v = fields.optJSONObject(name);
        if (v == null) return 0;
        try {
            return Long.parseLong(v.optString("integerValue", "0"));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** Horodatage Firestore (RFC 3339) en millisecondes, 0 si absent. */
    static long timestamp(JSONObject fields, String name) {
        JSONObject v = fields.optJSONObject(name);
        if (v == null) return 0;
        return parseTimestamp(v.optString("timestampValue", null));
    }

    static long parseTimestamp(String ts) {
        if (ts == null || ts.length() < 19) return 0;
        try {
            java.util.Calendar c = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC"));
            c.clear();
            c.set(Integer.parseInt(ts.substring(0, 4)), Integer.parseInt(ts.substring(5, 7)) - 1,
                    Integer.parseInt(ts.substring(8, 10)), Integer.parseInt(ts.substring(11, 13)),
                    Integer.parseInt(ts.substring(14, 16)), Integer.parseInt(ts.substring(17, 19)));
            long ms = c.getTimeInMillis();
            if (ts.length() > 20 && ts.charAt(19) == '.') {
                String frac = (ts.substring(20).replaceAll("[^0-9].*$", "") + "000").substring(0, 3);
                ms += Integer.parseInt(frac);
            }
            return ms;
        } catch (RuntimeException e) {
            return 0;
        }
    }
}
