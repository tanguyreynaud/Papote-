package com.papote.tablette;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.telephony.TelephonyManager;

import org.junit.Test;

/** Répondeur de la carte SIM coupé (##002#) : quand le refaire, comment lire la réponse d'Android. */
public class RepondeurTest {
    private static final long T = 1_800_000_000_000L;
    private static final long JOUR = Repondeur.REESSAI_MS;

    @Test
    public void codeStandardDesOperateursFrancais() {
        assertEquals("##002#", Repondeur.CODE);
    }

    @Test
    public void jamaisEssayeOnLeFait() {
        assertTrue(Repondeur.aFaire("", "", "8933", 0, T));
    }

    @Test
    public void dejaCoupeSurCetteCarteOnNeRefaitRien() {
        assertFalse(Repondeur.aFaire("ok", "8933", "8933", T - 1000, T));
        assertFalse("des mois après aussi", Repondeur.aFaire("ok", "8933", "8933", T - 100 * JOUR, T));
        // Carte illisible ce jour-là : on ne recommence pas pour rien.
        assertFalse(Repondeur.aFaire("ok", "8933", "", T - 1000, T));
    }

    @Test
    public void nouvelleCarteOnRecommenceToutDeSuite() {
        assertTrue(Repondeur.aFaire("ok", "8933", "8944", T - 1000, T));
    }

    @Test
    public void echecUnEssaiParJourAuPlus() {
        assertFalse(Repondeur.aFaire("refuse", "", "8933", T - JOUR + 60_000, T));
        assertTrue(Repondeur.aFaire("refuse", "", "8933", T - JOUR, T));
        assertTrue("horloge revenue en arrière", Repondeur.aFaire("delai", "", "8933", T + JOUR, T));
    }

    @Test
    public void reponsesDAndroid() {
        assertEquals("refuse", Repondeur.raison(TelephonyManager.USSD_RETURN_FAILURE));
        assertEquals("indisponible", Repondeur.raison(TelephonyManager.USSD_ERROR_SERVICE_UNAVAIL));
        assertEquals("delai", Repondeur.raison(Repondeur.DELAI));
        assertEquals("erreur", Repondeur.raison(12345));
        assertTrue(Repondeur.definitif("refuse"));
        assertTrue(Repondeur.definitif("sans-permission"));
        assertFalse("un délai se retente tout de suite", Repondeur.definitif("delai"));
        assertFalse(Repondeur.definitif("indisponible"));
    }
}
