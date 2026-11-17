package com.papote.tablette;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * Veille : garde-fou des heures reçues (17/11 : réveil à 20 h 30, nuit de 23 h 30 sur 24).
 * Même règle exactement que le serveur (functions/veille.js veilleSure) : simple borne.
 */
public class VeilleTest {
    private static int h(int heure, int min) { return heure * 60 + min; }

    @Test
    public void reveilA20h30RamenaA10hCommeLeServeur() {
        assertEquals(h(10, 0), Veille.bornerFin(h(20, 30)));
    }

    @Test
    public void reveilTropTotRamenaA5h() {
        assertEquals(h(5, 0), Veille.bornerFin(h(3, 0)));
    }

    @Test
    public void valeursNormalesInchangees() {
        assertEquals(h(21, 0), Veille.bornerDebut(h(21, 0)));
        assertEquals(h(23, 30), Veille.bornerDebut(h(23, 30)));
        assertEquals(h(6, 30), Veille.bornerFin(h(6, 30)));
    }

    @Test
    public void coucherHorsBornesSimpleBorne() {
        assertEquals(h(19, 0), Veille.bornerDebut(h(14, 0)));
        assertEquals("1 h : 19 h, comme le serveur", h(19, 0), Veille.bornerDebut(h(1, 0)));
    }

    @Test
    public void heureMalFormeeValeurParDefaut() {
        assertEquals(-1, Veille.lire(25, 0));
        assertEquals(-1, Veille.lire(-1, 0));
        assertEquals(h(6, 30), Veille.lire(6, 30));
        assertEquals("minutes autres que 30 : 0", h(6, 0), Veille.lire(6, 15));
        assertEquals(h(23, 0), Veille.DEFAULT_FROM);
        assertEquals(h(5, 0), Veille.DEFAULT_TO);
    }
}
