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
        assertNull(Redemarrage.refus(false, false, false, false, true));
    }

    @Test
    public void jamaisPendantUnAppelOuUnSos() {
        assertEquals("appel en cours", Redemarrage.refus(false, true, false, false, true));
        assertEquals("appel en cours", Redemarrage.refus(false, false, true, false, true));
        assertEquals("SOS en cours", Redemarrage.refus(false, false, false, true, true));
        assertEquals("maintenance", Redemarrage.refus(true, false, false, false, true));
    }

    @Test
    public void unePageFigeeEnPleinSosNeBloquePas() {
        // Page figée (Gardien : plus de pouls) : on peut redémarrer, le SOS se reprend au démarrage.
        assertNull(Redemarrage.refus(false, false, false, true, false));
        // Un appel bloque toujours, même page figée (Android refuserait de toute façon).
        assertEquals("appel en cours", Redemarrage.refus(false, false, true, true, false));
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
