package com.papote.tablette;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

import org.junit.Test;

/** Changer le wifi depuis l'appli (A36) : les décisions, sans tablette. */
public class WifiChangementTest {
    @Test
    public void unVraiResultatPourChaqueCas() {
        assertEquals(WifiChangement.Issue.CONNECTEE, WifiChangement.issue(true, false, true, true));
        assertEquals(WifiChangement.Issue.INTROUVABLE, WifiChangement.issue(false, false, false, false));
        assertEquals(WifiChangement.Issue.MOT_DE_PASSE, WifiChangement.issue(true, true, false, false));
        assertEquals(WifiChangement.Issue.SANS_INTERNET, WifiChangement.issue(true, false, true, false));
        assertEquals(WifiChangement.Issue.ECHEC, WifiChangement.issue(true, false, false, false));
        assertEquals("mot-de-passe", WifiChangement.Issue.MOT_DE_PASSE.code);
    }

    @Test
    public void unReseauDejaEnregistreNEstJamaisOublie() {
        Set<Integer> avant = new HashSet<>(Arrays.asList(0, 3, 7));
        assertFalse("l'ancien wifi reste", WifiChangement.retirerApresEchec(3, avant));
        assertTrue("seul le réseau ajouté pour l'essai est retiré", WifiChangement.retirerApresEchec(8, avant));
        assertFalse(WifiChangement.retirerApresEchec(-1, avant));
    }

    @Test
    public void lesTextesDisentOuEstLaTablette() {
        assertEquals("Connectée à « Freebox ». L'ancien wifi « Livebox » reste enregistré.",
                WifiChangement.texte(WifiChangement.Issue.CONNECTEE, "Freebox", "Livebox", false));
        assertEquals("Mot de passe refusé par « Freebox ». La tablette est restée sur « Livebox ».",
                WifiChangement.texte(WifiChangement.Issue.MOT_DE_PASSE, "Freebox", "Livebox", false));
        assertEquals("Réseau « Freebox » introuvable autour de la tablette. La tablette est restée sur la carte SIM.",
                WifiChangement.texte(WifiChangement.Issue.INTROUVABLE, "Freebox", "", true));
        assertTrue(WifiChangement.texte(WifiChangement.Issue.ECHEC, "Freebox", "", false).endsWith("signal trop faible)."));
        for (WifiChangement.Issue i : WifiChangement.Issue.values()) {
            String t = WifiChangement.texte(i, "Freebox", "Livebox", false);
            assertFalse("jamais « se connecte » sans vérification : " + t, t.contains("se connecte "));
        }
        assertTrue(WifiChangement.reussi(WifiChangement.Issue.DEJA));
        assertFalse(WifiChangement.reussi(WifiChangement.Issue.SANS_INTERNET));
    }
}
