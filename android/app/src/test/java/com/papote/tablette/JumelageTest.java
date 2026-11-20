package com.papote.tablette;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Tablette pas encore reliée (19/11). Le serveur la réveille quand son code change (push « jumelage ») : la
 * relecture n'est alors qu'un secours (60 s pendant les 10 minutes qui suivent une activité, puis 10 minutes).
 * Tant qu'aucun réveil n'est arrivé pour ce code : 4 s, puis 15 s après 10 minutes sans activité. Une tablette
 * oubliée allumée en stock ne consomme plus la carte SIM pour rien.
 */
public class JumelageTest {
    private static final long MIN = 60_000;

    private static final long H = 60 * MIN;

    @Test
    public void rapideDixMinutesApresUnGeste() {
        assertEquals(4_000, Sync.delaiJumelage(0, false, 5_000, 14 * MIN));
        assertEquals(4_000, Sync.delaiJumelage(10 * MIN - 1, false, 5 * MIN, 9 * MIN));
        assertEquals("réveils du serveur reçus : relecture de secours seulement", 60_000, Sync.delaiJumelage(MIN, true, MIN, 14 * MIN));
    }

    @Test
    public void sommeilPlusAucuneRelectureJusquAuCodeSuivant() {
        // Tanguy, 20/11 : après 10 min sans geste, elle ne relit plus ; elle attend son prochain code.
        assertEquals(9 * MIN + 1_000, Sync.delaiJumelage(10 * MIN, false, 6 * MIN, 9 * MIN));
        assertEquals(9 * MIN + 1_000, Sync.delaiJumelage(10 * MIN, true, 6 * MIN, 9 * MIN));
        assertEquals(1_000, Sync.delaiJumelage(3 * H, false, 16 * MIN, -MIN));
    }

    @Test
    public void sommeilGuetDeTrenteSecondesApresUnNouveauCode() {
        assertEquals(10_000, Sync.delaiJumelage(2 * H, false, 0, 15 * MIN));
        assertEquals(10_000, Sync.delaiJumelage(2 * H, false, 29_000, 15 * MIN));
        assertEquals(15 * MIN - 30_000 + 1_000, Sync.delaiJumelage(2 * H, false, 30_000, 15 * MIN - 30_000));
        assertEquals("le serveur réveille la tablette : pas de guet", 15 * MIN + 1_000, Sync.delaiJumelage(2 * H, true, 0, 15 * MIN));
    }

    @Test
    public void sommeilSansCodeUnEssaiParMinute() {
        assertEquals(60_000, Sync.delaiJumelage(2 * H, false, -1, 0));
    }

    @Test
    public void unCodeParQuartDheurePuisParHeureApres24h() {
        assertEquals(15 * MIN, Sync.intervalleCode(0));
        assertEquals(15 * MIN, Sync.intervalleCode(24 * H - 1));
        assertEquals(60 * MIN, Sync.intervalleCode(24 * H));
    }

    @Test
    public void lecturesParJourEnSommeil() {
        // Un jour bloquée en sommeil : 1 écriture + 4 lectures par code (guet), 96 codes ; puis 24 après 24 h.
        int premierJour = 0, suivant = 0;
        for (long t = 0; t < 24 * H; t += 15 * MIN) premierJour += 5;
        for (long t = 0; t < 24 * H; t += 60 * MIN) suivant += 5;
        assertTrue("≈ 480 échanges le premier jour (avant : 5 800)", premierJour <= 500);
        assertTrue("≈ 120 ensuite", suivant <= 130);
    }

    @Test
    public void horlogeIncoherenteSommeil() {
        assertTrue(Sync.jumelageEnSommeil(-1));
        assertFalse(Sync.jumelageEnSommeil(0));
    }

    @Test
    public void codeConfirmeTropAncienJeteSeulementSurPreuve() {
        long exp = 1_800_000_000_000L, H = 60 * MIN;
        assertTrue("403 et 24 h passées à l'heure du serveur", Sync.entreeExpiree(403, exp, exp + 24 * H + 1));
        assertFalse("encore dans les 24 h", Sync.entreeExpiree(403, exp, exp + 23 * H));
        assertFalse("heure du serveur inconnue", Sync.entreeExpiree(403, exp, 0));
        assertFalse("autre refus (réseau, serveur)", Sync.entreeExpiree(500, exp, exp + 48 * H));
        assertFalse("pas de refus", Sync.entreeExpiree(0, exp, exp + 48 * H));
        assertFalse("échéance illisible", Sync.entreeExpiree(403, 0, exp));
    }

}
