package com.papote.tablette;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** Luminosité de jour réglée par la famille (Tanguy, 20/11) : 40 à 100 %, sinon celle de la tablette. */
public class LuminositeTest {
    @Test
    public void reglageBorneEntre40Et100() {
        assertEquals(40, Luminosite.borner(40));
        assertEquals(100, Luminosite.borner(100));
        assertEquals(70, Luminosite.borner(70));
        assertEquals(0, Luminosite.borner(39));   // trop sombre pour lire : refusé
        assertEquals(0, Luminosite.borner(101));
        assertEquals(0, Luminosite.borner(0));    // champ absent
        assertEquals(0, Luminosite.borner(-5));
    }

    @Test
    public void sansReglageLaTabletteGardeSaLuminosite() {
        assertEquals(Luminosite.TABLETTE, Luminosite.jour(0), 0f);
        assertEquals(Luminosite.SOIR, Luminosite.soir(0), 0f);
    }

    @Test
    public void leJourSuitLeReglage() {
        assertEquals(0.40f, Luminosite.jour(40), 0.001f);
        assertEquals(0.85f, Luminosite.jour(85), 0.001f);
        assertEquals(1f, Luminosite.jour(100), 0.001f);
    }

    @Test
    public void leSoirJamaisPlusFortQueLeJour() {
        assertEquals(0.55f, Luminosite.soir(100), 0.001f);
        assertEquals(0.55f, Luminosite.soir(55), 0.001f);
        assertEquals(0.40f, Luminosite.soir(40), 0.001f);
    }
}
