package com.papote.tablette;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * Tablette pas encore reliée (19/11). Le serveur la réveille quand son code change (push « jumelage ») : la
 * relecture n'est alors qu'un secours (60 s pendant les 10 minutes qui suivent une activité, puis 10 minutes).
 * Tant qu'aucun réveil n'est arrivé pour ce code : 4 s, puis 15 s après 10 minutes sans activité. Une tablette
 * oubliée allumée en stock ne consomme plus la carte SIM pour rien.
 */
public class JumelageTest {
    private static final long MIN = 60_000;

    @Test
    public void sansReveilRapideJusteApresUneActivite() {
        assertEquals(4_000, Sync.delaiJumelage(0, false));
        assertEquals(4_000, Sync.delaiJumelage(MIN, false));
        assertEquals(4_000, Sync.delaiJumelage(10 * MIN - 1, false));
    }

    @Test
    public void sansReveilLentApresDixMinutesSansActivite() {
        assertEquals(15_000, Sync.delaiJumelage(10 * MIN, false));
        assertEquals(15_000, Sync.delaiJumelage(3 * 24 * 60 * MIN, false));
    }

    @Test
    public void prevenueParLeServeurLaRelectureNestQuUnSecours() {
        assertEquals(60_000, Sync.delaiJumelage(0, true));
        assertEquals(60_000, Sync.delaiJumelage(10 * MIN - 1, true));
        assertEquals(10 * MIN, Sync.delaiJumelage(10 * MIN, true));
        assertEquals(10 * MIN, Sync.delaiJumelage(3 * 24 * 60 * MIN, true));
    }

    @Test
    public void horlogeIncoherenteJamaisPlusViteQueLent() {
        assertEquals(15_000, Sync.delaiJumelage(-1, false));
        assertEquals(10 * MIN, Sync.delaiJumelage(-1, true));
    }
}
