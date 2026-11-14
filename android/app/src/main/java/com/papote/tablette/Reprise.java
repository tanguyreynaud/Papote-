package com.papote.tablette;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;

/**
 * Téléchargement qui reprend là où il s'est arrêté (audit réseau du 11/11, RM5, décision de Tanguy du 12/11).
 *
 * Avant : une vidéo de 9 Mo ou l'APK (3 Mo) coupé à 90 % par la 4G était repris de zéro à chaque essai, sur le
 * forfait de la carte SIM. Maintenant la partie reçue est gardée (<fichier>.part, avec <fichier>.part.info :
 * adresse, validateur ETag/Last-Modified, taille totale, empreinte MD5 annoncée) et le reste est demandé avec
 * « Range: bytes=N- » et « If-Range » :
 *   - 206 qui commence bien à N : la suite est ajoutée ;
 *   - 200 (serveur qui ignore Range, ou fichier changé depuis : If-Range) : on repart de zéro, en entier ;
 *   - 416 : la partie gardée est déjà complète (taille connue), sinon on repart de zéro au prochain essai.
 * Avant d'utiliser le fichier : taille = taille annoncée, et MD5 = celle du serveur quand il la donne
 * (x-goog-hash de Google Cloud Storage, donc Firebase Storage). L'APK garde en plus son SHA-256 (Updater).
 * Serveurs vérifiés le 12/11 : raw.githubusercontent.com (APK) et storage.googleapis.com répondent 206.
 * Au plus 3 essais par jour et par fichier (essaiPermis / noterEssai), pour ne pas vider le forfait.
 * Sans Android : essayé par RepriseTest, avec un faux serveur qui coupe au milieu du fichier.
 */
final class Reprise {
    static final int ESSAIS_PAR_JOUR = 3;

    private Reprise() { }

    /** Ouvre la connexion (la tablette y ajoute ses en-têtes : App Check, délais). */
    interface Ouvreur {
        HttpURLConnection ouvrir(URL url) throws IOException;
    }

    /** Fichier plus gros que permis : refusé pour de bon. */
    static final class TropGros extends IOException {
        TropGros(String message) { super(message); }
    }

    static final class Resultat {
        final File fichier;
        /** Une partie venait d'un essai précédent. */
        final boolean repris;

        Resultat(File fichier, boolean repris) {
            this.fichier = fichier;
            this.repris = repris;
        }
    }

    static File partie(File cible) { return new File(cible.getPath() + ".part"); }

    static File info(File cible) { return new File(cible.getPath() + ".part.info"); }

    /** Efface ce qui reste d'un téléchargement (partie et informations). */
    static void oublier(File cible) {
        partie(cible).delete();
        info(cible).delete();
    }

    /** Télécharge url dans cible, en reprenant la partie déjà reçue si c'est le même fichier. */
    static Resultat telecharger(String url, File cible, long max, Ouvreur ouvreur) throws IOException {
        File partie = partie(cible);
        File infoF = info(cible);
        String[] info = lireInfo(infoF); // url, validateur, total, md5
        long deja = partie.exists() && info != null && url.equals(info[0]) ? partie.length() : 0;
        if (deja == 0) {
            oublier(cible);
            info = null;
        }
        HttpURLConnection c = ouvreur.ouvrir(new URL(url));
        if (deja > 0) {
            c.setRequestProperty("Range", "bytes=" + deja + "-");
            if (!info[1].isEmpty()) c.setRequestProperty("If-Range", info[1]);
        }
        try {
            int code = c.getResponseCode();
            boolean ajout;
            long total;
            if (code == 206 && deja > 0) {
                long[] cr = contentRange(c.getHeaderField("Content-Range"));
                if (cr == null || cr[0] != deja) {
                    oublier(cible); // morceau inattendu : tout sera redemandé au prochain essai
                    throw new IOException("Reprise refusée (" + c.getHeaderField("Content-Range") + ")");
                }
                total = cr[2];
                ajout = true;
            } else if (code == 200) {
                total = c.getContentLengthLong();
                ajout = false;
                deja = 0;
            } else if (code == 416 && deja > 0) {
                long connu = parseLong(info[2]);
                if (connu > 0 && connu == deja) return terminer(cible, partie, connu, info[3], true);
                oublier(cible);
                throw new IOException("HTTP 416");
            } else {
                throw new IOException("HTTP " + code);
            }
            if (total > max) {
                oublier(cible);
                throw new TropGros("Fichier trop gros (" + total + " octets)");
            }
            String validateur = c.getHeaderField("ETag");
            if (validateur == null || validateur.startsWith("W/")) validateur = c.getHeaderField("Last-Modified");
            String md5 = md5Annonce(c.getHeaderFields());
            if (ajout && md5.isEmpty() && info != null) md5 = info[3];
            if (ajout && total < 0 && info != null) total = parseLong(info[2]);
            ecrireInfo(infoF, url, validateur == null ? "" : validateur, total, md5);
            InputStream in = c.getInputStream();
            // Sans tampon : chaque morceau reçu est sur le disque, même si la 4G coupe juste après.
            FileOutputStream out = new FileOutputStream(partie, ajout);
            try {
                byte[] buf = new byte[64 * 1024];
                long recu = deja;
                int n;
                while ((n = in.read(buf)) > 0) {
                    recu += n;
                    if (recu > max) {
                        out.close();
                        oublier(cible);
                        throw new TropGros("Fichier trop gros (plus de " + max + " octets)");
                    }
                    out.write(buf, 0, n);
                }
            } finally {
                out.close();
                in.close();
            }
            return terminer(cible, partie, total, md5, ajout);
        } catch (IOException e) {
            c.disconnect(); // connexion douteuse : pas réutilisée ; la partie reçue reste
            throw e;
        }
    }

    private static Resultat terminer(File cible, File partie, long total, String md5, boolean repris) throws IOException {
        if (total >= 0 && partie.length() != total) {
            // Le serveur a fermé avant la fin sans erreur : la partie reste, la suite au prochain essai.
            throw new IOException("Fichier incomplet (" + partie.length() + " sur " + total + " octets)");
        }
        if (!md5.isEmpty() && !md5.equals(md5(partie))) {
            oublier(cible); // fichier abîmé : redemandé en entier au prochain essai
            throw new IOException("Empreinte du fichier incorrecte");
        }
        cible.delete();
        if (!partie.renameTo(cible)) throw new IOException("Renommage " + cible.getName());
        info(cible).delete();
        return new Resultat(cible, repris);
    }

    /** « bytes 100-199/3000 » → {100, 199, 3000} ; total « * » → -1. Null si illisible. */
    static long[] contentRange(String v) {
        if (v == null) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)").matcher(v.trim());
        if (!m.matches()) return null;
        return new long[] {Long.parseLong(m.group(1)), Long.parseLong(m.group(2)),
                "*".equals(m.group(3)) ? -1 : Long.parseLong(m.group(3))};
    }

    /** MD5 annoncée par Google Cloud Storage (x-goog-hash: md5=…), en hexadécimal ; "" sinon. */
    static String md5Annonce(Map<String, List<String>> headers) {
        if (headers == null) return "";
        for (Map.Entry<String, List<String>> h : headers.entrySet()) {
            if (h.getKey() == null || !"x-goog-hash".equalsIgnoreCase(h.getKey()) || h.getValue() == null) continue;
            for (String v : h.getValue()) {
                for (String part : v.split(",")) {
                    String p = part.trim();
                    if (!p.startsWith("md5=")) continue;
                    try {
                        return hex(java.util.Base64.getDecoder().decode(p.substring(4)));
                    } catch (IllegalArgumentException e) {
                        return "";
                    }
                }
            }
        }
        return "";
    }

    static String md5(File f) throws IOException {
        try {
            MessageDigest d = MessageDigest.getInstance("MD5");
            InputStream in = new FileInputStream(f);
            try {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) d.update(buf, 0, n);
            } finally {
                in.close();
            }
            return hex(d.digest());
        } catch (java.security.NoSuchAlgorithmException e) {
            return "";
        }
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    private static long parseLong(String s) {
        try {
            return Long.parseLong(s);
        } catch (Exception e) {
            return -1;
        }
    }

    private static String[] lireInfo(File f) {
        try {
            if (!f.exists()) return null;
            String[] l = new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8).split("\n", -1);
            return l.length >= 4 ? new String[] {l[0], l[1], l[2], l[3]} : null;
        } catch (IOException e) {
            return null;
        }
    }

    private static void ecrireInfo(File f, String url, String validateur, long total, String md5) throws IOException {
        String s = url + "\n" + validateur.replace("\n", "") + "\n" + total + "\n" + md5;
        java.nio.file.Files.write(f.toPath(), s.getBytes(StandardCharsets.UTF_8));
    }

    // ---------- Au plus 3 essais par jour et par fichier ----------
    // etat : « 2026-11-12|2 » (jour, essais ce jour-là), gardé par la tablette ; null ou autre jour = 0.

    static boolean essaiPermis(String etat, String jour) {
        return essais(etat, jour) < ESSAIS_PAR_JOUR;
    }

    static String noterEssai(String etat, String jour) {
        return jour + "|" + (essais(etat, jour) + 1);
    }

    private static int essais(String etat, String jour) {
        if (etat == null || !etat.startsWith(jour + "|")) return 0;
        try {
            return Integer.parseInt(etat.substring(jour.length() + 1));
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
