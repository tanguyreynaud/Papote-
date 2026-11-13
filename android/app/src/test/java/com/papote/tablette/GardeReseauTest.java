package com.papote.tablette;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.telephony.ServiceState;

import org.junit.Test;

/** Garde du réseau mobile : quand redémarrer la tablette pour réinscrire une carte SIM coincée (T-003, 12-13/11). */
public class GardeReseauTest {
    private static final long MIN = 60_000;
    private static final long H = 60 * MIN;
    private static final long T = 1_800_000_000_000L; // « maintenant » (heure murale)

    private static boolean decider(long horsDepuis, boolean antenne, boolean appel, long dernier, int faits) {
        return GardeReseau.fautRedemarrer(T, horsDepuis, antenne, appel, false, dernier, faits);
    }

    @Test
    public void enServiceRienNeSePasse() {
        assertFalse(decider(0, true, false, 0, 0));
    }

    @Test
    public void horsServiceMoinsDe20MinOnAttend() {
        assertFalse("une coupure courte (ascenseur, tunnel) se répare seule", decider(T - 19 * MIN, true, false, 0, 0));
    }

    @Test
    public void horsService20MinAvecAntenneRedemarre() {
        assertTrue("cas de T-003 : antenne Orange entendue, carte jamais inscrite", decider(T - 21 * MIN, true, false, 0, 0));
    }

    @Test
    public void sansAntenneVraieZoneBlancheOnNeRedemarrePas() {
        assertFalse(decider(T - 10 * H, false, false, 0, 0));
    }

    @Test
    public void jamaisPendantUnAppel() {
        assertFalse(decider(T - 2 * H, true, true, 0, 0));
    }

    @Test
    public void jamaisPendantLaMaintenance() {
        assertFalse(GardeReseau.fautRedemarrer(T, T - 2 * H, true, false, true, 0, 0));
    }

    @Test
    public void deuxiemeEssaiSixHeuresApresPuisUnParJour() {
        assertFalse("pas de redémarrages en boucle", decider(T - 10 * H, true, false, T - 5 * H, 1));
        assertTrue(decider(T - 10 * H, true, false, T - 6 * H, 1));
        assertFalse(decider(T - 30 * H, true, false, T - 23 * H, 2));
        assertTrue(decider(T - 30 * H, true, false, T - 24 * H, 2));
    }

    @Test
    public void seuleUneAntenneDuReseauDeLaCarteCompte() {
        // Tanguy (13/11) : à Poissy, rien que des antennes Orange pour une carte portée par Bouygues :
        // redémarrer n'y change rien.
        assertFalse(GardeReseau.memeReseau("20801", "20820"));
        assertTrue(GardeReseau.memeReseau("20820", "20820"));
        assertTrue("réseau de la carte jamais vu : toute antenne compte", GardeReseau.memeReseau("20801", ""));
    }

    @Test
    public void horsServiceEtUrgencesSeulementComptent() {
        assertTrue(GardeReseau.hors(ServiceState.STATE_OUT_OF_SERVICE));
        assertTrue(GardeReseau.hors(ServiceState.STATE_EMERGENCY_ONLY));
        assertFalse(GardeReseau.hors(ServiceState.STATE_IN_SERVICE));
        assertFalse("mode avion : voulu, on ne touche à rien", GardeReseau.hors(ServiceState.STATE_POWER_OFF));
    }
}
