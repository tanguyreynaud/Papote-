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
}
