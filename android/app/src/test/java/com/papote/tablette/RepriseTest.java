package com.papote.tablette;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Random;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * Reprise des téléchargements (RM5) avec un faux serveur sur l'ordinateur : il coupe au milieu du fichier,
 * respecte ou ignore « Range », change le fichier entre deux essais, annonce une empreinte. Sans tablette.
 */
public class RepriseTest {
    private ServerSocket serveur;
    private Thread fil;
    private byte[] contenu;
    private String etag = "\"v1\"";
    /** Octets envoyés au plus par réponse avant de couper (-1 : tout). */
    private volatile long couperApres = -1;
    private volatile boolean ignorerRange;
    private volatile boolean annoncerMd5 = true;
    private volatile String md5Annonce; // null : la vraie
    private final List<String> ranges = new ArrayList<>();
    private long octetsEnvoyes;
    private File dossier;

    @Before
    public void demarrer() throws Exception {
        contenu = new byte[1_000_000];
        new Random(7).nextBytes(contenu);
        dossier = Files.createTempDirectory("reprise").toFile();
        // Petit serveur HTTP/1.1 fait main (une requête par connexion) : il peut couper au milieu d'un envoi.
        serveur = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        fil = new Thread(() -> {
            while (!serveur.isClosed()) {
                try (Socket s = serveur.accept()) {
                    repondre(s);
                } catch (IOException ignore) { }
            }
        });
        fil.setDaemon(true);
        fil.start();
    }

    @After
    public void arreter() throws IOException {
        serveur.close();
        for (File f : dossier.listFiles()) f.delete();
        dossier.delete();
    }

    private void repondre(Socket s) throws IOException {
        java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(s.getInputStream(), "ISO-8859-1"));
        String ligne = r.readLine();
        if (ligne == null) return;
        String range = null;
        String ifRange = null;
        while ((ligne = r.readLine()) != null && !ligne.isEmpty()) {
            int i = ligne.indexOf(':');
            if (i < 0) continue;
            String nom = ligne.substring(0, i).trim().toLowerCase();
            String val = ligne.substring(i + 1).trim();
            if (nom.equals("range")) range = val;
            if (nom.equals("if-range")) ifRange = val;
        }
        synchronized (ranges) { ranges.add(range == null ? "-" : range); }
        OutputStream out = s.getOutputStream();
        StringBuilder h = new StringBuilder();
        long debut = 0;
        boolean partiel = false;
        if (range != null && !ignorerRange && (ifRange == null || ifRange.equals(etag))) {
            debut = Long.parseLong(range.replace("bytes=", "").replace("-", ""));
            if (debut >= contenu.length) {
                out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + contenu.length
                        + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes("ISO-8859-1"));
                out.flush();
                return;
            }
            partiel = true;
        }
        long longueur = contenu.length - debut;
        h.append(partiel ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
        h.append("ETag: ").append(etag).append("\r\nAccept-Ranges: bytes\r\n");
        if (annoncerMd5) {
            h.append("x-goog-hash: crc32c=AAAAAA==\r\n");
            h.append("x-goog-hash: md5=").append(md5Annonce != null ? md5Annonce : md5b64(contenu)).append("\r\n");
        }
        if (partiel) h.append("Content-Range: bytes ").append(debut).append('-').append(contenu.length - 1).append('/').append(contenu.length).append("\r\n");
        h.append("Content-Length: ").append(longueur).append("\r\nConnection: close\r\n\r\n");
        out.write(h.toString().getBytes("ISO-8859-1"));
        long aEnvoyer = couperApres < 0 ? longueur : Math.min(longueur, couperApres);
        out.write(contenu, (int) debut, (int) aEnvoyer);
        out.flush();
        synchronized (ranges) { octetsEnvoyes += aEnvoyer; }
        // Moins que annoncé : la 4G a coupé, la connexion se ferme sans le reste.
    }

    private static String md5b64(byte[] b) {
        try {
            return Base64.getEncoder().encodeToString(MessageDigest.getInstance("MD5").digest(b));
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private String url() { return "http://127.0.0.1:" + serveur.getLocalPort() + "/video.mp4"; }

    private static final Reprise.Ouvreur OUVREUR = (u) -> {
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setConnectTimeout(5000);
        c.setReadTimeout(5000);
        return c;
    };

    private Reprise.Resultat essai(File cible) throws IOException {
        return Reprise.telecharger(url(), cible, 30L << 20, OUVREUR);
    }

    @Test
    public void coupeAuMilieuPuisRepriseSansRedemanderLeDebut() throws Exception {
        File cible = new File(dossier, "v.mp4");
        couperApres = 400_000;
        try {
            essai(cible);
            fail("la coupure doit faire échouer le premier essai");
        } catch (IOException attendu) { }
        assertFalse("pas de fichier final tant qu'il est incomplet", cible.exists());
        assertEquals(400_000, Reprise.partie(cible).length());
        couperApres = -1;
        octetsEnvoyes = 0;
        Reprise.Resultat r = essai(cible);
        assertTrue(r.repris);
        assertArrayEquals(contenu, Files.readAllBytes(cible.toPath()));
        assertEquals("seule la suite est envoyée", 600_000, octetsEnvoyes);
        assertEquals("bytes=400000-", ranges.get(1));
        assertFalse(Reprise.partie(cible).exists());
        assertFalse(Reprise.info(cible).exists());
    }

    @Test
    public void troisCoupuresDeSuiteLeFichierArriveQuandMeme() throws Exception {
        File cible = new File(dossier, "v.mp4");
        couperApres = 300_000;
        for (int i = 0; i < 3; i++) {
            try { essai(cible); } catch (IOException attendu) { }
        }
        assertEquals(900_000, Reprise.partie(cible).length());
        couperApres = -1;
        assertArrayEquals(contenu, Files.readAllBytes(essai(cible).fichier.toPath()));
    }

    @Test
    public void serveurQuiIgnoreRangeOnRepartDeZeroEnEntier() throws Exception {
        File cible = new File(dossier, "v.mp4");
        couperApres = 500_000;
        try { essai(cible); } catch (IOException attendu) { }
        ignorerRange = true; // répond 200 avec tout le fichier
        couperApres = -1;
        Reprise.Resultat r = essai(cible);
        assertFalse(r.repris);
        assertArrayEquals("pas de doublon du début", contenu, Files.readAllBytes(cible.toPath()));
    }

    @Test
    public void fichierChangeEntreDeuxEssaisIfRangeRedonneToutLeFichier() throws Exception {
        File cible = new File(dossier, "v.mp4");
        couperApres = 500_000;
        try { essai(cible); } catch (IOException attendu) { }
        new Random(99).nextBytes(contenu); // nouvelle version sur le serveur
        etag = "\"v2\"";
        couperApres = -1;
        Reprise.Resultat r = essai(cible);
        assertFalse(r.repris);
        assertArrayEquals(contenu, Files.readAllBytes(cible.toPath()));
    }

    @Test
    public void empreinteFausseLeFichierNEstPasUtiliseEtToutEstEfface() throws Exception {
        File cible = new File(dossier, "v.mp4");
        md5Annonce = md5b64(new byte[] {1, 2, 3});
        try {
            essai(cible);
            fail("empreinte fausse : refusé");
        } catch (IOException attendu) { }
        assertFalse(cible.exists());
        assertFalse("tout sera redemandé", Reprise.partie(cible).exists());
    }

    @Test
    public void sansEmpreinteAnnonceeLaTailleSuffit() throws Exception {
        File cible = new File(dossier, "v.mp4");
        annoncerMd5 = false;
        couperApres = 123_456;
        try { essai(cible); } catch (IOException attendu) { }
        couperApres = -1;
        assertArrayEquals(contenu, Files.readAllBytes(essai(cible).fichier.toPath()));
    }

    @Test
    public void partieDejaCompleteLe416Termine() throws Exception {
        File cible = new File(dossier, "v.mp4");
        couperApres = 500_000;
        try { essai(cible); } catch (IOException attendu) { }
        // Toute la fin reçue mais coupée avant le renommage : on simule la partie complète.
        Files.write(Reprise.partie(cible).toPath(), contenu);
        couperApres = -1;
        assertArrayEquals(contenu, Files.readAllBytes(essai(cible).fichier.toPath()));
    }

    @Test
    public void autreAdresseLaPartieNeSertPas() throws Exception {
        File cible = new File(dossier, "v.mp4");
        Files.write(Reprise.partie(cible).toPath(), new byte[] {9, 9, 9});
        Files.write(Reprise.info(cible).toPath(), "https://ailleurs/x\n\"v1\"\n1000000\n".getBytes());
        Reprise.Resultat r = essai(cible);
        assertFalse(r.repris);
        assertEquals("-", ranges.get(0));
        assertArrayEquals(contenu, Files.readAllBytes(cible.toPath()));
    }

    @Test
    public void tropGrosRefuse() throws Exception {
        File cible = new File(dossier, "v.mp4");
        try {
            Reprise.telecharger(url(), cible, 1000, OUVREUR);
            fail();
        } catch (Reprise.TropGros attendu) { }
        assertFalse(Reprise.partie(cible).exists());
    }

    @Test
    public void auPlusTroisEssaisParJourEtParFichier() {
        String etat = null;
        for (int i = 0; i < 3; i++) {
            assertTrue(Reprise.essaiPermis(etat, "2026-11-12"));
            etat = Reprise.noterEssai(etat, "2026-11-12");
        }
        assertFalse("4e essai le même jour : non", Reprise.essaiPermis(etat, "2026-11-12"));
        assertTrue("le lendemain : de nouveau 3", Reprise.essaiPermis(etat, "2026-11-13"));
        assertEquals("2026-11-13|1", Reprise.noterEssai(etat, "2026-11-13"));
    }

    @Test
    public void enTetesLus() {
        assertArrayEquals(new long[] {100, 199, 3123536}, Reprise.contentRange("bytes 100-199/3123536"));
        assertArrayEquals(new long[] {5, 9, -1}, Reprise.contentRange("bytes 5-9/*"));
        assertNull(Reprise.contentRange("octets 1-2/3"));
        java.util.Map<String, List<String>> h = new java.util.HashMap<>();
        h.put("X-Goog-Hash", java.util.Arrays.asList("crc32c=FnKFFQ==", "md5=EivGmzgsUzAdL6zmtp0zRw=="));
        assertEquals("122bc69b382c53301d2face6b69d3347", Reprise.md5Annonce(h)); // = l'ETag de GCS pour ce fichier
    }
}
