package com.papote.tablette;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Before;
import org.junit.Test;

/** L'heure de la tablette vérifiée contre celle des serveurs (Tanguy, 19/11 : « on ne récupère pas n'importe quelle heure »). */
public class HorlogeTest {
    private static final long MIN = 60_000, H = 60 * MIN, JOUR = 24 * H, AN = 365 * JOUR;
    private static final long VRAI = 1_795_000_000_000L; // une vraie date, fin novembre 2026
    private static final long CHRONO = 500_000;

    @Before
    public void oublier() {
        Horloge.oublier();
    }

    @Test
    public void sansServeurSeuleLaDateDUsineEstRefusee() {
        assertNull(Horloge.ecart(VRAI, CHRONO));
        assertTrue(Horloge.sure(VRAI, CHRONO));
        assertFalse("1970, batterie vidée", Horloge.sure(5 * JOUR, CHRONO));
        assertFalse("date d'usine", Horloge.sure(Horloge.PLANCHER - JOUR, CHRONO));
    }

    @Test
    public void heureJusteConfirmee() {
        Horloge.noter(VRAI, CHRONO);
        assertEquals(Long.valueOf(0), Horloge.ecart(VRAI + 3 * H, CHRONO + 3 * H));
        assertTrue(Horloge.sure(VRAI + 3 * H, CHRONO + 3 * H));
        assertTrue("une minute d'écart : acceptée", Horloge.sure(VRAI + MIN, CHRONO));
    }

    @Test
    public void horlogeQuiSauteDansLeFuturEstRefusee() {
        Horloge.noter(VRAI, CHRONO);
        assertFalse(Horloge.sure(VRAI + 5 * AN, CHRONO + MIN));
        assertTrue("puis revient : acceptée de nouveau", Horloge.sure(VRAI + 2 * MIN, CHRONO + 2 * MIN));
    }

    @Test
    public void horlogeQuiRetombeEn1970EstRefusee() {
        Horloge.noter(VRAI, CHRONO);
        assertFalse(Horloge.sure(3 * H, CHRONO + H));
    }

    @Test
    public void horlogeDecaleeDUneHeureEstRefusee() {
        Horloge.noter(VRAI, CHRONO);
        assertFalse("une heure de trop (mauvais fuseau, heure d'été ratée)", Horloge.sure(VRAI + H, CHRONO));
        assertFalse(Horloge.sure(VRAI - H, CHRONO));
    }

    @Test
    public void enTeteDateLu() {
        assertEquals(1_795_118_400_000L, Horloge.lire("Thu, 19 Nov 2026 20:00:00 GMT"));
        assertEquals(0, Horloge.lire(null));
        assertEquals(0, Horloge.lire("n'importe quoi"));
    }

    @Test
    public void unServeurAUneDateImpossibleNEstPasUneReference() {
        Horloge.noter(10 * JOUR, CHRONO);
        assertNull(Horloge.ecart(VRAI, CHRONO));
    }
}
