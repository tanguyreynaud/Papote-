package com.papote.tablette;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;

/**
 * Sert l'écran (assets/) et les photos téléchargées sous une adresse https locale.
 * Une vraie origine https est nécessaire pour la caméra, le micro et le stockage du navigateur.
 */
final class LocalContent {
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;
    static final String PAGE = ORIGIN + "/tablette.html";

    private LocalContent() { }

    static String photoUrl(String id) {
        return ORIGIN + "/photos/" + id + ".jpg";
    }

    /** Renvoie la ressource locale, ou null pour laisser passer la requête vers internet. */
    static WebResourceResponse intercept(Context context, Uri url) {
        if (url == null || !HOST.equals(url.getHost())) return null;
        String path = url.getPath();
        if (path == null || path.contains("..")) return null;
        try {
            if (path.startsWith("/photos/")) {
                File f = new File(new File(context.getFilesDir(), "photos"), path.substring("/photos/".length()));
                return new WebResourceResponse("image/jpeg", null, new FileInputStream(f));
            }
            String asset = path.startsWith("/") ? path.substring(1) : path;
            return new WebResourceResponse(mime(asset), "utf-8", context.getAssets().open(asset));
        } catch (IOException e) {
            return null;
        }
    }

    private static String mime(String name) {
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".js")) return "text/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }
}
