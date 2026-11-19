package com.papote.tablette;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * Tablette pas encore reliée (19/11) : elle relit son jumelage toutes les 4 s pendant les 10 minutes qui suivent
 * une activité (démarrage, écran touché, ordre de l'admin), puis toutes les 15 s. Une tablette oubliée allumée
 * en stock ne consomme plus la carte SIM pour rien.
 */
public class JumelageTest {
    private static final long MIN = 60_000;

    @Test
    public void rapideJusteApresUneActivite() {
        assertEquals(4_000, Sync.delaiJumelage(0));
        assertEquals(4_000, Sync.delaiJumelage(MIN));
        assertEquals(4_000, Sync.delaiJumelage(10 * MIN - 1));
    }

    @Test
    public void lentApresDixMinutesSansActivite() {
        assertEquals(15_000, Sync.delaiJumelage(10 * MIN));
        assertEquals(15_000, Sync.delaiJumelage(3 * 24 * 60 * MIN));
    }

    @Test
    public void horlogeIncoherenteJamaisPlusViteQueLent() {
        assertEquals(15_000, Sync.delaiJumelage(-1));
    }
}
