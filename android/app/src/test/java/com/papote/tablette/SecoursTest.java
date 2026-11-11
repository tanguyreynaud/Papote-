package com.papote.tablette;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Mode secours et tâche de mise à jour de fond, sans tablette (gradlew test). */
public class SecoursTest {
    @Test
    public void secoursApresTroisDemarragesRates() {
        assertFalse(Secours.fautSecourir(0));
        assertFalse(Secours.fautSecourir(1));
        assertFalse(Secours.fautSecourir(2));
        assertTrue(Secours.fautSecourir(3));
        assertTrue(Secours.fautSecourir(10));
    }

    @Test
    public void nouvelEssaiDeuxMinutesPuisDixMinutes() {
        assertEquals(2 * 60_000L, Secours.attenteMs(1));
        assertEquals(10 * 60_000L, Secours.attenteMs(2));
        assertEquals(10 * 60_000L, Secours.attenteMs(50));
    }

    @Test
    public void laTacheDeFondNeFaitRienQuandLEcranVaBien() {
        assertFalse(MajTache.utile(true, false));
        assertTrue(MajTache.utile(false, false)); // écran jamais ouvert
        assertTrue(MajTache.utile(true, true));   // écran ouvert depuis moins d'une minute, ou qui replante
        assertTrue(MajTache.utile(false, true));
    }
}
