package com.papote.tablette;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * Durée d'affichage d'un envoi ou d'un rappel pas encore vu (options.dureeAffichage, réglée par la famille) :
 * 1 à 5 minutes, 3 sans réglage. Le comportement à l'écran est couvert par android/tests/affichage.test.js.
 */
public class DureeAffichageTest {
    @Test
    public void entre1Et5Minutes() {
        assertEquals(1, Sync.dureeAffichageMin(1));
        assertEquals(3, Sync.dureeAffichageMin(3));
        assertEquals(5, Sync.dureeAffichageMin(5));
        assertEquals(2, Sync.dureeAffichageMin(2.4));
    }

    @Test
    public void horsBornesRamene() {
        assertEquals(1, Sync.dureeAffichageMin(0));
        assertEquals(1, Sync.dureeAffichageMin(-4));
        assertEquals(5, Sync.dureeAffichageMin(30));
        assertEquals(5, Sync.dureeAffichageMin(Double.NaN));
    }
}
