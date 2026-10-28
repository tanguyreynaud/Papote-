package com.papote.tablette;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;

import javax.net.ssl.HttpsURLConnection;

/** Petit client HTTPS (GET/POST) basé sur HttpsURLConnection, disponible depuis Android 1. */
final class Http {
    static final class Response {
        final int code;
        final String body;
        /** En-têtes de la réponse, noms en minuscules (header("Last-Modified")). */
        final java.util.Map<String, String> headers;

        Response(int code, String body) {
            this(code, body, java.util.Collections.<String, String>emptyMap());
        }

        Response(int code, String body, java.util.Map<String, String> headers) {
            this.code = code;
            this.body = body;
            this.headers = headers;
        }

        String header(String name) {
            return headers.get(name.toLowerCase(java.util.Locale.ROOT));
        }

        boolean ok() {
            return code >= 200 && code < 300;
        }
    }

    private final Context context;

    Http(Context context) {
        this.context = context.getApplicationContext();
    }

    Response request(String method, String url, String contentType, String body, String bearer) throws IOException {
        return request(method, url, contentType, body, bearer, null);
    }

    /** Même chose, avec des en-têtes en plus (If-Modified-Since…). */
    Response request(String method, String url, String contentType, String body, String bearer,
                     java.util.Map<String, String> extraHeaders) throws IOException {
        HttpsURLConnection c = (HttpsURLConnection) new URL(url).openConnection();
        if (extraHeaders != null) {
            for (java.util.Map.Entry<String, String> h : extraHeaders.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
        }
        c.setConnectTimeout(20_000);
        c.setReadTimeout(30_000);
        c.setRequestMethod(method);
        c.setRequestProperty("Accept", "application/json");
        // MET Norway (météo) refuse les appels sans nom d'application ni contact.
        c.setRequestProperty("User-Agent", "Papote (+https://mapapote.fr)");
        if (bearer != null) c.setRequestProperty("Authorization", "Bearer " + bearer);
        AppCheck.addHeader(context, c, url);
        try {
            if (body != null) {
                byte[] bytes = body.getBytes("UTF-8");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", contentType);
                c.setFixedLengthStreamingMode(bytes.length);
                OutputStream out = c.getOutputStream();
                try {
                    out.write(bytes);
                } finally {
                    out.close();
                }
            }
            int code = c.getResponseCode();
            java.util.Map<String, String> headers = new java.util.HashMap<>();
            for (java.util.Map.Entry<String, java.util.List<String>> h : c.getHeaderFields().entrySet()) {
                if (h.getKey() != null && h.getValue() != null && !h.getValue().isEmpty()) {
                    headers.put(h.getKey().toLowerCase(java.util.Locale.ROOT), h.getValue().get(0));
                }
            }
            // 304 « pas modifié » : pas de corps.
            InputStream in = code == 304 ? null : code >= 400 ? c.getErrorStream() : c.getInputStream();
            return new Response(code, in == null ? "" : readAll(in), headers);
        } catch (IOException e) {
            c.disconnect(); // connexion douteuse : pas réutilisée
            throw e;
        }
        // Corps lu jusqu'au bout et fermé, sans disconnect() : Android garde la connexion ouverte
        // quelques minutes et les requêtes suivantes du même tour évitent une nouvelle poignée de
        // main TLS (fil réseau, 28/10 : ~ −40 % de données au repos sur la SIM).
    }

    /** Envoi de données binaires (message vocal vers Firebase Storage). */
    Response upload(String url, String contentType, byte[] bytes, String bearer) throws IOException {
        HttpsURLConnection c = (HttpsURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20_000);
        c.setReadTimeout(60_000);
        c.setRequestMethod("POST");
        c.setRequestProperty("Accept", "application/json");
        if (bearer != null) c.setRequestProperty("Authorization", "Bearer " + bearer);
        AppCheck.addHeader(context, c, url);
        try {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", contentType);
            c.setFixedLengthStreamingMode(bytes.length);
            OutputStream out = c.getOutputStream();
            try {
                out.write(bytes);
            } finally {
                out.close();
            }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            return new Response(code, in == null ? "" : readAll(in));
        } catch (IOException e) {
            c.disconnect();
            throw e;
        }
    }

    private static String readAll(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } finally {
            in.close();
        }
    }
}
