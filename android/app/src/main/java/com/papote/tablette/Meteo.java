package com.papote.tablette;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

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
     * Communes d'un code postal (5 chiffres) : [{nom, detail, lat, lon}], par ordre alphabétique.
     * Service gratuit de l'État (geo.api.gouv.fr), sans clé.
     */
    static JSONArray searchPostcode(Http http, String code) {
        JSONArray out = new JSONArray();
        try {
            Http.Response r = http.request("GET", "https://geo.api.gouv.fr/communes?codePostal=" + code
                    + "&fields=nom,centre,departement&format=json", null, null, null);
            if (!r.ok()) return out;
            JSONArray communes = new JSONArray(r.body);
            List<JSONObject> list = new ArrayList<>();
            for (int i = 0; i < communes.length(); i++) {
                JSONObject c = communes.getJSONObject(i);
                JSONArray xy = c.optJSONObject("centre") == null ? null
                        : c.getJSONObject("centre").optJSONArray("coordinates");
                if (xy == null || xy.length() < 2) continue;
                JSONObject dep = c.optJSONObject("departement");
                list.add(new JSONObject()
                        .put("nom", c.optString("nom"))
                        .put("detail", code + (dep == null ? "" : " · " + dep.optString("nom")))
                        .put("lat", xy.getDouble(1))
                        .put("lon", xy.getDouble(0)));
            }
            Collections.sort(list, (x, y) -> x.optString("nom").compareTo(y.optString("nom")));
            for (JSONObject o : list) out.put(o);
        } catch (Exception e) {
            Log.w(TAG, "Recherche par code postal", e);
        }
        return out;
    }

    /**
     * Communes qui portent ce nom (France d'abord) : [{nom, detail, lat, lon}], au plus 6.
     * Un code postal à 5 chiffres donne toutes ses communes. Service gratuit de l'État (geo.api.gouv.fr).
     */
    static JSONArray search(Http http, String query) {
        JSONArray out = new JSONArray();
        if (query == null || query.trim().length() < 2) return out;
        if (query.trim().matches("\\d{5}")) return searchPostcode(http, query.trim());
        try {
            String url = "https://geo.api.gouv.fr/communes?fields=nom,centre,departement&boost=population&limit=6&format=json&nom="
                    + URLEncoder.encode(query.trim(), "UTF-8");
            Http.Response r = http.request("GET", url, null, null, null);
            if (!r.ok()) return out;
            JSONArray communes = new JSONArray(r.body);
            for (int i = 0; i < communes.length() && out.length() < 6; i++) {
                JSONObject c = communes.getJSONObject(i);
                JSONArray xy = c.optJSONObject("centre") == null ? null
                        : c.getJSONObject("centre").optJSONArray("coordinates");
                if (xy == null || xy.length() < 2) continue;
                JSONObject dep = c.optJSONObject("departement");
                out.put(new JSONObject()
                        .put("nom", c.optString("nom"))
                        .put("detail", dep == null ? "" : dep.optString("nom"))
                        .put("lat", xy.getDouble(1))
                        .put("lon", xy.getDouble(0)));
            }
        } catch (Exception e) {
            Log.w(TAG, "Recherche de la ville", e);
        }
        return out;
    }

    /**
     * Prévisions de MET Norway (institut météo norvégien : gratuit, usage commercial permis,
     * sans compte, licence CC BY 4.0), remises au format attendu par la page :
     * {current:{temperature_2m, weather_code, is_day}, daily:{weather_code[], temperature_2m_max[], temperature_2m_min[]}}
     * avec les codes météo WMO (0 soleil, 3 couvert, 61 pluie…). Aujourd'hui puis demain.
     */
    /** Dernière réponse de MET Norway : adresse et « Last-Modified », pour ne redemander que si ça a changé. */
    private static String lastUrl;
    private static String lastModified;
    private static int lastDay = -1; // jour (Paris) de la dernière lecture complète

    /**
     * null si les prévisions n'ont pas changé depuis la dernière lecture (réponse 304, quelques octets) :
     * MET Norway demande aux clients d'envoyer If-Modified-Since, et ça ménage la carte SIM.
     */
    static JSONObject forecast(Http http, double lat, double lon) throws Exception {
        String url = String.format(java.util.Locale.US,
                "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=%.4f&lon=%.4f", lat, lon);
        java.util.Map<String, String> headers = null;
        int today = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("Europe/Paris")).get(java.util.Calendar.DAY_OF_YEAR);
        // Même ville et même jour seulement : à minuit, « aujourd'hui » change, il faut relire en entier.
        if (lastModified != null && url.equals(lastUrl) && today == lastDay) {
            headers = java.util.Collections.singletonMap("If-Modified-Since", lastModified);
        }
        Http.Response r = http.request("GET", url, null, null, null, headers);
        if (r.code == 304) return null;
        if (!r.ok()) throw new java.io.IOException("Météo HTTP " + r.code);
        JSONObject parsed = parseForecast(r.body);
        lastUrl = url;
        lastDay = today;
        lastModified = r.header("Last-Modified");
        lastBody = r.body;
        return parsed;
    }

    /** Dernière réponse complète de MET Norway (48 h heure par heure), pour rejouer la météo sans réseau. */
    static String lastBody;

    /**
     * Météo de l'heure en cours à partir de la dernière réponse gardée (sans réseau) : la prévision du
     * matin couvre toute la journée, il suffit de la relire pour que « maintenant » suive les heures.
     * null si rien n'est gardé ou si la réponse ne couvre plus aujourd'hui.
     */
    static JSONObject rejouer() {
        if (lastBody == null) return null;
        try {
            return parseForecast(lastBody);
        } catch (Exception e) {
            return null;
        }
    }

    /** Réponse « compact » de MET Norway remise au format de la page. */
    static JSONObject parseForecast(String body) throws Exception {
        JSONArray series = new JSONObject(body).getJSONObject("properties").getJSONArray("timeseries");
        if (series.length() == 0) throw new java.io.IOException("Météo vide");

        java.util.TimeZone paris = java.util.TimeZone.getTimeZone("Europe/Paris");
        java.text.SimpleDateFormat iso = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US);
        iso.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        java.util.Calendar cal = java.util.Calendar.getInstance(paris);
        int today = cal.get(java.util.Calendar.DAY_OF_YEAR);
        cal.add(java.util.Calendar.DAY_OF_YEAR, 1);
        int tomorrow = cal.get(java.util.Calendar.DAY_OF_YEAR);

        double[] max = {-999, -999};
        double[] min = {999, 999};
        String[] noon = {null, null};
        int[] noonGap = {99, 99};
        // « Maintenant » : l'heure de la série la plus proche de l'heure actuelle (la réponse du matin,
        // relue l'après-midi, donne alors la température de l'après-midi, pas celle du matin).
        long nowMs = System.currentTimeMillis();
        int nowIndex = 0;
        long nowGap = Long.MAX_VALUE;
        for (int i = 0; i < series.length(); i++) {
            JSONObject s = series.getJSONObject(i);
            java.util.Calendar t = java.util.Calendar.getInstance(paris);
            t.setTime(iso.parse(s.getString("time")));
            long gapMs = Math.abs(t.getTimeInMillis() - nowMs);
            if (gapMs < nowGap) { nowGap = gapMs; nowIndex = i; }
            int doy = t.get(java.util.Calendar.DAY_OF_YEAR);
            int d = doy == today ? 0 : doy == tomorrow ? 1 : -1;
            if (d < 0) continue;
            JSONObject data = s.getJSONObject("data");
            double temp = data.getJSONObject("instant").getJSONObject("details").optDouble("air_temperature", Double.NaN);
            if (!Double.isNaN(temp)) { max[d] = Math.max(max[d], temp); min[d] = Math.min(min[d], temp); }
            // Le temps de la journée : celui annoncé vers midi.
            String sym = symbol(data, "next_6_hours");
            if (sym == null) sym = symbol(data, "next_1_hours");
            int gap = Math.abs(t.get(java.util.Calendar.HOUR_OF_DAY) - 12);
            if (sym != null && gap < noonGap[d]) { noonGap[d] = gap; noon[d] = sym; }
        }

        if (nowGap > 3 * 3600_000L) throw new java.io.IOException("Météo trop ancienne"); // plus d'heure proche : à relire
        JSONObject first = series.getJSONObject(nowIndex).getJSONObject("data");
        String nowSym = symbol(first, "next_1_hours");
        if (nowSym == null) nowSym = symbol(first, "next_6_hours");
        double nowTemp = first.getJSONObject("instant").getJSONObject("details").optDouble("air_temperature", 0);
        if (max[0] < -900) { max[0] = nowTemp; min[0] = nowTemp; }
        if (max[1] < -900) { max[1] = max[0]; min[1] = min[0]; }
        if (noon[0] == null) noon[0] = nowSym;
        if (noon[1] == null) noon[1] = noon[0];
        int hour = java.util.Calendar.getInstance(paris).get(java.util.Calendar.HOUR_OF_DAY);
        boolean isDay = nowSym != null ? !nowSym.endsWith("_night") : hour >= 7 && hour < 20;

        return new JSONObject()
                .put("current", new JSONObject()
                        .put("temperature_2m", nowTemp)
                        .put("weather_code", wmo(nowSym))
                        .put("is_day", isDay ? 1 : 0))
                .put("daily", new JSONObject()
                        .put("weather_code", new JSONArray().put(wmo(noon[0])).put(wmo(noon[1])))
                        .put("temperature_2m_max", new JSONArray().put(max[0]).put(max[1]))
                        .put("temperature_2m_min", new JSONArray().put(min[0]).put(min[1])));
    }

    private static String symbol(JSONObject data, String period) {
        JSONObject p = data.optJSONObject(period);
        JSONObject s = p == null ? null : p.optJSONObject("summary");
        return s == null ? null : s.optString("symbol_code", null);
    }

    /** Symbole MET Norway (« partlycloudy_day », « lightrainshowers_night »…) vers code WMO. */
    static int wmo(String symbol) {
        if (symbol == null) return 3;
        String s = symbol.replaceAll("_(day|night|polartwilight)$", "");
        if (s.contains("thunder")) return 95;
        switch (s) {
            case "clearsky": return 0;
            case "fair": return 1;
            case "partlycloudy": return 2;
            case "cloudy": return 3;
            case "fog": return 45;
            case "lightrain": return 61;
            case "rain": return 63;
            case "heavyrain": return 65;
            case "lightrainshowers": return 80;
            case "rainshowers": return 81;
            case "heavyrainshowers": return 82;
            case "lightsnow": return 71;
            case "snow": return 73;
            case "heavysnow": return 75;
            case "lightsnowshowers": return 85;
            case "snowshowers": case "heavysnowshowers": return 86;
            default:
                if (s.contains("sleet")) return 68; // pluie et neige mêlées
                return 3;
        }
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
