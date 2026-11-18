package com.papote.tablette;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Redémarrage à la main (volume bas tenu 10 s) : quand la fenêtre s'ouvre, quand « Oui » compte. */
public class RedemarrageTest {
    private static final long T = 1_000_000;

    @Test
    public void ouvertePourUneTabletteTranquille() {
        assertNull(Redemarrage.refus(false, false, false, false, 0, T));
    }

    @Test
    public void jamaisPendantUnAppelOuUnSos() {
        assertEquals("appel en cours", Redemarrage.refus(false, true, false, false, 0, T));
        assertEquals("appel en cours", Redemarrage.refus(false, false, true, false, 0, T));
        assertEquals("SOS en cours", Redemarrage.refus(false, false, false, true, T - 1_000, T));
        assertEquals("maintenance", Redemarrage.refus(true, false, false, false, 0, T));
    }

    @Test
    public void unSosQueLaPageNeRepetePlusNeBloquePas() {
        // Page figée en plein SOS : au-delà de 10 s sans nouvelle, on peut redémarrer (le SOS se reprend).
        assertNull(Redemarrage.refus(false, false, false, true, T - Redemarrage.SOS_FRAIS_MS - 1, T));
        assertNull(Redemarrage.refus(false, false, false, true, 0, T));
    }

    @Test
    public void ouiSeulementPourUneFenetreOuverte() {
        assertFalse("fenêtre fermée", Redemarrage.ouiValable(0, T));
        assertTrue(Redemarrage.ouiValable(T - 5_000, T));
        assertTrue(Redemarrage.ouiValable(T - Redemarrage.REPONSE_MS, T));
        assertFalse("bien après la fermeture automatique", Redemarrage.ouiValable(T - Redemarrage.REPONSE_MS - 3_000, T));
        assertFalse("horloge revenue en arrière", Redemarrage.ouiValable(T + 1, T));
    }

    @Test
    public void appuiDeDixSecondesEtVingtSecondesPourRepondre() {
        assertEquals(10_000, Redemarrage.APPUI_MS);
        assertEquals(20_000, Redemarrage.REPONSE_MS);
    }
}
