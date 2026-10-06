package com.papote.tablette;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;

/**
 * Accès à Firebase par ses API REST : connexion anonyme et Firestore.
 * Pas de SDK Firebase, pour fonctionner aussi sur Android 4.4.
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

    // ---------- Connexion anonyme ----------

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
            // Jeton refusé (compte supprimé) : on repart sur un nouveau compte anonyme.
        }
        Http.Response r = http.request("POST",
                "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + API_KEY,
                "application/json", "{\"returnSecureToken\":true}", null);
        if (!r.ok()) throw new ApiException(r.code, r.body);
        JSONObject j = new JSONObject(r.body);
        remember(j.getString("idToken"), j.getString("refreshToken"),
                j.getString("localId"), j.optLong("expiresIn", 3600));
        return idToken;
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
