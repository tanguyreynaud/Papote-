package com.papote.tablette;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Garde-fous de la mise à jour (MajGarde), sans tablette (gradlew test). */
public class MajGardeTest {
    private static final String COMMIT = "0123456789abcdef0123456789abcdef01234567";
    private static final String BONNE = "https://raw.githubusercontent.com/tanguyreynaud/Papote-/" + COMMIT + "/installation/Papote.apk";
    private static final String SHA = "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";

    @Test
    public void adresseEcriteParMajCommunAcceptee() {
        assertNull(MajGarde.refus(BONNE, SHA, null));
        assertNull(MajGarde.refus(BONNE.replace("Papote.apk", "Papote-test.apk"), SHA.toUpperCase(), ""));
        assertNull(MajGarde.refus("https://maj.mapapote.fr/Papote-221.apk", SHA, null));
    }

    @Test
    public void autresAdressesRefusees() {
        assertNotNull(MajGarde.refus("https://exemple.com/Papote.apk", SHA, null));
        assertNotNull(MajGarde.refus("http://raw.githubusercontent.com/tanguyreynaud/Papote-/" + COMMIT + "/installation/Papote.apk", SHA, null));
        // Autre dépôt (fork d'un attaquant), branche au lieu d'un commit, autre fichier, suffixe ajouté
        assertNotNull(MajGarde.refus(BONNE.replace("tanguyreynaud", "attaquant"), SHA, null));
        assertNotNull(MajGarde.refus(BONNE.replace(COMMIT, "main"), SHA, null));
        assertNotNull(MajGarde.refus(BONNE.replace("Papote.apk", "Gros.bin"), SHA, null));
        assertNotNull(MajGarde.refus(BONNE + "?x=1", SHA, null));
        assertNotNull(MajGarde.refus("https://raw.githubusercontent.com.attaquant.fr/tanguyreynaud/Papote-/" + COMMIT + "/installation/Papote.apk", SHA, null));
        assertNotNull(MajGarde.refus(null, SHA, null));
        assertNotNull(MajGarde.refus("https://maj.mapapote.fr.attaquant.fr/Papote.apk", SHA, null));
        assertNotNull(MajGarde.refus("https://maj.mapapote.fr/../x/Papote.apk", SHA, null));
        assertNotNull(MajGarde.refus("https://autre.mapapote.fr/Papote.apk", SHA, null));
    }

    @Test
    public void empreinteAbsenteOuDejaRefusee() {
        assertNotNull(MajGarde.refus(BONNE, "", null));
        assertNotNull(MajGarde.refus(BONNE, "zz", null));
        assertTrue(MajGarde.refus(BONNE, SHA, SHA.toUpperCase()).contains("déjà refusée"));
    }

    @Test
    public void plafondDeTaille() {
        // ~4 Mo aujourd'hui : de la marge, mais pas de quoi vider un forfait prépayé.
        assertEquals(30L * 1024 * 1024, MajGarde.TAILLE_MAX);
    }

    @Test
    public void laPlusRecenteAcceptableEstChoisie() {
        // Cas normal : les deux adresses sont bonnes, la plus récente gagne.
        assertEquals(1, MajGarde.choisir(new int[]{230, 231}, new boolean[]{true, true}));
        // Une adresse détournée annonce un numéro énorme mais refusé : la vraie version reste prise.
        assertEquals(0, MajGarde.choisir(new int[]{231, 999999}, new boolean[]{true, false}));
        assertEquals(1, MajGarde.choisir(new int[]{999999, 231}, new boolean[]{false, true}));
        // Tout est refusé : la plus récente, que la vérification ignorera en le notant.
        assertEquals(1, MajGarde.choisir(new int[]{231, 999999}, new boolean[]{false, false}));
        assertEquals(0, MajGarde.choisir(new int[]{230}, new boolean[]{true}));
    }

    @Test
    public void seulsLesRefusDefinitifsSontMemorises() {
        assertTrue(MajGarde.refusDefinitif(4));  // fichier invalide
        assertTrue(MajGarde.refusDefinitif(5));  // conflit : autre signature
        assertTrue(MajGarde.refusDefinitif(7));  // incompatible
        org.junit.Assert.assertFalse(MajGarde.refusDefinitif(0));  // réussite
        org.junit.Assert.assertFalse(MajGarde.refusDefinitif(1));  // échec sans précision
        org.junit.Assert.assertFalse(MajGarde.refusDefinitif(3));  // interrompue
        org.junit.Assert.assertFalse(MajGarde.refusDefinitif(6));  // place manquante
        org.junit.Assert.assertFalse(MajGarde.refusDefinitif(-1)); // confirmation demandée
    }

    // ---------- Audit réseau du 11/11 ----------

    @Test
    public void lesEssaisSEspacentQuandLeTelechargementRate() {
        assertEquals(10 * 60_000L, MajGarde.attenteApresEchec(0));
        assertEquals(10 * 60_000L, MajGarde.attenteApresEchec(1));
        assertEquals(30 * 60_000L, MajGarde.attenteApresEchec(2));
        assertEquals(2 * 3600_000L, MajGarde.attenteApresEchec(3));
        assertEquals(6 * 3600_000L, MajGarde.attenteApresEchec(4));
        assertEquals(24 * 3600_000L, MajGarde.attenteApresEchec(5));
        assertEquals(24 * 3600_000L, MajGarde.attenteApresEchec(500));
        // Un téléchargement qui rate toujours : pas plus de 5 essais le premier jour, puis un par jour
        // (avant : 144 par jour, l'APK entier à chaque fois sur la carte SIM).
        long temps = 0;
        int essais = 0;
        for (int echecs = 1; temps < 24 * 3600_000L; echecs++) { essais++; temps += MajGarde.attenteApresEchec(echecs); }
        assertTrue("essais le premier jour : " + essais, essais <= 5);
    }

    @Test
    public void troisInstallationsRateesEtLApkNEstPlusRepris() {
        org.junit.Assert.assertFalse(MajGarde.abandonner(1));
        org.junit.Assert.assertFalse(MajGarde.abandonner(2));
        assertTrue(MajGarde.abandonner(3));
        assertEquals(0, MajGarde.essaisPour(null, SHA));
        assertEquals(0, MajGarde.essaisPour("", SHA));
        assertEquals(2, MajGarde.essaisPour(SHA + ":2", SHA));
        assertEquals(2, MajGarde.essaisPour(SHA.toUpperCase() + ":2", SHA));
        assertEquals(0, MajGarde.essaisPour("autre:2", SHA)); // nouvelle publication : on repart de zéro
        assertEquals(0, MajGarde.essaisPour(SHA + ":x", SHA));
        assertEquals(0, MajGarde.essaisPour(SHA + ":-4", SHA));
    }

    @Test
    public void pasDInstallationPendantUnAppel() {
        // Libre : on installe tout de suite, sans attendre.
        assertTrue(Updater.attendreLibre(() -> false, 180, 0));
        assertTrue(Updater.attendreLibre(null, 180, 0));
        // L'appel se termine au 3e regard : on installe à ce moment-là.
        final int[] regards = {0};
        assertTrue(Updater.attendreLibre(() -> ++regards[0] < 3, 180, 0));
        assertEquals(3, regards[0]);
        // Toujours occupée (long appel, SOS) : on n'installe pas, la vérification reviendra.
        org.junit.Assert.assertFalse(Updater.attendreLibre(() -> true, 5, 0));
    }
}
