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

    /** Adresse d'un fichier téléchargé (photo ou message vocal). */
    static String mediaUrl(String fileName) {
        return ORIGIN + "/photos/" + fileName;
    }

    /** Renvoie la ressource locale, ou null pour laisser passer la requête vers internet. */
    static WebResourceResponse intercept(Context context, Uri url) {
        if (url == null || !HOST.equals(url.getHost())) return null;
        String path = url.getPath();
        if (path == null || path.contains("..")) return null;
        try {
            if (path.startsWith("/photos/")) {
                File f = new File(new File(context.getFilesDir(), "photos"), path.substring("/photos/".length()));
                return new WebResourceResponse(mime(f.getName()), null, new FileInputStream(f));
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
        if (name.endsWith(".jpg")) return "image/jpeg";
        if (name.endsWith(".m4a")) return "audio/mp4";
        if (name.endsWith(".mp3")) return "audio/mpeg";
        if (name.endsWith(".webm")) return "audio/webm";
        if (name.endsWith(".ogg")) return "audio/ogg";
        return "application/octet-stream";
    }
}
