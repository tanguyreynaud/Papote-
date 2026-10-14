package com.papote.tablette;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;

/**
 * Ville de la météo. Choisie à l'installation (écran Bienvenue ou script d'installation), puis
 * modifiable par la famille : families/{fid}.meteoVille = {nom, lat, lon} (lat/lon facultatifs,
 * retrouvés d'après le nom). Le réglage de la famille l'emporte ; la tablette garde la dernière
 * ville connue pour tenir sans internet.
 */
final class Meteo {
    private static final String TAG = "PapoteMeteo";

    private Meteo() { }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences("papote", Context.MODE_PRIVATE);
    }

    static String name(Context c) { return prefs(c).getString("meteoNom", ""); }

    static boolean hasCity(Context c) { return prefs(c).contains("meteoLat"); }

    static double lat(Context c) { return Double.parseDouble(prefs(c).getString("meteoLat", "0")); }

    static double lon(Context c) { return Double.parseDouble(prefs(c).getString("meteoLon", "0")); }

    /** Étape « météo » de l'écran Bienvenue faite (ville choisie ou étape passée). */
    static boolean done(Context c) { return hasCity(c) || prefs(c).getBoolean("meteoPassee", false); }

    static void skip(Context c) { prefs(c).edit().putBoolean("meteoPassee", true).apply(); }

    /** Enregistre la ville ; vrai si elle a changé. */
    static boolean save(Context c, String name, double lat, double lon) {
        SharedPreferences p = prefs(c);
        String la = String.valueOf(lat);
        String lo = String.valueOf(lon);
        if (name.equals(p.getString("meteoNom", null)) && la.equals(p.getString("meteoLat", null))
                && lo.equals(p.getString("meteoLon", null))) return false;
        p.edit().putString("meteoNom", name).putString("meteoLat", la).putString("meteoLon", lo).apply();
        return true;
    }

    static void forget(Context c) {
        prefs(c).edit().remove("meteoNom").remove("meteoLat").remove("meteoLon").remove("meteoPassee").apply();
    }

    /**
     * Communes qui portent ce nom (France d'abord) : [{nom, detail, lat, lon}], au plus 6.
     * Service gratuit d'Open-Meteo, le même que pour la météo.
     */
    static JSONArray search(Http http, String query) {
        JSONArray out = new JSONArray();
        if (query == null || query.trim().length() < 2) return out;
        try {
            String url = "https://geocoding-api.open-meteo.com/v1/search?count=10&language=fr&format=json&name="
                    + URLEncoder.encode(query.trim(), "UTF-8");
            Http.Response r = http.request("GET", url, null, null, null);
            if (!r.ok()) return out;
            JSONArray results = new JSONObject(r.body).optJSONArray("results");
            if (results == null) return out;
            JSONArray fr = new JSONArray();
            JSONArray other = new JSONArray();
            for (int i = 0; i < results.length(); i++) {
                JSONObject g = results.getJSONObject(i);
                String detail = join(g.optString("admin2", ""), g.optString("admin1", ""));
                if (!"FR".equals(g.optString("country_code"))) detail = join(detail, g.optString("country", ""));
                JSONObject item = new JSONObject()
                        .put("nom", g.optString("name"))
                        .put("detail", detail)
                        .put("lat", g.optDouble("latitude"))
                        .put("lon", g.optDouble("longitude"));
                ("FR".equals(g.optString("country_code")) ? fr : other).put(item);
            }
            for (int i = 0; i < fr.length() && out.length() < 6; i++) out.put(fr.get(i));
            for (int i = 0; i < other.length() && out.length() < 6; i++) out.put(other.get(i));
        } catch (Exception e) {
            Log.w(TAG, "Recherche de la ville", e);
        }
        return out;
    }

    private static String join(String a, String b) {
        if (a == null || a.isEmpty()) return b == null ? "" : b;
        if (b == null || b.isEmpty() || b.equals(a)) return a;
        return a + ", " + b;
    }

    /**
     * Ville réglée par la famille ({nom, lat?, lon?}). Retrouve les coordonnées d'après le nom si
     * besoin. Vrai si la ville de la tablette a changé.
     */
    static boolean applyFamily(Context c, Http http, JSONObject ff) {
        JSONObject v = ff == null ? null : ff.optJSONObject("meteoVille");
        JSONObject vf = v == null || v.optJSONObject("mapValue") == null ? null
                : v.optJSONObject("mapValue").optJSONObject("fields");
        if (vf == null) return false;
        String name = Firebase.str(vf, "nom");
        if (name == null || name.trim().isEmpty()) return false;
        name = name.trim();
        Double lat = number(vf, "lat");
        Double lon = number(vf, "lon");
        if (lat == null || lon == null) {
            // Même nom que la ville en cours : rien à chercher.
            if (name.equals(name(c)) && hasCity(c)) return false;
            JSONArray found = search(http, name);
            if (found.length() == 0) return false;
            JSONObject first = found.optJSONObject(0);
            lat = first.optDouble("lat");
            lon = first.optDouble("lon");
        }
        return save(c, name, lat, lon);
    }

    private static Double number(JSONObject fields, String key) {
        JSONObject v = fields.optJSONObject(key);
        if (v == null) return null;
        if (v.has("doubleValue")) return v.optDouble("doubleValue");
        if (v.has("integerValue")) {
            try { return Double.parseDouble(v.optString("integerValue")); } catch (NumberFormatException e) { return null; }
        }
        return null;
    }
}
