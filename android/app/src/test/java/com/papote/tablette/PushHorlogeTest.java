package com.papote.tablette;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Nuit du 19/11 : un ping noté pendant que l'horloge avançait ne doit pas faire croire au push pour toujours. */
public class PushHorlogeTest {
    private static final long MIN = 60_000, JOUR = 24 * 60 * MIN;
    private static final long MAINTENANT = 1_800_000_000_000L;

    @Test
    public void pingDuFuturNestPlusCru() {
        assertTrue(Push.pingDuFutur(MAINTENANT + 30 * JOUR, MAINTENANT));
        assertTrue(Push.pingDuFutur(MAINTENANT + 3 * MIN, MAINTENANT));
    }

    @Test
    public void pingNormalOuPetitDecalageGarde() {
        assertFalse(Push.pingDuFutur(MAINTENANT - MIN, MAINTENANT));
        assertFalse(Push.pingDuFutur(MAINTENANT + MIN, MAINTENANT));
        assertFalse(Push.pingDuFutur(0, MAINTENANT));
    }

    @Test
    public void heureServeurInconnueAvantToutEchange() {
        Horloge.oublier();
        assertTrue(Horloge.maintenantServeur(5_000) == 0);
        Horloge.noter(MAINTENANT, 1_000);
        assertTrue("heure du serveur + temps écoulé au chronomètre", Horloge.maintenantServeur(61_000) == MAINTENANT + MIN);
        Horloge.oublier();
    }
}
