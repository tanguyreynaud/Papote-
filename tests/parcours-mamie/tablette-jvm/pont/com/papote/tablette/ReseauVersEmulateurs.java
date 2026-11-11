package com.papote.tablette;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.nio.charset.StandardCharsets;
import java.security.cert.Certificate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import javax.net.ssl.HttpsURLConnection;

/**
 * Le réseau de la tablette pendant l'essai : chaque adresse https que l'appli demande à Firebase est
 * servie par les émulateurs de l'ordinateur (Firestore, comptes, fichiers). L'appli n'est pas modifiée :
 * c'est Java qui ouvre une autre porte derrière la même adresse. Tout le reste d'internet (météo, mises
 * à jour…) est coupé. « coupe » imite une tablette sans réseau.
 */
final class ReseauVersEmulateurs {
    static final String PROJET_APPLI = "papote-famille";
    static volatile String projet = "demo-papote";
    static volatile String firestore = "127.0.0.1:8087";
    static volatile String comptes = "127.0.0.1:9097";
    static volatile String fichiers = "127.0.0.1:9197";
    /** Fonctions serveur appelées en https par la tablette (inscription par QR…) : adresse du banc, ou rien. */
    static volatile String fonctions = "";
    /** true : plus de réseau du tout (comme une box débranchée). */
    static volatile boolean coupe = false;
    /** Adresses demandées par la tablette et refusées (hors Firebase), pour information. */
    static final List<String> refusees = Collections.synchronizedList(new ArrayList<>());
    /** Nombre de demandes servies (lectures et écritures), pour mesurer ce qu'un tour coûte. */
    static final java.util.concurrent.atomic.AtomicInteger demandes = new java.util.concurrent.atomic.AtomicInteger();

    private static boolean installe;

    static synchronized void installer() {
        if (installe) return;
        installe = true;
        URL.setURLStreamHandlerFactory((protocole) -> "https".equals(protocole) ? new URLStreamHandler() {
            @Override protected URLConnection openConnection(URL u) { return new Faux(u); }
            @Override protected URLConnection openConnection(URL u, Proxy p) { return new Faux(u); }
        } : null);
    }

    /** L'adresse de l'émulateur qui répond à la place, ou null si la tablette sort de Firebase. */
    static String cible(URL u) {
        String hote = u.getHost();
        String suite = u.getFile(); // chemin + ?requête
        if ("firestore.googleapis.com".equals(hote)) return "http://" + firestore + versProjet(suite);
        if ("identitytoolkit.googleapis.com".equals(hote) || "securetoken.googleapis.com".equals(hote)) {
            return "http://" + comptes + "/" + hote + suite;
        }
        if ("firebasestorage.googleapis.com".equals(hote)) return "http://" + fichiers + suite;
        if (hote.endsWith("-" + PROJET_APPLI + ".cloudfunctions.net") && !fonctions.isEmpty()) return fonctions + suite;
        return null;
    }

    // Les deux écritures : « projects/x/ » et « projects\/x\/ » (le JSON d'Android écrit les barres ainsi).
    private static String changer(String s, String de, String vers) {
        return s.replace("projects/" + de + "/", "projects/" + vers + "/").replace("projects\\/" + de + "\\/", "projects\\/" + vers + "\\/");
    }
    static String versProjet(String s) { return changer(s, PROJET_APPLI, projet); }
    static String versAppli(String s) { return changer(s, projet, PROJET_APPLI); }

    /** Une connexion « https » qui parle en réalité à un émulateur local. */
    static final class Faux extends HttpsURLConnection {
        private final Map<String, String> entetes = new LinkedHashMap<>();
        private final ByteArrayOutputStream corps = new ByteArrayOutputStream();
        private HttpURLConnection vraie;
        private byte[] reponse;
        private int code = -1;

        Faux(URL u) { super(u); }

        @Override public void setRequestProperty(String k, String v) { entetes.put(k, v); }
        @Override public void addRequestProperty(String k, String v) { entetes.put(k, v); }
        @Override public String getRequestProperty(String k) { return entetes.get(k); }
        @Override public void setFixedLengthStreamingMode(int n) { }
        @Override public void setFixedLengthStreamingMode(long n) { }
        @Override public OutputStream getOutputStream() { return corps; }

        private synchronized void faire() throws IOException {
            if (code != -1) return;
            if (coupe) throw new java.net.UnknownHostException("Unable to resolve host \"" + url.getHost() + "\": No address associated with hostname");
            String cible = cible(url);
            if (cible == null) {
                refusees.add(url.getHost());
                throw new java.net.UnknownHostException("hors du banc d'essai : " + url.getHost());
            }
            demandes.incrementAndGet();
            vraie = (HttpURLConnection) new URL(cible).openConnection(Proxy.NO_PROXY);
            vraie.setConnectTimeout(getConnectTimeout());
            vraie.setReadTimeout(getReadTimeout());
            vraie.setRequestMethod(getRequestMethod());
            for (Map.Entry<String, String> e : entetes.entrySet()) vraie.setRequestProperty(e.getKey(), e.getValue());
            if (getDoOutput()) {
                byte[] envoi = corps.toByteArray();
                String type = String.valueOf(entetes.get("Content-Type"));
                if (type.contains("json")) envoi = versProjet(new String(envoi, StandardCharsets.UTF_8)).getBytes(StandardCharsets.UTF_8);
                vraie.setDoOutput(true);
                vraie.setFixedLengthStreamingMode(envoi.length);
                try (OutputStream out = vraie.getOutputStream()) { out.write(envoi); }
            }
            int c = vraie.getResponseCode();
            InputStream in = c >= 400 ? vraie.getErrorStream() : vraie.getInputStream();
            ByteArrayOutputStream lu = new ByteArrayOutputStream();
            if (in != null) {
                try (InputStream i = in) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = i.read(buf)) > 0) lu.write(buf, 0, n);
                }
            }
            byte[] r = lu.toByteArray();
            String type = String.valueOf(vraie.getContentType());
            if (type.contains("json")) r = versAppli(new String(r, StandardCharsets.UTF_8)).getBytes(StandardCharsets.UTF_8);
            reponse = r;
            code = c;
            if (Boolean.getBoolean("pont.bavard")) {
                System.err.println("RESEAU " + getRequestMethod() + " " + cible + " -> " + c
                        + (getDoOutput() ? "\n   > " + new String(corps.toByteArray(), StandardCharsets.UTF_8).replaceAll("\\s+", " ") : "")
                        + "\n   < " + new String(r, 0, Math.min(r.length, 600), StandardCharsets.UTF_8).replaceAll("\\s+", " "));
            }
        }

        @Override public void connect() throws IOException { faire(); }
        @Override public int getResponseCode() throws IOException { faire(); return code; }
        @Override public InputStream getInputStream() throws IOException {
            faire();
            if (code >= 400) throw new IOException("HTTP " + code + " " + url);
            return new ByteArrayInputStream(reponse);
        }
        @Override public InputStream getErrorStream() { return code >= 400 && reponse != null ? new ByteArrayInputStream(reponse) : null; }
        @Override public Map<String, List<String>> getHeaderFields() {
            try { faire(); } catch (IOException e) { return Collections.emptyMap(); }
            return vraie.getHeaderFields();
        }
        @Override public String getHeaderField(String nom) {
            try { faire(); } catch (IOException e) { return null; }
            return vraie.getHeaderField(nom);
        }
        @Override public String getContentType() { return getHeaderField("Content-Type"); }
        @Override public int getContentLength() { return reponse == null ? -1 : reponse.length; }
        @Override public void disconnect() { if (vraie != null) vraie.disconnect(); }
        @Override public boolean usingProxy() { return false; }
        @Override public String getCipherSuite() { return "TLS_AES_128_GCM_SHA256"; }
        @Override public Certificate[] getLocalCertificates() { return null; }
        @Override public Certificate[] getServerCertificates() { return new Certificate[0]; }
    }

    private ReseauVersEmulateurs() { }
}
