package com.papote.tablette;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Chien de garde : quand recharger la page, relancer Papote ou redémarrer la tablette. */
public class GardienTest {
    private static final long MIN = 60_000;
    private static final long T = 100 * MIN; // « maintenant » (uptime)

    private static Gardien.Geste decider(long tic, boolean aLEcran, long ecranDepuis, long pouls,
                                         long rechargeA, int dejaRecharge, boolean appelGsm) {
        return Gardien.decider(T, false, tic, aLEcran, ecranDepuis, pouls, rechargeA, dejaRecharge, appelGsm);
    }

    @Test
    public void toutVaBien() {
        assertEquals(Gardien.Geste.RIEN, decider(T - 5_000, true, T - 60 * MIN, T - 20_000, 0, 0, false));
    }

    @Test
    public void filPrincipalBloque45sRelancePapote() {
        assertEquals(Gardien.Geste.RELANCER, decider(T - 46_000, true, T - 60 * MIN, T - 20_000, 0, 0, false));
        // Même écran éteint et pendant un appel : l'appli entière est figée.
        assertEquals(Gardien.Geste.RELANCER, decider(T - 46_000, false, 0, 0, 0, 0, true));
    }

    @Test
    public void pageMuette3minRechargeeDeuxFoisPuisRelance() {
        assertEquals(Gardien.Geste.RIEN, decider(T, true, T - 60 * MIN, T - 2 * MIN, 0, 0, false));
        assertEquals(Gardien.Geste.RECHARGER, decider(T, true, T - 60 * MIN, T - 4 * MIN, 0, 0, false));
        // Juste rechargée : on lui laisse 3 min.
        assertEquals(Gardien.Geste.RIEN, decider(T, true, T - 60 * MIN, T - 10 * MIN, T - MIN, 1, false));
        assertEquals(Gardien.Geste.RECHARGER, decider(T, true, T - 60 * MIN, T - 10 * MIN, T - 4 * MIN, 1, false));
        assertEquals(Gardien.Geste.RELANCER, decider(T, true, T - 60 * MIN, T - 20 * MIN, T - 4 * MIN, 2, false));
    }

    @Test
    public void pageMuettePendantUnAppelTelephoneOnNeCoupePasLaLigne() {
        assertEquals(Gardien.Geste.RIEN, decider(T, true, T - 60 * MIN, T - 20 * MIN, T - 4 * MIN, 2, true));
    }

    @Test
    public void pageJugeeSeulementALEcranEtApresUnPremierPouls() {
        // Écran éteint (la page peut dormir).
        assertEquals(Gardien.Geste.RIEN, decider(T, false, 0, T - 30 * MIN, 0, 0, false));
        // Revenue à l'écran il y a 1 min : délai à partir du retour.
        assertEquals(Gardien.Geste.RIEN, decider(T, true, T - MIN, T - 30 * MIN, 0, 0, false));
        // Jamais de pouls (ancienne page) : jamais rechargée en boucle.
        assertEquals(Gardien.Geste.RIEN, decider(T, true, T - 60 * MIN, 0, 0, 0, false));
    }

    @Test
    public void rienPendantLaMaintenance() {
        assertEquals(Gardien.Geste.RIEN, Gardien.decider(T, true, 0, true, 1, 1, 0, 9, false));
    }

    @Test
    public void troisRelancesEn30minRedemarrentLaTablette() {
        long mur = 1_000_000_000L;
        String r = Gardien.noterRelance("", mur - 20 * MIN);
        assertFalse(Gardien.fautRedemarrer(r, mur, 0));
        r = Gardien.noterRelance(r, mur - 10 * MIN);
        assertFalse(Gardien.fautRedemarrer(r, mur, 0));
        r = Gardien.noterRelance(r, mur);
        assertTrue(Gardien.fautRedemarrer(r, mur, 0));
        // Déjà redémarrée il y a 2 h : pas de redémarrages en boucle.
        assertFalse(Gardien.fautRedemarrer(r, mur, mur - 120 * MIN));
    }

    @Test
    public void lesRelancesAnciennesSontOubliees() {
        long mur = 1_000_000_000L;
        String r = Gardien.noterRelance((mur - 50 * MIN) + "," + (mur - 40 * MIN) + ",abc", mur);
        assertEquals(String.valueOf(mur), r);
        assertFalse(Gardien.fautRedemarrer(r, mur, 0));
    }

    @Test
    public void enLigneCoupeQuandLaPageEstMuettePlusDe5min() {
        assertFalse(Gardien.pageMorte(T, true, T - 60 * MIN, T - 4 * MIN, 0));
        assertTrue(Gardien.pageMorte(T, true, T - 60 * MIN, T - 6 * MIN, 0));
        assertFalse(Gardien.pageMorte(T, false, 0, T - 60 * MIN, 0));
        assertFalse(Gardien.pageMorte(T, true, T - 60 * MIN, 0, 0));
    }
}
