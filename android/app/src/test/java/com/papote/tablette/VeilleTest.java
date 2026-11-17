package com.papote.tablette;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** Veille : garde-fou des heures reçues (17/11 : réveil à 20 h 30, nuit de 23 h 30 sur 24). */
public class VeilleTest {
    private static int h(int heure, int min) { return heure * 60 + min; }

    @Test
    public void reveilA20h30RamenaA10h() {
        assertEquals(h(10, 0), Veille.bornerFin(h(20, 30)));
    }

    @Test
    public void reveilTropTotRamenaA5h() {
        assertEquals(h(5, 0), Veille.bornerFin(h(3, 0)));
    }

    @Test
    public void valeursNormalesInchangees() {
        assertEquals(h(21, 0), Veille.bornerDebut(h(21, 0)));
        assertEquals(h(23, 0), Veille.bornerDebut(h(23, 0)));
        assertEquals(h(6, 30), Veille.bornerFin(h(6, 30)));
        assertEquals(h(5, 0), Veille.bornerFin(h(5, 0)));
    }

    @Test
    public void debutHorsBornes() {
        assertEquals("14 h (essai de Tanguy) : 19 h au plus tôt", h(19, 0), Veille.bornerDebut(h(14, 0)));
        assertEquals("après minuit : 23 h 30", h(23, 30), Veille.bornerDebut(h(1, 0)));
        assertEquals(h(23, 30), Veille.bornerDebut(h(23, 59)));
    }
}
