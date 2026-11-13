package com.papote.tablette;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Numéros de téléphone de la famille (chantier téléphone 29/10) : comparaison et composition. */
public class TelephoneTest {

    @Test
    public void memeNumeroSousToutesSesFormes() {
        assertTrue(Telephone.memeNumero("06 12 34 56 78", "+33612345678"));
        assertTrue(Telephone.memeNumero("0033612345678", "0612345678"));
        assertTrue(Telephone.memeNumero("+33 6 12 34 56 78", "06.12.34.56.78"));
        assertTrue(Telephone.memeNumero("tel:+33612345678", "0612345678"));
    }

    @Test
    public void numerosDifferents() {
        assertFalse(Telephone.memeNumero("0612345678", "0612345679"));
        assertFalse(Telephone.memeNumero("", "0612345678"));
        assertFalse(Telephone.memeNumero(null, "0612345678"));
        assertFalse(Telephone.memeNumero("0612345678", ""));
    }

    @Test
    public void numeroMasqueNeCorrespondAPersonne() {
        assertFalse(Telephone.memeNumero("", ""));
        assertEquals("", Telephone.normaliser(null));
    }

    @Test
    public void composerSeulementUnPortableFrancais() {
        assertEquals("0612345678", Telephone.composer("+33 6 12 34 56 78"));
        assertEquals("0612345678", Telephone.composer("06 12 34 56 78"));
        assertEquals("0712345678", Telephone.composer("0033712345678"));
        assertEquals("0612345678", Telephone.composer("+33 06 12 34 56 78"));
        assertTrue(Telephone.portableFrancais("07 00 00 00 00"));
    }

    @Test
    public void jamaisHorsForfait() {
        // Étranger, fixe, numéro spécial, numéro incomplet : jamais composé (Tanguy, 29/10).
        assertEquals("", Telephone.composer("+41 79 123 45 67"));
        assertEquals("", Telephone.composer("+32 470 12 34 56"));
        assertEquals("", Telephone.composer("01 42 00 00 00"));
        assertEquals("", Telephone.composer("08 99 00 00 00"));
        assertEquals("", Telephone.composer("3615"));
        assertEquals("", Telephone.composer("0612345"));
        assertEquals("", Telephone.composer(""));
        assertEquals("", Telephone.composer(null));
        assertFalse(Telephone.portableFrancais("+44 7700 900123"));
    }

    @Test
    public void smsSeulementVersDesPortablesFrancais() {
        // Numéro court surtaxé, 08, fixe, étranger : écartés. Doublon : une seule fois.
        assertEquals(java.util.Arrays.asList("0612345678", "0712345678"),
                Telephone.destinatairesSms("+33612345678,81212,0899123456,0145678901,+447911123456,06 12 34 56 78,0712345678"));
        assertTrue(Telephone.destinatairesSms("81212,+12025550123").isEmpty());
        assertTrue(Telephone.destinatairesSms(null).isEmpty());
        assertTrue(Telephone.destinatairesSms("").isEmpty());
    }

    @Test
    public void smsTrenteDestinatairesAuPlus() {
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < 40; i++) s.append(String.format("06000000%02d,", i));
        assertEquals(30, Telephone.destinatairesSms(s.toString()).size());
    }

    // Tanguy (13/11) : deux proches avec le même numéro, le responsable passe toujours devant.
    @Test
    public void leResponsableDAbordPuisParUid() {
        assertTrue(Telephone.ordre(true, "zz", false, "aa") < 0);
        assertTrue(Telephone.ordre(false, "aa", true, "zz") > 0);
        assertTrue("à égalité : par uid", Telephone.ordre(false, "aa", false, "bb") < 0);
        assertEquals(0, Telephone.ordre(true, "aa", true, "aa"));
        java.util.List<String[]> l = new java.util.ArrayList<>(java.util.Arrays.asList(
                new String[]{"u3", "0"}, new String[]{"u2", "1"}, new String[]{"u1", "0"}));
        java.util.Collections.sort(l, (a, b) -> Telephone.ordre("1".equals(a[1]), a[0], "1".equals(b[1]), b[0]));
        assertEquals("u2", l.get(0)[0]);
        assertEquals("u1", l.get(1)[0]);
        assertEquals("u3", l.get(2)[0]);
    }
}