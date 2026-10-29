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
    public void composerUnNumeroFrancais() {
        assertEquals("0612345678", Telephone.composer("+33 6 12 34 56 78"));
        assertEquals("0612345678", Telephone.composer("06 12 34 56 78"));
        assertEquals("0612345678", Telephone.composer("0033612345678"));
        assertEquals("+41791234567", Telephone.composer("+41 79 123 45 67"));
        assertEquals("", Telephone.composer(""));
    }
}
