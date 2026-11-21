package com.papote.tablette;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** Journal envoyé par morceaux (Tanguy, 21/11) : seulement les lignes venues après la dernière envoyée. */
public class JournalTest {
    @Test
    public void seulementLesLignesNouvelles() {
        assertEquals("c\nd", Journal.nouvelles("a\nb\nc\nd", "b"));
    }

    @Test
    public void rienDeNeuf() {
        assertEquals("", Journal.nouvelles("a\nb", "b"));
        assertEquals("", Journal.nouvelles("", "b"));
    }

    @Test
    public void premiereFoisOuLigneDisparueToutPart() {
        assertEquals("a\nb", Journal.nouvelles("a\nb", null));
        assertEquals("a\nb", Journal.nouvelles("a\nb", "z"));
    }

    @Test
    public void laDerniereOccurrenceCompte() {
        assertEquals("x", Journal.nouvelles("b\nc\nb\nx", "b"));
    }

    @Test
    public void derniereLigne() {
        assertEquals("c", Journal.derniere("a\nb\nc"));
        assertEquals("a", Journal.derniere("a"));
        assertEquals("", Journal.derniere(""));
    }
}
