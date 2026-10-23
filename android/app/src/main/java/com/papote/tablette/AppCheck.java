package com.papote.tablette;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;

import javax.net.ssl.HttpsURLConnection;

/**
 * Jeton App Check de la tablette : prouve à Firebase que les requêtes viennent d'une vraie tablette
 * Papote. La clé propre à chaque tablette est posée à l'installation (installer-tablette.ps1,
 * prefs « appCheckKey ») ; la fonction jetonAppCheck l'échange contre un jeton valable 1 heure.
 * Sans clé ou sans jeton, tout continue comme avant (rien n'est encore exigé côté serveur).
 */
final class AppCheck {
    private static final String TAG = "PapoteAppCheck";
    private static final String URL_JETON = "https://europe-west1-papote-famille.cloudfunctions.net/jetonAppCheck";
    private static final long MARGE_MS = 5 * 60_000;      // nouveau jeton 5 min avant la fin
    private static final long ATTENTE_ECHEC_MS = 10 * 60_000;

    private static String token;
    private static long expire;
    private static long prochainEssai;

    private AppCheck() { }

    static void saveKey(Context c, String key) {
        c.getApplicationContext().getSharedPreferences("papote", Context.MODE_PRIVATE)
                .edit().putString("appCheckKey", key).apply();
        synchronized (AppCheck.class) {
            token = null;
            expire = 0;
            prochainEssai = 0;
        }
    }

    static boolean hasKey(Context c) {
        String k = key(c);
        return k != null && !k.isEmpty();
    }

    private static String key(Context c) {
        return c.getApplicationContext().getSharedPreferences("papote", Context.MODE_PRIVATE)
                .getString("appCheckKey", null);
    }

    /** Adresses qui reçoivent l'en-tête X-Firebase-AppCheck (pas l'authentification ni la fonction du jeton). */
    static boolean concerne(String url) {
        if (url == null || url.startsWith(URL_JETON)) return false;
        // Hôte comparé exactement (audit du 23/10) : une adresse piégée dans un envoi, du genre
        // https://pirate.example/x.run.app/photo.jpg, ne doit pas recevoir le jeton.
        String host;
        try {
            URL u = new URL(url);
            if (!"https".equals(u.getProtocol())) return false;
            host = u.getHost().toLowerCase(java.util.Locale.ROOT);
        } catch (Exception e) {
            return false;
        }
        return host.equals("firestore.googleapis.com")
                || host.equals("firebasestorage.googleapis.com")
                || host.endsWith(".cloudfunctions.net")
                || host.endsWith(".run.app");
    }

    /** Jeton d'identité Firebase du compte de la tablette (Sync), envoyé à jetonAppCheck. */
    interface IdToken { String get() throws Exception; }
    private static IdToken idToken;

    static void setIdToken(IdToken source) {
        idToken = source;
    }

    /** Jeton en cours, ou null (pas de clé, service injoignable). Fait un appel réseau si besoin : hors fil principal. */
    static synchronized JSONObject current(Context c) {
        long now = System.currentTimeMillis();
        if (token != null && now < expire - MARGE_MS) return result();
        String k = key(c);
        if (k == null || k.isEmpty() || now < prochainEssai) return token != null && now < expire ? result() : null;
        try {
            HttpsURLConnection h = (HttpsURLConnection) new URL(URL_JETON).openConnection();
            h.setConnectTimeout(15_000);
            h.setReadTimeout(20_000);
            h.setRequestMethod("POST");
            h.setDoOutput(true);
            h.setRequestProperty("Content-Type", "application/json");
            // Prouve le compte de la tablette : le serveur relie la clé à ce compte (liaison tablette →
            // commande par n° de série, PR #213). Sans compte encore, la requête part sans.
            if (idToken != null) {
                try {
                    String id = idToken.get();
                    if (id != null) h.setRequestProperty("Authorization", "Bearer " + id);
                } catch (Exception e) {
                    Log.w(TAG, "Jeton d'identité pour App Check", e);
                }
            }
            byte[] body = new JSONObject().put("cle", k).toString().getBytes("UTF-8");
            h.setFixedLengthStreamingMode(body.length);
            try {
                OutputStream out = h.getOutputStream();
                try { out.write(body); } finally { out.close(); }
                int code = h.getResponseCode();
                if (code != 200) {
                    prochainEssai = now + ATTENTE_ECHEC_MS;
                    Journal.log(c, "App Check : jeton refusé (HTTP " + code + ")");
                    return null;
                }
                InputStream in = h.getInputStream();
                java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
                byte[] b = new byte[4096];
                int n;
                while ((n = in.read(b)) > 0) buf.write(b, 0, n);
                in.close();
                JSONObject r = new JSONObject(buf.toString("UTF-8"));
                token = r.getString("token");
                expire = r.optLong("expireTimeMillis", now + 3600_000L);
                return result();
            } finally {
                h.disconnect();
            }
        } catch (Exception e) {
            prochainEssai = now + ATTENTE_ECHEC_MS;
            Log.w(TAG, "Jeton App Check", e);
            return null;
        }
    }

    private static JSONObject result() {
        try {
            return new JSONObject().put("token", token).put("expireTimeMillis", expire);
        } catch (Exception e) {
            return null;
        }
    }

    /** Ajoute l'en-tête App Check à une requête vers Firebase, si un jeton est disponible. */
    static void addHeader(Context c, HttpsURLConnection h, String url) {
        if (!concerne(url)) return;
        JSONObject t = current(c);
        if (t != null) h.setRequestProperty("X-Firebase-AppCheck", t.optString("token"));
    }
}
